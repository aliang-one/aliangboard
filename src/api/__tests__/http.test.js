import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createHttp, parseBody } from '../http.js'
import { i18n } from '@/i18n'

// 构造 fetch 响应对象
function res({ ok = true, status = 200, body = '', bodyType = 'text' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return {
    ok,
    status,
    text: async () => text,
    blob: async () => ({ __blob: true, text }),
    _text: text,
    _bodyType: bodyType,
  }
}

describe('parseBody', () => {
  it('empty → null', () => { expect(parseBody('')).toBeNull() })
  it('json → object', () => { expect(parseBody('{"a":1}')).toEqual({ a: 1 }) })
  it('non-json → raw text', () => { expect(parseBody('not json')).toBe('not json') })
})

describe('createHttp.request', () => {
  let fetchMock
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock })
  afterEach(() => { delete global.fetch })

  it('returns parsed JSON body on 200', async () => {
    fetchMock.mockResolvedValue(res({ body: { ok: 1 } }))
    const http = createHttp({ baseUrl: 'http://x' })
    expect(await http.request('/api/ping')).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledWith('http://x/api/ping', expect.objectContaining({ headers: expect.any(Object) }))
  })

  it('null on empty body', async () => {
    fetchMock.mockResolvedValue(res({ body: '' }))
    const http = createHttp({})
    expect(await http.request('/x')).toBeNull()
  })

  it('raw text on non-json body', async () => {
    fetchMock.mockResolvedValue(res({ body: 'hello' }))
    const http = createHttp({})
    expect(await http.request('/x')).toBe('hello')
  })

  it('sets content-type only when body present + applies auth headers', async () => {
    fetchMock.mockResolvedValue(res({ body: '{}' }))
    const http = createHttp({ resolveAuth: () => ({ authorization: 'Bearer T' }) })
    await http.request('/x', { method: 'POST', body: '{}' })
    const [, opts] = fetchMock.mock.calls[0]
    expect(opts.headers['content-type']).toBe('application/json')
    expect(opts.headers.authorization).toBe('Bearer T')
    // no body → no content-type
    fetchMock.mockResolvedValue(res({ body: '{}' }))
    await http.request('/y')
    const [, opts2] = fetchMock.mock.calls[1]
    expect(opts2.headers['content-type']).toBeUndefined()
  })

  it('throws with .status/.details and message fallback on non-401 error', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 500, body: { message: 'boom' } }))
    const http = createHttp({})
    await expect(http.request('/x')).rejects.toMatchObject({ status: 500, message: 'boom', details: { message: 'boom' } })
  })

  it('message falls back to "请求失败：HTTP <status>" when body has no message', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 502, body: '' }))
    const http = createHttp({})
    await expect(http.request('/x')).rejects.toMatchObject({ status: 502, message: '请求失败：HTTP 502' })
  })

  it('on 401 calls onUnauthorized(path) then throws', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 401, body: { message: 'no' } }))
    const onUn = vi.fn()
    const http = createHttp({ onUnauthorized: onUn })
    await expect(http.request('/api/k8s/pods')).rejects.toMatchObject({ status: 401 })
    expect(onUn).toHaveBeenCalledWith('/api/k8s/pods', expect.any(Object))
  })
})

describe('createHttp.blob', () => {
  let fetchMock
  beforeEach(() => { fetchMock = vi.fn(); global.fetch = fetchMock })
  afterEach(() => { delete global.fetch })

  it('returns Blob on success', async () => {
    fetchMock.mockResolvedValue(res({ body: 'binary' }))
    const http = createHttp({})
    const b = await http.blob('/dl')
    expect(b).toEqual(expect.objectContaining({ __blob: true }))
  })

  it('throws "下载失败" on error with json message preferred', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 404, body: { message: '找不到文件' } }))
    const http = createHttp({})
    await expect(http.blob('/dl')).rejects.toMatchObject({ status: 404, message: '找不到文件' })
  })

  it('non-json error body becomes the message; empty → 下载失败 fallback', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 500, body: 'plain err' }))
    const http = createHttp({})
    await expect(http.blob('/dl')).rejects.toMatchObject({ message: 'plain err' })
    fetchMock.mockResolvedValue(res({ ok: false, status: 500, body: '' }))
    await expect(http.blob('/dl')).rejects.toMatchObject({ message: '下载失败：HTTP 500' })
  })

  it('on 401 calls onUnauthorized', async () => {
    fetchMock.mockResolvedValue(res({ ok: false, status: 401, body: '' }))
    const onUn = vi.fn()
    const http = createHttp({ onUnauthorized: onUn })
    await expect(http.blob('/dl')).rejects.toMatchObject({ status: 401 })
    expect(onUn).toHaveBeenCalled()
  })
})

describe('createHttp.authHeaders', () => {
  it('returns accept-language + resolveAuth result', () => {
    const http = createHttp({ resolveAuth: () => ({ 'x-platform-token': 'P' }) })
    expect(http.authHeaders()).toEqual({ 'accept-language': i18n.global.locale.value, 'x-platform-token': 'P' })
  })
  it('accept-language present when no resolver', () => {
    const http = createHttp({})
    expect(http.authHeaders()).toEqual({ 'accept-language': i18n.global.locale.value })
  })
})
