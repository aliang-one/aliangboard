// 静态资产 gzip 压缩单测(2026-09-09 LCP 5.96s 根因修复):
// 网关曾对全部资产零压缩裸传 —— 登录页关键路径 1.05MB(实测 gzip 后 ~330KB),
// 慢无线腿上 LCP 直逼 6s。本文件锁定:text 类资产按 Accept-Encoding: gzip 压缩,
// 已压缩格式(woff2/woff/图片)与小文件(<1KB)不压,HEAD 语义不破坏。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Writable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStatic } from './static.mjs'

function makeRes() {
  const chunks = []
  let status = null
  const headers = {}
  let ended = false
  const res = new Writable({
    write(c, _enc, cb) { chunks.push(c); cb() }
  })
  res.writeHead = (s, h) => { status = s; Object.assign(headers, h || {}) }
  const realEnd = res.end.bind(res)
  res.end = (d) => {
    if (d != null) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d))
    ended = true
    realEnd()
  }
  Object.defineProperty(res, 'writableEnded', { get() { return ended } })
  res.__state = () => ({ status, headers, body: Buffer.concat(chunks) })
  return res
}

// >1KB 的可压 fixture(过最小压缩阈值,证明走的是压缩门而非小文件豁免)
const BIG_JS = 'console.log("' + 'x'.repeat(4096) + '")'
const BIG_HTML = '<!doctype html><title>SPA</title><!--' + 'y'.repeat(4096) + '-->'

let root, base
test('setup 临时静态目录(gzip)', () => {
  base = mkdtempSync(join(tmpdir(), 'static-gz-'))
  root = join(base, 'dist')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'assets', 'app.js'), BIG_JS)
  writeFileSync(join(root, 'assets', 'icon.woff2'), 'w'.repeat(4096))
  writeFileSync(join(root, 'index.html'), BIG_HTML)
})

test('GET 大 JS + Accept-Encoding: gzip → Content-Encoding: gzip,gunzip 还原,Vary 头', async () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET', headers: { 'accept-encoding': 'gzip, deflate, br' } }, res, new URL('/assets/app.js', 'http://x'), { root })
  assert.equal(hit, true)
  await new Promise(resolve => res.on('finish', resolve))
  const { status, headers, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(headers['Content-Encoding'], 'gzip')
  assert.equal(headers['Vary'], 'Accept-Encoding')
  assert.equal(headers['Content-Length'], body.length, 'Content-Length 必须是压缩后字节数')
  assert.equal(gunzipSync(body).toString('utf8'), BIG_JS, '解压后必须是原文件内容')
})

test('GET 大 JS 无 Accept-Encoding → 原样裸传(老客户端兼容)', async () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET', headers: {} }, res, new URL('/assets/app.js', 'http://x'), { root })
  assert.equal(hit, true)
  await new Promise(resolve => res.on('finish', resolve))
  const { status, headers, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(headers['Content-Encoding'], undefined)
  assert.equal(body.toString('utf8'), BIG_JS)
})

test('GET woff2 + gzip 可接受 → 不压缩(已压缩格式,压了只会浪费 CPU)', async () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, res, new URL('/assets/icon.woff2', 'http://x'), { root })
  assert.equal(hit, true)
  await new Promise(resolve => res.on('finish', resolve))
  const { headers, body } = res.__state()
  assert.equal(headers['Content-Encoding'], undefined, 'woff2 不得压缩')
  assert.equal(body.length, 4096)
})

test('GET 小文件(1KB 以下)+ gzip → 不压缩(压缩开销大于收益)', async () => {
  writeFileSync(join(root, 'tiny.js'), 'console.log(1)')
  const res = makeRes()
  const hit = serveStatic({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, res, new URL('/tiny.js', 'http://x'), { root })
  assert.equal(hit, true)
  await new Promise(resolve => res.on('finish', resolve))
  const { headers, body } = res.__state()
  assert.equal(headers['Content-Encoding'], undefined)
  assert.equal(body.toString('utf8'), 'console.log(1)')
})

test('GET index.html + gzip → 压缩且 no-cache 保留', async () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET', headers: { 'accept-encoding': 'gzip' } }, res, new URL('/', 'http://x'), { root })
  assert.equal(hit, true)
  await new Promise(resolve => res.on('finish', resolve))
  const { headers, body } = res.__state()
  assert.equal(headers['Content-Encoding'], 'gzip')
  assert.equal(headers['Cache-Control'], 'no-cache')
  assert.equal(gunzipSync(body).toString('utf8'), BIG_HTML)
})

test('HEAD 大 JS + gzip → 200 无 body 不炸', async () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }, res, new URL('/assets/app.js', 'http://x'), { root })
  assert.equal(hit, true)
  await new Promise(resolve => res.on('finish', resolve))
  const { status, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(body.length, 0, 'HEAD 不返 body')
})

test('teardown(gzip)', () => { rmSync(base, { recursive: true, force: true }) })
