// refs 健壮性两件(2026-09-07 审计批次二 Task 6):
// ①refs-injection-02:references 数量/形状/字节零校验——巨数组慢耗网关+集群 API,每轮 LLM
//   前全量重拉放大。契约:create/messages/edit 三入口共用单一归一函数,条数>20 / 元素非对象
//   (或 kind/namespace/name 非 string)/ 总字节>64KB → 400 i18n message(非静默截断——静默丢
//   引用会让 AI 上下文与用户所见漂移)。
// ②gap3-01:项目换绑集群后存量 @refs 静默在新集群解析(同名串味/缺失误报已删/卡片恒显旧快照
//   零提示)。契约:refs 落库盖 clusterId 戳(创建/续接取 project.clusterId;edit 沿用锚 refs
//   保留原戳);run/resume 装配 refreshSystem 前比对戳与当下 project.clusterId,不一致 → 该 ref
//   停用(不重拉)并在注入上下文加作废注记;老行无戳视作当前集群(向后兼容)。
//   @server 引用不盖戳(平台 SSH 清单域,clusterRef 纯标签非硬关联)→ 永不作废。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import {
  createWorkbenchSchema, createProject, createConversation, getConversation, appendMessage,
} from './workbench-projects.mjs'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'
import { createWorkbenchAgent } from './workbench-agent.mjs'

// ── 路由层装置(镜像 workbench-conv-routes.test.mjs makeHarness)──
function makeHarness({ k8sCalls = null, overrides = {} } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  db.exec(`CREATE TABLE IF NOT EXISTS clusters (
    id TEXT PRIMARY KEY, name TEXT, apiServer TEXT, authMethod TEXT, authHeader TEXT,
    ca TEXT, cert TEXT, key TEXT, insecure INTEGER, version TEXT, createdBy TEXT, createdAt INTEGER)`)
  db.prepare("INSERT INTO clusters (id,name,apiServer,createdAt) VALUES ('c1','集群一','http://k8s1',?)").run(Date.now())
  db.prepare("INSERT INTO clusters (id,name,apiServer,createdAt) VALUES ('c2','集群二','http://k8s2',?)").run(Date.now())
  const pid = createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' }).id
  db.exec(`CREATE TABLE IF NOT EXISTS platform_users (id TEXT PRIMARY KEY, username TEXT, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  db.exec("ALTER TABLE clusters ADD COLUMN nsAuthMode TEXT DEFAULT 'open'")
  db.prepare("INSERT INTO platform_users (id,username,role,createdAt) VALUES ('u1','u','admin',1)").run()
  const sent = []
  const runs = []
  let body = {}
  const res = { writeHead: () => {}, end: () => {} }
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (r, status, json) => { sent.push({ status, json }) },
    readBody: async () => body,
    requireAdmin: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    requirePlatform: () => ({ userId: 'u1', username: 'u', role: 'admin' }),
    wbAgent: { runConversation: async (...a) => { runs.push(a[0]) }, resumeConversation: async () => {}, cancelConversation: () => ({ ok: true }) },
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'm' }),
    createLlmClient: () => ({ chat: async () => ({ content: '' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async (...a) => { if (k8sCalls) k8sCalls.push(a[1]); return { status: 200, headers: {}, body: { kind: 'Pod', metadata: { name: 'nginx', namespace: 'default' } } } },
    busSubscribe: () => {}, busUnsubscribe: () => {},
    ...overrides,
  })
  return {
    db, pid, sent, runs,
    setBody: b => { body = b },
    call: (method, pathname) => routes.handle({ method, on: () => {} }, res, new URL(`http://x${pathname}`)),
    rebindProject: (cid) => db.prepare('UPDATE workbench_projects SET clusterId=? WHERE id=?').run(cid, pid),
  }
}

const ref = (name = 'nginx') => ({ kind: 'pods', namespace: 'default', name })
const lastSent = h => h.sent[h.sent.length - 1]

// ═══ ① refs-injection-02:三入口统一归一门(超限/畸形 → 400,非静默截断)═══

