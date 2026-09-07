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

// 终审 2026-09-06 修复:clusterWide 也须过集群分配门(canAccessCluster)——
// 未分配 principal 即便在 open 集群上也拿不到集群级清单(wb_top nodes 等)。
test('wbToolGate.clusterWide:未分配 user_clusters 的 principal 在 open 集群也拒', () => {
  const db = fixture()
  // u2 未分配 c2(夹具只给 u1 分配了 c2)
  assert.throws(() => wbToolGate(db, { userId: 'u2', role: 'user' }, 'c2').clusterWide('wb_top'), /PERMISSION_DENIED/)
})

// F4(authz-entitlement-03,2026-09-07 审计):bootstrap_ledger = 全集群 14 维 survey + 重写
// 台账 INDEX.md,集群级面——此前零授权门,allowlist 非 admin 可经对话触发,与 wb_top nodes
// 的 clusterWide 拒绝语义不一致。补门后同判:open/admin 放行,allowlist 非 admin 拒
// (PermissionDeniedError → agent 循环 formatToolError 转工具失败错误面,AI 可读不再重试)。
test('wbToolGate.clusterWide:bootstrap_ledger 集群级门(allowlist 非 admin 拒 / admin·open 放行)', () => {
  const db = fixture()
  assert.throws(() => wbToolGate(db, { userId: 'u1', role: 'user' }, 'c1').clusterWide('wb_bootstrap_ledger'), /PERMISSION_DENIED: rbac/)
  try { wbToolGate(db, { userId: 'u1', role: 'user' }, 'c1').clusterWide('wb_bootstrap_ledger'); assert.fail('should throw') }
  catch (e) { assert.equal(e.tool, 'wb_bootstrap_ledger'); assert.equal(e.reason, 'rbac') }
  wbToolGate(db, { userId: 'a1', role: 'admin' }, 'c1').clusterWide('wb_bootstrap_ledger') // admin(allowlist 亦放行)
  wbToolGate(db, { userId: 'u1', role: 'user' }, 'c2').clusterWide('wb_bootstrap_ledger') // open
})

