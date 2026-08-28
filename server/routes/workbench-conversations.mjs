// SP3: 工作台对话 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// 7 端点 + buildRefsContext 辅助逐字搬迁,仅依赖引用改走 deps 注入。
// SP2 已抽出 agent loop → workbench-agent.mjs(wbAgent.runConversation / resumeConversation)。
import { buildWorkbenchSystemPrompt } from '../workbench-prompt.mjs'
import { getWorkbenchAiConfig } from '../workbench-ai-config.mjs'
import { registry } from '../tool-registry.mjs'
import { listSshServers } from '../ssh/store.mjs'
import {
  getProject, getConversation, updateConversation, listConversations,
  createConversation, appendMessage, getMaxSeq, setActiveConversation, listMessages,
  truncateAfterLastUser, regenWatermark, listActiveConversations, getPresenceConfig,
  buildHistory, truncateFromMessage,
} from '../workbench-projects.mjs'
import { contextWindowFor, estTokens } from '../model-context.mjs'
import { maybeSummarize, compactConversation } from '../workbench-summarize.mjs'
import { stripRefsContext, REFS_CTX_HEADER } from '../refs-context.mjs'
import { maskSecretResource } from '../secret-mask.mjs'
import { msg } from '../messages.mjs'

// @-ref 资源拉取(T4 抽出,POST /conversations 与 POST /:id/messages 复用):
// 取 project → k8s session → 逐 ref requestKubernetes .body → 拼 "Referenced resources" context 块。
// 无 references / 无绑定集群 → 返回 ''(调用方据此决定是否 prepend)。
import { getApiPath } from '../kind-paths.mjs'
import { normalizeKind } from '../kindAlias.mjs'

