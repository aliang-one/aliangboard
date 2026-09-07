// W3 Task 5:admin 会话治理路由级测试 —— GET /api/admin/sessions(全用户会话分页,JOIN
// platform_users,raw userAgent 前端自行摘要)+ DELETE /api/admin/sessions/:userId
// (revokeUserSessions 真调:内存 Map/DB/k8s 凭据三处同清 + admin_force_logout 审计)。
// 工厂照 admin-authz.test.mjs;platform_sessions 表结构照 index.mjs(含 W3 mfaPending/stepUpAt)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createAdminRoutes } from './routes/admin.mjs'
import { createAuditSchema, writeAudit, queryAuditLog } from './audit.mjs'

function makeHarness() {
  const sent = []
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL, disabled INTEGER DEFAULT 0)`)
  db.exec(`CREATE TABLE platform_sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL, createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT, mfaPending INTEGER DEFAULT 0, stepUpAt INTEGER)`)
  db.exec(`CREATE TABLE sessions (token TEXT PRIMARY KEY, apiServer TEXT NOT NULL, userId TEXT, clusterId TEXT)`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY (groupId, userId))`)
  db.exec(`CREATE TABLE ns_grants (id TEXT PRIMARY KEY, subjectType TEXT NOT NULL, subjectId TEXT NOT NULL, clusterId TEXT NOT NULL, namespace TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'view', grantedBy TEXT, grantedAt INTEGER NOT NULL, UNIQUE(subjectType,subjectId,clusterId,namespace))`)
  db.exec(`CREATE TABLE api_keys (id TEXT PRIMARY KEY, ownerUserId TEXT, revokedAt INTEGER)`)
  createAuditSchema(db)
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('u1','alice','x','user',1)").run()
  db.prepare("INSERT INTO platform_users (id,username,passwordHash,role,createdAt) VALUES ('adm','admin','x','admin',1)").run()
  // 三个会话:admin 当前 + alice 两个设备(不同 lastSeenAt,mfaPending 一台受限)
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt,lastSeenAt,ip,userAgent,mfaPending) VALUES ('tok-adm','adm','admin','admin',100,900,'1.1.1.1','admin-agent',0)").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt,lastSeenAt,ip,userAgent,k8sSessionToken) VALUES ('tok-a1','u1','alice','user',100,800,'2.2.2.2','Mozilla/5.0 alice-laptop','k8s-a1')").run()
  db.prepare("INSERT INTO platform_sessions (token,userId,username,role,createdAt,lastSeenAt,ip,userAgent,mfaPending) VALUES ('tok-a2','u1','alice','user',100,700,'3.3.3.3','curl/8.0 alice-ci',1)").run()
  db.prepare("INSERT INTO sessions (token, apiServer, userId, clusterId) VALUES ('k8s-a1','http://k8s','u1','c1')").run()

  const platformSessions = new Map(db.prepare('SELECT * FROM platform_sessions').all().map(r => [r.token, r]))
  const sessions = new Map([['k8s-a1', { apiServer: 'http://k8s', userId: 'u1', clusterId: 'c1' }]])
  const auditRows = []
  const routes = createAdminRoutes({
    db, sendJson: (r, s, j) => sent.push({ status: s, json: j }),
    readBody: async () => harness._body,
    // 镜像 index.mjs 生产接线:token → platformSessions Map → 用户行 role 复读 → 401/403。
    requireAdmin: (req, res) => {
      const tok = req.headers['x-platform-token']
      const ps = platformSessions.get(tok)
      if (!ps) { sent.push({ status: 401, json: { message: 'not logged in' } }); return null }
      const u = db.prepare('SELECT role FROM platform_users WHERE id=? AND disabled=0').get(ps.userId)
      if (!u) { sent.push({ status: 401, json: { message: 'not logged in' } }); return null }
      if (u.role !== 'admin') { sent.push({ status: 403, json: { message: 'admin required' } }); return null }
      return { ...ps, role: u.role }
    },
    getSetting: () => null, setSetting: () => {}, randomUUID: () => 'uuid-x',
    writeAudit: (d, row) => { auditRows.push(row); writeAudit(d, row) },
    sessions, platformSessions,
  })
  const harness = { sent, db, auditRows, platformSessions, sessions, _body: {},
    call: (m, p, body, headers) => { harness._body = body || {}; return routes.handle({ method: m, headers: headers || { 'x-platform-token': 'tok-adm' }, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) } }
  return harness
}

