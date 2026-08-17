// chatErrors.sanitizeChatError:对话错误显示前的净化——上游网关(nginx 等)错误体是整页 HTML,
// 原样落 banner/turn 会把标签当正文多行倾倒(2026-08-17 LLM 502 实例)。
// 契约:剥标签/压空白/截断;纯函数无 i18n,fallback 由调用方处理。
import { test, expect } from 'vitest'
import { sanitizeChatError } from '../chatErrors'

const NGINX_502 = 'LLM HTTP 502: <html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>'

test('HTML 错误体 → 压成单行无标签文本', () => {
  const out = sanitizeChatError(NGINX_502)
  expect(out).not.toContain('<')
  expect(out).toBe('LLM HTTP 502: 502 Bad Gateway 502 Bad Gateway nginx')
})

test('普通短消息原样保留(已是我们网关的 JSON message 风格)', () => {
  expect(sanitizeChatError('对话不存在')).toBe('对话不存在')
})

test('空值返回空串(fallback 由调用方补)', () => {
  expect(sanitizeChatError(undefined)).toBe('')
  expect(sanitizeChatError('')).toBe('')
  expect(sanitizeChatError('   ')).toBe('')
  expect(sanitizeChatError('<html></html>')).toBe('')
})

test('长文本截断到 160 字符加省略号', () => {
  const long = 'x'.repeat(300)
  const out = sanitizeChatError(long)
  expect(out.length).toBe(161)
  expect(out.endsWith('…')).toBe(true)
})

test('常见 HTML 实体解码', () => {
  expect(sanitizeChatError('a &amp; b &lt;c&gt; d&nbsp;e')).toBe('a & b <c> d e')
})