export function createWorkbenchConvRoutes(deps) {
  const {
    db, sendJson, readBody, requireAdmin, wbAgent,
    getLlmConfig, createLlmClient, buildCallContext, requestKubernetes,
    busSubscribe, busUnsubscribe, busDispose,
  } = deps

  // P0(E):审批准入 = 原子 CAS——UPDATE..WHERE status='paused' 命中 0 行即拒绝。
  // 迟到审批(done/failed 后)与双击并发都挡在门外;命中即置 running,
  // resumeConversation 内部的再次置 running 幂等无害。
  function claimPausedForResume(req, db_, id) {
    const conv = getConversation(db_, id)
    if (!conv) return { ok: false, status: 404, message: msg(req, 'wbc.convNotFound') }
    if (conv.status !== 'paused') return { ok: false, status: 400, message: msg(req, 'wbc.notPaused') }
    const changes = db_.prepare("UPDATE workbench_conversations SET status='running', updatedAt=? WHERE id=? AND status='paused'").run(Date.now(), id).changes
    if (changes === 0) return { ok: false, status: 400, message: msg(req, 'wbc.notPausedConcurrent') }
    return { ok: true }
  }

  // 当前轮快照(2026-08-25 闪变续修):trace = conv.trace 中「上一条消息行 createdAt 之后」的事件
  // (= 未落库的当前轮,覆盖 run+审批 resume 全程),assistant 全量形状瘦身为平铺——与消息级
  // trace 同形状。替代终态发全对话 / running 发 bus 快照(按 run 重置,resume 丢暂停前半段)
  // 两种口径不一的数据源;content/reasoning 用 conv 级检查点(已轮清零)。
  function turnSnapshot(id) {
    const conv = getConversation(db, id)
    if (!conv) return null
    const msgs = listMessages(db, id)
    const lastTs = msgs.length ? Math.max(...msgs.map(m => m.createdAt || 0)) : 0
    let all = []
    try { all = JSON.parse(conv.trace || '[]') } catch { all = [] }
    const trace = all
      .filter(e => e && typeof e === 'object' && (e.ts || 0) > lastTs && e.type !== 'tool_start')
      .map(e => e.type === 'assistant' ? { type: 'assistant', content: e.message?.content || '', ts: e.ts } : e)
    return { content: conv.content || '', reasoning: conv.reasoning || '', trace, steps: conv.steps ?? 0 }
  }

  // 上下文余量(spec §4.3,服务端单一计算源):estTokens ≈ buildHistory 装配 + conv.system
  // 的总字符 × 折中比例。近似说明:@refs 每轮重拉的注入长度未计(通常远小于正文,spec 已记录)。
  function contextInfo(conv) {
    const history = buildHistory(db, conv)
    const chars = conv.system.length + history.reduce((n, m) => n + JSON.stringify(m).length, 0)
    const windowTokens = contextWindowFor(getLlmConfig().model)
    const est = estTokens(chars)
    const budgetTokens = Math.floor(windowTokens * 0.7)
    return { estTokens: est, windowTokens, budgetTokens, recapUpTo: conv.summarizedUpTo ?? 0, willTrim: est > budgetTokens }
  }

  async function buildRefsContext(project, references) {
    if (!Array.isArray(references) || !references.length) return { ctx: '', resources: [] }
    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(project.clusterId)
    if (!cluster) return { ctx: '', resources: [] } // 项目绑定的集群不存在 → 无 @-ref 可拉
    const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
    const blocks = []
    const resources = [] // 原始资源 body(供前端 ResourceCard),与 ctx 同源单次拉取
    for (const ref of references) {
      const label = `[${ref.kind}/${ref.namespace || ''}/${ref.name}]`
      // 防御性归一:ref.kind 正常恒为前端 canonical,与工具链同源归一以防旧数据
      const path = getApiPath(normalizeKind(ref.kind), ref.namespace || '', ref.name)
      if (!path) { blocks.push(`${label}: (不支持的 kind)`); continue }
      try {
        const res = await requestKubernetes(k8sSession, path)
        // requestKubernetes 返回 {status,headers,body};资源在 body(guard:可能 undefined)
        const body = res?.body
        if (body == null) { blocks.push(`${label}: (空响应)`); continue }
        blocks.push(`${label}:\n${JSON.stringify(body, null, 2)}`)
        // 落库 refs + 前端 ResourceCard 均掩码形(脱敏 spec 2026-08-28,终审 I1):
        // 明文不出 DB;blocks 拼 ctx 保持原样(ctx 本身无消费方,system 注入走 fetchRefContext 已掩码)
        resources.push(maskSecretResource(body))
      } catch (e) {
        blocks.push(`${label}: (not found)`)
      }
    }
    return { ctx: `${REFS_CTX_HEADER}${blocks.join('\n\n')}`, resources }
  }

  // 提示词可用的 SSH 清单(仅 id/name/description/clusterRef,凭据不进 prompt)。
  // 防御式:ssh_servers 表可能尚未建(旧库/测试夹具)——SSH 清单不可用不该让对话创建
  // 或 admin 预览整体 500,失败降级为空清单(= 提示词无 SSH 段,零暴露语义不变)。
  function sshPromptServers() {
    try {
      return listSshServers(db, { exposedOnly: true }).map(s => ({ id: s.id, name: s.name, description: s.description, clusterRef: s.clusterRef }))
    } catch (e) {
      console.error('[wb-conversations] SSH 清单读取失败,提示词按无 SSH 服务器装配:', e?.message || e)
      return []
    }
  }

  // 匹配工作台对话路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  // 注:原 index.mjs 各分支用 `return sendJson(...)` 早退 + 终结响应;此处等价改为
  // `sendJson(...); return true`(sendJson 已 res.end,只需告知 dispatcher 已处理)。
  async function handle(req, res, url) {
    // GET /api/workbench/ai-config — 透明面板数据源(登录即可,2026-08-25 设计):
    // 生效提示词/工具清单/追加指令/model。刻意不回 baseURL/apiKey(连接配置仅 admin 可见)。
    if (url.pathname === '/api/workbench/ai-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const cfg = getWorkbenchAiConfig(db)
      const disabled = new Set(cfg.disabledTools)
      const sshServers = sshPromptServers()
      sendJson(res, 200, {
        effectivePrompt: buildWorkbenchSystemPrompt({ ...cfg, sshServers }),
        tools: registry.workbenchTools().map(t => ({ name: t.name, description: t.description, requiresApproval: t.requiresApproval, enabled: !disabled.has(t.name) })),
        additionalInstructions: cfg.additionalInstructions,
        model: getLlmConfig().model,
      })
      return true
    }
    // POST /api/workbench/conversations — 创建对话 + 后台执行(detached)
    if (url.pathname === '/api/workbench/conversations' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const project = getProject(db, input.projectId)
        if (!project) { sendJson(res, 404, { message: msg(req, 'wbc.projectNotFound') }); return true }
        if (project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: msg(req, 'wbc.noProjectAccess') }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
        const llmClient = createLlmClient(cfg)

        // @-mention references:首屏给前端 fetch 一次 ResourceCard(buildRefsContext 单次拉取,去重);
        // system 只存工作台 prompt 原文(不含 refContext——每轮 chat 前由 run/resumeConversation 内部
        // refreshSystem 钩子重新 fetch,避免吃首轮旧快照)。T5 + main 去重。
        const { resources: fetchedResources } = await buildRefsContext(project, input.references)

        // system 创建时烘焙入库(2026-08-25 设计决策):admin 改配置只影响新对话;
        // conv.system 即逐对话审计证据,透明面板据此展示"本对话实际用的提示词"。
        const sshServers = sshPromptServers()
        const system = buildWorkbenchSystemPrompt({ ...getWorkbenchAiConfig(db), sshServers })

        const conv = createConversation(db, { projectId: input.projectId, system, userMessage: String(input.message), references: input.references })
        // T5:新建线程成为项目当前活跃对话(前端轮询 GET project 拿此 id 跳转/高亮)。
        setActiveConversation(db, input.projectId, conv.id)
        // T4:首条 user 消息写入 workbench_messages(干净 content;@-ref 由 runConversation 的 refreshSystem 每轮刷新注入 system,不 baked 进 message)。
        appendMessage(db, { conversationId: conv.id, role: 'user', content: String(input.message), refs: Array.isArray(input.references) ? input.references.map((r, i) => ({ ...r, resource: fetchedResources[i] || null })) : null })
        wbAgent.runConversation(conv.id, llmClient, { userId: ps.userId, username: ps.username }).catch(e => console.error('[wbAgent] detached run 崩溃:', e?.message || e)) // detached — 不 await;.catch 防未捕获 rejection 杀进程(k8sSession 由 runConversation 内部按 conv.projectId 重建)
        sendJson(res, 200, { id: conv.id, status: 'running', references: fetchedResources, context: contextInfo(getConversation(db, conv.id)) })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.createFailed') }); return true }
    }

    // POST /api/workbench/conversations/:id/messages — 续接对话(多轮核心,T4)。
    // 必须在 GET /:id 之前注册(路径更具体,先匹配)。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/messages$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/messages
        const input = await readBody(req)
        const conv = getConversation(db, id)
        if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
        // P0 守卫(D):运行中/待审批拒绝续接——detached run 无互斥,并发双 run 会交错写
        // trace/检查点/messages(多标签页或直接 API 调用都能绕过前端 sending 守卫)。
        if (conv.status === 'running' || conv.status === 'paused') {
          sendJson(res, 400, { message: msg(req, 'wbc.busyNoResume') }); return true
        }
        const project = getProject(db, conv.projectId)
        if (!project) { sendJson(res, 404, { message: msg(req, 'wbc.projectNotFound') }); return true }
        if (project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: msg(req, 'wbc.noAccess') }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
        // 续接的线程持久化为活跃对话(刷新后回到该线程,而非之前持久化的线程)。
        setActiveConversation(db, conv.projectId, id)
        // 1) @-ref 资源拉取(先拉,enrich refs 存完整资源 → 刷新后 ResourceCard 不丢)
        const cleanMessage = String(input.message ?? '')
        const { resources: fetchedResources } = await buildRefsContext(project, input.references)
        // 2) append user 消息:content 只存干净正文(曾把 refsCtx 烤进 content → 刷新后整段
        //    JSON 当消息显示;agent 上下文改由 references 走 system,见下)
        appendMessage(db, { conversationId: id, role: 'user', content: cleanMessage, refs: Array.isArray(input.references) ? input.references.map((r, i) => ({ ...r, resource: fetchedResources[i] || null })) : null })
        // 3) 新 refs 并入对话级 "references"(去重 kind/namespace/name):runConversation 的
        //    refreshSystem 每轮重写 messages[0] 注入引用资源最新状态(agent.mjs T5 漂移修复),
        //    上下文与烤进 content 等价且更新鲜;新建路径(POST /conversations)本就走此机制。
        let mergedRefs = []
        try { mergedRefs = JSON.parse(conv.references || '[]') } catch { mergedRefs = [] }
        if (Array.isArray(input.references)) {
          const key = r => `${r.kind}/${r.namespace || ''}/${r.name}`
          const seen = new Set(mergedRefs.map(key))
          for (const r of input.references) {
            const k = key(r)
            if (!seen.has(k)) { seen.add(k); mergedRefs.push({ kind: r.kind, namespace: r.namespace, name: r.name }) }
          }
        }
        // 4) 标记 running + 复位上轮运行态字段(A)→ 后台跑 → 异步摘要(失败忽略)。
        //    content/reasoning/trace/steps/pendingApproval 不复位的话:上轮答案/思考残留会让
        //    启动抢救(salvageInterrupted)在本轮中断时把上轮内容补录成"新消息"(跨轮污染)。
        updateConversation(db, id, { status: 'running', references: mergedRefs, content: '', reasoning: '', trace: '[]', steps: 0, pendingApproval: null })
        const llmClient = createLlmClient(cfg)
        wbAgent.runConversation(id, llmClient, { userId: ps.userId, username: ps.username }).catch(e => console.error('[wbAgent] detached run 崩溃:', e?.message || e)) // detached — 不 await;.catch 防未捕获 rejection 杀进程
        maybeSummarize(db, id, llmClient).catch(() => {}) // 异步摘要,失败静默
        sendJson(res, 200, { status: 'running', references: fetchedResources, context: contextInfo(getConversation(db, id)) })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.resumeFailed') }); return true }
    }

    // POST /api/workbench/conversations/:id/regenerate — 重新生成最后一条回复(P1 消息操作)。
    // 截掉最后 user 消息之后的 assistant 回复 → 复位 conv 运行态字段 → runConversation
    // 以剩余消息(buildHistory)重跑,即"原问题重答",不重复计 user 轮。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/regenerate$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = url.pathname.split('/')[4]
        const conv = getConversation(db, id)
        if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
        if (conv.status === 'running' || conv.status === 'paused') { sendJson(res, 400, { message: msg(req, 'wbc.busyNoRegen') }); return true }
        const project = getProject(db, conv.projectId)
        if (!project) { sendJson(res, 404, { message: msg(req, 'wbc.projectNotFound') }); return true }
        if (project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: msg(req, 'wbc.noAccess') }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
        const { removed, lastUserSeq } = truncateAfterLastUser(db, id)
        if (removed === 0) { sendJson(res, 400, { message: msg(req, 'wbc.noRegenTarget') }); return true }
        setActiveConversation(db, conv.projectId, id)
        // 水位钳制(dev29):seq 复用 × summarizedUpTo 互踩——不钳的话原问题会被当"已进 recap"跳过,重答偏题
        updateConversation(db, id, { status: 'running', content: '', reasoning: '', error: '', trace: '[]', steps: 0, pendingApproval: null, summarizedUpTo: regenWatermark(conv.summarizedUpTo, lastUserSeq) })
        const llmClient = createLlmClient(cfg)
        wbAgent.runConversation(id, llmClient, { userId: ps.userId, username: ps.username }).catch(e => console.error('[wbAgent] detached run 崩溃:', e?.message || e)) // detached;.catch 防未捕获 rejection 杀进程
        sendJson(res, 200, { status: 'running' })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.regenFailed') }); return true }
    }

    // POST /api/workbench/conversations/:id/compact — 手动压缩上下文(全量重摘要,spec §4.4)
    // 必须在 GET /:id 之前注册(路径更具体,先匹配)。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/compact$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      if (conv.projectId) {
        const project = getProject(db, conv.projectId)
        if (project && project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: msg(req, 'wbc.noAccess') }); return true }
      }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      const input = await readBody(req)
      const out = await compactConversation(db, id, createLlmClient(cfg), String(input.instruction || ''))
      if (!out.ok) { sendJson(res, out.status, { message: msg(req, out.message) }); return true }
      sendJson(res, 200, { ok: true, recap: out.recap, context: contextInfo(getConversation(db, id)) })
      return true
    }

    // POST /api/workbench/conversations/:id/edit — 编辑已发消息重发(spec 2026-08-28 §3.1):
    // 截断锚消息及其后全部 → 以新内容 append(refs 缺省沿用)→ 复位运行态 → 重跑。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/edit$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      if (conv.status === 'running' || conv.status === 'paused') { sendJson(res, 400, { message: msg(req, 'wbc.busyNoResume') }); return true }
      const project = getProject(db, conv.projectId)
      if (!project) { sendJson(res, 404, { message: msg(req, 'wbc.projectNotFound') }); return true }
      if (project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: msg(req, 'wbc.noAccess') }); return true }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      try {
        const input = await readBody(req)
        const content = String(input.messageId ? input.content || '' : '')
        if (!content.trim()) { sendJson(res, 400, { message: msg(req, 'wbc.editContentRequired') }); return true }
        const anchor = db.prepare('SELECT id, seq, refs FROM workbench_messages WHERE id=? AND conversationId=? AND role=?').get(String(input.messageId || ''), id, 'user')
        if (!anchor) { sendJson(res, 400, { message: msg(req, 'wbc.editAnchorInvalid') }); return true }
        const t = truncateFromMessage(db, id, anchor.id)
        if (!t) { sendJson(res, 400, { message: msg(req, 'wbc.editAnchorInvalid') }); return true }
        // refs:body.references 替换;缺省沿用锚消息 refs(原始对象形状,appendMessage 直存)
        let refsValue = Array.isArray(input.references) ? input.references : null
        if (!refsValue && anchor.refs) { try { const p = JSON.parse(anchor.refs); if (Array.isArray(p)) refsValue = p } catch { refsValue = null } }
        setActiveConversation(db, conv.projectId, id)
        // 新 refs 并入对话级 references(与 append 的 mergeRefs 同款)
        let mergedRefs = []
        try { mergedRefs = JSON.parse(conv.references || '[]') } catch { mergedRefs = [] }
        const key = r => `${r.kind}/${r.namespace || ''}/${r.name}`
        const seen = new Set(mergedRefs.map(key))
        for (const r of (refsValue || [])) { const k = key(r); if (!seen.has(k)) { seen.add(k); mergedRefs.push({ kind: r.kind, namespace: r.namespace, name: r.name }) } }
        appendMessage(db, { conversationId: id, role: 'user', content, refs: refsValue ? refsValue.map(r => ({ kind: r.kind, namespace: r.namespace, name: r.name })) : null })
        updateConversation(db, id, {
          status: 'running', references: mergedRefs, content: '', reasoning: '', trace: '[]', steps: 0, pendingApproval: null,
          // 水位钳制(spec §3.1 修正):min(现值, fromSeq-1)——前缀连续 1..fromSeq-1,保留其摘要覆盖;
          // 编辑首条(fromSeq-1=0)归 0。原 keptMinSeq-1 因 seq 从 1 起恒为 0,会把摘要覆盖每次归零。
          summarizedUpTo: Math.min(conv.summarizedUpTo ?? 0, t.fromSeq - 1),
        })
        const llmClient = createLlmClient(cfg)
        wbAgent.runConversation(id, llmClient, { userId: ps.userId, username: ps.username }).catch(e => console.error('[wbAgent] detached run 崩溃:', e?.message || e)) // detached
        sendJson(res, 200, { status: 'running', context: contextInfo(getConversation(db, id)) })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.editFailed') }); return true }
    }

    // GET /api/workbench/conversations/active — 悬浮入口原料:近期动态模型(running/paused 永在 +
    // 终态窗口内有动态,Top-N;窗口/条数由 presence.* 配置驱动,2026-08-17)。
    // 必须放在 GET /:id 之前:/[^/]+$/ 同样匹配 'active',放后面会被当 :id 查 → 404。
    if (url.pathname === '/api/workbench/conversations/active' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const cfg = getPresenceConfig(db)
      sendJson(res, 200, { conversations: listActiveConversations(db, { windowMs: cfg.windowMs, cap: cfg.maxItems }) })
      return true
    }

    // GET /api/workbench/conversations/:id — 单条对话状态(轮询用)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+$/) && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/').pop()
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      sendJson(res, 200, {
        id: conv.id, status: conv.status, steps: conv.steps,
        content: conv.content, reasoning: conv.reasoning, error: conv.error,
        pendingApproval: conv.pendingApproval, trace: conv.trace,
        userMessage: conv.userMessage,
        recap: conv.recap, summarizedUpTo: conv.summarizedUpTo,
        system: conv.system, // 透明面板:本对话创建时烘焙的提示词(逐对话审计)
        context: contextInfo(conv),
        // 出参剥掉历史版本烤进 user content 的 refsCtx 前缀(库内原文不动,agent/摘要不受
        // 影响)——旧数据免迁移,刷新后不再把引用资源 JSON 当消息正文显示。
        messages: listMessages(db, id).map(m => m.role === 'user' ? { ...m, content: stripRefsContext(m.content) } : m),
      })
      return true
    }

    // DELETE /api/workbench/conversations/:id — 删除对话(+ 关联 messages;清 activeConversationId 若匹配)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+$/) && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      // P0(F):运行中先取消(cancelled 守卫让 in-flight run 的结果不再回写已删对话,
      // 避免 appendTrace 抛错 → salvagePartial 给已删对话落孤儿 assistant 行);再 dispose
      // bus 让挂在 SSE 上的客户端收到终结,而不是靠 keepalive 干等。
      if (conv.status === 'running' || conv.status === 'paused') wbAgent.cancelConversation(id)
      busDispose?.(id)
      if (conv.projectId) {
        const proj = getProject(db, conv.projectId)
        if (proj?.activeConversationId === id) setActiveConversation(db, conv.projectId, null)
      }
      // P0(F):两条 DELETE 包事务——中途失败整体回滚,不再产生"messages 没了 conv 还在"
      // 或反向的半删状态。
      try {
        db.exec('BEGIN')
        db.prepare('DELETE FROM workbench_messages WHERE conversationId=?').run(id)
        db.prepare('DELETE FROM workbench_conversations WHERE id=?').run(id)
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 已回滚 */ }
        sendJson(res, 500, { message: e?.message || msg(req, 'wbc.deleteFailed') }); return true
      }
      sendJson(res, 200, { ok: true })
      return true
    }

    // PATCH /api/workbench/conversations/:id — 重命名对话(title 字段)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+$/) && req.method === 'PATCH') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const input = await readBody(req)
      const title = String(input.title || '').slice(0, 100).trim()
      if (!title) { sendJson(res, 400, { message: msg(req, 'wbc.titleRequired') }); return true }
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      // 重命名是元数据编辑,不 bump updatedAt——悬浮入口以 updatedAt 判「新动态」,
      // 用户自己的改名不应让对话小点复活/跳顶。
      db.prepare('UPDATE workbench_conversations SET title=? WHERE id=?').run(title, id)
      sendJson(res, 200, { id, title })
      return true
    }

    // GET /api/workbench/conversations/:id/stream — SSE 实时事件流(T7)。
    // 推 hello | status | step | delta | approval | end 事件(spec §4.1.4)。Task 8 前端消费。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/stream$/) && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/stream
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      })
      const send = (evt) => { try { res.write('data: ' + JSON.stringify(evt) + '\n\n') } catch { /* 客户端已断 */ } }
      send({ type: 'hello', convId: id, status: conv.status })
      // 连上时已 paused:approval 事件可能在 SSE 建连前 emit 丢失,补推当前 pendingApproval(治审批不弹)
      if (conv.status === 'paused') {
        let pa = null
        try { pa = conv.pendingApproval ? JSON.parse(conv.pendingApproval) : null } catch {}
        if (pa) send({ type: 'approval', pending: pa })
        send({ type: 'status', status: 'paused' })
        send({ type: 'end' })
        res.end()
        return true
      }
      if (conv.status === 'done' || conv.status === 'failed' || conv.status === 'cancelled') {
        // 终态补发完整快照(dev31):此前只发 status+end 不带 content——刷新后恰逢对话刚结束的
        // 窗口连入的客户端,thinking turn 被置 done 但内容为空("看不到回答"的根因之一)。
        // R1(2026-08-19):快照同时带 reasoning 检查点(与 running 分支对齐)——终态思考可回看。
        const ts = turnSnapshot(id)   // 按轮切割+瘦身:全对话 trace 会把历史轮灌进最后一个 turn(交错渲染放大为可见污染)
        send({ type: 'snapshot', content: conv.content || '', reasoning: conv.reasoning || '', trace: ts?.trace || [], steps: conv.steps ?? 0 })
        send({ type: 'status', status: conv.status, ...(conv.error ? { error: conv.error } : {}) })
        send({ type: 'end' })
        res.end()
        return true
      }
      // running:先订阅再补发快照(同步执行无竞态)——断线重连/晚连的客户端一键吃齐
      // 此前已 emit 的 delta/step(conv.content 只在 done 落库,不补则中段文本永久丢失)
      busSubscribe(id, send)
      const snap = turnSnapshot(id)   // 按轮切割(覆盖 resume 前半段,bus 快照按 run 重置会丢)
      if (snap && (snap.content || snap.trace.length)) {
        send({ type: 'snapshot', content: snap.content, reasoning: snap.reasoning, trace: snap.trace, steps: snap.steps })
      }
      const keepalive = setInterval(() => { try { res.write(': keepalive\n\n') } catch {} }, 15000)
      req.on('close', () => { clearInterval(keepalive); busUnsubscribe(id, send) })
      return true
    }

    // GET /api/workbench/conversations?projectId=X — 列表(slim)
    if (url.pathname === '/api/workbench/conversations' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const projectId = url.searchParams.get('projectId')
      if (!projectId) { sendJson(res, 400, { message: msg(req, 'wbc.projectIdRequired') }); return true }
      sendJson(res, 200, { conversations: listConversations(db, projectId) })
      return true
    }

    // POST /api/workbench/conversations/:id/approve — resume(detached)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/approve$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/approve
      // P0(E):仅 paused 可审批。迟到审批(done/failed 后)此前会让 resume 的
      // JSON.parse(conv.pendingApproval=null) 抛错 → 把终态改写成 failed(吞掉已完成答案)。
      const cas = claimPausedForResume(req, db, id)
      if (!cas.ok) { sendJson(res, cas.status, { message: cas.message }); return true }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      const llmClient = createLlmClient(cfg)
      wbAgent.resumeConversation(id, true, llmClient, { userId: ps.userId, username: ps.username }).catch(e => console.error('[wbAgent] detached resume 崩溃:', e?.message || e)) // detached — 不 await;.catch 防未捕获 rejection 杀进程
      sendJson(res, 200, { status: 'running' })
      return true
    }

    // POST /api/workbench/conversations/:id/deny — resume(detached)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/deny$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/deny
      const cas = claimPausedForResume(req, db, id)
      if (!cas.ok) { sendJson(res, cas.status, { message: cas.message }); return true }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      const llmClient = createLlmClient(cfg)
      wbAgent.resumeConversation(id, false, llmClient, { userId: ps.userId, username: ps.username }).catch(e => console.error('[wbAgent] detached resume 崩溃:', e?.message || e)) // detached — 不 await;.catch 防未捕获 rejection 杀进程
      sendJson(res, 200, { status: 'running' })
      return true
    }

    // POST /api/workbench/conversations/:id/cancel — 用户主动停止(输错内容→停止→修改重发)。
    // 后台 LLM 调用不可中断,但 agent 落库前的 cancelled 守卫会丢弃其结果。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/cancel$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/cancel
        const r = wbAgent.cancelConversation(id)
        if (!r.ok) { sendJson(res, 400, { message: r.message }); return true }
        sendJson(res, 200, { status: 'cancelled' })
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.cancelFailed') }); return true }
      return true
    }

    return false // 无匹配
  }

  return { handle }
}
