// http 流式原语:downloadStream(stub fetch+reader 逐块)/ uploadBinary(注入 fake XHR)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHttp } from '../http'

// 可控 Response fake:ok 流按 chunks 顺序出块
function streamResponse(chunks, { total }) {
  let i = 0
  return {
    ok: true, status: 200,
    headers: { get: k => (k === 'content-length' ? (total ? String(total) : null) : 'application/octet-stream') },
    body: { getReader: () => ({ read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }) }) },
  }
}
const enc = s => new TextEncoder().encode(s)
describe('downloadStream', () => {
  beforeEach(() => vi.unstubAllGlobals())
  it('逐块 onProgress + Blob', async () => {
    const http = createHttp({ resolveAuth: () => ({ authorization: 'Bearer t' }) })
    const progress = []
    vi.stubGlobal('fetch', vi.fn(async () => streamResponse([enc('ab'), enc('cd')], { total: 4 })))
    const blob = await http.downloadStream('/d', { body: {}, onProgress: p => progress.push({ ...p }) })
    expect(progress).toEqual([{ received: 2, total: 4 }, { received: 4, total: 4 }])
    expect(blob.size).toBe(4)
    expect(await blob.text()).toBe('abcd')
  })
  it('非 2xx 抛 status', async () => {
    const http = createHttp({})
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 413,
      headers: { get: () => null },
      text: async () => JSON.stringify({ message: '文件过大' }),
    })))
    await expect(http.downloadStream('/d', {})).rejects.toMatchObject({ status: 413, message: '文件过大' })
  })
})

describe('uploadBinary', () => {
  function fakeXhrFactory() {
    const made = []
    const factory = () => {
      const x = {
        status: 0, responseText: '', upload: {}, sent: null, headers: {},
        open(_m, u) { x.url = u }, setRequestHeader(k, v) { x.headers[k] = v },
        send(b) { made.push(x); x.sent = b },
        abort() { x.aborted = true; x.onabort?.() },
        ok(json, status = 200) { x.status = status; x.responseText = JSON.stringify(json); x.onload?.() },
      }
      return x
    }
    factory.made = made
    return factory
  }
  it('进度透传 + resolve JSON + auth 头', async () => {
    const http = createHttp({ resolveAuth: () => ({ authorization: 'Bearer t' }) })
    const f = fakeXhrFactory()
    const progress = []
    const p = http.uploadBinary('/u', new Blob(['xy']), { onProgress: pr => progress.push({ ...pr }) }, f)
    const x = f.made[0]
    expect(x.headers.authorization).toBe('Bearer t')
    x.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 })
    x.ok({ ok: true, bytes: 2 })
    await expect(p).resolves.toEqual({ ok: true, bytes: 2 })
    expect(progress).toEqual([{ received: 1, total: 2 }])
  })
  it('abort → {aborted:true}', async () => {
    const http = createHttp({})
    const f = fakeXhrFactory()
    const p = http.uploadBinary('/u', new Blob(['x']), {}, f)
    const ctl = { listeners: {}, addEventListener(_, fn) { this.listeners.ab = fn } }
    // 直接调 abort 路径:send 后立刻 abort
    const x = f.made[0]
    const p2 = http.uploadBinary('/u', new Blob(['x']), { signal: ctl }, f)
    ctl.listeners.ab()                       // signal abort → xhr.abort()
    await expect(p2).rejects.toMatchObject({ aborted: true })
    x.ok({})                                 // p 未 abort,正常完成
    await expect(p).resolves.toEqual({})
  })
})
