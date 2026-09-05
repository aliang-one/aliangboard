import { describe, it, expect } from 'vitest'
import { mapIngress } from '../useResourceMappers'

// 回归锚:IngressClass 详情「暴露摘要」的 host 级端口判定依赖 tlsHosts
// (spec.tls[].hosts 扁平化)。2026-09-05 前 mapper 只有 tls 布尔值,
// 无法回答「这个 host 走 443 还是 80」——此测试钉住不回退。

const RAW = {
  metadata: { name: 'app1', namespace: 'web', creationTimestamp: '2026-08-01T00:00:00Z' },
  spec: {
    ingressClassName: 'nginx',
    rules: [
      { host: 'secure.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'svc-a', port: { number: 8080 } } } }] } },
      { host: 'plain.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'svc-b', port: { number: 80 } } } }] } },
    ],
    tls: [
      { hosts: ['secure.com'], secretName: 'cert-a' },
      { hosts: ['extra.com'], secretName: 'cert-b' }, // tls 段可含无 rule 的 host
    ],
  },
}

describe('mapIngress tlsHosts(暴露摘要数据源)', () => {
  it('扁平化 spec.tls[].hosts(含无 rule 的 tls 段)', () => {
    const m = mapIngress(RAW)
    expect(m.tlsHosts).toEqual(['secure.com', 'extra.com'])
    expect(m.tls).toBe(true)
  })

  it('无 tls → 空数组(缺省安全)', () => {
    const m = mapIngress({ metadata: { name: 'x' }, spec: { rules: [] } })
    expect(m.tlsHosts).toEqual([])
    expect(m.tls).toBe(false)
  })
})