test('① create:26 条 references → 400(条数上限 20,文案带上限值)', async () => {
  const h = makeHarness()
  h.setBody({ projectId: h.pid, message: '看下', references: Array.from({ length: 26 }, (_, i) => ref(`p${i}`)) })
  assert.ok(await h.call('POST', '/api/workbench/conversations'))
  assert.equal(lastSent(h).status, 400, '26 条 > 20 上限 → 400')
  assert.ok(lastSent(h).json.message.includes('20'), `文案须带上限值 20,收到:${lastSent(h).json.message}`)
  // 400 零副作用:不建对话行、不启动 run
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM workbench_conversations').get().c, 0)
  assert.equal(h.runs.length, 0)
})

test('① create:元素非对象 → 400;kind 非字符串 → 400', async () => {
  const h = makeHarness()
  h.setBody({ projectId: h.pid, message: '看下', references: [ref(), 'not-an-object'] })
  assert.ok(await h.call('POST', '/api/workbench/conversations'))
  assert.equal(lastSent(h).status, 400, '字符串元素 → 400 畸形')

  const h2 = makeHarness()
  h2.setBody({ projectId: h2.pid, message: '看下', references: [{ kind: 123, namespace: 'default', name: 'x' }] })
  assert.ok(await h2.call('POST', '/api/workbench/conversations'))
  assert.equal(lastSent(h2).status, 400, 'kind 非 string → 400 畸形')
})

test('① create:总字节 >64KB(单条 70KB name)→ 400', async () => {
  const h = makeHarness()
  h.setBody({ projectId: h.pid, message: '看下', references: [{ kind: 'pods', namespace: 'default', name: 'x'.repeat(70 * 1024) }] })
  assert.ok(await h.call('POST', '/api/workbench/conversations'))
  assert.equal(lastSent(h).status, 400, '70KB > 64KB 上限 → 400')
})

test('① messages 入口同门:26 条 → 400', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首轮' })
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  h.setBody({ message: '继续', references: Array.from({ length: 26 }, (_, i) => ref(`p${i}`)) })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/messages`))
  assert.equal(lastSent(h).status, 400, 'messages 入口共用归一函数')
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM workbench_messages WHERE role='user'").get().c, 0, '不落 user 消息')
})

test('① edit 入口同门:非对象元素 → 400;references 非数组(present)→ 400', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首轮' })
  const anchor = appendMessage(h.db, { conversationId: conv.id, role: 'user', content: '首轮', refs: [ref()] })
  appendMessage(h.db, { conversationId: conv.id, role: 'assistant', content: '答', trace: '[]' })
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  h.setBody({ messageId: anchor.id, content: '改', references: [ref(), null] })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(lastSent(h).status, 400, 'edit 入口 null 元素 → 400')

  const h2 = makeHarness()
  const conv2 = createConversation(h2.db, { projectId: h2.pid, system: 's', userMessage: '首轮' })
  h2.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv2.id)
  const anchor2 = appendMessage(h2.db, { conversationId: conv2.id, role: 'user', content: '首轮' })
  h2.setBody({ messageId: anchor2.id, content: '改', references: 'junk' })
  assert.ok(await h2.call('POST', `/api/workbench/conversations/${conv2.id}/edit`))
  assert.equal(lastSent(h2).status, 400, 'present 且非数组 → 400 畸形(不再静默当缺省)')
})

test('① 合法上限内(恰 20 条 / 64KB 内)照常放行——门不误伤正常载荷', async () => {
  const h = makeHarness()
  h.setBody({ projectId: h.pid, message: '看下', references: Array.from({ length: 20 }, (_, i) => ref(`p${i}`)) })
  assert.ok(await h.call('POST', '/api/workbench/conversations'))
  assert.equal(lastSent(h).status, 200, '恰 20 条放行')
  assert.equal(lastSent(h).json.references.length, 20, 'ResourceCard 载荷齐')
})

// ═══ ② gap3-01:落库盖戳 + 换绑作废 + 老/殊路径兼容 ═══

test('② create 落库盖戳:对话级 references 与消息级 refs 均带 clusterId(取 project.clusterId)', async () => {
  const h = makeHarness()
  h.setBody({ projectId: h.pid, message: '看下', references: [ref()] })
  assert.ok(await h.call('POST', '/api/workbench/conversations'))
  assert.equal(lastSent(h).status, 200)
  const conv = getConversation(h.db, h.runs[0])
  assert.equal(JSON.parse(conv.references)[0].clusterId, 'c1', '对话级 references 盖戳')
  const userMsg = h.db.prepare("SELECT refs FROM workbench_messages WHERE conversationId=? AND role='user'").get(conv.id)
  assert.equal(JSON.parse(userMsg.refs)[0].clusterId, 'c1', '消息级 refs 盖戳(ResourceCard 徽标数据源)')
})

test('② @server 引用不盖戳(平台清单域,不随项目换绑作废)', async () => {
  const h = makeHarness()
  h.setBody({ projectId: h.pid, message: '看下', references: [{ kind: 'server', namespace: '', name: '网关机' }] })
  assert.ok(await h.call('POST', '/api/workbench/conversations'))
  assert.equal(lastSent(h).status, 200)
  const conv = getConversation(h.db, h.runs[0])
  assert.equal(JSON.parse(conv.references)[0].clusterId, undefined, 'server ref 无集群戳')
})

test('② 换绑后 messages:旧 ref 戳保持 c1(不静默改锚);重 @ 同名 ref 重锚定 c2;新 ref 盖 c2', async () => {
  const h = makeHarness()
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首轮', references: [ref()] })
  h.rebindProject('c2') // 换绑
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  h.setBody({ message: '再看', references: [ref(), ref('api')] }) // 旧 ref 重 @ + 新 ref
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/messages`))
  assert.equal(lastSent(h).status, 200)
  const merged = JSON.parse(getConversation(h.db, conv.id).references)
  const nginx = merged.find(r => r.name === 'nginx')
  const api = merged.find(r => r.name === 'api')
  assert.equal(nginx.clusterId, 'c2', '换绑后重 @ 同名 ref → 重锚定当前集群(重新激活的正路)')
  assert.equal(api.clusterId, 'c2', '新提及 ref 盖当前集群戳')
  const msgs = h.db.prepare("SELECT refs FROM workbench_messages WHERE conversationId=? AND role='user' ORDER BY seq").all(conv.id)
  assert.equal(JSON.parse(msgs.at(-1).refs).find(r => r.name === 'nginx').clusterId, 'c2', '本轮消息级 refs 同步盖当前戳')
})

