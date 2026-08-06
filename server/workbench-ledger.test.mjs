// W3 台账纯函数测试:verifiedAt / groupWorkloads / formatIndexMd。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { verifiedAt, groupWorkloads, formatIndexMd } from './workbench-ledger.mjs'

test('verifiedAt:YYYY-MM-DD', () => {
  assert.equal(verifiedAt(new Date('2026-08-06T03:00:00Z')), '2026-08-06')
})

const mk = (kind, name, ns, extra = {}) => ({ metadata: { name, namespace: ns, kind }, ...extra })

test('groupWorkloads:按 ns 分组 deployments/services/ingresses(ingress 取 host)', () => {
  const wl = groupWorkloads(
    [mk('Deployment', 'nginx', 'default'), mk('Deployment', 'api', 'payments')],
    [mk('Service', 'nginx', 'default'), mk('Service', 'api-svc', 'payments')],
    [{ metadata: { name: 'ing1', namespace: 'default' }, spec: { rules: [{ host: 'app.example.com' }] } }],
  )
  assert.deepEqual(Object.keys(wl).sort(), ['default', 'payments'])
  assert.deepEqual(wl.default.deployments, ['nginx'])
  assert.deepEqual(wl.default.services, ['nginx'])
  assert.deepEqual(wl.default.ingresses, ['app.example.com'])
  assert.deepEqual(wl.payments.deployments, ['api'])
})

test('formatIndexMd:含 cluster 名 / verified_at / namespace 列表 / 工作负载分组;null 项优雅降级', () => {
  const md = formatIndexMd({
    clusterName: 'prod', apiServer: 'https://10.0.0.1', verifiedAt: '2026-08-06',
    namespaces: [mk('Namespace', 'default', undefined), mk('Namespace', 'kube-system', undefined)],
    nodes: null,
    ingressClasses: [mk('IngressClass', 'nginx', undefined)],
    storageClasses: null,
    deployments: [mk('Deployment', 'nginx', 'default')],
    services: [mk('Service', 'nginx', 'default')],
    ingresses: [],
  })
  assert.ok(md.includes('# prod 能力地图'), '标题')
  assert.ok(md.includes('verified_at: 2026-08-06'), 'verified_at')
  assert.ok(md.includes('cluster: https://10.0.0.1'), 'apiServer')
  assert.ok(md.includes('- default') && md.includes('- kube-system'), 'namespace 列表')
  assert.ok(md.includes('IngressClasses') && md.includes('- nginx'), 'ingress class')
  assert.ok(!md.includes('StorageClasses') || md.includes('_(无)_'), 'storageClasses null → 不出现该节(null 节略过)')
  assert.ok(md.includes('### default') && md.includes('Deployments: nginx'), '工作负载分组')
  // nodes=null → 不出现节点节
  assert.ok(!md.includes('## 节点'), 'nodes null → 略过节点节')
})

test('formatIndexMd:全 null(空集群/survey 全失败)→ 仍成合法 md,Namespaces 标不可用', () => {
  const md = formatIndexMd({ clusterName: 'empty', verifiedAt: '2026-08-06' })
  assert.ok(md.includes('# empty 能力地图'))
  assert.ok(md.includes('_(survey 不可用或无)_'))
  assert.ok(md.includes('工作负载概览'))
})

test('formatIndexMd:CRD/扩展段(group/kind + 常见 operator 推断)', () => {
  const crds = [
    { spec: { group: 'argoproj.io', names: { kind: 'Application' } } },
    { spec: { group: 'cert-manager.io', names: { kind: 'Certificate' } } },
    { spec: { group: 'acme.example.io', names: { kind: 'Widget' } } },
    { spec: { names: { kind: 'NoGroup' } } }, // 无 group → 过滤
  ]
  const md = formatIndexMd({ clusterName: 'c', verifiedAt: '2026-08-06', crds })
  assert.ok(md.includes('## 已安装扩展'), 'CRD 段标题')
  assert.ok(md.includes('argoproj.io/Application  (ArgoCD)'), 'operator 推断 ArgoCD')
  assert.ok(md.includes('cert-manager.io/Certificate  (cert-manager)'), 'operator 推断 cert-manager')
  assert.ok(md.includes('acme.example.io/Widget'), '未知 group 原样列出(无产品名)')
  assert.ok(!md.includes('NoGroup'), '无 group 的 CRD 被过滤')
})
