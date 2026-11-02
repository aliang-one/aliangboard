// issue#21 回归锁:Ingress 编辑弹窗逐 host TLS(与创建同构)。
// 三层规格:
//   hydrateHostTls —— spec.tls 条目 → host 行回填(一 entry 可覆盖多 host);
//   tlsFromHosts   —— host 行勾选态 → spec.tls 片段 + 孤儿条目保真(rules 里没有的 tls host
//                     不被 rules 编辑越权删除;部分覆盖条目拆分剩余 hosts,防同 host 双条目歧义);
//   buildIngressRulesPatch(…, tls) —— 第三参三态:undefined=不碰 tls(向后兼容②智能追加路径)、
//                     数组=整体替换、[]=null(merge-patch 删除字段,与 defaultBackend 同约定)。
import { test, expect } from 'vitest'
import { hydrateHostTls, tlsFromHosts, buildIngressRulesPatch, flatToHosts } from '../useIngressRules'
import { mapIngress } from '@/composables/useResourceMappers'

const H = (host, tls = false, tlsSecret = '', paths = [{ path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' }]) => ({ host, tls, tlsSecret, paths })

test('hydrateHostTls:单条目覆盖多 host → 各行回填同一 secret', () => {
  const rows = flatToHosts([
    { host: 'a.com', path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' },
    { host: 'b.com', path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' },
  ])
  const tls = [{ hosts: ['a.com', 'b.com'], secretName: 'wild-cert' }]
  const out = hydrateHostTls(rows, tls)
  expect(out.map(h => [h.host, h.tls, h.tlsSecret])).toEqual([
    ['a.com', true, 'wild-cert'],
    ['b.com', true, 'wild-cert'],
  ])
})

test('hydrateHostTls:不同条目不同 secret 各归其主;未覆盖行保持 tls=false', () => {
  const rows = [H('a.com'), H('b.com'), H('plain.com')]
  const tls = [
    { hosts: ['a.com'], secretName: 'cert-a' },
    { hosts: ['b.com'], secretName: 'cert-b' },
  ]
  const out = hydrateHostTls(rows, tls)
  expect(out[0].tlsSecret).toBe('cert-a')
  expect(out[1].tlsSecret).toBe('cert-b')
  expect(out[2].tls).toBe(false)
  expect(out[2].tlsSecret).toBe('')
})

test('hydrateHostTls:tls 为空/缺省 → 行原样(不误勾)', () => {
  const rows = [H('a.com')]
  expect(hydrateHostTls(rows, [])).toEqual(rows)
  expect(hydrateHostTls(rows, undefined)).toEqual(rows)
})

test('tlsFromHosts:勾选行 → 逐 host 条目;未勾选不产生条目', () => {
  const rows = [H('a.com', true, 'cert-a'), H('b.com', false, '')]
  expect(tlsFromHosts(rows)).toEqual([{ hosts: ['a.com'], secretName: 'cert-a' }])
})

test('tlsFromHosts:勾选但 secret 为空 → 保留空 secretName(部分控制器自动注入,与创建链路同构)', () => {
  const rows = [H('a.com', true, '')]
  expect(tlsFromHosts(rows)).toEqual([{ hosts: ['a.com'], secretName: '' }])
})

test('tlsFromHosts:孤儿条目保真 —— host 不在任何行(rules 编辑不越权删除)', () => {
  const rows = [H('a.com', true, 'cert-a')]
  const orphans = [{ hosts: ['legacy.no-rule.com'], secretName: 'old-cert' }]
  expect(tlsFromHosts(rows, orphans)).toEqual([
    { hosts: ['a.com'], secretName: 'cert-a' },
    { hosts: ['legacy.no-rule.com'], secretName: 'old-cert' },
  ])
})

test('tlsFromHosts:部分覆盖条目拆分 —— 被行认领的 host 移出,剩余 hosts 保留', () => {
  // 旧条目同时覆盖 a.com(有行,已勾选)与 x.com(无行):a.com 由行条目主张,x.com 留在缩编后的旧条目
  const rows = [H('a.com', true, 'new-cert')]
  const existing = [{ hosts: ['a.com', 'x.com'], secretName: 'old-cert' }]
  expect(tlsFromHosts(rows, existing)).toEqual([
    { hosts: ['a.com'], secretName: 'new-cert' },
    { hosts: ['x.com'], secretName: 'old-cert' },
  ])
})

test('tlsFromHosts:全部 hosts 被行认领的旧条目 → 不重复保留(防同 host 双条目歧义)', () => {
  const rows = [H('a.com', true, 'new-cert')]
  const existing = [{ hosts: ['a.com'], secretName: 'old-cert' }]
  expect(tlsFromHosts(rows, existing)).toEqual([{ hosts: ['a.com'], secretName: 'new-cert' }])
})

test('tlsFromHosts:行未勾选 = 用户显式移除该 host 的 TLS(对抗审查 HIGH:删除不得被孤儿保真吞成 no-op)', () => {
  // 行 a.com 存在但取消勾选 → 旧条目 {hosts:[a.com]} 必须被删除;
  // 否则保存成功 toast 后重开弹窗勾选自动回弹 = 静默 no-op
  const rows = [H('a.com', false, '')]
  const existing = [{ hosts: ['a.com'], secretName: 'cert-a' }]
  expect(tlsFromHosts(rows, existing)).toEqual([])
})

test('tlsFromHosts:勾选→取消→再保存 等价于全删(host 从 rowHosts 集合而非勾选集合判定)', () => {
  const rows = [H('a.com', false, ''), H('b.com', false, '')]
  const existing = [{ hosts: ['a.com', 'b.com'], secretName: 'cert' }]
  expect(tlsFromHosts(rows, existing)).toEqual([])
})

test('tlsFromHosts:无/空 hosts 的全局形态条目原样保留(API 合法:hosts 可选,SNI-only/强制跳转承载)', () => {
  const rows = [H('a.com', true, 'cert-a')]
  // {secretName} 单键:保形保留,不凭空补 hosts 键
  expect(tlsFromHosts(rows, [{ secretName: 'global-cert' }])).toEqual([
    { hosts: ['a.com'], secretName: 'cert-a' },
    { secretName: 'global-cert' },
  ])
  // {hosts:[], secretName}:同样保真
  expect(tlsFromHosts(rows, [{ hosts: [], secretName: 'default-cert' }])).toEqual([
    { hosts: ['a.com'], secretName: 'cert-a' },
    { hosts: [], secretName: 'default-cert' },
  ])
  // 有 hosts 但全部被行认领 → 仍丢弃(防同 host 双条目,既有语义不变)
  expect(tlsFromHosts(rows, [{ hosts: ['a.com'], secretName: 'old' }])).toEqual([{ hosts: ['a.com'], secretName: 'cert-a' }])
})

test('tlsFromHosts:真孤儿(host 完全无行)保留;行内未勾选的 host 不算孤儿', () => {
  const rows = [H('a.com', false, '')] // a.com 有行但未勾选 → 显式移除;b.com 无行 → 孤儿
  const existing = [{ hosts: ['a.com', 'b.com'], secretName: 'cert' }]
  expect(tlsFromHosts(rows, existing)).toEqual([{ hosts: ['b.com'], secretName: 'cert' }])
})

test('buildIngressRulesPatch:tls 数组 → spec.tls 整体替换', () => {
  const patch = buildIngressRulesPatch(
    [{ host: 'a.com', path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' }],
    null,
    [{ hosts: ['a.com'], secretName: 'cert-a' }],
  )
  expect(patch.spec.tls).toEqual([{ hosts: ['a.com'], secretName: 'cert-a' }])
})

test('buildIngressRulesPatch:tls=[] → spec.tls=null(merge-patch 删除字段,与 defaultBackend 同约定)', () => {
  const patch = buildIngressRulesPatch([], null, [])
  expect(patch.spec.tls).toBeNull()
  expect(patch.spec).toHaveProperty('defaultBackend', null)
})

test('buildIngressRulesPatch:不传 tls → spec 不含 tls 键(向后兼容:②智能追加路径不碰 TLS)', () => {
  const patch = buildIngressRulesPatch(
    [{ host: 'a.com', path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' }],
    { enabled: true, serviceName: 'db', servicePort: '80' },
  )
  expect(patch.spec).not.toHaveProperty('tls')
  expect(patch.spec.defaultBackend).toEqual({ service: { name: 'db', port: { number: 80 } } })
})

test('mapIngress:tlsEntries 保真字段携带完整条目数组(tlsHosts 有损视图之外的真值来源)', () => {
  const mapped = mapIngress({
    metadata: { name: 'ing', namespace: 'ns' },
    spec: {
      rules: [{"host":"a.com","http":{"paths":[{"path":"/","pathType":"Prefix","backend":{"service":{"name":"svc","port":{"number":80}}}}]}}],
      tls: [
        { hosts: ['a.com'], secretName: 'cert-a' },
        { hosts: ['x.com'], secretName: 'cert-x' },
      ],
    },
  })
  expect(mapped.tlsEntries).toEqual([
    { hosts: ['a.com'], secretName: 'cert-a' },
    { hosts: ['x.com'], secretName: 'cert-x' },
  ])
  expect(mapped.tlsSecret).toBe('cert-a') // 既有有损单条视图字段不变(其他消费方兼容)
})
