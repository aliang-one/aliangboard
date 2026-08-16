// src/composables/useIngressRules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIngressRulesPatch, ingressRulesToFlat, flatToHosts, hostsToFlat, hostsToK8sSpec, sameHostIngresses, appendPathToIngress, buildWizardIngressYaml } from './useIngressRules.js'

test('ingressRulesToFlat: K8s 形状 rules 拍平(新 backend 形状)', () => {
  const rules = [{ host: 'a.com', http: { paths: [{ path: '/api', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 8080 } } } }] } }]
  assert.deepEqual(ingressRulesToFlat(rules), [
    { host: 'a.com', path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' },
  ])
})

test('ingressRulesToFlat: 兼容旧形状(serviceName/servicePort 直挂 backend)+ 命名端口', () => {
  const rules = [{ host: '', http: { paths: [{ path: '/', backend: { serviceName: 'old', servicePort: 'http' } }] } }]
  assert.deepEqual(ingressRulesToFlat(rules), [
    { host: '', path: '/', pathType: 'Prefix', serviceName: 'old', servicePort: 'http' },
  ])
})

test('ingressRulesToFlat: 空/缺段安全', () => {
  assert.deepEqual(ingressRulesToFlat(undefined), [])
  assert.deepEqual(ingressRulesToFlat([{ host: 'a.com' }]), [])
  assert.deepEqual(ingressRulesToFlat([{ host: 'a.com', http: { paths: [] } }]), [])
})

test('flatToHosts: 同 host 聚合(含非相邻),保持首现顺序;round-trip 无损', () => {
  const flat = [
    { host: 'a.com', path: '/x', pathType: 'Prefix', serviceName: 's1', servicePort: '80' },
    { host: 'b.com', path: '/', pathType: 'Exact', serviceName: 's2', servicePort: '9090' },
    { host: 'a.com', path: '/y', pathType: 'Prefix', serviceName: 's1', servicePort: '8080' },
  ]
  const hosts = flatToHosts(flat)
  assert.equal(hosts.length, 2)
  assert.equal(hosts[0].host, 'a.com')
  assert.equal(hosts[0].paths.length, 2)
  assert.equal(hosts[0].paths[1].path, '/y')
  assert.equal(hosts[0].tls, false)
  // round-trip: 数据完整,host聚合后顺序变更为分组顺序
  assert.deepEqual(hostsToFlat(hosts), [
    { host: 'a.com', path: '/x', pathType: 'Prefix', serviceName: 's1', servicePort: '80' },
    { host: 'a.com', path: '/y', pathType: 'Prefix', serviceName: 's1', servicePort: '8080' },
    { host: 'b.com', path: '/', pathType: 'Exact', serviceName: 's2', servicePort: '9090' },
  ])
})

test('flatToHosts: 空输入 → []', () => {
  assert.deepEqual(flatToHosts([]), [])
  assert.deepEqual(flatToHosts(undefined), [])
})

test('hostsToFlat: 逐 path 展开,缺省补齐', () => {
  const hosts = [{ host: 'a.com', tls: true, tlsSecret: 'sec', paths: [{ path: '/api', pathType: 'Exact', serviceName: 'w', servicePort: '8080' }] }]
  assert.deepEqual(hostsToFlat(hosts), [{ host: 'a.com', path: '/api', pathType: 'Exact', serviceName: 'w', servicePort: '8080' }])
})

test('hostsToK8sSpec: 生成 K8s 形状 + per-host TLS 聚合 + 默认 secret 回退', () => {
  const hosts = [
    { host: 'a.com', tls: true, tlsSecret: '', paths: [{ path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' }] },
    { host: 'b.com', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'web', servicePort: '80' }] },
  ]
  const spec = hostsToK8sSpec(hosts, { defaultTlsSecret: 'my-tls' })
  assert.deepEqual(spec.rules, [
    { host: 'a.com', http: { paths: [{ path: '/api', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 8080 } } } }] } },
    { host: 'b.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } },
  ])
  assert.deepEqual(spec.tls, [{ hosts: ['a.com'], secretName: 'my-tls' }])
})

test('hostsToK8sSpec: 显式 secret 优先;空 host 的 tls 不进 tls 数组;port 无 80 兜底', () => {
  const hosts = [{ host: 'a.com', tls: true, tlsSecret: 'explicit', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'w', servicePort: '80' }] },
                 { host: '', tls: true, tlsSecret: 'x', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'w', servicePort: '80' }] }]
  const spec = hostsToK8sSpec(hosts, {})
  assert.deepEqual(spec.tls, [{ hosts: ['a.com'], secretName: 'explicit' }])
})

