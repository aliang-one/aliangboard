// W2 Phase D(Task 7):对话 15 端点降门 requireAdmin → requirePlatform + owner 链。
// 降门红利:普通用户(role='user')在工作台完整可用(建对话/续接/审批/取消…),但一切
// 单对话面都必须过「对话 → 项目 → owner/admin」链;触发 run 的面(建对话消息/regenerate)
// 另有集群分配 entitlement(canAccessCluster 单一事实源:admin 短路,其余须 user_clusters 行)。
// /ai-config 维持 admin。结构仿 wbc-ownership.test.mjs(deps 注入桩,真 handler)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'
import {
  createWorkbenchSchema, createProject, createConversation,
  getConversation, appendMessage, updateConversation,
} from './workbench-projects.mjs'

// ps 桩:模拟真 requirePlatform(登录即过)/ requireAdmin(非 admin 403)的发送行为。
function makeHarness({ userId = 'u1', role = 'user', assignedCluster = true } = {}) {
  const sent = []
  const resumeCalls = []
  const runCalls = []
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, apiServer TEXT, authMethod TEXT, authHeader TEXT, ca TEXT, cert TEXT, key TEXT, insecure INTEGER, version TEXT, createdBy TEXT, createdAt INTEGER, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT, role TEXT DEFAULT 'user', disabled INTEGER DEFAULT 0, createdAt INTEGER)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, PRIMARY KEY(userId, clusterId))`)
  db.prepare("INSERT INTO clusters (id,name,apiServer,createdAt) VALUES ('c1','c1','http://k8s',1)").run()
  db.prepare("INSERT INTO platform_users (id,username,role,createdAt) VALUES ('u1','u1','user',1)").run()
  db.prepare("INSERT INTO platform_users (id,username,role,createdAt) VALUES ('u2','u2','user',1)").run()
  db.prepare("INSERT INTO platform_users (id,username,role,createdAt) VALUES ('adm','adm','admin',1)").run()
  if (assignedCluster) db.prepare("INSERT INTO user_clusters VALUES ('u1','c1')").run()
  const pid = createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' }).id
  // 他人项目(u2 所有;active/entitlement 对照面)
  const pid2 = createProject(db, { name: 'p2', clusterId: 'c1', ownerId: 'u2' }).id

  const ps = { userId, role, username: userId }
  const requirePlatform = (req, res) => ps // 登录即过(真语义)
  const requireAdmin = (req, res) => {
    if (role !== 'admin') { sent.push({ status: 403, json: { message: 'admin required' } }); return null }
    return ps
  }

  const c = {} // key → 真实对话 id(createConversation 自生成 UUID)
  const mkConv = (key, status, extra = {}) => {
    const conv = createConversation(db, { projectId: pid, system: 'SYS', userMessage: 'q', ...extra })
    updateConversation(db, conv.id, { status })
    c[key] = conv.id
    return conv.id
  }
  mkConv('paused', 'paused', { pendingApproval: JSON.stringify({ toolCallId: 'tc1', name: 'wb_exec', args: {} }) })
  mkConv('done', 'done')
  appendMessage(db, { conversationId: c.done, role: 'user', content: 'm1' })
  appendMessage(db, { conversationId: c.done, role: 'assistant', content: 'a1' })
  appendMessage(db, { conversationId: c.done, role: 'user', content: 'm2' })
  appendMessage(db, { conversationId: c.done, role: 'assistant', content: 'a2' })
  appendMessage(db, { conversationId: c.done, role: 'user', content: 'm3' })
  appendMessage(db, { conversationId: c.done, role: 'assistant', content: 'a3' }) // regenerate 需要「最后 user 之后有 assistant」(removed>0)
  mkConv('run', 'running')

  const res = { writeHead: () => {}, end: () => {}, write: () => {} }
  const routes = createWorkbenchConvRoutes({
    db,
    sendJson: (r, status, json) => sent.push({ status, json }),
    readBody: async () => globalThis.__downshiftBody || {},
    requirePlatform,
    requireAdmin,
    wbAgent: {
      runConversation: async (id, llm, actor) => runCalls.push({ id, actor }),
      resumeConversation: async (id, approved, llm, actor) => resumeCalls.push({ id, approved, actor }),
      cancelConversation: (id) => ({ ok: true }),
    },
    writeAudit: () => {},
    getLlmConfig: () => ({ baseURL: 'http://llm', apiKey: 'k', model: 'm' }),
    createLlmClient: () => ({ chat: async () => ({ content: '压缩摘要 ok' }) }),
    buildCallContext: () => ({}),
    requestKubernetes: async () => ({ status: 200, headers: {}, body: { kind: 'Pod', metadata: { name: 'nginx', namespace: 'default' } } }),
    busSubscribe: () => {}, busUnsubscribe: () => {}, busSnapshot: () => null, busDispose: () => {},
  })
  const call = async (method, pathname, body) => {
    globalThis.__downshiftBody = body || {}
    try { await routes.handle({ method, on: () => {} }, res, new URL(`http://x${pathname}`)) } finally { globalThis.__downshiftBody = {} }
    return sent[sent.length - 1]
  }
  return { db, sent, runCalls, resumeCalls, pid, pid2, c, call, last: () => sent[sent.length - 1] }
}

