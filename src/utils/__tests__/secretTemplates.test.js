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

// 系统审计(2026-09-29):docker auth 用裸 btoa(Latin-1)——含非 Latin-1 字符的
// 密码(如中文)会 throw → catch 退化为明文 'user:pass' 写进 auth 字段(非 base64,
// 镜像拉取凭据损坏)。修复:UTF-8 安全编码(与 encodeBase64 同型)。
test('buildSecretData docker auth: 非 Latin-1 密码 → 合法 base64(UTF-8 字节),非明文', () => {
  const d = buildSecretData('kubernetes.io/dockerconfigjson', {
    registry: 'reg.io', registryUser: '部署', registryPassword: '密码123', registryEmail: 'e@x.io',
  })
  const cfg = JSON.parse(d['.dockerconfigjson'])
  const auth = cfg.auths['reg.io'].auth
  // 必须是合法 base64,且解码回 UTF-8 明文 '部署:密码123'(btoa 直抛会退化成明文串)
  const decoded = decodeURIComponent(escape(atob(auth)))
  expect(decoded).toBe('部署:密码123')
})