test('② 换绑后 edit 沿用锚 refs:保留原戳 + 不对旧 ref 重拉集群 API + 旧快照 resource 保留', async () => {
  const k8sCalls = []
  const h = makeHarness({ k8sCalls })
  // 经 create 路径落库(带 c1 戳 + resource 快照)
  h.setBody({ projectId: h.pid, message: '看下', references: [ref()] })
  assert.ok(await h.call('POST', '/api/workbench/conversations'))
  const conv = getConversation(h.db, h.runs[0])
  h.rebindProject('c2') // 换绑
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  k8sCalls.length = 0 // create 已拉过一轮;edit 段另计
  const anchor = h.db.prepare("SELECT id FROM workbench_messages WHERE conversationId=? AND role='user'").get(conv.id)
  h.setBody({ messageId: anchor.id, content: '改后的问题' }) // 不传 references → 沿用锚 refs
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(lastSent(h).status, 200)
  assert.equal(k8sCalls.length, 0, '旧集群 ref 不再对新集群发起拉取(停用,不静默重解析)')
  const newAnchor = h.db.prepare("SELECT refs FROM workbench_messages WHERE conversationId=? AND role='user' ORDER BY seq").get(conv.id)
  const stamped = JSON.parse(newAnchor.refs)[0]
  assert.equal(stamped.clusterId, 'c1', '沿用锚 refs 保留原集群戳(不被换绑静默改锚)')
  assert.equal(stamped.resource?.kind, 'Pod', '旧集群快照 resource 保留(ResourceCard 数据不丢)')
  assert.equal(JSON.parse(getConversation(h.db, conv.id).references).find(r => r.name === 'nginx').clusterId, 'c1', '对话级 references 戳不被换绑覆写')
})

// ═══ agent 层:refreshSystem 装配前比对(run/resume 双路径)+ 兼容路径 ═══
// 装置镜像 workbench-agent.test.mjs:真 :memory: db + 桩 runner 捕获 refreshSystem。