test('u2(非 owner 非 admin)对 u1 对话:11 个单对话端点全 403', async () => {
  const h = makeHarness({ userId: 'u2', role: 'user' })
  const cases = [
    ['GET', `/api/workbench/conversations/${h.c.done}`],
    ['GET', `/api/workbench/conversations/${h.c.done}/stream`],
    ['DELETE', `/api/workbench/conversations/${h.c.done}`],
    ['PATCH', `/api/workbench/conversations/${h.c.done}`],
    ['POST', `/api/workbench/conversations/${h.c.paused}/approve`],
    ['POST', `/api/workbench/conversations/${h.c.paused}/deny`],
    ['POST', `/api/workbench/conversations/${h.c.run}/cancel`],
    ['POST', `/api/workbench/conversations/${h.c.done}/messages`],
    ['POST', `/api/workbench/conversations/${h.c.done}/regenerate`],
    ['POST', `/api/workbench/conversations/${h.c.done}/compact`],
    ['POST', `/api/workbench/conversations/${h.c.done}/edit`],
  ]
  for (const [m, p] of cases) {
    const r = await h.call(m, p, m === 'PATCH' ? { title: 'x' } : { message: 'hi', content: 'hi', messageId: 'nope' })
    assert.equal(r.status, 403, `${m} ${p} → 期望 403,实得 ${r.status}`)
  }
  // 写面状态未被推进
  assert.equal(h.db.prepare(`SELECT status FROM workbench_conversations WHERE id='${h.c.run}'`).get().status, 'running')
  assert.equal(h.resumeCalls.length, 0)
  assert.equal(h.runCalls.length, 0)
})

test('owner u1 全端点 200(降门后普通用户完整可用)', async () => {
  const h = makeHarness({ userId: 'u1', role: 'user' })
  const ok = async (m, p, body) => {
    const r = await h.call(m, p, body)
    assert.equal(r.status, 200, `${m} ${p} → 期望 200,实得 ${r.status} ${JSON.stringify(r.json)}`)
    return r
  }
  await ok('GET', `/api/workbench/conversations/${h.c.done}`)
  await ok('GET', `/api/workbench/conversations/${h.c.done}/stream`)
  await ok('PATCH', `/api/workbench/conversations/${h.c.done}`, { title: '改名' })
  await ok('POST', `/api/workbench/conversations/${h.c.done}/compact`)
  await ok('POST', `/api/workbench/conversations/${h.c.done}/regenerate`) // 置 running
  h.db.prepare(`UPDATE workbench_conversations SET status='done' WHERE id=?`).run(h.c.done) // 复位,续接须非运行态
  await ok('POST', `/api/workbench/conversations/${h.c.done}/messages`, { message: '续接' })
  await ok('POST', `/api/workbench/conversations/${h.c.run}/cancel`)
  await ok('POST', `/api/workbench/conversations/${h.c.paused}/approve`) // resume 触发,actor 全字段线程(工具执行面授权门依赖)
  assert.equal(h.resumeCalls.length, 1)
  assert.deepEqual(h.resumeCalls[0].actor, { userId: 'u1', username: 'u1', role: 'user' })
  await ok('DELETE', `/api/workbench/conversations/${h.c.done}`) // DELETE 放最后(真删)
})

