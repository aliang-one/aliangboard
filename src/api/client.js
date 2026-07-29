import { dump as yamlDump } from 'js-yaml'

const baseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const sessionKey = 'aliangboard.session'

// 导出任意资源的真实 YAML（kubectl get -o yaml）：拉取 live 对象 → 去 managedFields → dump → 下载
export async function exportYaml(k8sPath, filename = 'resource.yaml') {
  const obj = await request(`/api/k8s${k8sPath}`)
  const clone = JSON.parse(JSON.stringify(obj || {}))
  if (clone?.metadata) delete clone.metadata.managedFields   // 去掉冗长的 managedFields
  const text = yamlDump(clone)
  const blob = new Blob([text], { type: 'text/yaml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
  return text
}


function getSessionToken() {
  return sessionStorage.getItem(sessionKey) || localStorage.getItem(sessionKey) || ''
}

async function request(path, options = {}) {
  const headers = { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) }
  const token = getSessionToken()
  if (token) headers.authorization = `Bearer ${token}`
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    const error = new Error(body?.message || `请求失败：HTTP ${response.status}`)
    error.status = response.status
    error.details = body
    throw error
  }
  return body
}

export function saveSession(token, remember = false) {
  sessionStorage.removeItem(sessionKey)
  localStorage.removeItem(sessionKey)
  ;(remember ? localStorage : sessionStorage).setItem(sessionKey, token)
}

export function clearSession() {
  sessionStorage.removeItem(sessionKey)
  localStorage.removeItem(sessionKey)
}

export function getSession() {
  return getSessionToken()
}

export const api = {
  connect: payload => request('/api/session', { method: 'POST', body: JSON.stringify(payload) }),
  session: () => request('/api/session'),
  logout: () => request('/api/session', { method: 'DELETE' }),
  health: () => request('/api/health'),
  applyYaml: yaml => request('/api/apply', { method: 'POST', body: JSON.stringify({ yaml }) }),
  k8s: (path, options) => request(`/api/k8s${path}`, options),
}

// 端口转发管理（REST）：在网关主机开本地 TCP 监听转发到 Pod，等同 kubectl port-forward。
export const portForwardApi = {
  create: payload => request('/api/portforward', { method: 'POST', body: JSON.stringify(payload) }),
  list: () => request('/api/portforward'),
  remove: id => request(`/api/portforward/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

// Pod 文件浏览（基于一次性 exec：ls / cat / 写入），仅远端模式可用。
export const podFileApi = {
  list: payload => request('/api/podfile/list', { method: 'POST', body: JSON.stringify(payload) }),
  read: payload => request('/api/podfile/read', { method: 'POST', body: JSON.stringify(payload) }),
  write: payload => request('/api/podfile/write', { method: 'POST', body: JSON.stringify(payload) }),
  async download(payload) {
    const headers = { 'content-type': 'application/json' }
    const token = getSessionToken()
    if (token) headers.authorization = `Bearer ${token}`
    const res = await fetch(`${baseUrl}/api/podfile/download`, { method: 'POST', headers, body: JSON.stringify(payload) })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let msg = text
      try { msg = JSON.parse(text)?.message || text } catch { /* 非 JSON */ }
      throw new Error(msg || `下载失败：HTTP ${res.status}`)
    }
    return res.blob()
  },
}

// 注入 Ephemeral Container（kubectl debug），用于调试无 shell / distroless 镜像。仅远端模式。
export const podDebugApi = {
  attach: payload => request('/api/pod/debug', { method: 'POST', body: JSON.stringify(payload) }),
}

// Pod exec 终端双向通道：浏览器 WebSocket ↔ Gateway ↔ K8s（SPDY/WS）。
// 二进制帧首字节为通道标识（1 stdin / 2 resize 入向；1 stdout / 2 stderr / 3 exit / 4 error 出向）。
// 返回 { send, resize, close, isOpen } 供 xterm 终端驱动。
export function execStream({ namespace, pod, container = '', command = '/bin/sh', tty = true, onStdout, onStderr, onExit, onError, onClose } = {}) {
  const token = getSessionToken()
  const proto = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
  const host = globalThis.location?.host || '127.0.0.1:8787'
  const params = new URLSearchParams({ namespace, pod, tty: tty ? 'true' : 'false' })
  if (container) params.set('container', container)
  if (command) params.set('command', command)
  if (token) params.set('session', token)
  const ws = new WebSocket(`${proto}://${host}/api/exec?${params}`)
  ws.binaryType = 'arraybuffer'
  const decoder = new TextDecoder()
  ws.onmessage = ev => {
    const buf = new Uint8Array(ev.data)
    if (!buf.length) return
    const type = buf[0]
    const payload = decoder.decode(buf.subarray(1), { stream: true })
    if (type === 1) onStdout?.(payload)
    else if (type === 2) onStderr?.(payload)
    else if (type === 3) { try { onExit?.(JSON.parse(payload || '{}')) } catch { onExit?.({}) } }
    else if (type === 4) onError?.(payload)
  }
  ws.onerror = () => onError?.('exec 连接异常（请确认已连接集群、容器已就绪且镜像内存在 shell）')
  ws.onclose = () => onClose?.()
  const encoder = new TextEncoder()
  function frame(type, data) {
    if (ws.readyState !== 1) return
    const body = typeof data === 'string' ? encoder.encode(data) : data
    const out = new Uint8Array(body.length + 1)
    out[0] = type
    out.set(body, 1)
    ws.send(out.buffer)
  }
  return {
    send: data => frame(1, data),
    resize: ({ cols, rows }) => frame(2, JSON.stringify({ cols, rows })),
    close: () => { try { ws.close() } catch { /* noop */ } },
    get isOpen() { return ws.readyState === 1 },
  }
}

// 流式读取 K8s 长连接（watch=true / log follow=true）：Gateway 已对这两类请求改为 pipe 透传。
// 按行回调 onMessage（watch 为换行分隔 JSON，log 为换行分隔文本）；返回 { abort } 供调用方停止。
export function k8sStream(path, { onMessage, onError, onClose } = {}) {
  const controller = new AbortController()
  let reader = null
  let aborted = false
  ;(async () => {
    try {
      const headers = {}
      const token = getSessionToken()
      if (token) headers.authorization = `Bearer ${token}`
      const response = await fetch(`${baseUrl}/api/k8s${path}`, { headers, signal: controller.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        let body = text
        try { body = JSON.parse(text) } catch { /* 非 JSON */ }
        throw new Error(body?.message || `流式请求失败：HTTP ${response.status}`)
      }
      reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      while (!aborted) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl)
          buffer = buffer.slice(nl + 1)
          if (line.trim()) onMessage?.(line)
        }
      }
      if (buffer.trim()) onMessage?.(buffer)
      onClose?.()
    } catch (e) {
      if (!aborted) onError?.(e)
    }
  })()
  return {
    abort: () => {
      aborted = true
      try { controller.abort() } catch { /* noop */ }
      try { reader?.cancel() } catch { /* noop */ }
    },
  }
}
