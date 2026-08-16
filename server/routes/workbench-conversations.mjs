// SP3: 工作台对话 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// 7 端点 + buildRefsContext 辅助逐字搬迁,仅依赖引用改走 deps 注入。
// SP2 已抽出 agent loop → workbench-agent.mjs(wbAgent.runConversation / resumeConversation)。
import { WORKBENCH_SYSTEM_PROMPT } from '../workbench-prompt.mjs'
import {
  getProject, getConversation, updateConversation, listConversations,
  createConversation, appendMessage, getMaxSeq, setActiveConversation, listMessages,
} from '../workbench-projects.mjs'
import { maybeSummarize } from '../workbench-summarize.mjs'

// @-ref 资源拉取(T4 抽出,POST /conversations 与 POST /:id/messages 复用):
// 取 project → k8s session → 逐 ref requestKubernetes .body → 拼 "Referenced resources" context 块。
// 无 references / 无绑定集群 → 返回 ''(调用方据此决定是否 prepend)。
import { KIND_API_PATH } from '../kind-paths.mjs'

export function createWorkbenchConvRoutes(deps) {
  const {
    db, sendJson, readBody, requireAdmin, wbAgent,
    getLlmConfig, createLlmClient, buildCallContext, requestKubernetes,
    busSubscribe, busUnsubscribe, busSnapshot,
  } = deps

  async function buildRefsContext(project, references) {
    if (!Array.isArray(references) || !references.length) return { ctx: '', resources: [] }
    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(project.clusterId)
    if (!cluster) return { ctx: '', resources: [] } // 项目绑定的集群不存在 → 无 @-ref 可拉
    const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
    const blocks = []
    const resources = [] // 原始资源 body(供前端 ResourceCard),与 ctx 同源单次拉取
    for (const ref of references) {
      const pathFn = KIND_API_PATH[ref.kind]
      const label = `[${ref.kind}/${ref.namespace || ''}/${ref.name}]`
      if (!pathFn) { blocks.push(`${label}: (不支持的 kind)`); continue }
      try {
        const res = await requestKubernetes(k8sSession, pathFn(ref.namespace || '', ref.name))
        // requestKubernetes 返回 {status,headers,body};资源在 body(guard:可能 undefined)
        const body = res?.body
        if (body == null) { blocks.push(`${label}: (空响应)`); continue }
        blocks.push(`${label}:\n${JSON.stringify(body, null, 2)}`)
        resources.push(body)
      } catch (e) {
        blocks.push(`${label}: (not found)`)
      }
    }
    return { ctx: `Referenced resources (当前状态,供你参考):\n${blocks.join('\n\n')}`, resources }
  }

  // 匹配工作台对话路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  // 注:原 index.mjs 各分支用 `return sendJson(...)` 早退 + 终结响应;此处等价改为
  // `sendJson(...); return true`(sendJson 已 res.end,只需告知 dispatcher 已处理)。
  async function handle(req, res, url) {
    // POST /api/workbench/conversations — 创建对话 + 后台执行(detached)
    if (url.pathname === '/api/workbench/conversations' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const project = getProject(db, input.projectId)
        if (!project) { sendJson(res, 404, { message: '项目不存在' }); return true }
        if (project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: '无权访问该项目' }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: 'LLM 未配置' }); return true }
        const llmClient = createLlmClient({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })

        // @-mention references:首屏给前端 fetch 一次 ResourceCard(buildRefsContext 单次拉取,去重);
        // system 只存工作台 prompt 原文(不含 refContext——每轮 chat 前由 run/resumeConversation 内部
        // refreshSystem 钩子重新 fetch,避免吃首轮旧快照)。T5 + main 去重。
        const { resources: fetchedResources } = await buildRefsContext(project, input.references)

        const system = WORKBENCH_SYSTEM_PROMPT

        const conv = createConversation(db, { projectId: input.projectId, system, userMessage: String(input.message), references: input.references })
        // T5:新建线程成为项目当前活跃对话(前端轮询 GET project 拿此 id 跳转/高亮)。
        setActiveConversation(db, input.projectId, conv.id)
        // T4:首条 user 消息写入 workbench_messages(干净 content;@-ref 由 runConversation 的 refreshSystem 每轮刷新注入 system,不 baked 进 message)。
        appendMessage(db, { conversationId: conv.id, role: 'user', content: String(input.message), refs: Array.isArray(input.references) ? input.references.map((r, i) => ({ ...r, resource: fetchedResources[i] || null })) : null })
        wbAgent.runConversation(conv.id, llmClient, { userId: ps.userId, username: ps.username }) // detached — 不 await(k8sSession 由 runConversation 内部按 conv.projectId 重建)
        sendJson(res, 200, { id: conv.id, status: 'running', references: fetchedResources })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || '创建对话失败' }); return true }
    }

    // POST /api/workbench/conversations/:id/messages — 续接对话(多轮核心,T4)。
    // 必须在 GET /:id 之前注册(路径更具体,先匹配)。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/messages$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/messages
        const input = await readBody(req)
        const conv = getConversation(db, id)
        if (!conv) { sendJson(res, 404, { message: '对话不存在' }); return true }
        const project = getProject(db, conv.projectId)
        if (!project) { sendJson(res, 404, { message: '项目不存在' }); return true }
        if (project.ownerId !== ps.userId && ps.role !== 'admin') { sendJson(res, 403, { message: '无权访问' }); return true }
        const cfg = getLlmConfig()
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: 'LLM 未配置' }); return true }
        // 续接的线程持久化为活跃对话(刷新后回到该线程,而非之前持久化的线程)。
        setActiveConversation(db, conv.projectId, id)
        // 1) @-ref 资源拉取(先拉,enrich refs 存完整资源 → 刷新后 ResourceCard 不丢)
        const cleanMessage = String(input.message ?? '')
        const { ctx: refsCtx, resources: fetchedResources } = await buildRefsContext(project, input.references)
        // 2) append user 消息(enriched refs + refsCtx 拼进 content 供 agent buildHistory 读;合并原两步 append+UPDATE)
        appendMessage(db, { conversationId: id, role: 'user', content: refsCtx ? `${refsCtx}\n\n${cleanMessage}` : cleanMessage, refs: Array.isArray(input.references) ? input.references.map((r, i) => ({ ...r, resource: fetchedResources[i] || null })) : null })
        // 3) 标记 running → 后台跑 → 异步摘要(失败忽略)
        updateConversation(db, id, { status: 'running' })
        const llmClient = createLlmClient({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })
        wbAgent.runConversation(id, llmClient, { userId: ps.userId, username: ps.username }) // detached — 不 await
        maybeSummarize(db, id, llmClient).catch(() => {}) // 异步摘要,失败静默
        sendJson(res, 200, { status: 'running', references: fetchedResources })
        return true
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || '续接失败' }); return true }
    }

    // GET /api/workbench/conversations/:id — 单条对话状态(轮询用)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+$/) && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/').pop()
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: '对话不存在' }); return true }
      sendJson(res, 200, {
        id: conv.id, status: conv.status, steps: conv.steps,
        content: conv.content, error: conv.error,
        pendingApproval: conv.pendingApproval, trace: conv.trace,
        userMessage: conv.userMessage,
        recap: conv.recap, summarizedUpTo: conv.summarizedUpTo,
        messages: listMessages(db, id),
      })
      return true
    }

    // DELETE /api/workbench/conversations/:id — 删除对话(+ 关联 messages;清 activeConversationId 若匹配)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+$/) && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: '对话不存在' }); return true }
      if (conv.projectId) {
        const proj = getProject(db, conv.projectId)
        if (proj?.activeConversationId === id) setActiveConversation(db, conv.projectId, null)
      }
      db.prepare('DELETE FROM workbench_messages WHERE conversationId=?').run(id)
      db.prepare('DELETE FROM workbench_conversations WHERE id=?').run(id)
      sendJson(res, 200, { ok: true })
      return true
    }

    // PATCH /api/workbench/conversations/:id — 重命名对话(title 字段)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+$/) && req.method === 'PATCH') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const input = await readBody(req)
      const title = String(input.title || '').slice(0, 100).trim()
      if (!title) { sendJson(res, 400, { message: 'title 不能为空' }); return true }
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: '对话不存在' }); return true }
      db.prepare('UPDATE workbench_conversations SET title=?, updatedAt=? WHERE id=?').run(title, Date.now(), id)
      sendJson(res, 200, { id, title })
      return true
    }

    // GET /api/workbench/conversations/:id/stream — SSE 实时事件流(T7)。
    // 推 hello | status | step | delta | approval | end 事件(spec §4.1.4)。Task 8 前端消费。
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/stream$/) && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/stream
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: '对话不存在' }); return true }
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
        send({ type: 'status', status: conv.status, ...(conv.error ? { error: conv.error } : {}) })
        send({ type: 'end' })
        res.end()
        return true
      }
      // running:先订阅再补发快照(同步执行无竞态)——断线重连/晚连的客户端一键吃齐
      // 此前已 emit 的 delta/step(conv.content 只在 done 落库,不补则中段文本永久丢失)
      busSubscribe(id, send)
      const snap = busSnapshot(id)
      if (snap && (snap.content || (snap.trace && snap.trace.length))) {
        send({ type: 'snapshot', content: snap.content || '', trace: snap.trace || [], steps: snap.steps || 0 })
      }
      const keepalive = setInterval(() => { try { res.write(': keepalive\n\n') } catch {} }, 15000)
      req.on('close', () => { clearInterval(keepalive); busUnsubscribe(id, send) })
      return true
    }

    // GET /api/workbench/conversations?projectId=X — 列表(slim)
    if (url.pathname === '/api/workbench/conversations' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const projectId = url.searchParams.get('projectId')
      if (!projectId) { sendJson(res, 400, { message: '缺 projectId' }); return true }
      sendJson(res, 200, { conversations: listConversations(db, projectId) })
      return true
    }

    // POST /api/workbench/conversations/:id/approve — resume(detached)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/approve$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/approve
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: '对话不存在' }); return true }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: 'LLM 未配置' }); return true }
      const llmClient = createLlmClient({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })
      wbAgent.resumeConversation(id, true, llmClient, { userId: ps.userId, username: ps.username }) // detached — 不 await
      sendJson(res, 200, { status: 'running' })
      return true
    }

    // POST /api/workbench/conversations/:id/deny — resume(detached)
    if (url.pathname.match(/^\/api\/workbench\/conversations\/[^/]+\/deny$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4] // /api/workbench/conversations/<id>/deny
      const conv = getConversation(db, id)
      if (!conv) { sendJson(res, 404, { message: '对话不存在' }); return true }
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) { sendJson(res, 400, { message: 'LLM 未配置' }); return true }
      const llmClient = createLlmClient({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })
      wbAgent.resumeConversation(id, false, llmClient, { userId: ps.userId, username: ps.username }) // detached — 不 await
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
      } catch (e) { sendJson(res, e.status || 500, { message: e?.message || '取消失败' }); return true }
      return true
    }

    return false // 无匹配
  }

  return { handle }
}
