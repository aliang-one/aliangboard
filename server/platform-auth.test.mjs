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