// W2 审计 P0-③(2026-09-07):read_ledger 的集群 entitlement 档——与 HTTP 面 GET /api/workbench/ledger
// 的 clusterEntitled 同判(canAccessCluster 单源:admin 放行 / 须 user_clusters 分配 / 禁用拒)。
// 台账 INDEX.md 是全集群 14 维 survey:分配内用户可读(HTTP 面既有语义,知识库=平台级资产裁决 §6.2 D),
// 未分配/禁用 principal 拒——工具面不得成为绕过 entitlement 的第二通道。
test('wbToolGate.entitled:集群 entitlement 档(分配即放行 / 未分配·禁用拒 / admin 放行)', () => {
  const db = fixture()
  wbToolGate(db, { userId: 'u1', role: 'user' }, 'c1').entitled('read_ledger') // 已分配(哪怕仅 team-a view)
  wbToolGate(db, { userId: 'u2', role: 'user' }, 'c1').entitled('read_ledger') // u2 同样分配 c1
  wbToolGate(db, { userId: 'a1', role: 'admin' }, 'c1').entitled('read_ledger')
  assert.throws(() => wbToolGate(db, { userId: 'u2', role: 'user' }, 'c2').entitled('read_ledger'), /PERMISSION_DENIED: rbac/, 'u2 未分配 c2')
  db.prepare(`UPDATE platform_users SET disabled=1 WHERE id='u1'`).run()
  assert.throws(() => wbToolGate(db, { userId: 'u1', role: 'user' }, 'c1').entitled('read_ledger'), /PERMISSION_DENIED/, '禁用即拒(现查)')
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
// undefined=集群级 kind、null=不可发现。
// W2 审计 P1-6(2026-09-07):null 不再放行。原「applyYaml 以原语义失败,无法 apply 即无
// 绕过」被瞬态失败证伪——resolve 阶段 discovery 瞬时故障 push null,紧随的 apply 阶段重试
// discovery(失败不进缓存)成功 → 写未过门出站。fail-closed:无法核实 ns 的文档一律拒
// (kind 拼错本来也无法 apply,语义等价;瞬态故障重试可恢复)。

test('gateApplyNamespaces:string→check operate;undefined→clusterWide;null→拒(fail-closed)', () => {
  const seen = []
  const fakeGate = {
    check: (ns, level, tool) => seen.push(['check', ns, level, tool]),
    clusterWide: tool => seen.push(['clusterWide', tool]),
  }
  gateApplyNamespaces(fakeGate, ['team-a', undefined, 'team-b'])
  assert.deepEqual(seen, [
    ['check', 'team-a', 'operate', 'wb_apply'],
    ['clusterWide', 'wb_apply'],
    ['check', 'team-b', 'operate', 'wb_apply'],
  ])
  // null(不可发现):必须 throw policy(fail-closed),不得静默放行
  assert.throws(() => gateApplyNamespaces(fakeGate, [null]), (e) => {
    assert.equal(e.code, 'PERMISSION_DENIED')
    assert.equal(e.reason, 'policy')
    return true
  })
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

// W2 审计 P1-6(2026-09-07):HTTP /api/apply 的逐文档循环同样不得跳过 null(不可发现)——
// 瞬态 discovery 失败 + apply 阶段重试成功 = 未过门写。三面(HTTP apply / wb applyManifests /
// reconcile)统一 fail-closed。外层空 catch(仅可达于无效 YAML)保留:无效 YAML 本就无法写。
test('接线守卫:HTTP /api/apply 逐文档循环不得 continue 跳过 null(不可发现)', () => {
  const m = src.match(/const \{ resources, applied, failed, total \} = await applyYaml\(/)
  assert.ok(m, '未定位到 /api/apply 的 applyYaml 调用(结构漂移请同步守卫)')
  const loop = src.slice(Math.max(0, m.index - 1200), m.index)
  assert.doesNotMatch(loop, /if \(ns === null\) continue/, '/api/apply 不得放行不可发现文档(null 须 403,fail-closed)')
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
// bootstrapLedger 是集群级面(F4):实现体首行 gate.clusterWide(与 wb_top nodes 同判)。
const TOOL_GATES = [
  ['listResources', /gate\.(check|clusterWide|namespaces)\(|gateKind\(/],
  ['bootstrapLedger', /gate\.clusterWide\(/],
  ['readLedger', /gate\.entitled\(/],
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

// F4 接线守卫(authz-entitlement-03,专属):bootstrapLedger 此前零授权门。通用 TOOL_GATES 扫描
// 对「单行闭包」会前向误匹配后续工具体内的 gate 调用(假绿),故锚定闭包开头精确断言顺序:
// gate.clusterWide 必须先于实际 survey 调用(bootstrapLedgerForCluster)——拒绝先于副作用。
test('接线守卫:bootstrapLedger 闭包先过 clusterWide 门再 survey(集群级面授权)', () => {
  const m = region.match(/bootstrapLedger: async \(\) => \{([\s\S]*?)bootstrapLedgerForCluster\(/)
  assert.ok(m, '未截取到 bootstrapLedger 闭包体(签名变了请同步守卫)')
  assert.match(m[1], /gate\.clusterWide\('wb_bootstrap_ledger'\)/, 'bootstrapLedger 必须在 survey 前过 gate.clusterWide——集群级面,allowlist 非 admin 拒')
})

// workbench-agent 必须把 actor 线程进 buildWbCtx(detached runner 才有 principal 可执法)
const agentSrc = readFileSync(join(HERE, 'workbench-agent.mjs'), 'utf8')
test('run/resume 两处 buildWbCtx 调用都线程 principal', () => {
  const calls = agentSrc.match(/buildWbCtx\(project[^)]*\)/g) || []
  assert.ok(calls.length >= 2, 'buildWbCtx 调用点少于 2(run/resume 各一)')
  for (const c of calls) assert.match(c, /principal/, `调用点未传 principal: ${c}`)
})

// W2 审计 P0-①(2026-09-07):授权主体必须从 project.ownerId 派生,不得用触发 actor——
// admin 审批/代触发他人对话时若以 actor 为 principal,一次审批即解锁 admin 全权(队列剩余
// 工具全部按 admin 判权),违反 spec §6.3「审批/续跑统一以 conv→project.ownerId 为准」。
test('run/resume 的 principal 恒从 project.ownerId 派生(不以触发 actor 为授权主体)', () => {
  const derives = agentSrc.match(/const principal = \{ userId: project\.ownerId \}/g) || []
  assert.equal(derives.length, 2, 'run/resume 两处 principal 都必须从 project.ownerId 派生')
  assert.doesNotMatch(agentSrc, /const principal = \{ userId: actor\?\.userId/, '触发 actor 只作审计留痕,不得进入授权链')
})

// W2 审计 P1-5(2026-09-07):wb_read_pod_file 实现是 exec(cat),与 wb_exec 同为「容器内拉起
// 进程」语义——authz 的 SUBRESOURCE_OPERATE 把 exec/log 恒判 operate,wb_exec 也恒 operate,
// 唯独它用 view 档(view-only 用户可在容器内跑进程;safePodPath/podPathDenied 只是路径缓解)。
test('接线守卫:readPodFile 门档位必须是 operate(exec 语义,与 wb_exec/HTTP 面同口径)', () => {
  const m = region.match(/readPodFile: async \(args\) => \{([\s\S]*?)execCapture\(/)
  assert.ok(m, '未截取到 readPodFile 闭包体(签名变了请同步守卫)')
  assert.match(m[1], /gate\.check\(args\.namespace, 'operate', 'wb_read_pod_file'\)/, 'readPodFile 过 cat-via-exec,门必须 operate 档')
})

// W2 审计 P0-③(2026-09-07 专属):readLedger 此前零授权门——ledger INDEX.md 是全集群 14 维
// survey(全部 namespaces/nodes/集群级 kind/全 ns 工作负载),只授单 ns view 的 principal 绑项目
// 即可经对话免审拿到全集群清单。补门后与 HTTP 面(GET /api/workbench/ledger 的 clusterEntitled)
// 同判;锚定闭包开头精确断言顺序:gate.entitled 必须先于 wbReadFile(读先于门=门形同虚设)。
test('接线守卫:readLedger 闭包先过 entitled 门再读台账', () => {
  const m = region.match(/readLedger: async \(\) => \{([\s\S]*?)wbReadFile\(/)
  assert.ok(m, '未截取到 readLedger 闭包体(签名变了请同步守卫)')
  assert.match(m[1], /gate\.entitled\('read_ledger'\)/, 'readLedger 必须在读 INDEX.md 前过 gate.entitled——集群 entitlement 档,与 HTTP 面同判')
})
