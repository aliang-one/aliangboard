import { test, expect } from 'vitest'
import { SECRET_TYPES, buildSecretData, secretFieldsComplete } from '../secretTemplates.js'

test('SECRET_TYPES 覆盖现有 5 类型', () => {
  expect(SECRET_TYPES.map(t => t.id)).toEqual(['Opaque', 'kubernetes.io/basic-auth', 'kubernetes.io/dockerconfigjson', 'kubernetes.io/tls', 'kubernetes.io/ssh-auth'])
})

test('buildSecretData: Opaque 透传 / tls 固定键 / dockerconfigjson 组装', () => {
  expect(buildSecretData('Opaque', { data: { a: '1' } })).toEqual({ a: '1' })
  expect(buildSecretData('kubernetes.io/tls', { 'tls.crt': 'C', 'tls.key': 'K' })).toEqual({ 'tls.crt': 'C', 'tls.key': 'K' })
  const d = buildSecretData('kubernetes.io/dockerconfigjson', { registry: 'reg.io', registryUser: 'u', registryPassword: 'p', registryEmail: 'e@x.io' })
  const cfg = JSON.parse(d['.dockerconfigjson'])
  expect(cfg.auths['reg.io'].username).toBe('u')
  expect(cfg.auths['reg.io'].auth).toBe(btoa('u:p'))
})

test('secretFieldsComplete 与旧 canCreateSecret 行为一致', () => {
  expect(secretFieldsComplete('kubernetes.io/tls', { 'tls.crt': 'C', 'tls.key': '' })).toBe(false)
  expect(secretFieldsComplete('kubernetes.io/tls', { 'tls.crt': 'C', 'tls.key': 'K' })).toBe(true)
  expect(secretFieldsComplete('kubernetes.io/basic-auth', { username: 'u', password: 'p' })).toBe(true)
  expect(secretFieldsComplete('Opaque', { data: { k: 'v' } })).toBe(true)
  expect(secretFieldsComplete('Opaque', { data: {} })).toBe(false)
})
