// W2 Phase C (Task 5): wb 工具执行面授权门。
// buildWbCtx 嵌在 index.mjs 的 handle 闭包内(import 即起服务,无法直测)——按
// workbench-ctx-wiring.test.mjs 先例分两层:
//   ① 纯逻辑层:authz.mjs 的 wbToolGate(check/clusterWide/namespaces)真库夹具测;
//   ② 接线层:静态源码守卫——buildWbCtx 必须构造 gate,ns 型工具必须首行调 gate。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wbToolGate, gateApplyNamespaces, canAccessNs } from './authz.mjs'
import { makeAuthzDb } from './authz.test.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

// ============ ① 纯逻辑层:wbToolGate ============

// 夹具同款(authz.test.mjs 的 seedGrants 未导出,本地复刻):
// c1=allowlist(u1=team-a:view + 组 team-b:operate,u2=team-b:operate,a1=admin)、c2=open(u1 分配)
function fixture() {
  const db = makeAuthzDb()
  const ins = {
    user: db.prepare('INSERT INTO platform_users VALUES (?,?,?,?,?)'),
    cluster: db.prepare('INSERT INTO clusters VALUES (?,?,?,?)'),
    uc: db.prepare('INSERT INTO user_clusters VALUES (?,?)'),
    grant: db.prepare('INSERT INTO ns_grants VALUES (?,?,?,?,?,?,?,?)'),
  }
  ins.user.run('u1', 'user1', 'user', 0, 1)
  ins.user.run('u2', 'user2', 'user', 0, 1)
  ins.user.run('a1', 'admin1', 'admin', 0, 1)
  ins.cluster.run('c1', 'allowlist-one', 'https://k8s', 'allowlist')
  ins.cluster.run('c2', 'open-one', 'https://k8s', 'open')
  ins.uc.run('u1', 'c1')
  ins.uc.run('u1', 'c2')
  ins.uc.run('u2', 'c1')
  ins.grant.run('n1', 'user', 'u1', 'c1', 'team-a', 'view', 'root', 1)
  ins.grant.run('n3', 'user', 'u2', 'c1', 'team-b', 'operate', 'root', 1)
  return db
}

test('wbToolGate.check: allowlist 下 view/operate 分档拒不足档', () => {
  const db = fixture()
  const g = wbToolGate(db, { userId: 'u2', role: 'user' }, 'c1')
  g.check('team-b', 'view', 'wb_top')
  g.check('team-b', 'operate', 'wb_exec')
  assert.throws(() => g.check('team-a', 'view', 'wb_get_pod_logs'), /PERMISSION_DENIED/)
})

test('wbToolGate.check: u1(仅 team-a view) team-b 读写均拒', () => {
  const db = fixture()
  const g = wbToolGate(db, { userId: 'u1', role: 'user' }, 'c1')
  g.check('team-a', 'view', 'wb_get_pod_logs')
  assert.throws(() => g.check('team-a', 'operate', 'wb_scale'), /PERMISSION_DENIED: rbac/)
  assert.throws(() => g.check('team-b', 'view', 'wb_get_pod_logs'), /PERMISSION_DENIED: rbac/)
})

test('wbToolGate.check: open 集群全通 / admin 全通', () => {
  const db = fixture()
  for (const [principal, cid] of [[{ userId: 'u1', role: 'user' }, 'c2'], [{ userId: 'a1', role: 'admin' }, 'c1']]) {
    const g = wbToolGate(db, principal, cid)
    g.check('team-a', 'view', 't')
    g.check('team-b', 'operate', 't')
    g.check('anything-else', 'operate', 't')
  }
})

test('wbToolGate.check: 拒绝错误形状 = PermissionDeniedError(code/reason/tool/ns)', () => {
  const db = fixture()
  const g = wbToolGate(db, { userId: 'u1', role: 'user' }, 'c1')
  try { g.check('team-b', 'view', 'wb_get_pod_logs'); assert.fail('should throw') }
  catch (e) {
    assert.equal(e.code, 'PERMISSION_DENIED')
    assert.equal(e.reason, 'rbac')
    assert.equal(e.tool, 'wb_get_pod_logs')
    assert.equal(e.ns, 'team-b')
  }
})

test('wbToolGate.clusterWide: allowlist 非 admin 拒 / open 与 admin 放行', () => {
  const db = fixture()
  assert.throws(() => wbToolGate(db, { userId: 'u1', role: 'user' }, 'c1').clusterWide('wb_top'), /PERMISSION_DENIED/)
  wbToolGate(db, { userId: 'u1', role: 'user' }, 'c2').clusterWide('wb_top') // open
  wbToolGate(db, { userId: 'a1', role: 'admin' }, 'c1').clusterWide('wb_top') // admin
})

test('wbToolGate.namespaces: open/admin → null(不限);allowlist → 授权 ns 集合;未分配 → 空集', () => {
  const db = fixture()
  assert.equal(wbToolGate(db, { userId: 'u1', role: 'user' }, 'c2').namespaces(), null)
  assert.equal(wbToolGate(db, { userId: 'a1', role: 'admin' }, 'c1').namespaces(), null)
  assert.deepEqual([...wbToolGate(db, { userId: 'u1', role: 'user' }, 'c1').namespaces()], ['team-a'])
  assert.deepEqual([...wbToolGate(db, { userId: 'u2', role: 'user' }, 'c1').namespaces()], ['team-b'])
  // u2 未分配 c2 → 空 Set(canAccessCluster 先拒,namespaces 不得放大权限)
  assert.deepEqual([...wbToolGate(db, { userId: 'u2', role: 'user' }, 'c2').namespaces()], [])
})