function agentSetup({ references, projectClusterId = 'c1' } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  createProject(db, { name: 'p1', clusterId: projectClusterId, ownerId: 'u1' })
  const project = db.prepare("SELECT * FROM workbench_projects WHERE name='p1'").get()
  const conv = createConversation(db, { projectId: project.id, system: 'sys', userMessage: 'hi', references })
  appendMessage(db, { conversationId: conv.id, role: 'user', content: 'hi' })
  const fetchCalls = []
  let capturedOpts = null
  const deps = {
    db,
    buildWbCtx: () => ({ ctx: {} }),
    buildK8sSession: () => ({}),
    fetchRefContext: async (refs) => { fetchCalls.push(JSON.parse(JSON.stringify(refs))); return '' },
    createAgentRunner: () => ({ run: async (opts) => { capturedOpts = opts; return { status: 'done', content: 'ok', trace: [], steps: 1, messages: [], queue: [], denied: [] } } }),
    busEmit: () => {}, busDispose: () => {},
  }
  const agent = createWorkbenchAgent(deps)
  return { db, project, conv, fetchCalls, agent, refresh: () => capturedOpts?.refreshSystem?.() }
}

test('② 换绑后 run:旧 ref 不进 fetchRefContext(不再重拉),注入含作废注记(带原集群标识)', async () => {
  const { conv, fetchCalls, agent, refresh } = agentSetup({
    references: [{ kind: 'pods', namespace: 'default', name: 'nginx', clusterId: 'c1', clusterName: '旧集群' }],
    projectClusterId: 'c2', // 项目已换绑
  })
  await agent.runConversation(conv.id, { chat: async () => ({}), model: 'm' })
  const sys = await refresh()
  assert.equal(fetchCalls.length, 1, 'refreshSystem 装配一次 fetchRefContext')
  assert.ok(!fetchCalls[0].some(r => r.name === 'nginx'), '旧集群 ref 不再重拉(active 列表不含)')
  assert.ok(sys.includes('已停用'), `注入含停用注记,收到:${sys}`)
  assert.ok(sys.includes('重新 @'), '注记指引让用户重新 @')
  assert.ok(sys.includes('旧集群') || sys.includes('c1'), '注记带原集群标识(名缺失回退 id)')
  // 稳定性:同一 run 内二次调用(round 演化)注记不膨胀——每次重建同一常量段
  const sys2 = await refresh()
  assert.equal(sys, sys2, '注记每轮恒定重建(不累积膨胀)')
})

test('② 换绑后 resume(审批续跑)同门:旧 ref 不重拉 + 注记在场', async () => {
  const { db, conv, fetchCalls, agent, refresh } = agentSetup({
    references: [{ kind: 'pods', namespace: 'default', name: 'nginx', clusterId: 'c1' }],
    projectClusterId: 'c2',
  })
  db.prepare('UPDATE workbench_conversations SET status=?, messages=?, queue=?, denied=?, pendingApproval=? WHERE id=?').run(
    'paused', '[]', '[]', '[]', JSON.stringify({ toolCallId: 't1', name: 'wb_scale', args: {} }), conv.id)
  await agent.resumeConversation(conv.id, true, { chat: async () => ({}), model: 'm' })
  const sys = await refresh()
  assert.ok(!fetchCalls[0].some(r => r.name === 'nginx'), 'resume 路径旧 ref 同样不重拉')
  assert.ok(sys.includes('已停用'), 'resume 注入同款作废注记')
})

test('③ 老行无戳:视作当前集群照常重拉,无作废注记(向后兼容,存量对话不回归)', async () => {
  const { conv, fetchCalls, agent, refresh } = agentSetup({
    references: [{ kind: 'pods', namespace: 'default', name: 'nginx' }], // 无 clusterId(存量行)
  })
  await agent.runConversation(conv.id, { chat: async () => ({}), model: 'm' })
  const sys = await refresh()
  assert.ok(fetchCalls[0].some(r => r.name === 'nginx'), '无戳 ref 照常进拉取序列')
  assert.ok(!sys.includes('已停用'), '无戳不注入作废注记')
})

test('③ 混合列表:旧集群 ref 停用、当前集群 ref 与 @server ref 照常拉取(三者并存各得其所)', async () => {
  const { conv, fetchCalls, agent, refresh } = agentSetup({
    references: [
      { kind: 'pods', namespace: 'default', name: 'stale-pod', clusterId: 'cX' },
      { kind: 'pods', namespace: 'default', name: 'fresh-pod', clusterId: 'c1' },
      { kind: 'server', namespace: '', name: '网关机' }, // 无戳(server 不参与)
    ],
  })
  await agent.runConversation(conv.id, { chat: async () => ({}), model: 'm' })
  const sys = await refresh()
  const names = fetchCalls[0].map(r => r.name)
  assert.ok(!names.includes('stale-pod'), '旧集群 ref 停用')
  assert.ok(names.includes('fresh-pod'), '当前集群 ref 照常拉取')
  assert.ok(names.includes('网关机'), '@server ref 不随换绑作废(无戳=平台域)')
  assert.ok(sys.includes('stale-pod') && sys.includes('已停用'), '仅旧 ref 进作废注记')
})

