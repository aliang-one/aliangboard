// T8 Step 6: extractPlatformToken query 回退测试。
// EventSource 不能加自定义 header,SSE 端点靠 ?token= query 过鉴权。
// header 优先,header 缺失 → 回退 query;两者都无 → 空串。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { extractPlatformToken } from './platform-auth.mjs'

test('header 优先:req.headers[x-platform-token] 存在 → 返回 header 值', () => {
  const req = {
    headers: { 'x-platform-token': 'tok-from-header' },
    url: '/api/workbench/conversations/abc/stream?token=tok-from-query',
  }
  assert.equal(extractPlatformToken(req), 'tok-from-header')
})

test('header 缺失:回退到 ?token= query', () => {
  const req = {
    headers: {},
    url: '/api/workbench/conversations/abc/stream?token=tok-from-query',
  }
  assert.equal(extractPlatformToken(req), 'tok-from-query')
})

test('header 与 query 都无:返回空串', () => {
  const req = {
    headers: {},
    url: '/api/workbench/conversations/abc/stream',
  }
  assert.equal(extractPlatformToken(req), '')
})

test('?token= 空值:返回空串', () => {
  const req = {
    headers: {},
    url: '/api/workbench/conversations/abc/stream?token=',
  }
  assert.equal(extractPlatformToken(req), '')
})

test('?token= 含特殊字符(URL 编码由 EventSource 自动处理)', () => {
  const req = {
    headers: {},
    url: '/api/workbench/conversations/abc/stream?token=abc-123_xyz',
  }
  assert.equal(extractPlatformToken(req), 'abc-123_xyz')
})

test('无 query 的根路径:返回空串', () => {
  const req = {
    headers: {},
    url: '/',
  }
  assert.equal(extractPlatformToken(req), '')
})

// W3 Task 6:kubectl 类客户端只能发标准 Authorization: Bearer(kubeconfig user.token 的
// 唯一载体)。优先级:x-platform-token(浏览器)> Authorization Bearer > ?token=(SSE)。
test('Authorization: Bearer 回退(W3 Task 6 kubeconfig 凭据):无 x-platform-token 时取 Bearer 值', () => {
  const req = {
    headers: { authorization: 'Bearer platform-token-for-kubectl' },
    url: '/api/k8s-proxy/c1/api/v1/namespaces/default/pods',
  }
  assert.equal(extractPlatformToken(req), 'platform-token-for-kubectl')
})

test('x-platform-token 优先于 Authorization: Bearer(浏览器路径不受污染)', () => {
  const req = {
    headers: { 'x-platform-token': 'tok-from-header', authorization: 'Bearer k8s-session-token' },
    url: '/api/auth/me',
  }
  assert.equal(extractPlatformToken(req), 'tok-from-header')
})

test('非 Bearer 的 Authorization(如 Basic)不当作平台 token', () => {
  const req = {
    headers: { authorization: 'Basic dXNlcjpwYXNz' },
    url: '/api/k8s-proxy/c1/api/v1/pods',
  }
  assert.equal(extractPlatformToken(req), '')
})
