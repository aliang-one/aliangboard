// W2 Phase E (Task 1):impersonation 身份构造 + 能力探测器(纯逻辑)与 connect-cluster 接线。
// 命名约定(spec §7):User=aliangboard:u-<userId>;Group=aliangboard:team-<groupId>;
// 可读名走 Impersonate-Extra-Displayname。探测器=POST SelfSubjectRulesReview 带 impersonate
// 头,2xx→true,403/网络错误→false(保守),按 clusterId 缓存(重启清零可接受)。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { buildImpersonation, impersonateDisplaynameFor, impersonateHeadersFor, createImpersonationProbe, mergeImpersonate } from './impersonate.mjs'
import { createAuthRoutes } from './routes/auth.mjs'

function makeDb() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE platform_users (
    id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, passwordHash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user', displayName TEXT, createdAt INTEGER NOT NULL,
    disabled INTEGER DEFAULT 0, prefs TEXT, avatar BLOB, avatarMime TEXT)`)
  db.exec(`CREATE TABLE platform_sessions (
    token TEXT PRIMARY KEY, userId TEXT NOT NULL, username TEXT NOT NULL, role TEXT NOT NULL,
    createdAt INTEGER NOT NULL, k8sSessionToken TEXT, lastSeenAt INTEGER, ip TEXT, userAgent TEXT)`)
  db.exec(`CREATE TABLE clusters (id TEXT PRIMARY KEY, name TEXT, apiServer TEXT NOT NULL,
    authHeader TEXT, ca TEXT, cert TEXT, key TEXT, insecure INTEGER DEFAULT 0, version TEXT, nsAuthMode TEXT DEFAULT 'open')`)
  db.exec(`CREATE TABLE user_clusters (userId TEXT, clusterId TEXT, assignedBy TEXT, assignedAt INTEGER)`)
  db.exec(`CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, createdAt INTEGER NOT NULL, createdBy TEXT)`)
  db.exec(`CREATE TABLE group_members (groupId TEXT NOT NULL, userId TEXT NOT NULL, addedBy TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY (groupId, userId))`)
  return db
}

// u1 alice(g1+g2 两组)/u2 bob 无组/ua admin/u3 disabled;ghost 不存在。
function seed(db) {
  const ins = db.prepare('INSERT INTO platform_users (id,username,passwordHash,role,displayName,createdAt,disabled) VALUES (?,?,?,?,?,?,?)')
  ins.run('u1', 'alice', 'x', 'user', 'Alice', 1, 0)
  ins.run('u2', 'bob', 'x', 'user', null, 1, 0)
  ins.run('ua', 'root', 'x', 'admin', 'Root', 1, 0)
  ins.run('u3', 'mallory', 'x', 'user', null, 1, 1)
  const g = db.prepare('INSERT INTO groups (id,name,createdAt) VALUES (?,?,1)')
  g.run('g1', 'team-a'); g.run('g2', 'team-b')
  const m = db.prepare('INSERT INTO group_members (groupId,userId,createdAt) VALUES (?,?,1)')
  m.run('g1', 'u1'); m.run('g2', 'u1')
  db.prepare('INSERT INTO clusters (id,name,apiServer,authHeader) VALUES (?,?,?,?)').run('c1', 'k8s', 'https://k8s.local', 'Bearer t')
  db.prepare('INSERT INTO user_clusters (userId,clusterId) VALUES (?,?)').run('u1', 'c1')
  db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES (?,?,?,?,1)').run('t-me', 'u1', 'alice', 'user')
  db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES (?,?,?,?,1)').run('t-admin', 'ua', 'root', 'admin')
  // legacy 形状是合成防御面(生产 platform_sessions.userId 自 Wave1 起 NOT NULL 恒有值)。
  // role 填 admin 是为了让合成行过 W2-0 分配门(否则 403 掩蔽断言目标),非宣称 legacy 恒 admin。
  db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES (?,?,?,?,1)').run('t-legacy', '', 'legacy', 'admin')
}

// ===== buildImpersonation =====

test('buildImpersonation:用户身份 + 组身份(顺序:u- 首,组随组表序)', () => {
  const db = makeDb(); seed(db)
  assert.deepEqual(buildImpersonation(db, 'u1'), ['aliangboard:u-u1', 'aliangboard:team-g1', 'aliangboard:team-g2'])
})

test('buildImpersonation:无组用户 → 仅 u- 头', () => {
  const db = makeDb(); seed(db)
  assert.deepEqual(buildImpersonation(db, 'u2'), ['aliangboard:u-u2'])
})

test('buildImpersonation:admin 平台用户同样携带身份(R3:admin 归真同理所应当)', () => {
  const db = makeDb(); seed(db)
  assert.deepEqual(buildImpersonation(db, 'ua'), ['aliangboard:u-ua'])
})

test('buildImpersonation:ghost/禁用/空 userId → [](legacy 无归属 = 无注入)', () => {
  const db = makeDb(); seed(db)
  assert.deepEqual(buildImpersonation(db, 'ghost'), [])
  assert.deepEqual(buildImpersonation(db, 'u3'), [])
  assert.deepEqual(buildImpersonation(db, ''), [])
  assert.deepEqual(buildImpersonation(db, null), [])
  assert.deepEqual(buildImpersonation(db, undefined), [])
})

test('impersonateDisplaynameFor:displayName 优先,回退 username;ghost → undefined', () => {
  const db = makeDb(); seed(db)
  assert.equal(impersonateDisplaynameFor(db, 'u1'), 'Alice')
  assert.equal(impersonateDisplaynameFor(db, 'u2'), 'bob')
  assert.equal(impersonateDisplaynameFor(db, 'ghost'), undefined)
})

// ===== impersonateHeadersFor(纯函数) =====

test('impersonateHeadersFor:空/undefined/非数组 → {}', () => {
  assert.deepEqual(impersonateHeadersFor({}), {})
  assert.deepEqual(impersonateHeadersFor({ impersonate: [] }), {})
  assert.deepEqual(impersonateHeadersFor({ impersonate: undefined }), {})
  assert.deepEqual(impersonateHeadersFor({ impersonate: 'aliangboard:u-u1' }), {})
  assert.deepEqual(impersonateHeadersFor(null), {})
})

test('impersonateHeadersFor:单组 → user+group 两头,group 恒数组形态', () => {
  const h = impersonateHeadersFor({ impersonate: ['aliangboard:u-u2', 'aliangboard:team-g1'] })
  assert.deepEqual(h, { 'impersonate-user': 'aliangboard:u-u2', 'impersonate-group': ['aliangboard:team-g1'] })
})

test('impersonateHeadersFor:多组 → group 数组(undici 重复头数组形态)', () => {
  const h = impersonateHeadersFor({ impersonate: ['aliangboard:u-u1', 'aliangboard:team-g1', 'aliangboard:team-g2'] })
  assert.deepEqual(h, {
    'impersonate-user': 'aliangboard:u-u1',
    'impersonate-group': ['aliangboard:team-g1', 'aliangboard:team-g2'],
  })
})

test('impersonateHeadersFor:可读名 → impersonate-extra-displayname 头', () => {
  const h = impersonateHeadersFor({ impersonate: ['aliangboard:u-u1', 'aliangboard:team-g1'], impersonateDisplayname: 'Alice' })
  assert.equal(h['impersonate-extra-displayname'], 'Alice')
})

test('impersonateHeadersFor:displayname 控制字符剥成空格(review #3 头注入防线,\r\n\t 恒单行)', () => {
  const h = impersonateHeadersFor({ impersonate: ['aliangboard:u-u1'], impersonateDisplayname: 'Evil\r\nX-Injected: 1\t|nul\x00' })
  assert.equal(h['impersonate-extra-displayname'], 'Evil  X-Injected: 1 |nul ')
  assert.ok(!h['impersonate-extra-displayname'].includes('\r') && !h['impersonate-extra-displayname'].includes('\n'))
})

// ===== createImpersonationProbe =====

function sess(over = {}) {
  return { clusterId: 'c1', impersonate: ['aliangboard:u-u1', 'aliangboard:team-g1'], impersonateDisplayname: 'Alice', ...over }
}

// kill-switch(review #2)默认关——各「开关已开」用例统一注入此 stub。
const ON = { getSetting: () => '1' }

test('probe:2xx → true 并缓存(同 cluster 只探测一次,requestFn 计数)', async () => {
  const calls = []
  const probe = createImpersonationProbe({ ...ON, requestKubernetes: async (s, path, init) => { calls.push({ s, path, init }); return { status: 201 } } })
  assert.equal(probe.isProbed('c1'), undefined, '探测前未知')
  assert.equal(await probe.ensureProbed(sess()), true)
  assert.equal(await probe.ensureProbed(sess()), true)
  assert.equal(calls.length, 1, '同 cluster 只发一次探测')
  assert.equal(probe.isProbed('c1'), true)
})

test('probe:探测请求形状 = POST SelfSubjectRulesReview 且自带 impersonate 头(注入门未开时探测必须显式带头);body 带必填 namespace', async () => {
  const calls = []
  const probe = createImpersonationProbe({ ...ON, requestKubernetes: async (s, path, init) => { calls.push({ s, path, init }); return { status: 200 } } })
  await probe.ensureProbed(sess())
  const { path, init, s } = calls[0]
  assert.equal(path, '/apis/authorization.k8s.io/v1/selfsubjectrulesreviews')
  assert.equal(init.method, 'POST')
  assert.equal(init.headers['impersonate-user'], 'aliangboard:u-u1')
  assert.deepEqual(init.headers['impersonate-group'], ['aliangboard:team-g1'])
  assert.equal(init.headers['impersonate-extra-displayname'], 'Alice')
  assert.equal(s.clusterId, 'c1')
  const body = JSON.parse(init.body)
  assert.equal(body.kind, 'SelfSubjectRulesReview')
  assert.equal(body.apiVersion, 'authorization.k8s.io/v1')
  // review #1:spec.namespace 是 SSRR 必填字段,缺省 apiserver 直接 400(探测永远真不了)
  assert.equal(body.spec.namespace, 'default', 'SSRR body 必须带必填 spec.namespace')
})

test('probe:kill-switch 关(默认)→ 不发 SSRR、不写缓存、恒 false;置 1 后无需重启即真探测', async () => {
  const calls = []
  const enabled = { value: null } // 模拟 platform_settings 键
  const probe = createImpersonationProbe({
    getSetting: (k) => (k === 'impersonation.enabled' ? enabled.value : null),
    requestKubernetes: async () => { calls.push(1); return { status: 200 } },
  })
  assert.equal(await probe.ensureProbed(sess()), false, '未注入 getSetting 值非 1 → false')
  assert.equal(calls.length, 0, '关着不发 SSRR')
  assert.equal(probe.isProbed('c1'), undefined, '关着不写缓存(不是 false)')
  probe.kick(sess()) // kick 同样被开关拦住
  await new Promise(r => setImmediate(r))
  assert.equal(calls.length, 0)
  enabled.value = '1' // admin 置键——无需重启/新建工厂
  assert.equal(await probe.ensureProbed(sess()), true)
  assert.equal(calls.length, 1, '开后的第一次 kick 即真探测')
  assert.equal(probe.isProbed('c1'), true)
})

test('probe:未注入 getSetting(缺省)→ 恒关(保守)', async () => {
  const calls = []
  const probe = createImpersonationProbe({ requestKubernetes: async () => { calls.push(1); return { status: 200 } } })
  assert.equal(await probe.ensureProbed(sess()), false)
  assert.equal(calls.length, 0)
})

test('probe:403 → false(凭据无 impersonate 权)并缓存;401 同为确定性缓存', async () => {
  for (const status of [403, 401]) {
    const calls = []
    const probe = createImpersonationProbe({ ...ON, requestKubernetes: async () => { calls.push(1); throw Object.assign(new Error('denied'), { status }) } })
    assert.equal(await probe.ensureProbed(sess()), false)
    assert.equal(await probe.ensureProbed(sess()), false)
    assert.equal(calls.length, 1, `${status} 结果同样缓存,不重复探测`)
    assert.equal(probe.isProbed('c1'), false)
  }
})

test('probe:网络错误(无 HTTP status)→ 本次 false 但不缓存(isProbed=undefined,可重试)', async () => {
  const calls = []
  const probe = createImpersonationProbe({ ...ON, requestKubernetes: async () => { calls.push(1); throw new Error('ECONNREFUSED') } })
  assert.equal(await probe.ensureProbed(sess()), false, '本次调用仍保守返 false')
  assert.equal(probe.isProbed('c1'), undefined, '瞬态不落缓存(review #4)')
  assert.equal(await probe.ensureProbed(sess()), false, '下一请求重试')
  assert.equal(calls.length, 2, '瞬态失败会再次发起探测')
})

test('probe:5xx → 同网络错误处理(瞬态不缓存,重试)', async () => {
  const calls = []
  const probe = createImpersonationProbe({ ...ON, requestKubernetes: async () => { calls.push(1); throw Object.assign(new Error('boom'), { status: 502 }) } })
  assert.equal(await probe.ensureProbed(sess()), false)
  assert.equal(probe.isProbed('c1'), undefined)
  await probe.ensureProbed(sess())
  assert.equal(calls.length, 2)
})

test('probe:不同 clusterId 独立探测;无 clusterId 不发探测直接 false', async () => {
  const calls = []
  const probe = createImpersonationProbe({ ...ON, requestKubernetes: async (s) => { calls.push(s.clusterId); return { status: 200 } } })
  assert.equal(await probe.ensureProbed(sess()), true)
  assert.equal(await probe.ensureProbed(sess({ clusterId: 'c2' })), true)
  assert.deepEqual(calls.sort(), ['c1', 'c2'])
  assert.equal(await probe.ensureProbed(sess({ clusterId: undefined })), false)
  assert.equal(calls.length, 2, '无 clusterId 不产生请求')
})

test('probe:并发 ensureProbed 共享同一 in-flight 探测(不重复打 apiserver)', async () => {
  let release
  const calls = []
  const probe = createImpersonationProbe({ ...ON, requestKubernetes: () => { calls.push(1); return new Promise(r => { release = r }) } })
  const p1 = probe.ensureProbed(sess())
  const p2 = probe.ensureProbed(sess())
  release({ status: 200 })
  assert.deepEqual(await Promise.all([p1, p2]), [true, true])
  assert.equal(calls.length, 1)
})

// ===== connect-cluster 接线(auth-selfservice 同款工厂) =====

function makeRoutes(db, over = {}) {
  const sent = []
  const persisted = []
  const probed = []
  const deps = {
    db, sendJson: (_res, status, payload) => sent.push({ status, payload }),
    readBody: async () => deps._body,
    requirePlatform: (req) => req._ps,
    platformSessions: new Map(db.prepare('SELECT * FROM platform_sessions').all().map(r => [r.token, r])),
    sessions: new Map(),
    persistSession: (token, session) => persisted.push({ token, session }),
    verifyPassword: () => true, hashPassword: (p) => `hashed(${p})`,
    randomUUID: () => 'uuid-x',
    normalizeServer: (s) => new URL(s), buildCallContext: () => ({ apiServer: new URL('https://k8s.local') }),
    requestKubernetes: async () => ({ body: { gitVersion: 'v1.30.0' } }),
    checkLoginRate: () => ({ allowed: true }),
    writeAudit: () => {}, extractPlatformToken: (req) => req.headers['x-platform-token'] || '',
    impersonationProbe: { ensureProbed: (s) => { probed.push(s); return Promise.resolve(true) } },
    ...over,
  }
  Object.assign(deps, over)
  const router = createAuthRoutes(deps)
  const wrapper = { get routes() { return router } }
  Object.defineProperty(wrapper, '_body', { get() { return deps._body }, set(v) { deps._body = v } })
  return { routes: wrapper, sent, persisted, probed, deps }
}

async function connect(routes, ps, body = { clusterId: 'c1' }) {
  routes._body = body
  return routes.routes.handle(
    { method: 'POST', headers: { 'x-platform-token': ps.token }, url: '/api/connect-cluster', _ps: ps }, {},
    new URL('/api/connect-cluster', 'http://x'))
}

test('connect-cluster:k8sSession 携带 impersonate 身份(u-+组)与可读名;探测 fire-and-forget 一次', async () => {
  const db = makeDb(); seed(db)
  const ps = db.prepare('SELECT * FROM platform_sessions WHERE token=?').get('t-me')
  const { routes, sent, persisted, probed } = makeRoutes(db)
  await connect(routes, ps)
  assert.equal(sent[0].status, 200)
  assert.equal(persisted.length, 1)
  const { session } = persisted[0]
  assert.deepEqual(session.impersonate, ['aliangboard:u-u1', 'aliangboard:team-g1', 'aliangboard:team-g2'])
  assert.equal(session.impersonateDisplayname, 'Alice')
  assert.equal(probed.length, 1)
  assert.equal(probed[0].impersonate?.[0], 'aliangboard:u-u1', '探测吃到的就是签发的 session')
})

test('connect-cluster:admin 平台用户同样携带 impersonate(R3)', async () => {
  const db = makeDb(); seed(db)
  const ps = db.prepare('SELECT * FROM platform_sessions WHERE token=?').get('t-admin')
  const { routes, persisted, probed } = makeRoutes(db)
  await connect(routes, ps)
  assert.deepEqual(persisted[0].session.impersonate, ['aliangboard:u-ua'])
  assert.equal(probed.length, 1)
})

test('connect-cluster:legacy 无归属 ps(userId 空)→ impersonate 空数组,不触发探测', async () => {
  const db = makeDb(); seed(db)
  const ps = db.prepare('SELECT * FROM platform_sessions WHERE token=?').get('t-legacy')
  const { routes, sent, persisted, probed } = makeRoutes(db)
  await connect(routes, ps)
  assert.equal(sent[0].status, 200)
  assert.deepEqual(persisted[0].session.impersonate, [])
  assert.equal(probed.length, 0, '无身份即无探测')
})

// ===== Task 2:mergeImpersonate(egress 注入纯函数,requestOnce 形状) =====

test('mergeImpersonate:probed=true + 有身份 → 注入(就地 mutate 并返回同一对象)', () => {
  const headers = { accept: 'application/json' }
  const out = mergeImpersonate(headers, sess(), true)
  assert.equal(out, headers, '返回同一 headers 对象(requestOnce 单点调用)')
  assert.equal(headers['impersonate-user'], 'aliangboard:u-u1')
  assert.deepEqual(headers['impersonate-group'], ['aliangboard:team-g1'])
  assert.equal(headers['impersonate-extra-displayname'], 'Alice')
})

test('mergeImpersonate:probed=false/undefined → 不注(探测未过/未知一律保守不注)', () => {
  for (const probed of [false, undefined]) {
    const headers = { accept: 'application/json' }
    mergeImpersonate(headers, sess(), probed)
    assert.deepEqual(headers, { accept: 'application/json' })
  }
})

test('mergeImpersonate:无身份(空数组/undefined/缺字段)→ 恒不注', () => {
  for (const session of [{}, { impersonate: [] }, { impersonate: undefined }]) {
    const headers = {}
    mergeImpersonate(headers, session, true)
    assert.deepEqual(headers, {})
  }
})

test('mergeImpersonate:显式已有 impersonate 头不被覆盖(调用方显式语义优先)', () => {
  const headers = { 'impersonate-user': 'explicit' }
  mergeImpersonate(headers, sess(), true)
  assert.equal(headers['impersonate-user'], 'explicit', '探测请求自带 impersonate 头时不能被覆盖')
})

// ===== Task 2:probe.kick(egress 懒探测,fire-and-forget) =====

test('kick:cache 无条目 → 发起;在途/已决 → 不重复;无身份/无 clusterId → 不发', async () => {
  const calls = []
  let release
  const probe = createImpersonationProbe({ ...ON, requestKubernetes: () => { calls.push(1); return new Promise(r => { release = r }) } })
  probe.kick(sess())                          // cache 无条目 → 发起
  probe.kick(sess())                          // 在途 → 去重
  assert.equal(calls.length, 1)
  release({ status: 200 })
  assert.equal(await probe.ensureProbed(sess()), true)
  probe.kick(sess())                          // 已决 → 不再发
  assert.equal(calls.length, 1)
  probe.kick(sess({ clusterId: undefined }))  // 无 clusterId → 不发
  probe.kick(sess({ impersonate: [] }))       // 无身份 → 不发
  assert.equal(calls.length, 1)
})

test('kick:fire-and-forget 恒不抛;网络错误失败不落缓存(可重试),403 落 false 缓存', async () => {
  for (const [mkErr, cached] of [
    [() => new Error('boom'), undefined],
    [() => Object.assign(new Error('forbidden'), { status: 403 }), false],
  ]) {
    const probe = createImpersonationProbe({ ...ON, requestKubernetes: async () => { throw mkErr() } })
    probe.kick(sess())
    await new Promise(r => setImmediate(r))
    assert.equal(probe.isProbed('c1'), cached)
  }
})
