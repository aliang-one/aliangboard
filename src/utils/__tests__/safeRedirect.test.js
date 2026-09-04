import { test, expect } from 'vitest'
import { safeRedirectPath } from '../safeRedirect'

// 登录回跳(2026-09-04 事故⑥)的开放重定向闸:仅接受同源绝对路径。
test('同源绝对路径原样放行(含 query)', () => {
  expect(safeRedirectPath('/ssh-terminal-popup?serverId=x&sid=y')).toBe('/ssh-terminal-popup?serverId=x&sid=y')
  expect(safeRedirectPath('/cluster')).toBe('/cluster')
})
test('协议相对/外链/反斜杠/空值/非字符串 → 落 fallback', () => {
  for (const bad of ['', null, undefined, 42, '//evil.com', '/\\evil.com', 'http://evil.com/x', 'https://x', 'login']) {
    expect(safeRedirectPath(bad, '/cluster')).toBe('/cluster')
  }
})
test('fallback 可自定义', () => {
  expect(safeRedirectPath(undefined, '/workbench')).toBe('/workbench')
})

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

test('client.js:redirectToLogin 携带 ?redirect=(原路径+query 经编码)', () => {
  const src = readFileSync(resolve('src/api/client.js'), 'utf8')
  expect(src).toContain('/login?redirect=${back}')
  expect(src).toContain('encodeURIComponent(location.pathname + location.search)')
})

test('client.js:sshTerminalStream 握手段失败探针 /api/auth/me(仅一次,且从未 open 才探)', () => {
  const src = readFileSync(resolve('src/api/client.js'), 'utf8')
  expect(src).toContain('probeAuthIfHandshakeFailed')
  expect(src).toContain("platformHttp.request('/api/auth/me')")
  expect(src).toContain('if (opened || probed) return')
  expect(src).toContain('ws.onopen = () => { opened = true }')
})

test('Login.vue:登录成功优先安全回跳(全量加载,弹窗页可完整重建)', () => {
  const src = readFileSync(resolve('src/views/Login.vue'), 'utf8')
  expect(src).toContain('safeRedirectPath(route.query.redirect)')
  expect(src).toContain('window.location.href = target')
})