test('wbToolGate: clusterId 空(未绑定项目)→ 零门(工具自然失败)', () => {
  const db = fixture()
  const g = wbToolGate(db, { userId: 'u1', role: 'user' }, '')
  g.check('team-b', 'operate', 'wb_exec')
  g.clusterWide('wb_top')
  g.check(undefined, 'view', 'wb_list')
})

// ===== Job 2(wb_apply 门):applyManifests 的逐文档 ns 决策 =====
// docNss 元素语义与 /api/apply 门同源(resolveApplyNamespaces):string=namespaced ns、
// undefined=集群级 kind、null=不可发现(不拦,applyYaml 以原语义失败)。

test('gateApplyNamespaces:string→check operate;undefined→clusterWide;null→跳过', () => {
  const seen = []
  const fakeGate = {
    check: (ns, level, tool) => seen.push(['check', ns, level, tool]),
    clusterWide: tool => seen.push(['clusterWide', tool]),
  }
  gateApplyNamespaces(fakeGate, ['team-a', undefined, null, 'team-b'])
  assert.deepEqual(seen, [
    ['check', 'team-a', 'operate', 'wb_apply'],
    ['clusterWide', 'wb_apply'],
    ['check', 'team-b', 'operate', 'wb_apply'],
  ])
})

test('gateApplyNamespaces:拒绝透传(check 抛即停)+ 空文档清单零调用', () => {
  const fakeGate = { check: () => { throw new Error('PERMISSION_DENIED: rbac') }, clusterWide: () => {} }
  assert.throws(() => gateApplyNamespaces(fakeGate, ['team-a', 'team-b']), /PERMISSION_DENIED/)
  const seen = []
  const okGate = { check: (...a) => seen.push(a), clusterWide: () => seen.push('cw') }
  gateApplyNamespaces(okGate, [])
  assert.equal(seen.length, 0)
})

test('接线守卫:applyManifests 实现体内先 resolveApplyNamespaces 过门再 apply', () => {
  const m = region.match(/applyManifests: async \(yaml\)[\s\S]*?\n {8}},/)
  assert.ok(m, '未截取到 applyManifests 实现体')
  assert.match(m[0], /resolveApplyNamespaces\(/, 'applyManifests 必须先解析逐文档 ns(与 /api/apply 门同源)')
  assert.match(m[0], /gateApplyNamespaces\(gate,/, 'applyManifests 必须经 gateApplyNamespaces 逐文档 operate 门')
  assert.ok(m[0].indexOf('gateApplyNamespaces') < m[0].indexOf('applyYamlPartial'), '门必须在 applyYamlPartial 之前')
})

// ============ ② 接线层:静态源码守卫(index.mjs buildWbCtx 必须接门) ============

const src = readFileSync(join(HERE, 'index.mjs'), 'utf8')
const regionMatch = src.match(/function buildWbCtx\([\s\S]*?\n {2}\}/)
const region = regionMatch ? regionMatch[0] : ''

test('守卫前置:buildWbCtx 函数体可截取', () => {
  assert.ok(regionMatch, '未匹配到 buildWbCtx 函数体——签名/缩进层级变了,请更新本守卫')
})

test('buildWbCtx 构造 wbToolGate(principal 从参数线程进来)', () => {
  assert.match(region, /wbToolGate\(db,\s*principal,\s*project\.clusterId\)/, 'buildWbCtx 必须用 (db, principal, project.clusterId) 构造 gate——principal 由 run/resume 的 actor 线程传入')
})

// 每个 ns 型工具实现体内必须有 gate 调用(check/clusterWide/checkKind)。
const TOOL_GATES = [
  ['listResources', /gate\.(check|clusterWide|namespaces)\(|gateKind\(/],
  ['getPodLogs', /gate\.check\(/],
  ['readPodFile', /gate\.check\(/],
  ['describeResource', /gate\.(check|clusterWide)\(|gateKind\(/],
  ['getResource', /gate\.(check|clusterWide)\(|gateKind\(/],
  ['getEvents', /gate\.check\(/],
  ['rolloutStatus', /gate\.check\(/],
  ['topUsage', /gate\.(check|clusterWide)\(/],
  ['scale:', /gate\.check\(/],
  ['restart:', /gate\.check\(/],
  ['updateImage', /gate\.check\(/],
  ['rolloutUndo', /gate\.check\(/],
  ['execInPod', /gate\.check\(/],
]
test('全部 ns 型 wb 工具实现体内接线 gate(新增 K8s 工具时同步登记)', () => {
  for (const [name, re] of TOOL_GATES) {
    const m = region.match(new RegExp(`${name}[\\s\\S]*?\\n {8}},`))
    assert.ok(m, `未截取到工具实现体: ${name}`)
    assert.match(m[0], re, `${name} 实现体内缺少 gate 调用——每个 ns 型工具必须在 K8s 出站前过 canAccessNs`)
  }
})

// workbench-agent 必须把 actor 线程进 buildWbCtx(detached runner 才有 principal 可执法)
const agentSrc = readFileSync(join(HERE, 'workbench-agent.mjs'), 'utf8')
test('run/resume 两处 buildWbCtx 调用都线程 principal', () => {
  const calls = agentSrc.match(/buildWbCtx\(project[^)]*\)/g) || []
  assert.ok(calls.length >= 2, 'buildWbCtx 调用点少于 2(run/resume 各一)')
  for (const c of calls) assert.match(c, /principal/, `调用点未传 principal: ${c}`)
})