test('GET /api/admin/sessions:全用户会话,JOIN 用户列,lastSeen 降序,raw userAgent,分页 size 钳 1..200', async () => {
  const h = makeHarness()
  await h.call('GET', '/api/admin/sessions')
  assert.equal(h.sent[0].status, 200)
  const { items, total, page, size } = h.sent[0].json
  assert.equal(total, 3)
  assert.equal(page, 1); assert.equal(size, 50, '缺省 size 与 queryAuditLog 同款 50')
  // lastSeenAt 降序:tok-adm(900) → tok-a1(800) → tok-a2(700)
  assert.deepEqual(items.map(r => r.userId), ['adm', 'u1', 'u1'])
  assert.deepEqual(items.map(r => r.lastSeenAt), [900, 800, 700])
  // JOIN 列:username/role 来自 platform_users;mfaPending/ip/userAgent/createdAt/lastSeenAt 来自会话行
  const a1 = items.find(r => r.ip === '2.2.2.2')
  assert.equal(a1.username, 'alice'); assert.equal(a1.role, 'user')
  assert.equal(a1.userAgent, 'Mozilla/5.0 alice-laptop', 'userAgent 原样回传(前端 uaSummary 摘要)')
  assert.equal(a1.mfaPending, 0); assert.equal(a1.createdAt, 100)
  const a2 = items.find(r => r.ip === '3.3.3.3')
  assert.equal(a2.mfaPending, 1, '受限会话(mfaPending=1)在列表可见 —— 徽章数据面')
  // 不回传 token( Fingerprints/明文都不要 —— 管理面只需会话元数据)
  for (const r of items) assert.equal(r.token, undefined)

  // 分页:page=2&size=2 → 只剩最旧一条;size 钳制(999 → 200;0 → 1)
  await h.call('GET', '/api/admin/sessions?page=2&size=2')
  assert.equal(h.sent[1].json.items.length, 1)
  assert.equal(h.sent[1].json.items[0].lastSeenAt, 700)
  assert.equal(h.sent[1].json.total, 3); assert.equal(h.sent[1].json.page, 2); assert.equal(h.sent[1].json.size, 2)
  await h.call('GET', '/api/admin/sessions?size=999')
  assert.equal(h.sent[2].json.size, 200)
  await h.call('GET', '/api/admin/sessions?size=abc')
  assert.equal(h.sent[3].json.size, 50, '非数字/0 与 queryAuditLog 同语义:视作缺省 50(Number(x)||50)')
  await h.call('GET', '/api/admin/sessions?size=0.5')
  assert.equal(h.sent[4].json.size, 1, '小数下限钳到 1')
})

test('DELETE /api/admin/sessions/:userId:级联吊销真调(下一请求 401)+ 审计 admin_force_logout', async () => {
  const h = makeHarness()
  await h.call('DELETE', '/api/admin/sessions/u1')
  assert.equal(h.sent[0].status, 200)
  assert.equal(h.sent[0].json.revoked, 2)
  // 内存 Map + DB 三处同清(revokeUserSessions 真调)
  assert.equal(h.platformSessions.has('tok-a1'), false)
  assert.equal(h.platformSessions.has('tok-a2'), false)
  assert.equal(h.db.prepare('SELECT COUNT(*) c FROM platform_sessions WHERE userId=?').get('u1').c, 0)
  assert.equal(h.sessions.has('k8s-a1'), false, 'k8s 凭据随平台会话级联吊销')
  assert.equal(h.db.prepare("SELECT COUNT(*) c FROM sessions WHERE token='k8s-a1'").get().c, 0)
  // 被 force-logout 的 token 下一请求 401(镜像生产的 requireAdmin 兑现)
  await h.call('GET', '/api/admin/sessions', undefined, { 'x-platform-token': 'tok-a1' })
  assert.equal(h.sent[1].status, 401)
  // 审计行:tool=admin_force_logout,requestSummary 带 userId 与 revoked 数
  const rows = queryAuditLog(h.db, { tool: 'admin_force_logout', status: null })
  assert.equal(rows.total, 1)
  assert.match(rows.items[0].requestSummary, /userId=u1 revoked=2/)
  assert.equal(rows.items[0].owner, 'admin')
  // admin 自己的会话不受波及
  assert.equal(h.platformSessions.has('tok-adm'), true)
})

test('DELETE 未知用户 → 404;非 admin token → 401;user token → 403', async () => {
  const h = makeHarness()
  await h.call('DELETE', '/api/admin/sessions/ghost')
  assert.equal(h.sent[0].status, 404)
  await h.call('GET', '/api/admin/sessions', undefined, { 'x-platform-token': 'dead-token' })
  assert.equal(h.sent[1].status, 401)
  await h.call('GET', '/api/admin/sessions', undefined, { 'x-platform-token': 'tok-a1' })
  assert.equal(h.sent[2].status, 403, '普通用户会话不得看全会话列表')
})