// ═══ ④ refs-injection-06 残余(2026-09-07 审计批次三 Task 7):消息级 resource 无大小上限 ═══
// @refs enrich 的 resource(全量 K8s 对象)落库进 message.refs 且随响应回传——1MB ConfigMap
// 原样入库:行膨胀 + GET /:id(messages 含 refs)与轮询/重连快照线性放大 + 前端回放全量。
// 契约:clampResource 单源(refs-normalize)64KB 上限——超限替换为「骨架+标记」形状
// (kind/metadata 保留,ResourceCard 头部照常渲染;truncated:true + truncatedBytes 原始
// 字节数 + 2KB JSON 前缀预览),≤上限原样返回;幂等(已 clamp 形状再 clamp 不变)。
// 拉取单点收口:buildRefsContext 的 resources.push(响应回传/消息落库/edit 回显同源)。
import { clampResource, RESOURCE_MAX_BYTES } from './refs-normalize.mjs'

test('④ clampResource 单元:≤64KB 原样返回;1MB → 骨架+标记 ≤64KB;幂等', () => {
  const small = { kind: 'Pod', metadata: { name: 'p1', namespace: 'default' }, spec: {} }
  assert.equal(clampResource(small), small, '小资源原引用返回(零拷贝,不扰动)')

  const bigCm = { kind: 'ConfigMap', metadata: { name: 'big-cm', namespace: 'default' }, data: { big: 'x'.repeat(1024 * 1024) } }
  const clamped = clampResource(bigCm)
  assert.notEqual(clamped, bigCm)
  assert.equal(clamped.truncated, true, '截断标记(ResourceCard 提示数据源)')
  assert.equal(clamped.kind, 'ConfigMap', 'kind 保留')
  assert.equal(clamped.metadata.name, 'big-cm', 'metadata.name/namespace 保留(卡片头部照常渲染)')
  assert.ok(clamped.truncatedBytes > 1024 * 1024, '原始字节数入标记')
  assert.ok(Buffer.byteLength(JSON.stringify(clamped), 'utf8') < RESOURCE_MAX_BYTES, 'clamp 后形状 < 64KB')
  assert.ok(typeof clamped.preview === 'string' && clamped.preview.length > 0, '带 JSON 前缀预览')

  // 幂等:已 clamp 形状(≤64KB)再过 clamp 不变(双 clamp/重放安全)
  assert.equal(clampResource(clamped), clamped)
  // null/非对象透传(占位 null 不被加工)
  assert.equal(clampResource(null), null)
})

test('④ 1MB ConfigMap 经 create 落库/回传 clamp 64KB:响应与 message.refs 均截断+标记', async () => {
  const bigCm = { kind: 'ConfigMap', metadata: { name: 'big-cm', namespace: 'default' }, data: { big: 'y'.repeat(1024 * 1024) } }
  const h = makeHarness({ overrides: { requestKubernetes: async () => ({ status: 200, headers: {}, body: bigCm }) } })
  h.setBody({ projectId: h.pid, message: '看下配置', references: [{ kind: 'configmaps', namespace: 'default', name: 'big-cm' }] })
  assert.ok(await h.call('POST', '/api/workbench/conversations'))
  assert.equal(lastSent(h).status, 200)
  // 回传:截断标记 + 骨架(kind/name 保留)
  const echoed = lastSent(h).json.references[0]
  assert.equal(echoed.truncated, true, '响应 references[0] 为截断形状')
  assert.equal(echoed.kind, 'ConfigMap')
  assert.ok(Buffer.byteLength(JSON.stringify(echoed), 'utf8') < 64 * 1024, '回传载荷 < 64KB')
  // 落库:message.refs 的 resource 同款截断(1MB 不入 SQLite 行)
  const conv = getConversation(h.db, h.runs[0])
  const userMsg = h.db.prepare("SELECT refs FROM workbench_messages WHERE conversationId=? AND role='user'").get(conv.id)
  const stored = JSON.parse(userMsg.refs)[0].resource
  assert.equal(stored.truncated, true, '落库 resource 截断标记')
  assert.ok(Buffer.byteLength(JSON.stringify(stored), 'utf8') < 64 * 1024, '落库 resource < 64KB(1MB ConfigMap 不原样入库)')
  assert.equal(stored.metadata.name, 'big-cm', '骨架 metadata 保留(ResourceCard 头部可渲染)')
})

