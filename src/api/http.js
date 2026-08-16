// 统一 HTTP 原语：把原先 client.js 里 4 份重复的「取 token + 拼 header + fetch + 解析 + 401 + 错误」
// (request / platformRequest / k8sStream 内 / podFileApi.download)收敛为一份。
//
// 设计：依赖注入。createHttp 不触碰 storage/location，由调用方注入
//   - resolveAuth(): () => header 对象（如 { authorization: 'Bearer …' } / { 'x-platform-token': … }）
//   - onUnauthorized(path, response): 401 时的处理（清凭据 + 跳登录），由调用方按层（k8s/平台）决定
// 这样 http.js 纯净可单测，client.js 造两个实例（k8sHttp / platformHttp）即可。
import { i18n } from '@/i18n'

// 响应体解析：空 → null；JSON → 对象；非 JSON → 原文本。与原 request/platformRequest 行为一致。
export function parseBody(text) {
  if (!text) return null
  try { return JSON.parse(text) } catch { return text }
}

export function createHttp({ baseUrl = '', resolveAuth = () => ({}), onUnauthorized } = {}) {
  // 当前会话的认证 header（供 stream/blob/ws 等非 request 形态复用，避免再写一份取 token 逻辑）
  function authHeaders() {
    return resolveAuth() || {}
  }

  // 常规 JSON 请求：返回已解析 body；非 2xx 抛带 .status/.details 的 Error；401 触发 onUnauthorized。
  async function request(path, options = {}) {
    const headers = {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...authHeaders(),
      ...(options.headers || {}),
    }
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers })
    const text = await response.text()
    const body = parseBody(text)
    if (!response.ok) {
      if (response.status === 401) onUnauthorized?.(path, response)
      const error = new Error(body?.message || i18n.global.t('api.requestFailed', { status: response.status }))
      error.status = response.status
      error.details = body
      throw error
    }
    return body
  }

  // 二进制下载：成功返回 Blob；失败抛「下载失败」错误（保留原 podFileApi.download 文案）。
  async function blob(path, options = {}) {
    const headers = {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...authHeaders(),
      ...(options.headers || {}),
    }
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      if (response.status === 401) onUnauthorized?.(path, response)
      const body = parseBody(text)
      const msg = body?.message || (typeof body === 'string' ? body : '') || i18n.global.t('api.downloadFailed', { status: response.status })
      const error = new Error(msg)
      error.status = response.status
      error.details = body
      throw error
    }
    return response.blob()
  }

  // 流式下载:fetch + reader 逐块读,onProgress({received,total});完成返回 Blob。
  // total 来自 content-length(缺失/0 → 不确定态,调用方只显示已收字节)。
  async function downloadStream(path, { body, onProgress, signal } = {}) {
    const headers = {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...authHeaders(),
    }
    // fetch 中止原生抛 AbortError(DOMException,无 .aborted 属性),统一改写为 {aborted:true}
    // 契约形状(与 uploadBinary 的 xhr.onabort 一致),供 transfers store 的 catch 判 canceled。
    // 覆盖 fetch 发起与 reader.read() 两个阶段的中止。
    try {
      const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: body ? JSON.stringify(body) : undefined, signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        if (response.status === 401) onUnauthorized?.(path, response)
        const b = parseBody(text)
        throw Object.assign(new Error(b?.message || i18n.global.t('api.downloadFailed', { status: response.status })), { status: response.status, details: b })
      }
      const total = parseInt(response.headers.get('content-length') || '0', 10) || 0
      const reader = response.body?.getReader?.()
      if (!reader) return response.blob()
      const chunks = []
      let received = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        onProgress?.({ received, total })
      }
      return new Blob(chunks, { type: response.headers.get('content-type') || 'application/octet-stream' })
    } catch (e) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { aborted: true })
      throw e
    }
  }

  // 二进制流式上传:XHR(fetch 拿不到上传进度)。createXhr 可注入(测试)。
  function uploadBinary(path, file, { onProgress, signal } = {}, createXhr = () => new XMLHttpRequest()) {
    return new Promise((resolve, reject) => {
      // 已中止守卫：signal 先于调用被 abort 时，不再创建/发送 XHR（Task 3 审查承接）
      if (signal?.aborted) { reject(Object.assign(new Error('aborted'), { aborted: true })); return }
      const xhr = createXhr()
      const onAbort = () => xhr.abort()
      signal?.addEventListener('abort', onAbort)
      const detach = () => signal?.removeEventListener?.('abort', onAbort)
      xhr.open('POST', `${baseUrl}${path}`)
      for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v)
      xhr.upload.onprogress = e => { if (e.lengthComputable) onProgress?.({ received: e.loaded, total: e.total }) }
      xhr.onload = () => {
        detach()
        const b = parseBody(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) return resolve(b)
        if (xhr.status === 401) onUnauthorized?.(path, { status: 401 })
        reject(Object.assign(new Error(b?.message || i18n.global.t('api.requestFailed', { status: xhr.status })), { status: xhr.status, details: b }))
      }
      xhr.onerror = () => { detach(); reject(Object.assign(new Error(i18n.global.t('api.downloadFailed', { status: 0 })), { status: 0 })) }
      xhr.onabort = () => { detach(); reject(Object.assign(new Error('aborted'), { aborted: true })) }
      xhr.send(file)
    })
  }

  return { request, blob, downloadStream, uploadBinary, authHeaders, baseUrl }
}