test('buildIngressRulesPatch 存量回归:不因本次改动破坏', () => {
  const patch = buildIngressRulesPatch([{ host: 'a.com', path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' }], null)
  assert.deepEqual(patch.spec.rules[0].http.paths[0].backend.service.name, 's')
})

const ING = {
  name: 'app-ingress',
  rules: [
    { host: 'a.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } },
    { host: 'b.com', http: { paths: [{ path: '/x', pathType: 'Exact', backend: { service: { name: 'api', port: { number: 8080 } } } }] } },
  ],
}

test('sameHostIngresses: 精确匹配,空 host 不匹配任何', () => {
  const list = [ING, { name: 'other', rules: [{ host: '', http: { paths: [{ path: '/', backend: { service: { name: 'x', port: { number: 1 } } } }] } }] }]
  assert.equal(sameHostIngresses(list, 'a.com').length, 1)
  assert.equal(sameHostIngresses(list, 'A.com').length, 0)   // 大小写敏感(K8s host 精确)
  assert.deepEqual(sameHostIngresses(list, ''), [])
  assert.deepEqual(sameHostIngresses(list, '  '), [])
  assert.deepEqual(sameHostIngresses(undefined, 'a.com'), [])
})

test('appendPathToIngress: 追加到同 host 组,返回完整 flatRules', () => {
  const { flatRules, conflict } = appendPathToIngress(ING, { host: 'a.com', path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' })
  assert.equal(conflict, false)
  assert.equal(flatRules.length, 3)
  assert.deepEqual(flatRules[2], { host: 'a.com', path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' })
})

test('appendPathToIngress: 同 host 同 path 已存在 → conflict(不管 pathType)', () => {
  const { conflict } = appendPathToIngress(ING, { host: 'a.com', path: '/', pathType: 'Exact', serviceName: 'w', servicePort: '80' })
  assert.equal(conflict, true)
})

test('appendPathToIngress: host 不在 ingress 内也安全(新建组追加)', () => {
  const { flatRules } = appendPathToIngress(ING, { host: 'c.com', path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' })
  assert.equal(flatRules.length, 3)
  assert.equal(flatRules[2].host, 'c.com')
})

test('buildWizardIngressYaml: 完整文档,backend 取 path 级字段', () => {
  const hosts = [
    { host: 'a.com', tls: true, tlsSecret: '', paths: [
      { path: '/api', pathType: 'Prefix', serviceName: 'app-svc', servicePort: '80' },
      { path: '/admin', pathType: 'Prefix', serviceName: 'other-svc', servicePort: '9090' },  // 不同端口分流
    ]},
    { host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'x', servicePort: '1' }] },
  ]
  const y = buildWizardIngressYaml(hosts, { name: 'app', namespace: 'default', ingressClassName: 'nginx', annotations: { 'k': 'v' } })
  assert.ok(y.startsWith('\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress'))
  assert.ok(y.includes('  name: app\n  namespace: default'))
  assert.ok(y.includes('  ingressClassName: nginx'))
  assert.ok(y.includes('    k: v'))
  assert.ok(y.includes('  - host: a.com'))                       // 空 host 规则被剔除
  assert.ok(!y.includes('host: \n'))                              // 空 host 行不出现
  // path 级 backend:/api→80、/admin→9090(核心回归:不再全指向 servicePorts[0])
  assert.ok(y.includes('- path: /api\n        pathType: Prefix\n        backend:\n          service:\n            name: app-svc\n            port:\n              number: 80'))
  assert.ok(y.includes('- path: /admin\n        pathType: Prefix\n        backend:\n          service:\n            name: other-svc\n            port:\n              number: 9090'))
  // tls:secret 回退 <name>-tls
  assert.ok(y.includes('  tls:\n  - hosts:\n    - a.com\n    secretName: app-tls'))
})

test('buildWizardIngressYaml: 无有效 host → 空串;无注解/无 class 时省略对应行', () => {
  assert.equal(buildWizardIngressYaml([{ host: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' }] }], { name: 'a', namespace: 'd' }), '')
  const y = buildWizardIngressYaml([{ host: 'a.com', tls: false, paths: [{ path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' }] }], { name: 'a', namespace: 'd' })
  assert.ok(!y.includes('ingressClassName'))
  assert.ok(!y.includes('annotations'))
  assert.ok(!y.includes('tls:'))
})

test('buildWizardIngressYaml: name 逐字使用 + defaultTlsSecret 参与 tls 回退(向导 -ingress 后缀契约)', () => {
  // 调用方(DeployApp)传 name=`${f.name}-ingress`、defaultTlsSecret=`${f.name}-tls`;
  // 函数侧:name 逐字落 metadata.name,secret 回退链 = 显式 > defaultTlsSecret > name+'-tls'
  const hosts = [{ host: 'a.com', tls: true, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'myapp-svc', servicePort: '80' }] }]
  const y = buildWizardIngressYaml(hosts, { name: 'myapp-ingress', namespace: 'default', defaultTlsSecret: 'myapp-tls' })
  assert.ok(y.includes('  name: myapp-ingress\n  namespace: default'))   // metadata.name = 收到的 name
  assert.ok(y.includes('    secretName: myapp-tls'))                     // defaultTlsSecret 回退生效
  assert.ok(!y.includes('myapp-ingress-tls'))                            // 不再拼 name+'-tls'(旧链路会产出错误名)
})

test('buildWizardIngressYaml: 显式 tlsSecret 优先于 defaultTlsSecret', () => {
  const hosts = [{ host: 'a.com', tls: true, tlsSecret: 'explicit-sec', paths: [{ path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' }] }]
  const y = buildWizardIngressYaml(hosts, { name: 'app', namespace: 'd', defaultTlsSecret: 'app-tls' })
  assert.ok(y.includes('    secretName: explicit-sec'))
  assert.ok(!y.includes('secretName: app-tls'))
})
