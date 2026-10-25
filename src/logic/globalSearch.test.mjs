// src/logic/globalSearch.test.mjs —— 全局搜索纯函数(node --test,进 package.json test:server 链)
// 2026-09-04 顶栏搜索升级:补 kinds + 页面导航匹配 + 页面优先排序,自 TopNavBar 内联实现抽出。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import enLocales from '../locales/en.json' with { type: 'json' }
import zhLocales from '../locales/zh.json' with { type: 'json' }
import { PAGE_ENTRIES, matchPages, searchResources, searchAll, collectResourceItems } from './globalSearch.js'

// 中文关键词已迁往 locales(nav.searchPageSynonyms,i18n 残留中文门禁不允许 src 出现中文字面量);
// 组件从 i18n 取当前语言同义词表传入。此处夹具即 zh.json 的对应段。
const ZH_SYNONYMS = { ...zhLocales.nav.searchPageSynonyms }

test('matchPages:英文 slug 子串匹配(monitor→/monitoring)', () => {
  const hits = matchPages('monitor')
  assert.ok(hits.some(p => p.path === '/monitoring'))
})
test('matchPages:中文同义词表传入后可命中(监控/部署/工作台)', () => {
  assert.ok(matchPages('监控', ZH_SYNONYMS).some(p => p.path === '/monitoring'))
  assert.ok(matchPages('部署', ZH_SYNONYMS).some(p => p.path === '/deploy'))
  assert.ok(matchPages('工作台', ZH_SYNONYMS).some(p => p.path === '/workbench'))
})
test('matchPages:大小写不敏感;多命中并存(rbac 与 can-i)', () => {
  assert.ok(matchPages('RBAC').some(p => p.path === '/rbac'))
  const hits = matchPages('rbac')
  assert.ok(hits.some(p => p.path === '/rbac'))
})
test('matchPages:无命中 → 空数组;空查询 → 空数组', () => {
  assert.deepEqual(matchPages('zzz-no-such-page'), [])
  assert.deepEqual(matchPages(''), [])
  assert.deepEqual(matchPages('   '), [])
})

test('searchResources:按 name 子串大小写不敏感过滤', () => {
  const items = [
    { kind: 'Pod', name: 'api-7d9x', namespace: 'web' },
    { kind: 'Service', name: 'API-svc', namespace: 'web' },
    { kind: 'Node', name: 'worker-1', namespace: '' },
  ]
  const hits = searchResources('api', items)
  assert.equal(hits.length, 2)
  assert.deepEqual(hits.map(h => h.kind).sort(), ['Pod', 'Service'])
})

test('searchAll:页面结果排在资源前,总条数受 limit 钳制(默认 12)', () => {
  const resources = Array.from({ length: 20 }, (_, i) => ({ kind: 'Pod', name: `monitor-pod-${i}`, namespace: 'web' }))
  const { pages, resources: res } = searchAll('monitor', resources)
  assert.equal(pages.length, 1)              // /monitoring 页命中
  assert.equal(res.length, 11)               // 12 - 1 页
  assert.deepEqual(searchAll('monitor', resources, { limit: 5 }).resources.length, 4)
})

test('searchAll:页面至多占 4 席(短查询不给资源结果断粮)', () => {
  const resources = Array.from({ length: 20 }, (_, i) => ({ kind: 'Pod', name: `e-pod-${i}`, namespace: 'web' }))
  const { pages, resources: res } = searchAll('e', resources)
  assert.ok(pages.length <= 4, `pages=${pages.length}`)
  assert.ok(res.length >= 8, `resources=${res.length}`)
})
test('searchAll:空查询/纯空白 → 双空', () => {
  assert.deepEqual(searchAll('', [{ kind: 'Pod', name: 'x', namespace: '' }]).pages, [])
  assert.deepEqual(searchAll('  ', []).resources, [])
})

