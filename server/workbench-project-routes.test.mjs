// 工作台项目路由·进程内 handler 测试(不 spawn 网关,模式同 workbench-summary.test.mjs)。
// 覆盖(终审 I6):DELETE 项目时 cancelConversation 必须先于 deleteProject——
// 规格 §5 的「running 先取消(P0(F) 不等 LLM 轮结束)」承诺落在路由层,取消若晚于删除,
// agent 取消守卫读不到行(见 workbench-agent I5 存在性守卫),行为等同没取消。
// 注:deleteProject 是模块内 import 不可直接 spy,但其顺序由两侧夹逼唯一确定——
// cancel spy 记录调用时的行数,writeAudit 在路由体内紧跟 deleteProject 之后调用。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createWorkbenchSchema, createProject, projectRepoPath } from './workbench-projects.mjs'
import { createWorkbenchProjectRoutes } from './routes/workbench-projects.mjs'

function setup({ confirmName = 'demo' } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  const p = createProject(db, { name: 'demo', clusterId: 'c1', ownerId: 'u-me' })
  const dir = mkdtempSync(join(tmpdir(), 'wb-proj-route-'))
  const repo = projectRepoPath(dir, p)
  mkdirSync(repo, { recursive: true })
  // running + paused + done 三态:前两者必须被取消
  const convs = ['running', 'paused', 'done'].map((status, i) => {
    const now = Date.now()
    const id = `conv-${status}`
    db.prepare('INSERT INTO workbench_conversations (id,projectId,status,createdAt,updatedAt) VALUES (?,?,?, ?,?)')
      .run(id, p.id, status, now + i, now + i)
    return id
  })
  const convCount = () => db.prepare('SELECT count(*) c FROM workbench_conversations WHERE projectId=?').get(p.id).c
  const sent = []
  const order = []
  const routes = createWorkbenchProjectRoutes({
    db,
    sendJson: (_res, status, body) => sent.push({ status, body }),
    readBody: async () => ({ confirmName }),
    requirePlatform: () => ({ userId: 'u-me', username: 'me', role: 'user' }),
    requireAdmin: () => null,
    // writeAudit 在路由体内紧跟 deleteProject 之后调用 → 其记录即「删除已完成」侧标
    writeAudit: (_db, entry) => order.push(['audit:' + entry.tool, null, convCount()]),
    WORKBENCH_DIR: dir,
    dbPath: ':memory:',
    listSshSessions: () => [],
    wbAgent: {
      runConversation: () => {},
      resumeConversation: async () => {},
      cancelConversation: id => { order.push(['cancel', id, convCount()]); return { ok: true } },
    },
    busDispose: id => order.push(['dispose', id, convCount()]),
  })
  const call = () => routes.handle(
    { headers: {}, method: 'DELETE' }, {},
    new URL(`http://x/api/workbench/projects/${p.id}`),
  )
  return { db, p, convs, sent, order, convCount, call, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('I6:DELETE 项目时 cancelConversation 先于 deleteProject(取消发生在行仍在时)', async () => {
  const s = setup()
  try {
    const handled = await s.call()
    assert.equal(handled, true)
    assert.equal(s.sent[0].status, 200, JSON.stringify(s.sent[0]))
    assert.equal(s.sent[0].body.ok, true)

    const kinds = s.order.map(e => e[0])
    // running/paused 两条被取消;cancel 全部先于 audit(=deleteProject 已提交)
    assert.equal(kinds.filter(k => k === 'cancel').length, 2, 'running+paused 各取消一次')
    assert.equal(kinds.indexOf('audit:project_delete'), kinds.length - 1, 'audit 最后')
    assert.ok(kinds.indexOf('cancel') < kinds.indexOf('audit:project_delete'), 'cancel 先于 deleteProject')

    // 强断言:cancel 调用瞬间对话行仍在(=尚未删除);audit 调用瞬间行已清(=删除已提交)
    const cancels = s.order.filter(e => e[0] === 'cancel')
    assert.ok(cancels.every(e => e[2] === 3), `取消时 3 条对话行都还在(实际 ${cancels.map(e => e[2])})`)
    assert.equal(s.order.find(e => e[0] === 'audit:project_delete')[2], 0, 'deleteProject 已级联清空')
    assert.equal(s.convCount(), 0)
  } finally { s.cleanup() }
})

test('I6 反例守卫:确认名不符 400 时不触发任何取消/删除', async () => {
  const s = setup({ confirmName: 'wrong' })
  try {
    await s.call()
    assert.equal(s.sent[0].status, 400)
    assert.equal(s.order.length, 0, '无 cancel/dispose/audit(数据零动作)')
    assert.equal(s.convCount(), 3, '对话行全保留')
  } finally { s.cleanup() }
})

// ═══ 终审 M4:PATCH 原子性 + recap: null 视为未提供 ═══
function setupPatch({ triggerFailName = false } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  // 响应体带 clusterName(查 clusters 表)——测试库补一张,免得 500 掩盖被测行为
  db.exec('CREATE TABLE IF NOT EXISTS clusters (id TEXT PRIMARY KEY, name TEXT)')
  const p = createProject(db, { name: 'demo', clusterId: 'c1', ownerId: 'u-me' })
  db.prepare('UPDATE workbench_projects SET projectRecap=?, historyWatermark=7 WHERE id=?').run('既有记忆', p.id)
  if (triggerFailName) {
    // 原子性失败注入:name UPDATE 走到就 ABORT(recap 已写)→ 整个 PATCH 必须回滚
    db.exec(`CREATE TRIGGER fail_name BEFORE UPDATE OF name ON workbench_projects
             WHEN NEW.name = 'boom' BEGIN SELECT RAISE(ABORT, 'injected name failure'); END`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'wb-proj-patch-'))
  const sent = []
  let body = {}
  const routes = createWorkbenchProjectRoutes({
    db,
    sendJson: (_res, status, b) => sent.push({ status, body: b }),
    readBody: async () => body,
    requirePlatform: () => ({ userId: 'u-me', username: 'me', role: 'user' }),
    requireAdmin: () => null,
    writeAudit: () => {},
    WORKBENCH_DIR: dir,
    dbPath: ':memory:',
    listSshSessions: () => [],
  })
  const call = (nextBody, method = 'PATCH') => {
    body = nextBody
    return routes.handle({ headers: {}, method }, {}, new URL(`http://x/api/workbench/projects/${p.id}`))
  }
  const row = () => db.prepare('SELECT name, projectRecap, historyWatermark FROM workbench_projects WHERE id=?').get(p.id)
  return { p, sent, call, row, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('M4:PATCH {recap: null} 视为未提供——400(无有效字段)且既有记忆/水位不动', async () => {
  const s = setupPatch()
  try {
    await s.call({ recap: null })
    assert.equal(s.sent[0].status, 400, 'null 不算提供,与全缺同判')
    assert.equal(s.row().projectRecap, '既有记忆', '记忆不被静默清空')
    assert.equal(s.row().historyWatermark, 7, '水位不被归零')
  } finally { s.cleanup() }
})

test('M4:PATCH {name, recap: null} → 只改名,记忆保留', async () => {
  const s = setupPatch()
  try {
    await s.call({ name: 'renamed', recap: null })
    assert.equal(s.sent[0].status, 200, JSON.stringify(s.sent[0]))
    assert.equal(s.row().name, 'renamed')
    assert.equal(s.row().projectRecap, '既有记忆')
    assert.equal(s.row().historyWatermark, 7)
  } finally { s.cleanup() }
})

test('M4:PATCH recap 空串仍=清空+水位归零(null 与 空串 语义分开)', async () => {
  const s = setupPatch()
  try {
    await s.call({ recap: '' })
    assert.equal(s.sent[0].status, 200)
    assert.equal(s.row().projectRecap, null)
    assert.equal(s.row().historyWatermark, 0)
  } finally { s.cleanup() }
})

test('M4:PATCH name+recap 单事务——name 写入失败时 recap 一并回滚(不留半截)', async () => {
  const s = setupPatch({ triggerFailName: true })
  try {
    await s.call({ name: 'boom', recap: '危险的新记忆' })
    assert.equal(s.sent[0].status, 500, JSON.stringify(s.sent[0]))
    assert.equal(s.row().name, 'demo', '改名回滚')
    assert.equal(s.row().projectRecap, '既有记忆', 'recap 不许先落半截')
    assert.equal(s.row().historyWatermark, 7, '水位不受半途失败影响')
  } finally { s.cleanup() }
})

// ═══ 终审 M1(服务端):确认名两侧 trim——带首尾空白的项目名也删得掉 ═══
test('M1:项目名带首尾空白,confirmName trim 后即可删;不等仍 400', async () => {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  const p = createProject(db, { name: 'pad me ', clusterId: 'c1', ownerId: 'u-me' })
  const dir = mkdtempSync(join(tmpdir(), 'wb-proj-trim-'))
  mkdirSync(projectRepoPath(dir, p), { recursive: true })
  const sent = []
  let body = {}
  const routes = createWorkbenchProjectRoutes({
    db,
    sendJson: (_res, status, b) => sent.push({ status, body: b }),
    readBody: async () => body,
    requirePlatform: () => ({ userId: 'u-me', username: 'me', role: 'user' }),
    requireAdmin: () => null,
    writeAudit: () => {},
    WORKBENCH_DIR: dir,
    dbPath: ':memory:',
    listSshSessions: () => [],
    wbAgent: { cancelConversation: () => ({ ok: true }) },
  })
  const call = b => { body = b; return routes.handle({ headers: {}, method: 'DELETE' }, {}, new URL(`http://x/api/workbench/projects/${p.id}`)) }
  try {
    await call({ confirmName: 'nope' })          // 真·不等(trim 后)→ 400,数据零动作
    assert.equal(sent[0].status, 400)
    assert.equal(db.prepare('SELECT count(*) c FROM workbench_projects').get().c, 1)
    await call({ confirmName: 'pad me' })        // trim 后相等 → 200(M1 修复:旧行为恒 400 删不掉)
    assert.equal(sent[1].status, 200, JSON.stringify(sent[1]))
    assert.equal(db.prepare('SELECT count(*) c FROM workbench_projects').get().c, 0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
