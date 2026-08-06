// 统一 HTTP 原语：把原先 client.js 里 4 份重复的「取 token + 拼 header + fetch + 解析 + 401 + 错误」
// (request / platformRequest / k8sStream 内 / podFileApi.download)收敛为一份。
//
// 设计：依赖注入。createHttp 不触碰 storage/location，由调用方注入
//   - resolveAuth(): () => header 对象（如 { authorization: 'Bearer …' } / { 'x-platform-token': … }）
//   - onUnauthorized(path, response): 401 时的处理（清凭据 + 跳登录），由调用方按层（k8s/平台）决定
// 这样 http.js 纯净可单测，client.js 造两个实例（k8sHttp / platformHttp）即可。

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
      const error = new Error(body?.message || `请求失败：HTTP ${response.status}`)
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
      const msg = body?.message || (typeof body === 'string' ? body : '') || `下载失败：HTTP ${response.status}`
      const error = new Error(msg)
      error.status = response.status
      error.details = body
      throw error
    }
    return response.blob()
  }

  return { request, blob, authHeaders, baseUrl }
}
