// SP3: 工作台对话 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// 7 端点 + buildRefsContext 辅助逐字搬迁,仅依赖引用改走 deps 注入。
// SP2 已抽出 agent loop → workbench-agent.mjs(wbAgent.runConversation / resumeConversation)。
//
// 权限契约(W2 Phase D 生效,2026-09-07 contracts-07 校正):对话域(本文件全部 conversations
// 路由)= requirePlatform + owner 链(对话→项目→owner/admin,assertProjectOwnership 单一事实源),
// 触发 run 的面(messages/regenerate/edit/approve/deny + create)另加集群分配 entitlement
// (canAccessCluster,批次二 F4)。c982a9a 时代的契约注释要求「放开非 admin 前先做 ns 隔离 ADR」
// ——Phase D 的 owner 链 + entitlement 门(含批次二补齐)即该裁决的落地:非 owner 403、失权
// owner 403、单对话端点 ownership 前移不泄漏存在性(authz-entitlement-07)。GET /ai-config 仍
// requireAdmin(透明面板含生效提示词,连接配置仅 admin 可见)。同文件域的 @server 搜索分支
// (workbench-projects.mjs)同门槛(requirePlatform+owner)。前端入口(AppLayout ChatPresence /
// WorkbenchDetail Agent 模式)对全部平台会话可见(与前端测试 AppLayout.chat-presence-entry /
// WorkbenchDetail.lifecycle 对齐)。
import { buildWorkbenchSystemPrompt } from '../workbench-prompt.mjs'
import { getWorkbenchAiConfig, getMaxRunningConversationsConfig, getMaxConversationsPerProjectConfig, sshPromptServers } from '../workbench-ai-config.mjs'
import { registry, SSH_HIDDEN_TOOLS } from '../tool-registry.mjs'
// approval-flow-02:deny 无 LLM 终态转换需要向 conv-bus 广播(与 wbAgent.cancelConversation
// 同款 failed+end+dispose 三连)。模块级单例,与 deps 注入的 busSubscribe/busDispose 同源。
import { emit as busEmit } from '../conv-bus.mjs'
import {
  getProject, getConversation, updateConversation, listConversations,
  createConversation, appendMessage, getMaxSeq, setActiveConversation, listMessages,
  truncateAfterLastUser, regenWatermark, listActiveConversations, getPresenceConfig,
  buildHistory, truncateFromMessage,
} from '../workbench-projects.mjs'
import { contextWindowFor, estTokensFromCounts, countCjkChars } from '../model-context.mjs'
import { maybeSummarize, maybeSummarizeProject, compactConversation } from '../workbench-summarize.mjs'
import { stripRefsContext, REFS_CTX_HEADER, REFS_GUARD_NOTE } from '../refs-context.mjs'
import { maskSecretResource } from '../secret-mask.mjs'
import { msg } from '../messages.mjs'
import { assertProjectOwnership } from './workbench-projects.mjs' // W2 CB-B:归属判定单一事实源(导出式 helper)

// @-ref 资源拉取(T4 抽出,POST /conversations 与 POST /:id/messages 复用):
// 取 project → k8s session → 逐 ref requestKubernetes .body → 拼 "Referenced resources" context 块。
// 无 references / 无绑定集群 → 返回 ''(调用方据此决定是否 prepend)。
import { getApiPath } from '../kind-paths.mjs'
import { normalizeKind } from '../kindAlias.mjs'
import { refAllowed } from '../ref-fetch.mjs' // Phase C Task 6:@mention 引用门单一事实源
import { canAccessCluster } from '../authz.mjs' // Phase D Task 7:集群分配 entitlement(单一事实源,admin 短路)
// refs-injection-02 + gap3-01(2026-09-07 审计批次二 Task 6):三入口统一归一(条数/形状/字节
// → 400)+ 落库盖 clusterId 戳 + 换绑停用。见 refs-normalize.mjs 文件头注。
import { normalizeReferences, stampRefs, clampResource, REFS_MAX_ITEMS, REFS_MAX_BYTES } from '../refs-normalize.mjs'