test('admin 全端点 200(跨 owner 直通)', async () => {
  const h = makeHarness({ userId: 'adm', role: 'admin', assignedCluster: false })
  for (const [m, p] of [
    ['GET', `/api/workbench/conversations/${h.c.done}`],
    ['GET', `/api/workbench/conversations/${h.c.done}/stream`],
    ['PATCH', `/api/workbench/conversations/${h.c.done}`],
    ['POST', `/api/workbench/conversations/${h.c.paused}/approve`],
    ['POST', `/api/workbench/conversations/${h.c.run}/cancel`],
    ['POST', `/api/workbench/conversations/${h.c.done}/regenerate`], // 先 regenerate(done 态),messages 置 running 后 DELETE 走取消流
    ['POST', `/api/workbench/conversations/${h.c.done}/messages`],
    ['DELETE', `/api/workbench/conversations/${h.c.done}`], // DELETE 放最后(真删)
  ]) {
    if (m === 'POST' && p.endsWith('/messages')) h.db.prepare(`UPDATE workbench_conversations SET status='done' WHERE id=?`).run(h.c.done) // regenerate 已置 running,复位以过 P0(D) busy 守卫
    const r = await h.call(m, p, { message: 'hi', title: 't' })
    assert.equal(r.status, 200, `${m} ${p} → 期望 200,实得 ${r.status} ${JSON.stringify(r.json)}`)
  }
})

