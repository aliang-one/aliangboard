// 静态前端服务(serveStatic)单测:无副作用纯模块,临时目录验。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Writable } from 'node:stream'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveStatic } from './static.mjs'

// 假 res:记录 writeHead,接收 pipe/end 的字节。
function makeRes() {
  const chunks = []
  let status = null
  const headers = {}
  let ended = false
  const res = new Writable({
    write(c, _enc, cb) {
      chunks.push(c)
      cb()
    }
  })
  res.writeHead = (s, h) => { status = s; Object.assign(headers, h || {}) }
  const realEnd = res.end.bind(res)
  res.end = (d) => {
    if (d != null) chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d))
    ended = true
    realEnd()
  }
  // Define writableEnded as a property getter to avoid TypeError
  Object.defineProperty(res, 'writableEnded', {
    get() { return ended }
  })
  res.__state = () => ({ status, headers, body: Buffer.concat(chunks).toString('utf8') })
  return res
}

let root, sibling, base
test('setup 临时静态目录', () => {
  base = mkdtempSync(join(tmpdir(), 'static-'))
  root = join(base, 'dist')
  sibling = join(base, 'dist-evil') // 同级目录,验穿越守卫的「前缀精确匹配」
  mkdirSync(root, { recursive: true })
  mkdirSync(join(root, 'assets'), { recursive: true })
  mkdirSync(sibling, { recursive: true })
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>SPA</title>')
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)')
  writeFileSync(join(sibling, 'secret.txt'), 'TOPSECRET')
})

test('GET / → index.html,200,no-cache', async () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/', 'http://x'), { root })
  assert.equal(hit, true)
  // Wait for stream to finish
  await new Promise(resolve => res.on('finish', resolve))
  const { status, headers, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(headers['Content-Type'], 'text/html; charset=utf-8')
  assert.equal(headers['Cache-Control'], 'no-cache')
  assert.match(body, /SPA/)
})

test('GET /assets/app.js → 200, immutable 缓存', async () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/assets/app.js', 'http://x'), { root })
  assert.equal(hit, true)
  // Wait for stream to finish
  await new Promise(resolve => res.on('finish', resolve))
  const { status, headers, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(headers['Content-Type'], 'text/javascript; charset=utf-8')
  assert.equal(headers['Cache-Control'], 'public, max-age=31536000, immutable')
  assert.equal(body, 'console.log(1)')
})

test('GET 未知前端路由 /workloads → SPA fallback(index.html, no-cache)', async () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/workloads', 'http://x'), { root })
  assert.equal(hit, true)
  // Wait for stream to finish
  await new Promise(resolve => res.on('finish', resolve))
  const { status, headers, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(headers['Cache-Control'], 'no-cache')
  assert.match(body, /SPA/)
})

test('/api/* 不被静态吞掉 → false,不写响应(交 404 JSON 兜底)', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/api/whatever', 'http://x'), { root })
  assert.equal(hit, false)
  assert.equal(res.__state().status, null, '不应写任何响应头')
})

test('路径穿越 /../dist-evil/secret.txt → false,不泄露同级文件', () => {
  const res = makeRes()
  // 用裸对象模拟「含 .. 的 pathname」直击 normalize 守卫(真实 URL 已折叠 ..,此处为纵深防御)
  const hit = serveStatic({ method: 'GET' }, res, { pathname: '/../dist-evil/secret.txt' }, { root })
  assert.equal(hit, false, '前缀匹配必须带分隔符,否则会读到 dist-evil 同级文件')
  assert.equal(res.__state().status, null)
})

test('POST / → false(非 GET/HEAD,维持 404)', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'POST' }, res, new URL('/', 'http://x'), { root })
  assert.equal(hit, false)
})

test('HEAD / → 200 header 但无 body', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'HEAD' }, res, new URL('/', 'http://x'), { root })
  assert.equal(hit, true)
  const { status, body } = res.__state()
  assert.equal(status, 200)
  assert.equal(body, '', 'HEAD 不返 body')
})

test('无 root → false(未配静态目录,直接兜底)', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, new URL('/', 'http://x'), {})
  assert.equal(hit, false)
})

test('畸形百分号编码 /bad%ZZ → false,不抛(decode 守卫)', () => {
  const res = makeRes()
  const hit = serveStatic({ method: 'GET' }, res, { pathname: '/bad%ZZ' }, { root })
  assert.equal(hit, false)
  assert.equal(res.__state().status, null, '不应写响应')
})

test('teardown', () => { rmSync(base, { recursive: true, force: true }) })