export function createWorkbenchConvRoutes(deps) {
  const {
    db, sendJson, readBody, requireAdmin, wbAgent, writeAudit,
    getLlmConfig, createLlmClient, buildCallContext, requestKubernetes,
    busSubscribe, busUnsubscribe, busDispose,
    // W2 Phase D(Task 7)降门:端点地板从 admin 放到 platform。requirePlatform 缺省回退
    // requireAdmin(更严=fail-closed;index.mjs 装配两参齐传,旧测试桩只注入 requireAdmin 也能跑)。
    requirePlatform = requireAdmin,
  } = deps

  // 审批归属留痕(CB-B Task 4):approverId/approvedAt 并入 pendingApproval JSON(载荷原样保留)。
  // 只在 approve/deny 的 CAS 命中后调用——resumeConversation 清 pendingApproval 前,归属写入先落。
  function stampApprover(db_, id, approverId) {
    const conv = getConversation(db_, id)
    if (!conv?.pendingApproval) return
    let pa; try { pa = JSON.parse(conv.pendingApproval) } catch { pa = {} }
    db_.prepare('UPDATE workbench_conversations SET pendingApproval=? WHERE id=?')
      .run(JSON.stringify({ ...pa, approverId, approvedAt: Date.now() }), id)
  }

  // W2 Phase D(Task 7):单对话端点所有权链单一事实源——对话 → 项目 → owner/admin。
  // 降门(requirePlatform)后每个单对话面都必须过此链;失败 send 403(wbc.noProjectAccess,
  // 与写面同键)并返回 null,调用方 `if (!project) return true`。
  // authz-entitlement-07(2026-09-07 审计批次三):conv 缺失同样 403(项目无从解析 = 恒拒)
  // ——404/busy-400 判定必须排在此链之后(单对话端点不泄漏存在性/运行状态;与列表端点
  // 「项目缺失同 403」同款)。
  function resolveConvProject(req, res, ps, conv) {
    const project = conv?.projectId ? getProject(db, conv.projectId) : null
    if (!project || !assertProjectOwnership(ps, project)) {
      sendJson(res, 403, { message: msg(req, 'wbc.noProjectAccess') })
      return null
    }
    return project
  }

  // authz-entitlement-06(2026-09-07 审计批次三):对话生命周期审计——create/messages/
  // regenerate/edit/DELETE/cancel 六动作各落一行(tool='wb_conv',verb=动作;approve/deny
  // 走既有 wb_approval 不动)。摘要 conv= + project=(approve 的 key=value 串同款)。调用点
  // 一律在状态已 COMMIT 且 detached run 已启动之后:审计此处是可观测而非鉴权留痕(approve
  // 的归属记录才需要失败即回滚),写失败不回滚业务(与 workbench-projects 的 project_delete
  // 同款——动作已成,审计尽力落;audit_log 写不进 = 库已坏,请求 500 可接受)。
  function auditConv(ps, verb, convId, projectId) {
    writeAudit?.(db, { owner: ps.username, verb, tool: 'wb_conv', result: 'ok', requestSummary: `conv=${convId} project=${projectId}`, source: 'platform' })
  }

  // W2 Phase D(Task 7):集群分配 entitlement——canAccessCluster 单一事实源(admin 短路
  // true;其余须 user_clusters 分配行)。施加于触发对话运行的面(续接消息 / regenerate);
  // 未绑定集群('')不在此门(对话自然降级为无集群面,不放大也不收紧)。
  function clusterEntitled(ps, clusterId) {
    if (!clusterId) return true
    return canAccessCluster(db, { userId: ps.userId }, clusterId)
  }

  // F6(2026-09-07 审计):对话限额双门,触发 run 前现读配置(admin 改完即时生效,与 maxSteps
  // 同款「每次 run 现读」语义)。归属口径:会话无独立属主列 → 项目 ownerId(records/summary 的
  // listConversationsByOwner 同口径);DB count 重启安全(非内存计数)。0 = 不限制(逃生阀,
  // admin 不豁免——统一门)。计数查询 try/catch fail-open:限额是防滥用闸非鉴权不变式,
  // 异构 schema(测试夹具/旧库)不该把端点打成 500。
  // quotaHit 的 excludeConvId:并发计数排除自身会话行——自身 running 行属取代语义不占新名额
  // (messages/regenerate/edit 都有 busy 守卫先行,自身实际到不了 running;排除是按审计契约
  // 防守卫顺序变化后误计自身;对空闲会话则如实占新名额)。
  function quotaHit(userId, { excludeConvId = null, projectId = null } = {}) {
    const maxRunning = getMaxRunningConversationsConfig(db)
    if (maxRunning > 0) {
      try {
        const sql = `SELECT COUNT(*) AS n FROM workbench_conversations c
          JOIN workbench_projects p ON p.id = c.projectId
          WHERE p.ownerId = ? AND c.status = 'running'${excludeConvId ? ' AND c.id != ?' : ''}`
        const row = excludeConvId ? db.prepare(sql).get(userId, excludeConvId) : db.prepare(sql).get(userId)
        if (row.n >= maxRunning) return { kind: 'running', limit: maxRunning }
      } catch { /* fail-open(见上注) */ }
    }
    if (projectId != null) { // 仅 create 查总数(messages/regenerate/edit 不新建行,不查)
      const maxPerProject = getMaxConversationsPerProjectConfig(db)
      if (maxPerProject > 0) {
        try {
          const n = db.prepare('SELECT COUNT(*) AS n FROM workbench_conversations WHERE projectId=?').get(projectId).n
          if (n >= maxPerProject) return { kind: 'project', limit: maxPerProject }
        } catch { /* fail-open */ }
      }
    }
    return null
  }

  // 超限 429:文案带当前生效上限值(前端 errorBanner 直显服务端 message,用户可自证门值)
  function sendQuota429(req, res, hit) {
    sendJson(res, 429, { message: hit.kind === 'running'
      ? msg(req, 'wbc.convRunningLimit', { limit: hit.limit })
      : msg(req, 'wbc.convProjectLimit', { limit: hit.limit }) })
  }

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

  // gap3-02(2026-09-07 审计批次三):审批集群戳门——pendingApproval 落库时盖 clusterId 戳
  // (workbench-agent paused 分支,裁决快照锚定创建时集群)。approve/deny 执行前比对当下
  // project.clusterId:不一致 → 拒绝(resume 不启动,已批工具绝不按旧裁决快照对新集群执行)。
  // 终态形状与 gap3-03 换绑协调同语义(PT5 deny-no-LLM 形状:CAS 抢占 → 审计 → failed 终态
  // + pendingApproval 消费 + bus 三连)→ 200 {status:'failed'}——对话落 failed 而非悬
  // paused(死审批无再生路径,每次重试都撞同一错误只会徒增困惑)。无戳(存量老审批)视作
  // 当前集群放行(向后兼容,同 refs 无戳惯例)。返回 true=已处置(调用方 return)。
  function approvalClusterStale(req, res, ps, conv, project) {
    let pa = null
    try { pa = conv?.pendingApproval ? JSON.parse(conv.pendingApproval) : null } catch { pa = null }
    if (!pa || typeof pa.clusterId !== 'string' || pa.clusterId === project.clusterId) return false
    const reason = msg(req, 'wbc.approvalClusterChanged')
    const cas = claimPausedForResume(req, db, conv.id)
    if (!cas.ok) { sendJson(res, cas.status, { message: cas.message }); return true }
    try {
      // 归属持久留痕(同 deny-no-LLM:审计链是 durable 权威源,先于终态翻转落账)
      writeAudit?.(db, { owner: ps.username, verb: 'deny', tool: 'wb_approval', result: 'ok', requestSummary: `conv=${conv.id} cluster-stamp=${pa.clusterId} current=${project.clusterId || '(unbound)'} approverId=${ps.userId}`, source: 'platform' })
      updateConversation(db, conv.id, { status: 'failed', pendingApproval: null, error: reason })
      busEmit(conv.id, { type: 'status', status: 'failed', error: reason })
      busEmit(conv.id, { type: 'end' })
      busDispose?.(conv.id)
    } catch (e) {
      // 回滚连 pendingApproval 一起还原(deny-no-LLM fix round 1 同款:只回滚 status 会留
      // 「paused 但无审批」死形状)。原值取自入参 conv(CAS 前读取)。
      try { db.prepare("UPDATE workbench_conversations SET status='paused', pendingApproval=? WHERE id=?").run(conv.pendingApproval ?? null, conv.id) } catch { /* 行已删等,尽力回滚 */ }
      sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.approveFailed') }); return true
    }
    sendJson(res, 200, { status: 'failed', message: reason })
    return true
  }

  // 当前轮快照(2026-08-25 闪变续修):trace = conv.trace 中「上一条消息行 createdAt 之后」的事件
  // (= 未落库的当前轮,覆盖 run+审批 resume 全程),assistant 全量形状瘦身为平铺——与消息级
  // trace 同形状。替代终态发全对话 / running 发 bus 快照(按 run 重置,resume 丢暂停前半段;
  // 该 bus 快照机制已于 cancel-races-07 退役删除,本函数即唯一快照源)
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
  // + 项目记忆段(pm 精确)+ @refs 注入(估算)。
  // context-assembly-05(2026-09-07 审计批次三)CJK 感知:逐块按 CJK/非 CJK 字数累计再
  // estTokensFromCounts 汇总(cjk≈1 token/字、其余≈1 token/4字符)——旧 chars/2 在纯中文上
  // 低估 ~2 倍,willTrim 漏报。
  // 近似说明:refs 为估算——动态拉取体积不落库,按每资源 2KB 常数近似(REF_EST_CHARS,按
  // 非 CJK 计:K8s JSON 主体);pm 为精确值(≤2000 字恒注入段,A1 口径补全 2026-08-29)。
  const REF_EST_CHARS = 2048 // 每个 @-ref 资源 JSON 注入的估算字符数(非 CJK 口径)
  function contextInfo(conv) {
    const history = buildHistory(db, conv)
    const pmRecap = getProject(db, conv.projectId)?.projectRecap || '' // 项目记忆恒注入段(精确)
    let refs = []; try { refs = JSON.parse(conv.references || '[]') } catch { refs = [] }
    let cjk = 0
    let other = Array.isArray(refs) ? refs.length * REF_EST_CHARS : 0 // @refs 估算(非 CJK 计)
    for (const piece of [conv.system, pmRecap, ...history.map(m => JSON.stringify(m))]) {
      const c = countCjkChars(piece)
      cjk += c.cjk
      other += c.other
    }
    const windowTokens = contextWindowFor(getLlmConfig().model)
    const est = estTokensFromCounts(cjk, other)
    const budgetTokens = Math.floor(windowTokens * 0.7)
    return { estTokens: est, windowTokens, budgetTokens, recapUpTo: conv.summarizedUpTo ?? 0, willTrim: est > budgetTokens }
  }

  // refs-injection-02:三入口统一归一门。失败 sendJson 400(i18n,文案带上限值)并返
  // REFS_REJECTED(调用方 `if (inputRefs === REFS_REJECTED) return true`)——400 零副作用
  // (不建行/不落消息/不触发 run)。注意返回值三态:refs 数组 / null(键缺省,合法可选载荷,
  // 与「被拒」不同——edit 缺省=沿用锚 refs)/ REFS_REJECTED(畸形被拒),勿用 falsy 判被拒。
  // 刻意 400 而非静默截断:静默丢引用会让 AI 上下文与用户所见漂移(用户以为自己 @ 了,AI 看不见)。
  const REFS_REJECTED = Symbol('refs-rejected')
  function normalizeInputRefs(req, res, references) {
    const r = normalizeReferences(references)
    if (r.ok) return r.refs
    const params = r.code === 'wbc.refsTooMany' ? { limit: REFS_MAX_ITEMS }
      : r.code === 'wbc.refsTooLarge' ? { limitKB: Math.round(REFS_MAX_BYTES / 1024) } : undefined
    sendJson(res, 400, { message: params ? msg(req, r.code, params) : msg(req, r.code) })
    return REFS_REJECTED
  }

  // gap3-01:盖戳辅助——clusterName 随 id 一并落库(展示值定格在创建时:agent 层 detached、
  // 集群名后续可能被改,ResourceCard 徽标显示「引用创建时的集群名」而非当下名)。查名失败
  // (异构 schema 夹具/集群行已删)降级为无名——比对键是 id,无名只影响徽标显示回退到 id。
  function stampForProject(refs, project, opts = {}) {
    let name = ''
    try { name = db.prepare('SELECT name FROM clusters WHERE id=?').get(project.clusterId)?.name || '' } catch { name = '' }
    return stampRefs(refs, project.clusterId, name, opts)
  }

  // principal(Phase C Task 6):{ userId, role }——逐 ref 过 refAllowed(ref-fetch.mjs 单一
  // 事实源,与 run/resume 的 fetchRefContext 同门);无权 ref 静默跳过(零注入不中断),
  // resources 对应位 push null 保下标对齐(不变式见循环内注释)。
  async function buildRefsContext(project, references, principal = null) {
    if (!Array.isArray(references) || !references.length) return { ctx: '', resources: [] }
    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(project.clusterId)
    if (!cluster) return { ctx: '', resources: [] } // 项目绑定的集群不存在 → 无 @-ref 可拉
    const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
    const blocks = []
    const resources = [] // 原始资源 body(供前端 ResourceCard),与 ctx 同源单次拉取
    for (const ref of references) {
      // gap3-01 换绑停用(编辑重发沿用锚 refs 的唯一入口):戳 ≠ 当前集群 → 不重拉(否则
      // 同名资源在新集群静默串味/缺失误报已删),注进作废块 + null 占位保下标对齐(不变式)。
      if (typeof ref.clusterId === 'string' && ref.clusterId !== project.clusterId) {
        blocks.push(`[${ref.kind}/${ref.namespace || ''}/${ref.name}]: (引用创建于集群 ${ref.clusterName || ref.clusterId},项目已换绑,已停用,请让用户重新 @)`)
        resources.push(null)
        continue
      }
      if (!refAllowed(db, principal, ref, project.clusterId)) { resources.push(null); continue } // 无授权:零注入,null 占位保对齐
      const label = `[${ref.kind}/${ref.namespace || ''}/${ref.name}]`
      // @server 引用(spec §5):原始值比较(normalizeKind 不识别 server);不入 k8s 拉取序列,
      // resources 对应位置 push null 占位——保持 fetchedResources 与 references 下标一一对应
      // 是本函数不变式(终审 Important#1:缺位会让后续 K8s ref 的 ResourceCard 张冠李戴)。
      if (ref.kind === 'server') {
        blocks.push(`${label}: (服务器引用:上下文由系统提示注入)`)
        resources.push(null)
        continue
      }
      // 防御性归一:ref.kind 正常恒为前端 canonical,与工具链同源归一以防旧数据
      const path = getApiPath(normalizeKind(ref.kind), ref.namespace || '', ref.name)
      if (!path) { blocks.push(`${label}: (不支持的 kind)`); resources.push(null); continue }
      try {
        const res = await requestKubernetes(k8sSession, path)
        // requestKubernetes 返回 {status,headers,body};资源在 body(guard:可能 undefined)
        const body = res?.body
        // 2026-08-31 审计修复①:空响应/拉取失败分支同样必须 push null 占位——
        // 终审 Important#1 只修了 @server 分支,这两个兄弟分支漏了,后续 ref 的
        // ResourceCard 会整体错位一位(fetchedResources 与 references 下标一一对应不变式)。
        if (body == null) { blocks.push(`${label}: (空响应)`); resources.push(null); continue }
        blocks.push(`${label}:\n${JSON.stringify(body, null, 2)}`)
        // 落库 refs + 前端 ResourceCard 均掩码形(脱敏 spec 2026-08-28,终审 I1):
        // 明文不出 DB;blocks 拼 ctx 保持原样(ctx 本身无消费方,system 注入走 fetchRefContext 已掩码)。
        // refs-injection-06 残余(2026-09-07 审计批次三):clampResource 64KB 上限(单点收口——
        // 本数组是响应回传/消息落库/edit 回显的共同来源,超限 resource 替换骨架+truncated 标记)。
        resources.push(clampResource(maskSecretResource(body)))
      } catch (e) {
        blocks.push(`${label}: (not found)`)
        resources.push(null) // 修复①:失败也要占位,保下标对齐
      }
    }
    // 审计#9:与 fetchRefContext 同构——header 后随抗声明段再接块(ctx 当前无消费方,保持同构防将来接线漏声明)
    return { ctx: `${REFS_CTX_HEADER}${REFS_GUARD_NOTE}${blocks.join('\n\n')}`, resources }
  }

  // 提示词可用的 SSH 清单:workbench-ai-config.sshPromptServers 单一事实源(context-assembly-06,
  // 2026-09-07 审计批次三)——admin 预览/对话创建/透明面板三面共源,所见即所发;防御式降级
  // 空清单(= 无 SSH 段,零暴露语义不变)见该函数注释。

  // 匹配工作台对话路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  // 注:原 index.mjs 各分支用 `return sendJson(...)` 早退 + 终结响应;此处等价改为
  // `sendJson(...); return true`(sendJson 已 res.end,只需告知 dispatcher 已处理)。
  async function handle(req, res, url) {
    // GET /api/workbench/ai-config — 透明面板数据源(2026-08-25 设计;当前经下方 requireAdmin
    // 收严到 admin 角色——route-auth-map 的门只是 platform 地板,内层可更严)。
    // 生效提示词/工具清单/追加指令/model。刻意不回 baseURL/apiKey(连接配置仅 admin 可见)。
    if (url.pathname === '/api/workbench/ai-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const cfg = getWorkbenchAiConfig(db)
      const disabled = new Set(cfg.disabledTools)
      const sshServers = sshPromptServers(db)
      const sshless = sshServers.length === 0
      sendJson(res, 200, {
        effectivePrompt: buildWorkbenchSystemPrompt({ ...cfg, sshServers }),
        tools: registry.workbenchTools()
          .filter(t => !(sshless && SSH_HIDDEN_TOOLS.includes(t.name)))
          .map(t => ({ name: t.name, description: t.description, requiresApproval: t.requiresApproval, enabled: !disabled.has(t.name) })),
        additionalInstructions: cfg.additionalInstructions,
        model: getLlmConfig().model,
      })
      return true
    }
    // POST /api/workbench/conversations — 创建对话 + 后台执行(detached)
    // W2 Phase D(Task 7):降门 requirePlatform——普通用户可在**自己的项目**上建对话(降门红利);
    // owner/admin 链见 assertProjectOwnership(单一事实源)。
    if (url.pathname === '/api/workbench/conversations' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        // 消息校验(2026-09-06 审计#10):旧 String(input.message) 会把 undefined 存成字面
        // "undefined";缺失/空白直接 400(旧路径落到 createConversation 抛错变 500 更糟)。
        if (typeof input.message !== 'string' || !input.message.trim()) {
          sendJson(res, 400, { message: msg(req, 'wbc.messageRequired') }); return true
        }
        // refs-injection-02:入口归一门(条数/形状/字节,refs-normalize 单源)——先于任何
        // 建行/拉取/run,400 零副作用。null = 键缺省(合法可选载荷,非畸形)。
        const inputRefs = normalizeInputRefs(req, res, input.references)
        if (inputRefs === REFS_REJECTED) return true
        const project = getProject(db, input.projectId)
        if (!project) { sendJson(res, 404, { message: msg(req, 'wbc.projectNotFound') }); return true }
        if (!assertProjectOwnership(ps, project)) { sendJson(res, 403, { message: msg(req, 'wbc.noProjectAccess') }); return true }
        // W2 Phase D(spec §6.2/§2.6):项目绑定集群时,创建者也须有集群分配 entitlement(admin 短路)
        // ——与 messages/regenerate 同门(clusterEntitled 单源),否则未分配用户可在自己项目上对
        // 未分配集群起对话(detached run 前的绕道)。未绑定集群('')不设门。
        if (!clusterEntitled(ps, project.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
        const llmClient = createLlmClient(cfg)

        // F6:并发 + 每项目总数双门(触发 run 前现读;0=不限制为逃生阀,admin 不豁免)。
        // 429 不建行不启动 run——quota-abuse 审计的原攻击面(detached run 烧 LLM key)被关死。
        const quota = quotaHit(ps.userId, { projectId: input.projectId })
        if (quota) { sendQuota429(req, res, quota); return true }

        // @-mention references:首屏给前端 fetch 一次 ResourceCard(buildRefsContext 单次拉取,去重);
        // system 只存工作台 prompt 原文(不含 refContext——每轮 chat 前由 run/resumeConversation 内部
        // refreshSystem 钩子重新 fetch,避免吃首轮旧快照)。T5 + main 去重。
        // gap3-01:拉取与落库前盖当前集群戳(clusterId=换绑比对键,clusterName=ResourceCard
        // 徽标展示值定格在创建时;server ref 不盖,未绑定项目不盖)。
        const stampedRefs = stampForProject(inputRefs, project)
        const { resources: fetchedResources } = await buildRefsContext(project, stampedRefs, { userId: ps.userId, role: ps.role })

        // system 创建时烘焙入库(2026-08-25 设计决策):admin 改配置只影响新对话;
        // conv.system 即逐对话审计证据,透明面板据此展示"本对话实际用的提示词"。
        // context-assembly-04(2026-09-07 审计批次三):hasCluster 随项目传给 builder——未绑
        // 集群时工具段与实际 offering 同源裁掉 16 个 K8s 依赖工具(与 disabledTools/SSH 维度
        // 同款过滤,不再虚列 AI 调不了的工具)。
        const sshServers = sshPromptServers(db)
        const system = buildWorkbenchSystemPrompt({ ...getWorkbenchAiConfig(db), sshServers, hasCluster: !!project.clusterId })

        // conv-lifecycle-05(2026-09-07 审计批次三):三语句写包事务(对照 DELETE 既有事务模式)
        // ——中途失败不留半状态:running 孤儿 conv 行会永久毒化并发限额(F6 计数按 status
        // 聚合),active 指针指向已消失/半建对话同样误导前端跳转。失败注入实测见测试。
        db.exec('BEGIN')
        const conv = createConversation(db, { projectId: input.projectId, system, userMessage: String(input.message), references: stampedRefs })
        // T5:新建线程成为项目当前活跃对话(前端轮询 GET project 拿此 id 跳转/高亮)。
        setActiveConversation(db, input.projectId, conv.id)
        // T4:首条 user 消息写入 workbench_messages(干净 content;@-ref 由 runConversation 的 refreshSystem 每轮刷新注入 system,不 baked 进 message)。
        // gap3-01:消息级 refs 同带戳(ResourceCard 徽标数据源;换绑后旧消息卡片可标注来源集群)。
        // contracts-09(2026-09-07 审计批次三):捕获 user 行回带 messageId——前端乐观 turn
        // 据此立即可编辑(旧响应无 id,发送后本会话内 user turn 恒 messageId:null 不可编辑)。
        const userRow = appendMessage(db, { conversationId: conv.id, role: 'user', content: String(input.message), refs: Array.isArray(stampedRefs) ? stampedRefs.map((r, i) => ({ ...r, resource: fetchedResources[i] || null })) : null })
        db.exec('COMMIT')
        wbAgent.runConversation(conv.id, llmClient, { userId: ps.userId, username: ps.username, role: ps.role }).catch(e => console.error('[wbAgent] detached run 崩溃:', e?.message || e)) // detached — 不 await;.catch 防未捕获 rejection 杀进程(k8sSession 由 runConversation 内部按 conv.projectId 重建)
        auditConv(ps, 'create', conv.id, input.projectId)
        sendJson(res, 200, { id: conv.id, status: 'running', references: fetchedResources, messageId: userRow?.id || null, context: contextInfo(getConversation(db, conv.id)) })
        return true
      } catch (e) {
        // conv-lifecycle-05:事务中途失败整体回滚(无活动事务时吞掉——错误可能来自 BEGIN 之前)
        try { db.exec('ROLLBACK') } catch { /* 无活动事务 */ }
        sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.createFailed') }); return true
      }
    }

    // POST /api/workbench/conversations/:id/messages — 续接对话(多轮核心,T4)。
    // 必须在 GET /:id 之前注册(路径更具体,先匹配)。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/messages$/) && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      try {
        const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/messages
        const input = await readBody(req)
        const conv = getConversation(db, id)
        // authz-entitlement-07(2026-09-07 审计批次三):ownership 前移——404/busy-400 排其后。
        // conv/项目缺失同 403(resolveConvProject 内建),非 owner 恒 403,不泄漏存在性/状态。
        const project = resolveConvProject(req, res, ps, conv)
        if (!project) return true
        // 消息校验(2026-09-06 审计#10):空/非字符串消息不落库不启动(空白也拒,防无问题空跑)
        if (typeof input.message !== 'string' || !input.message.trim()) {
          sendJson(res, 400, { message: msg(req, 'wbc.messageRequired') }); return true
        }
        // refs-injection-02:messages 入口同门(归一单源;authz-entitlement-07 把 ownership
        // 前移后此门不再最先——403 先于 400,拒绝仍零副作用)。
        const inputRefs = normalizeInputRefs(req, res, input.references)
        if (inputRefs === REFS_REJECTED) return true
        // P0 守卫(D):运行中/待审批拒绝续接——detached run 无互斥,并发双 run 会交错写
        // trace/检查点/messages(多标签页或直接 API 调用都能绕过前端 sending 守卫)。
        // authz-entitlement-07:状态判定在 ownership 之后(过了归属才可见状态,无状态 oracle)。
        if (conv.status === 'running' || conv.status === 'paused') {
          sendJson(res, 400, { message: msg(req, 'wbc.busyNoResume') }); return true
        }
        // Phase D(Task 7):集群分配 entitlement(续接触发 run;owner 链已在上方先行)。
        if (!clusterEntitled(ps, project.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
        // F6:并发门一道(排除自身行;不查总数——续接不新建行)。放在任何写(setActiveConversation/
        // append/置 running)之前,429 零副作用。
        const quota = quotaHit(ps.userId, { excludeConvId: id })
        if (quota) { sendQuota429(req, res, quota); return true }
        // 续接的线程持久化为活跃对话(刷新后回到该线程,而非之前持久化的线程)。
        setActiveConversation(db, conv.projectId, id)
        // 1) @-ref 资源拉取(先拉,enrich refs 存完整资源 → 刷新后 ResourceCard 不丢)
        const cleanMessage = String(input.message ?? '')
        // gap3-01:新提及 refs 盖当前集群戳(fresh——重 @ 同名 ref 即重锚定当前集群,这是
        // 「请让用户重新 @」指引的自救正路;不重锚定则换绑后旧 ref 永久停用)。
        const stampedRefs = stampForProject(inputRefs, project)
        const { resources: fetchedResources } = await buildRefsContext(project, stampedRefs, { userId: ps.userId, role: ps.role })
        // 并发双跑收口(2026-09-06 审计#1):首查 status 与此处之间隔了 await buildRefsContext
        // (K8s 往返),另一请求可先赢——node:sqlite 同步执行,「重读状态 → 落消息 → 置 running」
        // 零 await 同步块内原子,TOCTOU 关闭(前提=网关单进程不变式)。败者不落任何行。
        const nowConv = getConversation(db, id)
        if (!nowConv || nowConv.status === 'running' || nowConv.status === 'paused') {
          sendJson(res, 400, { message: msg(req, 'wbc.busyNoResume') }); return true
        }
        // 2) append user 消息:content 只存干净正文(曾把 refsCtx 烤进 content → 刷新后整段
        //    JSON 当消息显示;agent 上下文改由 references 走 system,见下)
        // conv-lifecycle-05(2026-09-07 审计批次三):append+置 running 两语句包事务——append
        // 成功而置 running 失败会留孤儿 user 行(buildHistory 拿到「问了但没答」的幽灵轮)。
        // 客户端构造挪到事务前:commit 后再失败只剩 detached run 的启动,无半状态窗口。
        // 事务不引入 await,审计#1 的零 await 同步块原子性不受影响。
        const llmClient = createLlmClient(cfg)
        db.exec('BEGIN')
        // contracts-09(2026-09-07 审计批次三):捕获 user 行回带 messageId(同 create 路径)。
        const userRow = appendMessage(db, { conversationId: id, role: 'user', content: cleanMessage, refs: Array.isArray(stampedRefs) ? stampedRefs.map((r, i) => ({ ...r, resource: fetchedResources[i] || null })) : null })
        // 4) 新 refs 并入对话级 "references"(去重 kind/namespace/name):runConversation 的
        //    refreshSystem 每轮重写 messages[0] 注入引用资源最新状态(agent.mjs T5 漂移修复),
        //    上下文与烤进 content 等价且更新鲜;新建路径(POST /conversations)本就走此机制。
        //    gap3-01:并入的是带戳形状(比对键随行);同 key 重 @ → 原地替换(重锚定当前集群,
        //    激活被停用的引用),未提及的旧条目原样保留(旧戳=换绑后由 agent 停用,不静默改锚)。
        let mergedRefs = []
        try { mergedRefs = JSON.parse(nowConv.references || '[]') } catch { mergedRefs = [] }
        if (Array.isArray(stampedRefs)) {
          const key = r => `${r.kind}/${r.namespace || ''}/${r.name}`
          const idxOf = new Map(mergedRefs.map((r, i) => [key(r), i]))
          for (const r of stampedRefs) {
            const k = key(r)
            if (idxOf.has(k)) mergedRefs[idxOf.get(k)] = r
            else { idxOf.set(k, mergedRefs.length); mergedRefs.push(r) }
          }
        }
        // 5) 标记 running + 复位上轮运行态字段(A)→ 后台跑 → 异步摘要(失败忽略)。
        //    content/reasoning/trace/steps/pendingApproval 不复位的话:上轮答案/思考残留会让
        //    启动抢救(salvageInterrupted)在本轮中断时把上轮内容补录成"新消息"(跨轮污染)。
        //    userMessage 同步更新(审计#4):done 时 appendHistory 的 user 侧记本轮真实提问,
        //    不再复读对话首问污染项目记忆(projectRecap)输入。
        //    conv-lifecycle-04:error 一并复位(regenerate 已有,对照同款)——上轮失败原因
        //    残留会让轮询端点恒回旧 error,前端错误横幅跨轮不消。
        updateConversation(db, id, { status: 'running', references: mergedRefs, content: '', reasoning: '', error: '', trace: '[]', steps: 0, pendingApproval: null, userMessage: cleanMessage })
        db.exec('COMMIT')
        wbAgent.runConversation(id, llmClient, { userId: ps.userId, username: ps.username, role: ps.role }).catch(e => console.error('[wbAgent] detached run 崩溃:', e?.message || e)) // detached — 不 await;.catch 防未捕获 rejection 杀进程
        // gap2-04(2026-09-07 审计批次三):摘要 fire-and-forget 不再静默吞错——内层 catch 已落
        // 日志,此处兜 detached reject(不吞=未捕获 rejection 杀进程;只记不阻响应)。
        maybeSummarize(db, id, llmClient).catch(e => console.error('[wb-conversations] 异步轮次摘要失败:', e?.message || e)) // 异步摘要,失败不阻塞
        maybeSummarizeProject(db, conv.projectId, llmClient).catch(e => console.error('[wb-conversations] 异步项目摘要失败:', e?.message || e)) // 项目记忆滚动摘要(spec §3.2,fire-and-forget)
        auditConv(ps, 'message', id, conv.projectId)
        sendJson(res, 200, { status: 'running', references: fetchedResources, messageId: userRow?.id || null, context: contextInfo(getConversation(db, id)) })
        return true
      } catch (e) {
        // conv-lifecycle-05:事务中途失败整体回滚(无活动事务时吞掉——错误可能来自 BEGIN 之前)
        try { db.exec('ROLLBACK') } catch { /* 无活动事务 */ }
        sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.resumeFailed') }); return true
      }
    }

    // POST /api/workbench/conversations/:id/regenerate — 重新生成最后一条回复(P1 消息操作)。
    // 截掉最后 user 消息之后的 assistant 回复 → 复位 conv 运行态字段 → runConversation
    // 以剩余消息(buildHistory)重跑,即"原问题重答",不重复计 user 轮。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/regenerate$/) && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      try {
        const id = url.pathname.split('/')[4]
        const conv = getConversation(db, id)
        // authz-entitlement-07:ownership 前移(conv/项目缺失同 403,busy-400 排其后)。
        const project = resolveConvProject(req, res, ps, conv)
        if (!project) return true
        if (conv.status === 'running' || conv.status === 'paused') { sendJson(res, 400, { message: msg(req, 'wbc.busyNoRegen') }); return true }
        // Phase D(Task 7):集群分配 entitlement(regenerate 触发 run;owner 链已在上方先行)。
        if (!clusterEntitled(ps, project.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
        // F6:并发门一道(排除自身行;不查总数)。放在 truncate 之前——429 不截消息(零副作用)。
        const quota = quotaHit(ps.userId, { excludeConvId: id })
        if (quota) { sendQuota429(req, res, quota); return true }
        // contracts-02(2026-09-07 审计):removed===0 有两形状——无 user 消息(lastUserSeq=0,
        // 无可重跑目标,维持 400)vs 失败/取消轮零 assistant 产出(user 仍是末条消息,removed
        // 恒 0;前端错误轮恒亮重试图标,旧实现一刀切 400 = 点了必被拒)。后者放行:buildHistory
        // 以剩余消息(末条 user)重跑 = 原问题重答,不重复计 user 轮,语义自洽(裁决:服务端
        // 单点放宽优于前端绕行)。lastUserSeq 两形状都有效,水位钳制照常喂。
        // conv-lifecycle-05(2026-09-07 审计批次三):截断+置 running 包事务——截断成功而置
        // running 失败会把旧回复白截(不可恢复的数据丢失)。lastUserSeq=0 早退路径 COMMIT
        // 空事务(该形状 removed 恒 0,无写入);客户端构造挪到事务前(同 messages)。
        const llmClient = createLlmClient(cfg)
        db.exec('BEGIN')
        const { lastUserSeq } = truncateAfterLastUser(db, id)
        if (!lastUserSeq) {
          db.exec('COMMIT')
          sendJson(res, 400, { message: msg(req, 'wbc.noRegenTarget') }); return true
        }
        setActiveConversation(db, conv.projectId, id)
        // 水位钳制(dev29):seq 复用 × summarizedUpTo 互踩——不钳的话原问题会被当"已进 recap"跳过,重答偏题
        updateConversation(db, id, { status: 'running', content: '', reasoning: '', error: '', trace: '[]', steps: 0, pendingApproval: null, summarizedUpTo: regenWatermark(conv.summarizedUpTo, lastUserSeq) })
        db.exec('COMMIT')
        wbAgent.runConversation(id, llmClient, { userId: ps.userId, username: ps.username, role: ps.role }).catch(e => console.error('[wbAgent] detached run 崩溃:', e?.message || e)) // detached;.catch 防未捕获 rejection 杀进程
        auditConv(ps, 'regenerate', id, conv.projectId)
        sendJson(res, 200, { status: 'running' })
        return true
      } catch (e) {
        // conv-lifecycle-05:事务中途失败整体回滚(无活动事务时吞掉——错误可能来自 BEGIN 之前)
        try { db.exec('ROLLBACK') } catch { /* 无活动事务 */ }
        sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.regenFailed') }); return true
      }
    }

    // POST /api/workbench/conversations/:id/compact — 手动压缩上下文(全量重摘要,spec §4.4)
    // 必须在 GET /:id 之前注册(路径更具体,先匹配)。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/compact$/) && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      // Phase D(Task 7):owner/admin 链(压缩是项目数据面的写操作;项目缺失 → 403)
      if (!resolveConvProject(req, res, ps, conv)) return true
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      // conv-lifecycle-07(2026-09-07 审计批次三):readBody 抛错自带 .status(413 超限/400 坏
      // JSON)——旧无 try/catch 直穿全局兜底统一 500,状态码语义丢失。包体读取保码;后续
      // compactConversation 的失败自有 {ok,status} 出参,意外异常仍走全局兜底(真 500)。
      let input
      try { input = await readBody(req) } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.compactFailed') }); return true }
      const out = await compactConversation(db, id, createLlmClient(cfg), String(input.instruction || ''))
      if (!out.ok) { sendJson(res, out.status, { message: msg(req, out.message) }); return true }
      sendJson(res, 200, { ok: true, recap: out.recap, context: contextInfo(getConversation(db, id)) })
      return true
    }

    // POST /api/workbench/conversations/:id/edit — 编辑已发消息重发(spec 2026-08-28 §3.1):
    // 截断锚消息及其后全部 → 以新内容 append(refs 缺省沿用)→ 复位运行态 → 重跑。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/edit$/) && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      // authz-entitlement-07:ownership 前移(conv/项目缺失同 403,busy-400 排其后)。
      // Phase D(Task 7):owner/admin 链(单一事实源;项目缺失 → 403)
      const project = resolveConvProject(req, res, ps, conv)
      if (!project) return true
      if (conv.status === 'running' || conv.status === 'paused') { sendJson(res, 400, { message: msg(req, 'wbc.busyNoResume') }); return true }
      // F4(authz-entitlement-02,2026-09-07 审计):edit 截断重发 = 触发 run 的面,与
      // messages/regenerate 同门(clusterEntitled 单源)——失权 owner 此前实测 200+run 启动
      //(兄弟端点 403 的绕道)。先于锚校验/截断,拒绝零副作用;未绑定集群('')不设门。
      if (!clusterEntitled(ps, project.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      try {
        const input = await readBody(req)
        const content = String(input.messageId ? input.content || '' : '')
        if (!content.trim()) { sendJson(res, 400, { message: msg(req, 'wbc.editContentRequired') }); return true }
        // refs-injection-02:edit 入口同门——客户端载荷(body.references)present 即归一校验
        // ([] 合法=清空全部 @;非数组/元素畸形/超限 → 400)。锚沿用路径的服务端数据不经此门
        // (见下:锚 refs 含 resource 载荷,落库时已过校验)。
        const inputRefs = normalizeInputRefs(req, res, input.references)
        if (inputRefs === REFS_REJECTED) return true
        const anchor = db.prepare('SELECT id, seq, refs FROM workbench_messages WHERE id=? AND conversationId=? AND role=?').get(String(input.messageId || ''), id, 'user')
        if (!anchor) { sendJson(res, 400, { message: msg(req, 'wbc.editAnchorInvalid') }); return true }
        // F6:并发门一道(排除自身行;不查总数)。放在 refs 拉取(await 窗口)之前,429 不截断不落消息。
        const quota = quotaHit(ps.userId, { excludeConvId: id })
        if (quota) { sendQuota429(req, res, quota); return true }
        // refs:body.references 替换;缺省沿用锚消息 refs(原始对象形状,appendMessage 直存)。
        // gap3-01 戳策略:客户端重发 → fresh 盖当前集群戳(用户当下重新挑的引用锚定当下集群);
        // 沿用锚 refs → preserve 保留原戳(换绑后编辑旧消息,锚 refs 语义是「当时引用的就是
        // 旧集群资源」——静默改锚成新集群戳会伪造「这是新集群的引用」,旧戳留给 agent 停用
        // 并注记;存量无戳老行在此补当前戳)。resource 载荷两路均保留。
        let refsValue = inputRefs !== null ? stampForProject(inputRefs, project) : null
        if (!refsValue && anchor.refs) {
          try { const p = JSON.parse(anchor.refs); if (Array.isArray(p)) refsValue = stampForProject(p, project, { preserve: true }) } catch { refsValue = null }
        }
        // 2026-08-31 审计修复⑧:与 create/messages 路径同款 enrich——沿用锚 refs 保留其已存的
        // resource 载荷,新 references 补拉(buildRefsContext 单次拉取);刷新后 ResourceCard 不丢。
        // gap3-01:换绑后的旧集群 ref 在 buildRefsContext 内停用(不重拉),resource 沿用锚存快照。
        const { resources: fetchedResources } = await buildRefsContext(project, refsValue, { userId: ps.userId, role: ps.role })
        // 并发双跑收口(2026-09-06 审计#1):此前 truncateFromMessage 在 await 之前就截了消息——
        // 输了竞态也会白截。截断挪到 await 之后,与重读状态/落消息/置 running 组成零 await
        // 同步块(node:sqlite 同步执行即原子;前提=网关单进程不变式)。败者零副作用。
        const nowConv = getConversation(db, id)
        if (!nowConv || nowConv.status === 'running' || nowConv.status === 'paused') {
          sendJson(res, 400, { message: msg(req, 'wbc.busyNoResume') }); return true
        }
        // conv-lifecycle-05(final-review 收尾,2026-09-08):截断→active 指针→append→置 running
        // 多语句写包事务(对照 create/messages/regenerate 兄弟路径)——截断成功而 append/update
        // 失败 = 旧消息白截 + active 指针已改 + 孤儿新 user 行的半状态(regenerate 同款危害:
        // 不可恢复的数据丢失 + 孤儿行污染 buildHistory)。客户端构造挪到事务前:commit 后再
        // 失败只剩 detached run 启动,无半状态窗口。事务不引入 await,审计#1 的零 await
        // 同步块原子性不受影响。
        const llmClient = createLlmClient(cfg)
        db.exec('BEGIN')
        const t = truncateFromMessage(db, id, anchor.id)
        // truncate 无锚早退(锚行在 await 窗口被并发截掉):该形状未写任何行,COMMIT 空事务
        // 再 400——留 BEGIN 不收会在单连接上悬挂(后续一切 BEGIN/写全炸),同 regenerate 约定。
        if (!t) {
          db.exec('COMMIT')
          sendJson(res, 400, { message: msg(req, 'wbc.editAnchorInvalid') }); return true
        }
        setActiveConversation(db, conv.projectId, id)
        // 新 refs 并入对话级 references(与 append 的 mergeRefs 同款;gap3-01:带戳形状入列,
        // 同 key 重发 → 原地替换重锚定,未提及旧条目保留旧戳不静默改锚)
        let mergedRefs = []
        try { mergedRefs = JSON.parse(nowConv.references || '[]') } catch { mergedRefs = [] }
        const key = r => `${r.kind}/${r.namespace || ''}/${r.name}`
        const idxOf = new Map(mergedRefs.map((r, i) => [key(r), i]))
        for (const r of (refsValue || [])) {
          const k = key(r)
          // 终审修复(2026-09-07 批次二):并入 conv 级只落 5 字段干净形状(与 messages 路径
          // stampedRefs 同形)——沿用锚 refs 的 refsValue 带消息级 enrich 的完整 resource K8s
          // 体,整对象入列既膨胀落库行又形状漂移(refreshSystem/buildRefsContext 只消费锚定
          // 字段;resource 只属于消息级 ResourceCard,appendMessage 那路照留)。
          const clean = { kind: r.kind, namespace: r.namespace, name: r.name }
          if (typeof r.clusterId === 'string') clean.clusterId = r.clusterId
          if (typeof r.clusterName === 'string') clean.clusterName = r.clusterName
          if (idxOf.has(k)) mergedRefs[idxOf.get(k)] = clean
          else { idxOf.set(k, mergedRefs.length); mergedRefs.push(clean) }
        }
        const appendedAnchor = appendMessage(db, {
          conversationId: id, role: 'user', content,
          refs: refsValue ? refsValue.map((r, i) => ({ ...r, resource: r.resource ?? fetchedResources[i] ?? null })) : null,
        })
        updateConversation(db, id, {
          status: 'running', references: mergedRefs, content: '', reasoning: '', trace: '[]', steps: 0, pendingApproval: null,
          // 审计#4:编辑后的提问即本轮真实问题,userMessage 同步更新(done 时项目历史记对)
          userMessage: content,
          // conv-lifecycle-04:error 复位与 messages/regenerate 同款——上轮失败原因不跨轮残留
          error: '',
          // 水位钳制(spec §3.1 修正):min(现值, fromSeq-1)——前缀连续 1..fromSeq-1,保留其摘要覆盖;
          // 编辑首条(fromSeq-1=0)归 0。原 keptMinSeq-1 因 seq 从 1 起恒为 0,会把摘要覆盖每次归零。
          summarizedUpTo: Math.min(nowConv.summarizedUpTo ?? 0, t.fromSeq - 1),
        })
        db.exec('COMMIT')
        wbAgent.runConversation(id, llmClient, { userId: ps.userId, username: ps.username, role: ps.role }).catch(e => console.error('[wbAgent] detached run 崩溃:', e?.message || e)) // detached
        auditConv(ps, 'edit', id, conv.projectId)
        // 2026-09-01 锚 id 失联修复:截断已删旧锚行,响应必须回带新 user 行 id——
        // 前端乐观 turn 据此回填,否则同视图内第二次编辑仍发被删旧 id → 「编辑目标无效」。
        // contracts-08(2026-09-07 审计批次三,PT7):references 对齐 append/create——前端乐观
        // turn 经 pairRefResources 即时出 ResourceCard(否则编辑重发后卡片降级回退 chip,须等
        // 刷新)。下标与落库 refsValue 一一对应(同 appendMessage 那路的合并式);沿用锚 refs
        // 回锚存 resource 快照(旧快照语义),新 references 回本次拉取结果,@server/失败 null
        // 占位。clampResource 防御性 no-op(两来源理论均已 clamp,双 clamp 幂等安全)。
        sendJson(res, 200, { status: 'running', anchorMessageId: appendedAnchor?.id || null, references: refsValue ? refsValue.map((r, i) => clampResource(r.resource ?? fetchedResources[i] ?? null)) : [], context: contextInfo(getConversation(db, id)) })
        return true
      } catch (e) {
        // conv-lifecycle-05:事务中途失败整体回滚(无活动事务时吞掉——错误可能来自 BEGIN 之前)
        try { db.exec('ROLLBACK') } catch { /* 无活动事务 */ }
        sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.editFailed') }); return true
      }
    }

    // GET /api/workbench/conversations/active — 悬浮入口原料:近期动态模型(running/paused 永在 +
    // 终态窗口内有动态,Top-N;窗口/条数由 presence.* 配置驱动,2026-08-17)。
    // 必须放在 GET /:id 之前:/[^/]+$/ 同样匹配 'active',放后面会被当 :id 查 → 404。
    if (url.pathname === '/api/workbench/conversations/active' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      const cfg = getPresenceConfig(db)
      // conv-lifecycle-11(2026-09-07 审计批次三):owner 过滤前移进 SQL(LIMIT 之前)——旧
      // 全局 Top-N 后才在路由按 owner 过滤,他人 10 条 running 可把非 admin 自己的
      // running/paused 整体挤出 cap(活跃入口失明)。ownerId=null(admin)不加过滤,语义不变。
      let actives = listActiveConversations(db, { windowMs: cfg.windowMs, cap: cfg.maxItems, ownerId: ps.role === 'admin' ? null : ps.userId })
      // Phase D(Task 7):owner 过滤——非 admin 只见自己项目的活跃(admin 全量);
      // 逐行 assertProjectOwnership(与单对话面同一判定源)。SQL 侧已过滤,此处保留为
      // 可见性权威判定的双保险(两口径同源:project.ownerId === ps.userId)。
      if (ps.role !== 'admin') {
        actives = actives.filter(row => {
          const p = row.projectId ? getProject(db, row.projectId) : null
          return !!p && assertProjectOwnership(ps, p)
        })
      }
      sendJson(res, 200, { conversations: actives })
      return true
    }

    // GET /api/workbench/conversations/:id — 单条对话状态(轮询用)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+$/) && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      const id = url.pathname.split('/').pop()
      const conv = getConversation(db, id)
      // authz-entitlement-07:ownership 前移——conv 缺失同 403(非 owner 恒 403,无存在性
      // oracle;404 分支随之退役,owner 的「真不存在」与「不是你的」不可分是刻意代价)。
      if (!resolveConvProject(req, res, ps, conv)) return true // Phase D:owner/admin 链
      sendJson(res, 200, {
        id: conv.id, status: conv.status, steps: conv.steps,
        content: conv.content, reasoning: conv.reasoning, error: conv.error,
        pendingApproval: conv.pendingApproval, trace: conv.trace,
        userMessage: conv.userMessage,
        recap: conv.recap, summarizedUpTo: conv.summarizedUpTo,
        projectRecap: db.prepare('SELECT projectRecap FROM workbench_projects WHERE id=?').get(conv.projectId)?.projectRecap ?? null,
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
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      if (!resolveConvProject(req, res, ps, conv)) return true // Phase D:owner/admin 链先于取消/删除
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
      auditConv(ps, 'delete', id, conv.projectId)
      sendJson(res, 200, { ok: true })
      return true
    }

    // PATCH /api/workbench/conversations/:id — 重命名对话(title 字段)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+$/) && req.method === 'PATCH') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      const id = url.pathname.split('/')[4]
      // conv-lifecycle-07(2026-09-07 审计批次三):readBody 抛错自带 .status(413/400)——旧无
      // try/catch 直穿全局兜底统一 500,状态码语义丢失。包体读取保码(与 compact 同款)。
      let input
      try { input = await readBody(req) } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.renameFailed') }); return true }
      const title = String(input.title || '').slice(0, 100).trim()
      if (!title) { sendJson(res, 400, { message: msg(req, 'wbc.titleRequired') }); return true }
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      if (!resolveConvProject(req, res, ps, conv)) return true // Phase D:owner/admin 链(改名此前无归属检查,降门后必须补)
      // 重命名是元数据编辑,不 bump updatedAt——悬浮入口以 updatedAt 判「新动态」,
      // 用户自己的改名不应让对话小点复活/跳顶。
      db.prepare('UPDATE workbench_conversations SET title=? WHERE id=?').run(title, id)
      sendJson(res, 200, { id, title })
      return true
    }

    // GET /api/workbench/conversations/:id/stream — SSE 实时事件流(T7)。
    // 推 hello | status | step | delta | approval | end 事件(spec §4.1.4)。Task 8 前端消费。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/stream$/) && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/stream
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      if (!resolveConvProject(req, res, ps, conv)) return true // Phase D:owner/admin 链先于 SSE 建连
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      })
      // cancel-races-08(2026-09-07 审计批次三;fix round 1 修确定性误切):res.write 返回
      // false = 写缓冲越过 HWM(16KB)——但 Node Writable 语义下**单次 ≥HWM 的 write 即使
      // socket 健康也恒 false**,且同帧内连续 write 之间无泄流机会(健康 socket 也会跨
      // HWM)。重连快照帧(长答全文 + trace 一次序列化)≥16KB 是长答常态,旧「write false
      // 即切」把健康重连客户端确定性切断 → EventSource 3s 重连 → 同帧再切 → 无限振荡,恰好
      // 击穿 cancel-races-05 刚修好的零滞后重连路。修正两件:
      // ① 帧按**字节**切 ≤8KB 片写出(按 UTF-16 切中文会 24KB/片,必须 Buffer 字节切;TCP
      //    本就是字节流,跨片断裂的 UTF-8 序列由客户端解码器重组);
      // ② 切断信号只取**首片** false——首片 ≤8KB,单独一次不可能把空缓冲推过 16KB HWM,
      //    它 false 必意味着帧开始前已有 ≥8KB 积压(此前帧留下的,隔了事件环轮转仍没泄掉)
      //    = 真慢消费者,断连让客户端既有重连机制接管。同帧后续片的 false 忽略:缓冲是有界
      //    的(至多多写完本帧)。小帧(keepalive / 单片 delta)首片即全帧,语义不变。
      // onBackpressure 仅 running 分支装配(paused/done 分支随函数返回即 res.end);幂等闸在
      // closeStream。
      const SSE_WRITE_SLICE = 8 * 1024
      let onBackpressure = null
      const send = (evt) => {
        try {
          const buf = Buffer.from('data: ' + JSON.stringify(evt) + '\n\n', 'utf8')
          const pressure = res.write(buf.subarray(0, SSE_WRITE_SLICE)) === false // 首片:切断判定唯一来源
          for (let i = SSE_WRITE_SLICE; i < buf.length; i += SSE_WRITE_SLICE) res.write(buf.subarray(i, i + SSE_WRITE_SLICE))
          if (pressure && onBackpressure) onBackpressure()
        } catch { /* 客户端已断 */ }
      }
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
      // 此前已 emit 的 delta/step(conv.content 只在 done 落库,不补则中段文本永久丢失)。
      // 快照读库前同步 flush 在途 run 的检查点(cancel-races-05,2026-09-07 审计批次三):
      // 检查点阈值(200 字/500ms)使 conv.content 至多滞后一段未落库文本,重连客户端要的是
      // 「全量已出文本」——flush 后零滞后;与订阅/读库同处一个同步块,无新增竞态窗口。
      // wbAgent.flushCheckpoint 可选(旧测试桩无此方法——可选链空操作)。
      //
      // closeStream 三消费方共用:keepalive 失权(conv-lifecycle-10)/ send 背压切断
      // (cancel-races-08)/ req close;幂等(closed 闸);显式摘 req close 监听(流关闭后
      // 不再留任何回调)。keepalive 用 let:closeStream 可能在 interval 装配前(首帧即背压)
      // 被调用,null 守卫替代 TDZ。
      let keepalive = null
      let closed = false
      // fix round 1(important):req close 委托 closeStream——旧 onReqClose 只 clearInterval+
      // 退订、无 closed 闸、不 end,与 closeStream 双路径并存时 removeListener/res.end 可能
      // 重复执行(靠 try/catch 兜底的隐性契约)。委托后幂等闸统一(重复 close 不重复执行),
      // 显式 res.end 让响应定终(Node 允许在自身 emit 中摘除监听器)。
      const onReqClose = () => closeStream()
      const closeStream = () => {
        if (closed) return
        closed = true
        if (keepalive) clearInterval(keepalive)
        busUnsubscribe(id, send)
        req.removeListener('close', onReqClose)
        try { res.end() } catch { /* 已断 */ }
      }
      onBackpressure = closeStream // 背压切断装配:running 分支的第一个 data 帧起生效
      busSubscribe(id, send)
      wbAgent.flushCheckpoint?.(id)
      const snap = turnSnapshot(id)   // 按轮切割(覆盖 run+审批 resume 全程的当前轮)
      if (snap && (snap.content || snap.trace.length)) {
        send({ type: 'snapshot', content: snap.content, reasoning: snap.reasoning, trace: snap.trace, steps: snap.steps })
      }
      // conv-lifecycle-10(2026-09-07 审计批次三):keepalive 拍周期重验建连鉴权(requirePlatform +
      // conv→project→owner/admin 链)——会话吊销/项目收权对**已建连**的流同样生效:关流 + 退订。
      // 刻意 NOT per-event:事件高频(delta 流),每事件一次鉴权查库不可接受;15s 拍 = 失权后
      // 最多再吃一拍窗口,与 SSE 长连模型一致。requirePlatform 失效时自会 sendJson 401/403——
      // headersSent 后生产 sendJson 只 end(2026-08-16 断流修复语义),恰等价关流;closeStream
      // 再显式 end 兜底(测试桩 sendJson 不 end)。conv 行被删(DELETE)同样经 ownership 重验
      // 走 close(conv2 缺失 → proj2 null → 恒拒)。
      // 已在快照帧被背压切断(closed=true)则不再装 keepalive/req 监听——生产里 res.end 后
      // req close 也会清掉它,此处直接不装配更干净(测试桩 req 不发 close,装配即泄漏)。
      if (!closed) {
        keepalive = setInterval(() => {
          const ps2 = requirePlatform(req, res)
          if (!ps2) return closeStream()
          const conv2 = getConversation(db, id)
          const proj2 = conv2?.projectId ? getProject(db, conv2.projectId) : null
          if (!conv2 || !proj2 || !assertProjectOwnership(ps2, proj2)) return closeStream()
          try {
            // 背压同款切断(慢消费者对 keepalive 写同样返回 false——同一信号,同一处置)
            if (res.write(': keepalive\n\n') === false) return closeStream()
          } catch { /* 客户端已断 */ }
        }, 15000)
        req.on('close', onReqClose)
      }
      return true
    }

    // GET /api/workbench/conversations?projectId=X — 列表(slim)
    if (url.pathname === '/api/workbench/conversations' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      const projectId = url.searchParams.get('projectId')
      if (!projectId) { sendJson(res, 400, { message: msg(req, 'wbc.projectIdRequired') }); return true }
      // Phase D(Task 7):项目维度查询 = 单项目面,非 owner/admin 直接 403
      // (与建对话/续接同一判定源;项目缺失同 403,不泄漏存在性)。
      const project = getProject(db, projectId)
      if (!project || !assertProjectOwnership(ps, project)) { sendJson(res, 403, { message: msg(req, 'wbc.noProjectAccess') }); return true }
      sendJson(res, 200, { conversations: listConversations(db, projectId) })
      return true
    }

    // POST /api/workbench/conversations/:id/approve — resume(detached)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/approve$/) && req.method === 'POST') {
      // W2 Phase D(CB-B Task 4):requirePlatform + 会话所属项目 owner 或 admin。
      const ps = requirePlatform(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/approve
      // W2 Phase D ownership gate(conv→project→owner/admin)
      const convForGate = getConversation(db, id)
      if (!convForGate) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      const projectForGate = getProject(db, convForGate.projectId)
      if (!projectForGate || !assertProjectOwnership(ps, projectForGate)) { sendJson(res, 403, { message: msg(req, 'wbc.noProjectAccess') }); return true }
      // F4(authz-entitlement-02,2026-09-07 审计):approve 触发 detached resume = 触发 run 的
      // 面,与 messages/regenerate/edit 同门(clusterEntitled 单源)——失权 owner 不得经审批
      // 续跑。先于 CAS(claimPausedForResume 翻 running)与 LLM 配置检查,拒绝零状态副作用。
      if (!clusterEntitled(ps, projectForGate.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
      // gap3-02:审批集群戳门(裁决快照 vs 当下绑定;不一致 → failed 终态,处置完 return)。
      if (approvalClusterStale(req, res, ps, convForGate, projectForGate)) return true
      // LLM 配置检查先于 CAS(2026-09-06 审计#2):配置缺失 400 时状态未动,对话保持 paused
      // 可配置恢复后直接重试;旧顺序 CAS 先翻 running,失败即永久卡死(只能重启网关抢救)。
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: msg(req, 'wbc.llmNotConfigured') }); return true }
      // P0(E):仅 paused 可审批。迟到审批(done/failed 后)此前会让 resume 的
      // JSON.parse(conv.pendingApproval=null) 抛错 → 把终态改写成 failed(吞掉已完成答案)。
      const cas = claimPausedForResume(req, db, id)
      if (!cas.ok) { sendJson(res, cas.status, { message: cas.message }); return true }
      // cancel-races-06(2026-09-07 审计批次三):CAS 翻 running 后的留痕/客户端构造须兜住
      // ——旧无 try/catch,stampApprover/writeAudit/createLlmClient 任一抛错直穿全局兜底:
      // 前端拿 500 的同时对话悬在 running(resume 未启动,无人再写终态,只能重启网关抢救)。
      // 失败回滚 paused 仅还原 status:pendingApproval 若已被 stampApprover 增补 approverId/
      // approvedAt 则保留(回滚不还原)——增补幂等,重试时再盖同款戳覆盖,无害;载荷本体
      // 未动,恢复后可直接重试。resumeConversation 是 async 函数(同步段抛错即未起跑),
      // catch 触发时 run 必未启动,回滚无竞态。200 响应刻意留在 try 外——sendJson 自身异常
      // 不得触发误回滚(run 已在跑)。
      try {
        // 审批归属留痕:approverId/approvedAt 并入 pendingApproval(载荷原样保留)。
        stampApprover(db, id, ps.userId)
        // 审批归属持久留痕(CB-B 控制器裁决):pendingApproval 的归属戳会在 resume 时被清,
        // 审计链才是 durable 权威源——resume 前落一条 wb_approval。
        writeAudit?.(db, { owner: ps.username, verb: 'approve', tool: 'wb_approval', result: 'ok', requestSummary: `conv=${id} approverId=${ps.userId}`, source: 'platform' })
        const llmClient = createLlmClient(cfg)
        wbAgent.resumeConversation(id, true, llmClient, { userId: ps.userId, username: ps.username, role: ps.role }).catch(e => console.error('[wbAgent] detached resume 崩溃:', e?.message || e)) // detached — 不 await;.catch 防未捕获 rejection 杀进程
      } catch (e) {
        try { db.prepare("UPDATE workbench_conversations SET status='paused' WHERE id=?").run(id) } catch { /* 行已删等,尽力回滚 */ }
        sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.approveFailed') }); return true
      }
      sendJson(res, 200, { status: 'running' })
      return true
    }

    // POST /api/workbench/conversations/:id/deny — resume(detached)。同 approve 权限与归属留痕。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/deny$/) && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/deny
      // W2 Phase D ownership gate(conv→project→owner/admin)
      const convForGate = getConversation(db, id)
      if (!convForGate) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
      const projectForGate = getProject(db, convForGate.projectId)
      if (!projectForGate || !assertProjectOwnership(ps, projectForGate)) { sendJson(res, 403, { message: msg(req, 'wbc.noProjectAccess') }); return true }
      // F4(authz-entitlement-02):deny 同 approve 门——deny 也走 resumeConversation(detached
      // 续跑 denied 队列),失权 owner 不得经任何审批面触碰 run;先于 CAS,拒绝零副作用。
      if (!clusterEntitled(ps, projectForGate.clusterId)) { sendJson(res, 403, { message: msg(req, 'wbp.clusterForbidden') }); return true }
      // gap3-02:审批集群戳门,approve/deny 对称(deny 续跑同样吃新集群上下文)。
      if (approvalClusterStale(req, res, ps, convForGate, projectForGate)) return true
      // approval-flow-02(2026-09-07 审计批次三):「拒绝」不依赖 LLM。审批决策本身(不执行
      // 该工具调用)无需模型;续跑(把拒绝回喂 LLM 出终答)才需要。旧实现配置缺失 400 拒绝
      // deny → 无 LLM 时 paused 审批死局(approve/deny 双拒,唯一出路重启网关)。裁决:配置
      // 缺失的 deny = 决策受理(CAS + 审计留痕)+ 会话终态 failed(明确文案,已流出内容保留,
      // pendingApproval 消费),不悬 paused。approve 保持 400(续跑即出终答,paused 可重试)。
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) {
        const cas = claimPausedForResume(req, db, id)
        if (!cas.ok) { sendJson(res, cas.status, { message: cas.message }); return true }
        try {
          // 归属持久留痕(同 approve:审计链是 durable 权威源;pendingApproval 随终态清,不落 stamp)
          writeAudit?.(db, { owner: ps.username, verb: 'deny', tool: 'wb_approval', result: 'ok', requestSummary: `conv=${id} approverId=${ps.userId}`, source: 'platform' })
          updateConversation(db, id, { status: 'failed', pendingApproval: null, error: msg(req, 'wbc.llmNotConfigured') })
          busEmit(id, { type: 'status', status: 'failed', error: msg(req, 'wbc.llmNotConfigured') })
          busEmit(id, { type: 'end' })
          busDispose?.(id)
        } catch (e) {
          // fix round 1(Minor):回滚必须连 pendingApproval 一起还原——本分支的 try 内
          // updateConversation 已同步清了 pendingApproval,若其后语句(busEmit 监听器抛错等)
          // 失败,只回滚 status 会留下「paused 但无审批」的死形状(前端黄条/modal 均不再弹,
          // 服务端 resume 也无 pending 可续)。原值取自 CAS 前读取的 convForGate。
          try { db.prepare("UPDATE workbench_conversations SET status='paused', pendingApproval=? WHERE id=?").run(convForGate.pendingApproval ?? null, id) } catch { /* 行已删等,尽力回滚 */ }
          sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.denyFailed') }); return true
        }
        sendJson(res, 200, { status: 'failed' })
        return true
      }
      const cas = claimPausedForResume(req, db, id)
      if (!cas.ok) { sendJson(res, cas.status, { message: cas.message }); return true }
      // cancel-races-06:同 approve——CAS 后留痕/客户端构造抛错兜住 + 回滚 paused,不悬 running。
      try {
        stampApprover(db, id, ps.userId)
        writeAudit?.(db, { owner: ps.username, verb: 'deny', tool: 'wb_approval', result: 'ok', requestSummary: `conv=${id} approverId=${ps.userId}`, source: 'platform' })
        const llmClient = createLlmClient(cfg)
        wbAgent.resumeConversation(id, false, llmClient, { userId: ps.userId, username: ps.username, role: ps.role }).catch(e => console.error('[wbAgent] detached resume 崩溃:', e?.message || e)) // detached — 不 await;.catch 防未捕获 rejection 杀进程
      } catch (e) {
        try { db.prepare("UPDATE workbench_conversations SET status='paused' WHERE id=?").run(id) } catch { /* 行已删等,尽力回滚 */ }
        sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.denyFailed') }); return true
      }
      sendJson(res, 200, { status: 'running' })
      return true
    }

    // POST /api/workbench/conversations/:id/cancel — 用户主动停止(输错内容→停止→修改重发)。
    // 后台 LLM 调用不可中断,但 agent 落库前的 cancelled 守卫会丢弃其结果。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/cancel$/) && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true // Phase D 降门
      try {
        const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/cancel
        const conv = getConversation(db, id)
        if (!conv) { sendJson(res, 404, { message: msg(req, 'wbc.convNotFound') }); return true }
        if (!resolveConvProject(req, res, ps, conv)) return true // Phase D:owner/admin 链先于取消
        const r = wbAgent.cancelConversation(id)
        if (!r.ok) { sendJson(res, 400, { message: r.message }); return true }
        auditConv(ps, 'cancel', id, conv.projectId)
        sendJson(res, 200, { status: 'cancelled' })
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || msg(req, 'wbc.cancelFailed') }); return true }
      return true
    }

    return false // 无匹配
  }

  return { handle }
}
