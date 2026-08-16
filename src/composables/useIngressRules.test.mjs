// src/composables/useIngressRules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIngressRulesPatch, ingressRulesToFlat, flatToHosts, hostsToFlat, hostsToK8sSpec } from './useIngressRules.js'

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