test('降门红利:普通用户在「自己的项目」上可建对话并触发 run(actor 线程);他人项目 403', async () => {
  const h = makeHarness({ userId: 'u1', role: 'user' })
  const r = await h.call('POST', '/api/workbench/conversations', { projectId: h.pid, message: '第一问' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(h.runCalls.length, 1)
  assert.deepEqual(h.runCalls[0].actor, { userId: 'u1', username: 'u1', role: 'user' })
  // u2 在 u1 项目上建对话 → 403
  const h2 = makeHarness({ userId: 'u2', role: 'user' })
  const r2 = await h2.call('POST', '/api/workbench/conversations', { projectId: h2.pid, message: 'x' })
  assert.equal(r2.status, 403)
})

test('集群 entitlement:messages/regenerate 须项目集群已分配(有行 200;无行 403;admin 无行 200)', async () => {
  // u1 已分配 c1(夹具默认)→ messages / regenerate 各自独立夹具 200(防 running 状态互扰)
  const h = makeHarness({ userId: 'u1', role: 'user' })
  assert.equal((await h.call('POST', `/api/workbench/conversations/${h.c.done}/messages`, { message: 'hi' })).status, 200)
  const hReg = makeHarness({ userId: 'u1', role: 'user' })
  assert.equal((await hReg.call('POST', `/api/workbench/conversations/${hReg.c.done}/regenerate`)).status, 200)
  // u1 未分配 c1 → 403(未分配集群的对话运行拒)
  const h2 = makeHarness({ userId: 'u1', role: 'user', assignedCluster: false })
  const r2 = await h2.call('POST', `/api/workbench/conversations/${h2.c.done}/messages`, { message: 'hi' })
  assert.equal(r2.status, 403)
  assert.match(String(r2.json?.message), /未分配|not assigned/)
  const h2Reg = makeHarness({ userId: 'u1', role: 'user', assignedCluster: false })
  assert.equal((await h2Reg.call('POST', `/api/workbench/conversations/${h2Reg.c.done}/regenerate`)).status, 403)
  // admin 短路(未分配也通)
  const h3 = makeHarness({ userId: 'adm', role: 'admin', assignedCluster: false })
  assert.equal((await h3.call('POST', `/api/workbench/conversations/${h3.c.done}/messages`, { message: 'hi' })).status, 200)
})

test('集群 entitlement:创建对话也须项目集群已分配(未分配 403;已分配 200)', async () => {
  // u1 未分配 c1 → 在自己项目上建对话也被拒(spec §6.2/§2.6:detached run 前的绕道封死)
  const h2 = makeHarness({ userId: 'u1', role: 'user', assignedCluster: false })
  const r2 = await h2.call('POST', '/api/workbench/conversations', { projectId: h2.pid, message: 'x' })
  assert.equal(r2.status, 403)
  assert.match(String(r2.json?.message), /未分配|not assigned/)
  assert.equal(h2.runCalls.length, 0, '被拒后不得触发 run')
  // 已分配(夹具默认)→ 200(独立夹具,防状态互扰)
  const h = makeHarness({ userId: 'u1', role: 'user' })
  const r = await h.call('POST', '/api/workbench/conversations', { projectId: h.pid, message: '第一问' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
})

// F4(authz-entitlement-02,2026-09-07 审计):edit/approve/deny 补集群分配门——审计实测失权
// owner 对未分配集群的对话 edit 200+run 启动(messages/regenerate 403)的绕道。三面同门:
// 未分配 → 403 wbp.clusterForbidden 且零副作用(先于截断/CAS);admin 无行短路 200。
test('集群 entitlement:edit/approve/deny 须项目集群已分配(未分配 403 零副作用;admin 无行 200)', async () => {
  // 授权回归(门不得过紧):已分配 owner 三面照常通——edit 用真实 user 锚(截断重发全流程)
  const hEdit = makeHarness({ userId: 'u1', role: 'user' })
  const anchor = hEdit.db.prepare("SELECT id FROM workbench_messages WHERE conversationId=? AND role='user' ORDER BY seq LIMIT 1").get(hEdit.c.done).id
  const rEdit = await hEdit.call('POST', `/api/workbench/conversations/${hEdit.c.done}/edit`, { messageId: anchor, content: '改写后的问题' })
  assert.equal(rEdit.status, 200, JSON.stringify(rEdit.json))
  assert.equal(hEdit.runCalls.length, 1, '授权 edit 照常触发 run')
  const hA = makeHarness({ userId: 'u1', role: 'user' })
  assert.equal((await hA.call('POST', `/api/workbench/conversations/${hA.c.paused}/approve`)).status, 200)
  assert.equal(hA.resumeCalls.length, 1)
  const hD = makeHarness({ userId: 'u1', role: 'user' })
  assert.equal((await hD.call('POST', `/api/workbench/conversations/${hD.c.paused}/deny`)).status, 200)
  assert.equal(hD.resumeCalls[0].approved, false)
  // 未分配(owner 过 ownership 后 entitlement 拒)→ 三面 403;messageId 故意用 'nope'
  // 证明门先于锚校验(若门在锚校验之后,edit 会 400 而非 403)
  const h2 = makeHarness({ userId: 'u1', role: 'user', assignedCluster: false })
  for (const [key, suffix, body] of [['done', '/edit', { messageId: 'nope', content: 'x' }], ['paused', '/approve', {}], ['paused', '/deny', {}]]) {
    const r = await h2.call('POST', `/api/workbench/conversations/${h2.c[key]}${suffix}`, body)
    assert.equal(r.status, 403, `${suffix} → 期望 403,实得 ${r.status}`)
    assert.match(String(r.json?.message), /未分配|not assigned/, `${suffix} 须是集群 entitlement 门(非 ownership 门)`)
  }
  assert.equal(h2.runCalls.length, 0, '被拒不得触发 run')
  assert.equal(h2.resumeCalls.length, 0, '被拒不得触发 resume')
  assert.equal(h2.db.prepare(`SELECT status FROM workbench_conversations WHERE id='${h2.c.paused}'`).get().status, 'paused', '审批拒绝须先于 CAS,状态不动')
  // admin 短路(未分配也通):edit + approve 各验一面
  const h3 = makeHarness({ userId: 'adm', role: 'admin', assignedCluster: false })
  const a3 = h3.db.prepare("SELECT id FROM workbench_messages WHERE conversationId=? AND role='user' ORDER BY seq LIMIT 1").get(h3.c.done).id
  assert.equal((await h3.call('POST', `/api/workbench/conversations/${h3.c.done}/edit`, { messageId: a3, content: 'x' })).status, 200)
  assert.equal((await h3.call('POST', `/api/workbench/conversations/${h3.c.paused}/approve`)).status, 200)
})

test('列表面:GET ?projectId 非owner 403/owner 200;/active 非 admin 只见自己项目的活跃', async () => {
  const h = makeHarness({ userId: 'u2', role: 'user' })
  assert.equal((await h.call('GET', '/api/workbench/conversations?projectId=' + h.pid)).status, 403)
  const h1 = makeHarness({ userId: 'u1', role: 'user' })
  assert.equal((await h1.call('GET', '/api/workbench/conversations?projectId=' + h1.pid)).status, 200)
  // /active:u2 的活跃对话都在 u1 的项目上 → 过滤后空;admin 全量
  const ra = await h.call('GET', '/api/workbench/conversations/active')
  assert.equal(ra.status, 200)
  assert.equal(ra.json.conversations.length, 0, 'u2 不应看到 u1 项目的活跃对话')
  const radm = await makeHarness({ userId: 'adm', role: 'admin' }).call('GET', '/api/workbench/conversations/active')
  assert.ok(radm.json.conversations.length >= 2, 'admin 全量')
})

test('/ai-config 维持 admin(非 admin 403)', async () => {
  const h = makeHarness({ userId: 'u1', role: 'user' })
  const r = await h.call('GET', '/api/workbench/ai-config')
  assert.equal(r.status, 403)
  const hadm = makeHarness({ userId: 'adm', role: 'admin' })
  assert.equal((await hadm.call('GET', '/api/workbench/ai-config')).status, 200)
})
