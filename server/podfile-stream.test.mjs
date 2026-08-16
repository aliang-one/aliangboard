// 流式传输纯逻辑:base64 行解码 / 下载编排(头/限/流/中断) / 上传编排(pipe/411/413/中断)。
// 全部注入 fake conn/req/res,无 k8s 依赖(照 exec-bounds.test.mjs 模式)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import {
  createBase64LineDecoder, streamDownload, streamUpload,
  limitMbFromValue, PODFILE_LIMIT_DEFAULT_MB, fmtMB,
} from './podfile-stream.mjs'

function fakeConn() {
  const c = new EventEmitter()
  c.closed = false
  c.close = () => { if (c.closed) return; c.closed = true; c.emit('close') }
  return c
}
function fakeRes() {
  return {
    headers: null, chunks: [], ended: false, destroyed: false, headersSent: false,
    writeHead(status, h) { this.headersSent = true; this.status = status; this.headers = h },
    write(c) { this.chunks.push(Buffer.from(c)) },
    end() { this.ended = true },
    destroy() { this.destroyed = true },
  }
}
const sinkWrite = (sink, data) => new Promise(r => sink.write(data, r))

test('createBase64LineDecoder: 跨 chunk 半行/\\r\\n/无换行尾段 → 解码拼接=原文', async () => {
  const data = Buffer.concat([Buffer.from('hello 二进制 \x00\xff\x0d\x0a tail'), Buffer.alloc(64, 7)])
  const b64 = data.toString('base64')
  const wrapped = b64.match(/.{1,76}/g).join('\r\n')            // busybox base64 行宽 + pty 的 \r\n
  const parts = [wrapped.slice(0, 100), wrapped.slice(100, 201), wrapped.slice(201) + '\r\n'] // 任意切分
  const out = []
  const dec = createBase64LineDecoder(c => out.push(c))
  for (const p of parts) await sinkWrite(dec, p)
  await new Promise(r => dec.end(r))
  assert.deepEqual(Buffer.concat(out), data)
})

test('streamDownload: 正常 → 200 头(content-length=statBytes)+块序解码+end', async () => {
  const data = Buffer.alloc(3000, 0xab)
  const conn = fakeConn()
  let so
  const res = fakeRes()
  const p = streamDownload({
    statBytes: data.length, limitBytes: 1024 * 1024, res, filename: 'a.bin',
    openConn: (stdoutSink) => { so = stdoutSink; return Promise.resolve(conn) },
  })
  await sinkWrite(so, data.toString('base64').match(/.{1,76}/g).join('\n') + '\n')
  conn.close()
  await p
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-length'], String(data.length))
  assert.equal(res.headers['content-disposition'], 'attachment; filename="a.bin"')
  assert.deepEqual(Buffer.concat(res.chunks), data)
  assert.ok(res.ended && !res.destroyed)
})

test('streamDownload: 空文件(statBytes=0)→ 直接 200+end,不启 exec', async () => {
  let opened = 0
  const res = fakeRes()
  await streamDownload({ statBytes: 0, limitBytes: 100, res, filename: 'e',
    openConn: async () => { opened++; return fakeConn() } })
  assert.equal(opened, 0)
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-length'], '0')
  assert.ok(res.ended)
})

test('streamDownload: 超限 → 抛 413,头部未写', async () => {
  await assert.rejects(
    streamDownload({ statBytes: 2 * 1024 ** 3, limitBytes: 1024 ** 3, res: fakeRes(), filename: 'x', openConn: async () => fakeConn() }),
    e => e.status === 413 && !/TBD/.test(e.message),
  )
})

test('streamDownload: conn 早关无数据(stderr 有错) → 抛 404(头部未发)', async () => {
  const conn = fakeConn()
  let se
  const p = streamDownload({ statBytes: 10, limitBytes: 100, res: fakeRes(), filename: 'x',
    openConn: (_so, stderrSink) => { se = stderrSink; return Promise.resolve(conn) } })
  await sinkWrite(se, 'cat: can\'t open \'x\': No such file')
  conn.close()
  await assert.rejects(p, e => e.status === 404)
})

test('streamDownload: 头部已发后 conn error → res.destroy 不抛', async () => {
  const conn = fakeConn()
  let so
  const res = fakeRes()
  const p = streamDownload({ statBytes: 100, limitBytes: 1000, res, filename: 'x',
    openConn: (stdoutSink) => { so = stdoutSink; return Promise.resolve(conn) } })
  await sinkWrite(so, Buffer.alloc(50, 1).toString('base64') + '\n')
  assert.ok(res.headersSent)
  conn.emit('error', new Error('ws broke'))
  conn.close()
  await p                                       // 不 reject:已发头只能 destroy
  assert.ok(res.destroyed)
})

test('streamUpload: 缺 content-length → 411;超限 → 413;均不启 exec', async () => {
  let opened = 0
  const openConn = () => { opened++; return Promise.resolve(fakeConn()) }
  await assert.rejects(streamUpload({ contentLength: NaN, limitBytes: 100, openConn, req: Readable.from([]) }), e => e.status === 411)
  await assert.rejects(streamUpload({ contentLength: 200, limitBytes: 100, openConn, req: Readable.from([]) }), e => e.status === 413)
  assert.equal(opened, 0)
})

test('streamUpload: req 全量进 stdin,conn close 后 → {ok, bytes}', async () => {
  const conn = fakeConn()
  let got
  const req = Readable.from([Buffer.from('abc'), Buffer.from('de')])
  const p = streamUpload({ contentLength: 5, limitBytes: 100, req,
    openConn: (stdinSink) => {
      got = new Promise(r => { const cs = []; stdinSink.on('data', c => cs.push(c)); stdinSink.on('end', () => { r(Buffer.concat(cs)); conn.close() }) })
      return Promise.resolve(conn)
    }
  })
  assert.deepEqual(await p, { ok: true, path: '', bytes: 5 })
  assert.equal((await got).toString(), 'abcde')
})

test('streamUpload: req 中途 aborted → conn.close 被调 + 抛 canceled', async () => {
  const conn = fakeConn()
  const req = new Readable({ read() {} })
  const p = streamUpload({ contentLength: 100, limitBytes: 1000, req,
    openConn: (stdinSink) => { stdinSink.on('error', () => {}); return Promise.resolve(conn) } })
  req.push('partial')
  req.destroy(new Error('client aborted'))   // destroy(err) → 'error' 事件(裸 destroy 只发 close,不够)
  await assert.rejects(p, e => e.canceled === true)
  assert.ok(conn.closed)
})

test('limitMbFromValue/fmtMB: 边界', () => {
  assert.equal(PODFILE_LIMIT_DEFAULT_MB, 1024)
  assert.equal(limitMbFromValue('2048'), 2048)
  assert.equal(limitMbFromValue(0), null)
  assert.equal(limitMbFromValue(999999), null)
  assert.equal(limitMbFromValue(null), null)
  assert.equal(fmtMB(1024 * 1024 * 1024), '1.0 GB')
})