// ═══ ⑤ contracts-08(2026-09-07 审计批次三,PT7):edit 响应回传 references ═══
// append/create 响应均回传 references(前端乐观 turn 经 pairRefResources 即时出 ResourceCard),
// edit 响应独缺——编辑重发后 ResourceCard 降级为回退 chip,须等刷新重建才恢复卡片。契约:
// edit 响应对齐带 references,下标与落库 refsValue 一一对应;沿用锚 refs 路径回锚存的
// resource 快照(旧快照语义,不重拉替换),新 references 路径回本次拉取结果,@server/null
// 占位保对齐。
test('⑤ edit 响应回传 references:锚沿用路径回锚存 resource 快照;新 references 回拉取结果;null 保下标对齐', async () => {
  const h = makeHarness()
  // 造一个 done 对话 + 带锚 refs 的 user 消息(resource=旧快照,与 mock 拉取的 nginx 区分)
  const conv = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首问' })
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv.id)
  const anchor = appendMessage(h.db, {
    conversationId: conv.id, role: 'user', content: '原问题',
    refs: [{ kind: 'pods', namespace: 'default', name: 'nginx', clusterId: 'c1', clusterName: '集群一', resource: { kind: 'Pod', metadata: { name: 'nginx-stale-snapshot' } } }],
  })
  // 路径 A:缺省 references → 沿用锚 refs → 响应 references[0] = 锚存 resource(非重拉的 nginx)
  h.setBody({ messageId: anchor.id, content: '改后的问题' })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv.id}/edit`))
  assert.equal(lastSent(h).status, 200)
  assert.ok(Array.isArray(lastSent(h).json.references), 'edit 响应带 references(与 append/create 对齐)')
  assert.equal(lastSent(h).json.references[0].metadata.name, 'nginx-stale-snapshot', '锚沿用路径回锚存快照(旧快照语义)')
  // 落库的新 user 行 refs 同步带 resource(既有行为,回归锚)
  const newRow = h.db.prepare('SELECT refs FROM workbench_messages WHERE id=?').get(lastSent(h).json.anchorMessageId)
  assert.equal(JSON.parse(newRow.refs)[0].resource.metadata.name, 'nginx-stale-snapshot')

  // 路径 B:显式新 references(pods + @server)→ 回本次拉取结果 + null 占位对齐
  const conv2 = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首问2' })
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv2.id)
  const anchor2 = appendMessage(h.db, { conversationId: conv2.id, role: 'user', content: '原问题2' })
  h.setBody({ messageId: anchor2.id, content: '改后的问题2', references: [ref(), { kind: 'server', namespace: '', name: '网关机' }] })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv2.id}/edit`))
  assert.equal(lastSent(h).status, 200)
  assert.equal(lastSent(h).json.references[0].metadata.name, 'nginx', '新 references 回本次拉取结果(mock k8s body)')
  assert.equal(lastSent(h).json.references[1], null, '@server 占位 null 保下标对齐')
  // 空数组合法(删光全部 @):references 恒传 [] → 响应回 []
  const conv3 = createConversation(h.db, { projectId: h.pid, system: 's', userMessage: '首问3' })
  h.db.prepare("UPDATE workbench_conversations SET status='done' WHERE id=?").run(conv3.id)
  const anchor3 = appendMessage(h.db, { conversationId: conv3.id, role: 'user', content: '原问题3' })
  h.setBody({ messageId: anchor3.id, content: '改后的问题3', references: [] })
  assert.ok(await h.call('POST', `/api/workbench/conversations/${conv3.id}/edit`))
  assert.equal(lastSent(h).status, 200)
  assert.deepEqual(lastSent(h).json.references, [], '空数组 → 空数组(删光全部 @)')
})
