// 静态服务安全头守卫(2026-08-28 架构治理第三件):CSP/nosniff/frame-deny 必须随每个静态响应下发。
// CSP 是 CodeViewer XSS 事故的纵深防御层——这里锁「头在」,策略内容变更须显式改这里。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStatic } from './static.mjs'

test('serveStatic:每个响应携带 CSP/nosniff/frame- deny/referrer 头', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-static-'))
  try {
    writeFileSync(join(dir, 'index.html'), '<html></html>')
    const headers = {}
    const res = { writeHead(status, h) { Object.assign(headers, h) }, end() {} }
    // HEAD:同一 writeHead 路径但不走 createReadStream,测试无流收尾问题
    const hit = serveStatic({ method: 'HEAD' }, res, new URL('http://x/'), { root: dir })
    assert.ok(hit, '应命中静态文件')
    assert.equal(headers['X-Content-Type-Options'], 'nosniff')
    assert.equal(headers['X-Frame-Options'], 'DENY')
    assert.equal(headers['Referrer-Policy'], 'no-referrer')
    const csp = headers['Content-Security-Policy']
    assert.ok(csp, 'CSP 必须在')
    // 关键收紧点逐项断言(变更须显式改此测试)
    assert.match(csp, /script-src 'self'/, "脚本只许同源")
    assert.match(csp, /object-src 'none'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /connect-src 'self' ws: wss:/, '终端 WS 与同源 API 必须可达')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