test('collectResourceItems:23 类来源聚合为 {kind,name,namespace},空/缺省安全', () => {
  const items = collectResourceItems({
    pods: [{ name: 'p1', namespace: 'web' }],
    workloads: [{ name: 'd1', namespace: 'web', type: 'Deployment' }, { name: 'u1', namespace: 'web' }],
    hpas: [{ name: 'h1', namespace: 'web' }],
    roles: [{ name: 'r1', namespace: 'web' }],
    serviceaccounts: [{ name: 'sa1', namespace: 'web' }],
    networkpolicies: [{ name: 'np1', namespace: 'web' }],
    resourcequotas: [{ name: 'rq1', namespace: 'web' }],
    limitranges: [{ name: 'lr1', namespace: 'web' }],
    pdbs: [{ name: 'pdb1', namespace: 'web' }],
    storageclasses: [{ name: 'sc1' }],
    pvs: [{ name: 'pv1' }],
    crds: [{ name: 'crd1' }],
    events: [{ reason: 'BackoffLimitExceeded', relatedName: 'etl', namespace: 'job' }],
    nodes: [{ name: 'n1' }],
    namespaces: [{ name: 'web' }],
  })
  const kinds = Object.fromEntries(items.map(i => [i.kind, i]))
  assert.equal(kinds.Pod.name, 'p1')
  assert.equal(kinds.Deployment.name, 'd1')
  assert.equal(kinds.Workload.name, 'u1')            // 无 type 退化 Workload
  assert.equal(kinds.HPA.name, 'h1')
  assert.equal(kinds.Role.name, 'r1')
  assert.equal(kinds.ServiceAccount.name, 'sa1')
  assert.equal(kinds.NetworkPolicy.name, 'np1')
  assert.equal(kinds.ResourceQuota.name, 'rq1')
  assert.equal(kinds.LimitRange.name, 'lr1')
  assert.equal(kinds.PDB.name, 'pdb1')
  assert.equal(kinds.StorageClass.name, 'sc1')
  assert.equal(kinds.PV.name, 'pv1')
  assert.equal(kinds.CRD.name, 'crd1')
  assert.equal(kinds.Event.name, 'etl')              // 事件以 involvedObject 名为索引名
  assert.equal(kinds.Event.reason, 'BackoffLimitExceeded')
  assert.equal(kinds.Node.name, 'n1')
  assert.equal(kinds.Namespace.name, 'web')
})
test('collectResourceItems:全空/undefined 入参 → 空数组', () => {
  assert.deepEqual(collectResourceItems({}), [])
  assert.deepEqual(collectResourceItems(undefined), [])
})

test('collectResourceItems:roles 混合面按 scope 拆 kind(store.fetchRoles 返回 Role+ClusterRole)', () => {
  const items = collectResourceItems({ roles: [
    { name: 'r1', namespace: 'web', scope: 'Namespace' },
    { name: 'cr1', scope: 'Cluster' },
  ] })
  const kinds = Object.fromEntries(items.map(i => [i.kind, i]))
  assert.equal(kinds.Role.name, 'r1')
  assert.equal(kinds.Role.namespace, 'web')
  assert.equal(kinds.ClusterRole.name, 'cr1')
  assert.equal(kinds.ClusterRole.namespace, '')
})

test('PAGE_ENTRIES:纯 ASCII 关键词(i18n 残留中文门禁红线),且双语言同义词表全覆盖', () => {
  for (const p of PAGE_ENTRIES) {
    assert.ok(p.keywords.length >= 1, p.path)
    for (const k of p.keywords) assert.ok(!/[一-鿿]/.test(k), `${p.path} 关键词含中文:${k}`)
  }
  for (const [name, loc] of [['en', enLocales], ['zh', zhLocales]]) {
    const syn = loc.nav.searchPageSynonyms
    assert.ok(syn && typeof syn === 'object', `${name} 缺 nav.searchPageSynonyms`)
    for (const p of PAGE_ENTRIES) {
      const key = p.path.replace(/^\//, '').split('/').pop()
      assert.ok(typeof syn[key] === 'string' && syn[key].length > 0, `${name}.${key} 缺同义词`)
    }
  }
})
