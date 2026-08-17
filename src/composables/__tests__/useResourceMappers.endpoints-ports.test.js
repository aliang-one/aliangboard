// mapEndpoints/extractEndpointSubsets 的端口 name 无损回归:
//   NsEndpoints 的 YAML 编辑器内容 = generateYAML('endpoints', row)(NsEndpoints.vue:99),
//   mapper 若丢 port.name → 编辑已有多端口 Endpoints 一保存 name 全蒸发 → K8s 拒 /
//   Service(named port)端口映射断裂(与 Ingress TLS 折叠同族的「generateYAML 有损回写」病)。
// 背景:2026-08-17 系统审计 P1-B。
import { test, expect } from 'vitest'
import { mapEndpoints } from '../useResourceMappers'

const RAW = {
  metadata: { name: 'svc-a', namespace: 'demo', uid: 'u1', creationTimestamp: '2026-08-17T00:00:00Z' },
  subsets: [{
    addresses: [{ ip: '10.1.2.3', targetRef: { kind: 'Pod', name: 'pod-a', namespace: 'demo' } }],
    ports: [
      { name: 'http', port: 80, protocol: 'TCP' },
      { name: 'metrics', port: 9090, protocol: 'TCP' },
      { port: 53, protocol: 'UDP' }, // 匿名端口也应保留(单端口匿名合法)
    ],
  }],
}

test('mapper:port.name 完整保留(有名/无名混合)', () => {
  const e = mapEndpoints(RAW)
  expect(e.ports.map(p => p.name)).toEqual(['http', 'metrics', ''])
  expect(e.ports.map(p => p.port)).toEqual([80, 9090, 53])
})

test('mapper:无名端口 name 落空串(显式,供 generateYAML 判空)', () => {
  const e = mapEndpoints(RAW)
  expect(e.ports[2].name).toBe('')
})
