// GET /api/workbench/summary 顶栏胶囊汇总端点:deps 注入(requirePlatform/sendJson/listSshSessions
// 假件)+ 内存 node:sqlite 直调 handle(),不 spawn 网关(避开 spawn 并跑竞态)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema } from './workbench-projects.mjs'
import { createWorkbenchProjectRoutes } from './routes/workbench-projects.mjs'

function setup({ user = 'u1', role = 'user', username = 'alice', ssh = [] } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  db.exec('CREATE TABLE IF NOT EXISTS clusters (id TEXT PRIMARY KEY, name TEXT)')
  db.prepare('INSERT INTO clusters (id,name) VALUES (?,?)').run('c1', 'prod-cluster')
  const sent = []
  const routes = createWorkbenchProjectRoutes({
    db,
    sendJson: (_res, status, body) => sent.push({ status, body }),
    readBody: async () => ({}),
    // 真实形状:userId=platform_users.id(UUID),username=登录名;SSH 终端注册表存 username
    requirePlatform: () => (user === null ? null : { userId: user, username, role }),
    requireAdmin: () => null,
    writeAudit: () => {},
    WORKBENCH_DIR: '/tmp/ab-summary-test',
    dbPath: ':memory:',
    listSshSessions: () => ssh,
  })
  return { db, sent, call: () => routes.handle({ headers: {}, method: 'GET' }, {}, new URL('http://x/api/workbench/summary')) }
}

// 直接 INSERT(不用 createProject):需要受控 id/createdAt 做排序断言
const addProject = (db, name, { ownerId = 'u1', clusterId = 'c1', createdAt = 1 } = {}) =>
  db.prepare('INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt,repoRoot) VALUES (?,?,?,?,?,?)')
    .run(`id-${name}`, name, clusterId, ownerId, createdAt, 'projects')

const addConv = (db, projectId, { status = 'running', pending = null, updatedAt = 1000, id } = {}) =>
  db.prepare('INSERT INTO workbench_conversations (id,projectId,status,pendingApproval,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .run(id || `conv-${projectId}-${status}-${Math.random()}`, projectId, status, pending, updatedAt, updatedAt)

test('普通用户只见自己项目,SSH 按 username 计数(终端注册表 userId 字段实存 username)', async () => {
  const { db, sent, call } = setup({
    user: 'u-uuid-1', username: 'alice', role: 'user',
    ssh: [{ userId: 'alice' }, { userId: 'alice' }, { userId: 'bob' }, { userId: 'u-uuid-1' }], // 末条=UUID 不计(身份字段错配反例)
  })
  addProject(db, 'mine', { ownerId: 'u-uuid-1' })
  addProject(db, 'others', { ownerId: 'u-uuid-2' })
  await call()
  assert.equal(sent[0].status, 200)
  const { projects, totals } = sent[0].body
  assert.equal(totals.projects, 1)
  assert.equal(projects.length, 1)
  assert.equal(projects[0].name, 'mine')
  assert.equal(projects[0].clusterName, 'prod-cluster')
  assert.equal(totals.sshSessions, 2)
})

test('未绑定(\'\' 哨兵)项目 clusterName=null', async () => {
  const { db, sent, call } = setup()
  addProject(db, 'free', { clusterId: '' })
  await call()
  assert.equal(sent[0].body.projects[0].clusterId, '')
  assert.equal(sent[0].body.projects[0].clusterName, null)
})

test('running/paused 待审批计数;paused 无 pendingApproval 不计', async () => {
  const { db, sent, call } = setup()
  addProject(db, 'p')
  addConv(db, 'id-p', { status: 'running' })
  addConv(db, 'id-p', { status: 'paused', pending: '{"tool":"wb_exec"}', updatedAt: 5000 })
  addConv(db, 'id-p', { status: 'paused', pending: null })
  await call()
  const { projects, totals } = sent[0].body
  assert.equal(projects[0].runningConvs, 1)
  assert.equal(projects[0].pendingApprovals, 1)
  assert.equal(projects[0].lastActiveAt, 5000)
  assert.equal(totals.runningConvs, 1)
  assert.equal(totals.pendingApprovals, 1)
})

test('admin 见全部项目', async () => {
  const { db, sent, call } = setup({ role: 'admin' })
  addProject(db, 'a')
  addProject(db, 'b', { ownerId: 'u2' })
  await call()
  assert.equal(sent[0].body.totals.projects, 2)
})

test('>8 项目截 8 且待办优先,totals 全量', async () => {
  const { db, sent, call } = setup()
  for (let i = 1; i <= 8; i++) addProject(db, `idle${i}`, { createdAt: i })
  addProject(db, 'run', { createdAt: 9 })
  addProject(db, 'pend', { createdAt: 10 })
  addConv(db, 'id-run', { status: 'running', updatedAt: 5000 })
  addConv(db, 'id-pend', { status: 'paused', pending: '{}', updatedAt: 9000 })
  await call()
  const { projects, totals } = sent[0].body
  assert.equal(projects.length, 8)
  assert.equal(projects[0].name, 'pend')   // 待审批最优先
  assert.equal(projects[1].name, 'run')
  assert.equal(totals.projects, 10)
  assert.equal(totals.pendingApprovals, 1)
  assert.equal(totals.runningConvs, 1)
})

test('未认证:requirePlatform 拒绝则不发响应', async () => {
  const { sent, call } = setup({ user: null })
  const handled = await call()
  assert.equal(handled, true)
  assert.equal(sent.length, 0)
})
