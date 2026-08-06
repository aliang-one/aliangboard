import { dump as yamlDump } from 'js-yaml'
import { createHttp, parseBody } from './http.js'
import { i18n } from '@/i18n'

const baseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const sessionKey = 'aliangboard.session'
const platformKey = 'aliangboard.platform'

// 跳登录页（已在 /login 则不重复跳，避免循环）
function redirectToLogin() {
  if (typeof location !== 'undefined' && !location.pathname.startsWith('/login')) {
    location.href = '/login'
  }
}

export function getSessionToken() {
  return sessionStorage.getItem(sessionKey) || localStorage.getItem(sessionKey) || ''
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

// 平台认证 token（Layer 1：用户身份）
export function getPlatformToken() {
  return localStorage.getItem(platformKey) || ''
}
export function savePlatformToken(token) {
  if (token) localStorage.setItem(platformKey, token)
}
// 平台 token 过期清理（原 platformRequest 无 401 处理，本次统一补齐）
export function clearPlatformToken() {
  localStorage.removeItem(platformKey)
}

// === 两个 HTTP 实例：k8s 会话层 + 平台认证层 ===
// 收敛原先 4 份重复的 fetch 实现（request / platformRequest / k8sStream 内 / podFileApi.download）。
// 401 处理：登录接口自身（/api/session、/api/auth/login）的 401 = 凭据错误，交调用方提示，不清凭据不跳转；
// 其余 401 = 会话过期 → 清对应凭据 + 跳登录。
const k8sHttp = createHttp({
  baseUrl,
  resolveAuth: () => {
    const t = getSessionToken()
    return t ? { authorization: `Bearer ${t}` } : {}
  },
  onUnauthorized: (path) => {
    if (!path.startsWith('/api/session')) { clearSession(); redirectToLogin() }
  },
})

const platformHttp = createHttp({
  baseUrl,
  resolveAuth: () => {
    const t = getPlatformToken()
    return t ? { 'x-platform-token': t } : {}
  },
  onUnauthorized: (path) => {
    if (!path.startsWith('/api/auth/login')) { clearPlatformToken(); redirectToLogin() }
  },
})

// 导出任意资源的真实 YAML（kubectl get -o yaml）：拉取 live 对象 → 去 managedFields → dump → 下载
export async function exportYaml(k8sPath, filename = 'resource.yaml') {
  const obj = await k8sHttp.request(`/api/k8s${k8sPath}`)
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

// === 多集群：已保存集群持久化（localStorage），活跃集群 = sessionKey 中的 token ===
const clustersKey = 'aliangboard.clusters'
export function getSavedClusters() {
  try { return JSON.parse(localStorage.getItem(clustersKey) || '[]') } catch { return [] }
}
function persistClusters(list) { localStorage.setItem(clustersKey, JSON.stringify(list)) }
export function addSavedCluster(c) {
  const list = getSavedClusters()
  const i = list.findIndex(x => x.apiServer === c.apiServer)
  const rec = { id: c.apiServer, name: c.name, apiServer: c.apiServer, token: c.token, version: c.version || 'unknown', authMethod: c.authMethod || 'token', status: 'Healthy', savedAt: c.savedAt }
  if (i >= 0) list[i] = { ...list[i], ...rec }; else list.push(rec)
  persistClusters(list)
}
export function removeSavedCluster(apiServer) {
  persistClusters(getSavedClusters().filter(c => c.apiServer !== apiServer))
}
// 切换活跃集群：写入活跃 token（双写 storage，getSessionToken 优先读 sessionStorage）
export function setActiveToken(token) {
  if (!token) return
  sessionStorage.setItem(sessionKey, token)
  localStorage.setItem(sessionKey, token)
}
export function activeApiServer() {
  const t = getSessionToken()
  return (getSavedClusters().find(c => c.token === t) || {}).apiServer || ''
}

export const api = {
  connect: payload => k8sHttp.request('/api/session', { method: 'POST', body: JSON.stringify(payload) }),
  session: () => k8sHttp.request('/api/session'),
  logout: () => k8sHttp.request('/api/session', { method: 'DELETE' }),
  health: () => k8sHttp.request('/api/health'),
  applyYaml: yaml => k8sHttp.request('/api/apply', { method: 'POST', body: JSON.stringify({ yaml }) }),
  k8s: (path, options) => k8sHttp.request(`/api/k8s${path}`, options),
}

// 端口转发管理（REST）：在网关主机开本地 TCP 监听转发到 Pod，等同 kubectl port-forward。
export const portForwardApi = {
  create: payload => k8sHttp.request('/api/portforward', { method: 'POST', body: JSON.stringify(payload) }),
  list: () => k8sHttp.request('/api/portforward'),
  remove: id => k8sHttp.request(`/api/portforward/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

// 镜像仓库可用版本（registry v2 /tags/list）：改版本时下拉选择而非手填。
export const registryApi = {
  tags: payload => k8sHttp.request('/api/registry/tags', { method: 'POST', body: JSON.stringify(payload) }),
}

// 终端会话管理（任务栏：CRUD + 持久化）
export const terminalApi = {
  list: () => k8sHttp.request('/api/terminals'),
  create: t => k8sHttp.request('/api/terminals', { method: 'POST', body: JSON.stringify(t) }),
  update: (id, patch) => k8sHttp.request(`/api/terminals/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: id => k8sHttp.request(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}

// Pod 文件浏览（基于一次性 exec：ls / cat / 写入），仅远端模式可用。
export const podFileApi = {
  list: payload => k8sHttp.request('/api/podfile/list', { method: 'POST', body: JSON.stringify(payload) }),
  read: payload => k8sHttp.request('/api/podfile/read', { method: 'POST', body: JSON.stringify(payload) }),
  write: payload => k8sHttp.request('/api/podfile/write', { method: 'POST', body: JSON.stringify(payload) }),
  download: payload => k8sHttp.blob('/api/podfile/download', { method: 'POST', body: JSON.stringify(payload) }),
}

// 注入 Ephemeral Container（kubectl debug），用于调试无 shell / distroless 镜像。仅远端模式。
export const podDebugApi = {
  attach: payload => k8sHttp.request('/api/pod/debug', { method: 'POST', body: JSON.stringify(payload) }),
}

// PVC 文件浏览（只读）：网关起 helper busybox Pod 只读挂载该 PVC + exec ls/cat。仅远端模式。
export const pvcFileApi = {
  list: payload => k8sHttp.request('/api/pvcfile/list', { method: 'POST', body: JSON.stringify(payload) }),
  read: payload => k8sHttp.request('/api/pvcfile/read', { method: 'POST', body: JSON.stringify(payload) }),
}

// 手动触发 CronJob（kubectl create job --from）。仅远端模式。
export const cronJobApi = {
  trigger: payload => k8sHttp.request('/api/cronjob/trigger', { method: 'POST', body: JSON.stringify(payload) }),
}

// 资源归属拓扑（沿 ownerReferences 解析归属链）。仅远端模式。
export const resourceTreeApi = {
  get: ({ namespace, kind, name, apiVersion }) =>
    k8sHttp.request(`/api/resource/tree?${new URLSearchParams({ namespace, kind, name, apiVersion: apiVersion || 'v1' })}`),
}

// 工作台 API（W2，第三阶段）：任意平台用户，项目按 userId 归属
export const workbenchApi = {
  listProjects: () => platformHttp.request('/api/workbench/projects'),
  createProject: payload => platformHttp.request('/api/workbench/projects', { method: 'POST', body: JSON.stringify(payload) }),
  getProject: id => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}`),
  readFile: (id, path) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`),
  writeFile: (id, path, content) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  commit: (id, message) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/commit`, { method: 'POST', body: JSON.stringify({ message }) }),
  // 集群台账（cluster-context repo，每集群一份）
  getLedger: clusterId => platformHttp.request(`/api/workbench/ledger?clusterId=${encodeURIComponent(clusterId)}`),
  bootstrapLedger: clusterId => platformHttp.request('/api/workbench/ledger/bootstrap', { method: 'POST', body: JSON.stringify({ clusterId }) }),
  // 项目 agent 聊天（W4b）：{ projectId, message?, resume? } → { status:'done'|'pending_approval', content, trace, ... }
  chat: payload => platformHttp.request('/api/agent/chat', { method: 'POST', body: JSON.stringify(payload) }),
  // 台账蒸馏(D2,自我学习):{ clusterId } → { proposed, current, summary, stats }
  distill: clusterId => platformHttp.request('/api/workbench/distill', { method: 'POST', body: JSON.stringify({ clusterId }) }),
  applyDistill: (clusterId, learnings) => platformHttp.request('/api/workbench/distill/apply', { method: 'POST', body: JSON.stringify({ clusterId, learnings }) }),
  dismissDistill: clusterId => platformHttp.request('/api/workbench/distill/dismiss', { method: 'POST', body: JSON.stringify({ clusterId }) }),
  // 项目 reconcile(第 4 阶段):幂等再 apply manifests → { applied, failed, total, ts } | { skipped }
  reconcile: id => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
}

// === 平台认证 API（Layer 1: 用户身份）===
export const authApi = {
  login: payload => platformHttp.request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  me: () => platformHttp.request('/api/auth/me'),
  logout: () => platformHttp.request('/api/auth/logout', { method: 'POST' }),
  myClusters: () => platformHttp.request('/api/my-clusters'),
  connectCluster: id => platformHttp.request('/api/connect-cluster', { method: 'POST', body: JSON.stringify({ clusterId: id }) }),
}
// Admin API
export const adminApi = {
  users: {
    list: () => platformHttp.request('/api/admin/users'),
    create: payload => platformHttp.request('/api/admin/users', { method: 'POST', body: JSON.stringify(payload) }),
    remove: id => platformHttp.request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    patch: (id, patch) => platformHttp.request(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    resetPassword: (id, newPassword) => platformHttp.request(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, { method: 'POST', body: JSON.stringify({ newPassword }) }),
    assignClusters: (id, clusterIds) => platformHttp.request(`/api/admin/users/${encodeURIComponent(id)}/clusters`, { method: 'PUT', body: JSON.stringify({ clusterIds }) }),
  },
  clusters: {
    list: () => platformHttp.request('/api/admin/clusters'),
    create: payload => platformHttp.request('/api/admin/clusters', { method: 'POST', body: JSON.stringify(payload) }),
    remove: id => platformHttp.request(`/api/admin/clusters/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  },
  apikeys: {
    list: () => platformHttp.request('/api/admin/apikeys'),
    create: payload => platformHttp.request('/api/admin/apikeys', { method: 'POST', body: JSON.stringify(payload) }),
    remove: id => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    updateOverrides: (id, tool_overrides) => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}/overrides`, { method: 'PATCH', body: JSON.stringify({ tool_overrides }) }),
  },
  // Agent 聊天(第二阶段切片 4):{ message, apiKeyId, history } → { content, steps, denied, truncated?, trace[] }
  agent: {
    chat: payload => platformHttp.request('/api/agent/chat', { method: 'POST', body: JSON.stringify(payload) }),
  },
  // LLM 配置(baseURL/apiKey/model 存 DB;GET 不回传 key)
  llmConfig: {
    get: () => platformHttp.request('/api/admin/llm-config'),
    save: payload => platformHttp.request('/api/admin/llm-config', { method: 'PUT', body: JSON.stringify(payload) }),
    test: payload => platformHttp.request('/api/admin/llm-config/test', { method: 'POST', body: JSON.stringify(payload || {}) }),
  },
}

// Pod exec 终端双向通道：浏览器 WebSocket ↔ Gateway ↔ K8s（SPDY/WS）。
// 二进制帧首字节为通道标识（1 stdin / 2 resize 入向；1 stdout / 2 stderr / 3 exit / 4 error 出向）。
// 返回 { send, resize, close, isOpen } 供 xterm 终端驱动。
export function execStream({ namespace, pod, container = '', command = '/bin/sh', tty = true, attach = false, onStdout, onStderr, onExit, onError, onClose } = {}) {
  const token = getSessionToken()
  const proto = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
  const host = globalThis.location?.host || '127.0.0.1:8787'
  const params = new URLSearchParams({ namespace, pod, tty: tty ? 'true' : 'false' })
  if (container) params.set('container', container)
  if (attach) params.set('mode', 'attach')          // kubectl attach：连主进程 stdio
  else if (command) params.set('command', command)
  if (token) params.set('session', token)
  const ws = new WebSocket(`${proto}://${host}/api/exec?${params}`)
  ws.binaryType = 'arraybuffer'
  // stdout/stderr 直传原始字节给 xterm（term.write 接受 Uint8Array，内部正确处理 UTF-8/ANSI/二进制），
  // 避免共享 TextDecoder 把非 ASCII 字节解成替换符、或跨帧 stream 状态错乱。
  const utf8 = new TextDecoder()
  ws.onmessage = ev => {
    const buf = new Uint8Array(ev.data)
    if (!buf.length) return
    const type = buf[0]
    const payload = buf.subarray(1)
    if (type === 1) onStdout?.(payload)
    else if (type === 2) onStderr?.(payload)
    else if (type === 3) { try { onExit?.(JSON.parse(utf8.decode(payload) || '{}')) } catch { onExit?.({}) } }
    else if (type === 4) onError?.(utf8.decode(payload))
  }
  ws.onerror = () => onError?.(i18n.global.t('terminal.execConnectError'))
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
// 认证 header 复用 k8sHttp.authHeaders()，错误体解析复用 parseBody（与 request 同源）。
export function k8sStream(path, { onMessage, onError, onClose } = {}) {
  const controller = new AbortController()
  let reader = null
  let aborted = false
  ;(async () => {
    try {
      const response = await fetch(`${k8sHttp.baseUrl}/api/k8s${path}`, { headers: k8sHttp.authHeaders(), signal: controller.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const body = parseBody(text)
        throw new Error(body?.message || i18n.global.t('store.streamFailed', { status: response.status }))
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
      // 主动 abort 是正常停止；AbortError 静默（避免 unhandled rejection 噪音）
      if (aborted || e?.name === 'AbortError') return
      onError?.(e)
    }
  })()
  return {
    abort: () => {
      aborted = true
      try { controller.abort() } catch { /* noop */ }
      try { reader?.cancel?.().catch(() => {}) } catch { /* noop */ }
    },
  }
}
