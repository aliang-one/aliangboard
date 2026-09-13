import { createHttp, parseBody } from './http.js'
import { i18n } from '@/i18n'

const baseUrl = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '')
const sessionKey = 'aliangboard.session'
const prevSessionKey = 'aliangboard.prevSession'
const platformKey = 'aliangboard.platform'

// 跳登录页（已在 /login 则不重复跳，避免循环）。携带 ?redirect= 原路径+query(2026-09-04 事故⑥):
// 被踢走的弹窗/页面登录后原路返回(SSH 弹窗同 sid 重建 WS);Login 侧经 safeRedirectPath 防开放重定向。
function redirectToLogin() {
  if (typeof location !== 'undefined' && !location.pathname.startsWith('/login')) {
    const back = encodeURIComponent(location.pathname + location.search)
    location.href = `/login?redirect=${back}`
  }
}

// 跳集群选择页（已在则不重复跳）。K8s 会话失效 ≠ 平台登出——平台登录还在，只需重选集群。
function redirectToSelectCluster() {
  if (typeof location !== 'undefined' && !location.pathname.startsWith('/select-cluster')) {
    location.href = '/select-cluster'
  }
}

// 跳 MFA 启用引导（W3 §1.5，外评 2026-09-07 修复 2）：admin 强制开关下的受限 token 首个
// 403 {code:'MFA_ENROLLMENT_REQUIRED'} → 个人中心安全 tab。不清平台凭据（受限 token 仍有效，
// 启用后原地转正）；已在 /profile 不跳——安全页自身的非白名单请求（如会话列表）同样 403，
// 反复整页跳转 = 刷新死循环（与 redirectToLogin 的「已在则不跳」同款守卫）。
function redirectToMfaEnrollment() {
  if (typeof location !== 'undefined' && !location.pathname.startsWith('/profile')) {
    location.href = '/profile?tab=security'
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
  // 暂存被清的 token(2026-09-03):任务栏终端/文件浏览记录以 K8s session token 为归属键,
  // 重连同集群后用旧 token 把记录迁到新会话(POST /api/terminals/rekey),否则记录永久失明。
  const prev = getSessionToken()
  if (prev) { try { localStorage.setItem(prevSessionKey, prev) } catch { /* 存储不可用静默 */ } }
  sessionStorage.removeItem(sessionKey)
  localStorage.removeItem(sessionKey)
}

// 读取/清除暂存的旧会话 token(迁移失败时保留,下次重连可再试)
export function getStashedSession() {
  try { return localStorage.getItem(prevSessionKey) || '' } catch { return '' }
}
export function clearStashedSession() {
  try { localStorage.removeItem(prevSessionKey) } catch { /* noop */ }
}

// 账号切换专用(W2-0 §0.4-4):双键全清且不暂存——与 clearSession(暂存供同集群 rekey)语义相反。
// 登录成功时调用:上一账号的 K8s token/暂存一律不留,防跨账号复用与窗口记录继承。
export function purgeSession() {
  try { sessionStorage.removeItem(sessionKey); localStorage.removeItem(sessionKey); localStorage.removeItem(prevSessionKey) } catch { /* 存储不可用静默 */ }
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
// 其余 401 = 会话过期 → 清对应凭据（K8s 层失效只清到「重选集群」，平台层失效才回登录页）。
const k8sHttp = createHttp({
  baseUrl,
  resolveAuth: () => {
    const t = getSessionToken()
    return t ? { authorization: `Bearer ${t}` } : {}
  },
  // K8s 层 401 分两种（分层鉴权，勿与平台登出混淆）：
  // - 请求时就没带 K8s token = 未连接集群（预期状态，典型：首装 admin 进集群管理页，
  //   AppLayout/TopNavBar 仍发 k8s 请求）→ 不清凭据不跳转，错误交调用方按需提示。
  //   曾误走 clearSession + 跳 /login → 守卫见平台 token 有效又弹回 /select-cluster → 死循环。
  // - 带了 token 被拒 = K8s 会话过期/失效 → 清 K8s session；平台登录仍在 → 跳集群选择页重连。
  onUnauthorized: (path) => {
    if (path.startsWith('/api/session')) return
    if (!getSessionToken()) return
    clearSession()
    redirectToSelectCluster()
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
  // 受限 token 403 → MFA 启用引导（mfaHttp 只打白名单内的 mfa/* 端点，不会收到该 403，不接）
  onMfaRequired: () => redirectToMfaEnrollment(),
})

// MFA 账户安全面专用(W3 Task 4):mfa/disable / step-up 的 401 = 验码失败(会话仍有效),
// 走 platformHttp 会被 401 全局处理清平台 token + 跳登录——错一次码就整页登出。
// 此实例 401 不做全局副作用,错误交调用方行内提示;鉴权 header 与 platformHttp 同源。
const mfaHttp = createHttp({
  baseUrl,
  resolveAuth: () => {
    const t = getPlatformToken()
    return t ? { 'x-platform-token': t } : {}
  },
  onUnauthorized: () => {},
})

// 导出任意资源的真实 YAML（kubectl get -o yaml）：拉取 live 对象 → 去 managedFields → dump → 下载
export async function exportYaml(k8sPath, filename = 'resource.yaml') {
  const obj = await k8sHttp.request(`/api/k8s${k8sPath}`)
  const clone = JSON.parse(JSON.stringify(obj || {}))
  if (clone?.metadata) delete clone.metadata.managedFields   // 去掉冗长的 managedFields
  // 动态 import(2026-09-09):js-yaml 只有本函数用,导出下载属低频功能,静态 import 会让
  // client chunk 持有 js-yaml 静态边。注意:入口关键路径当前仍含 js-yaml —— 另有
  // stores/cluster(.js/yaml.js)与 useYaml.js 三个急加载引入者(generateYAML 同步调用面
  // 广,异步化是独立后续项);本处改动保 hygiene + 防再添静态边。守卫:
  // scripts/client-critical-path.test.mjs。
  const { dump: yamlDump } = await import('js-yaml')
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

// (2026-09-10 issue#8)localStorage 集群登记簿(aliangboard.clusters)已退役:
// 可用集群列表服务端为源(/api/my-clusters),切换走平台连接链换新 token。
// 存量 localStorage 键为惰性孤儿数据,不做迁移。

export const api = {
  // connect(POST /api/session)已删——旧直连建会话已下线(CSO #1)
  session: () => k8sHttp.request('/api/session'),
  logout: () => k8sHttp.request('/api/session', { method: 'DELETE' }),
  health: () => k8sHttp.request('/api/health'),
  applyYaml: (yaml, defaultNs) => k8sHttp.request('/api/apply', { method: 'POST', body: JSON.stringify({ yaml, defaultNs }) }),
  k8s: (path, options) => k8sHttp.request(`/api/k8s${path}`, options),
  // 集群证书报告(2026-09-06):连接证书/CA 锚/TLS Secret 扫描(session 鉴权,集群级读)
  clusterCerts: () => k8sHttp.request('/api/cluster-certs'),
  ingressControllers: {
    catalog: () => k8sHttp.request('/api/ingress-controllers/catalog'),
    manifest: id => k8sHttp.request(`/api/ingress-controllers/manifest/${encodeURIComponent(id)}`),
  },
  // 平台版本检测(2026-08-27 版本机制设计;api 对象内首个 platformHttp 端点)
  getVersion: () => platformHttp.request('/api/version'),
  checkVersion: () => platformHttp.request('/api/version/check', { method: 'POST' }),
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

// 会话轮换后的窗口记录迁移(2026-09-03):旧 token 名下 terminals/file_browsers 迁到当前会话
export const rekeyApi = {
  windowRecords: from => k8sHttp.request('/api/terminals/rekey', { method: 'POST', body: JSON.stringify({ from }) }),
}

// 终端会话管理（任务栏：CRUD + 持久化）
export const terminalApi = {
  list: () => k8sHttp.request('/api/terminals'),
  create: t => k8sHttp.request('/api/terminals', { method: 'POST', body: JSON.stringify(t) }),
  update: (id, patch) => k8sHttp.request(`/api/terminals/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: id => k8sHttp.request(`/api/terminals/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
// 文件浏览窗口管理(任务栏:CRUD + 持久化,与 terminalApi 同构)
export const fileBrowserApi = {
  list: () => k8sHttp.request('/api/file-browsers'),
  create: b => k8sHttp.request('/api/file-browsers', { method: 'POST', body: JSON.stringify(b) }),
  update: (id, patch) => k8sHttp.request(`/api/file-browsers/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: id => k8sHttp.request(`/api/file-browsers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}


// Pod 文件浏览（基于一次性 exec：ls / cat / 写入），仅远端模式可用。
export const podFileApi = {
  list: payload => k8sHttp.request('/api/podfile/list', { method: 'POST', body: JSON.stringify(payload) }),
  read: payload => k8sHttp.request('/api/podfile/read', { method: 'POST', body: JSON.stringify(payload) }),
  write: payload => k8sHttp.request('/api/podfile/write', { method: 'POST', body: JSON.stringify(payload) }),
  download: payload => k8sHttp.blob('/api/podfile/download', { method: 'POST', body: JSON.stringify(payload) }),
  // 流式下载(进度):POST JSON → Blob,onProgress({received,total})
  downloadStream: (payload, { onProgress, signal } = {}) =>
    k8sHttp.downloadStream('/api/podfile/download', { body: payload, onProgress, signal }),
  // 流式上传(进度):元信息查询串 + 原始文件体
  uploadStream: ({ namespace, pod, container, path }, file, { onProgress, signal } = {}) => {
    const q = new URLSearchParams({ namespace, pod, container: container || '', path })
    return k8sHttp.uploadBinary(`/api/podfile/upload?${q}`, file, { onProgress, signal })
  },
  // 文件三件套(2026-09-08):mkdir={path:父目录,name} / delete={path} / rename={path,name}
  mkdir: payload => k8sHttp.request('/api/podfile/mkdir', { method: 'POST', body: JSON.stringify(payload) }),
  delete: payload => k8sHttp.request('/api/podfile/delete', { method: 'POST', body: JSON.stringify(payload) }),
  rename: payload => k8sHttp.request('/api/podfile/rename', { method: 'POST', body: JSON.stringify(payload) }),
}

// SSH 服务器管理(Task 3 REST;全部 admin-only)。行经服务端脱敏:只有 hasPassword 等布尔,无凭据本体。
export const sshApi = {
  list: () => platformHttp.request('/api/ssh/servers'),
  create: payload => platformHttp.request('/api/ssh/servers', { method: 'POST', body: JSON.stringify(payload) }),
  update: (id, patch) => platformHttp.request(`/api/ssh/servers/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(patch) }),
  remove: id => platformHttp.request(`/api/ssh/servers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  testSaved: id => platformHttp.request(`/api/ssh/servers/${encodeURIComponent(id)}/test`, { method: 'POST' }),
  testForm: payload => platformHttp.request('/api/ssh/test', { method: 'POST', body: JSON.stringify(payload) }),
  getLedger: () => platformHttp.request('/api/ssh/ledger'),
  saveLedger: (scope, notes) => platformHttp.request('/api/ssh/ledger', { method: 'PUT', body: JSON.stringify({ scope, notes }) }),
  // 网关存活终端会话(2026-08-29 泄漏审计):观测 + 手杀,任务栏对账用
  listSessions: () => platformHttp.request('/api/ssh/sessions'),
  // keepalive:弹窗页「关闭窗口」钮点击后随即 window.close(),让 kill 请求在标签页卸载后仍送达网关
  killSession: sid => platformHttp.request(`/api/ssh/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE', keepalive: true }),
}

// SSH 服务器文件浏览(Task 13 REST;形状与 podFileApi 对齐,走 platformHttp)。
// upload 服务端拒绝名字含 / \ .. . → 前端同名校验先行;409=凭据密钥不可用(message 来自服务端)。
export const sshFileApi = {
  list: (serverId, path) => platformHttp.request('/api/sshfile/list', { method: 'POST', body: JSON.stringify({ serverId, path }) }),
  // 流式下载(进度):完成返回 Blob(content-length 缺失 → total=0 不确定态)
  downloadStream: ({ serverId, path }, { onProgress, signal } = {}) =>
    platformHttp.downloadStream('/api/sshfile/download', { body: { serverId, path }, onProgress, signal }),
  // 流式上传(进度):元信息查询串 + 原始文件体
  uploadStream: ({ serverId, path, name }, file, { onProgress, signal } = {}) => {
    const q = new URLSearchParams({ serverId, path, name })
    return platformHttp.uploadBinary(`/api/sshfile/upload?${q}`, file, { onProgress, signal })
  },
  // 文件三件套(2026-09-08):与 podFileApi 同形({serverId,path[,name]})
  mkdir: payload => platformHttp.request('/api/sshfile/mkdir', { method: 'POST', body: JSON.stringify(payload) }),
  delete: payload => platformHttp.request('/api/sshfile/delete', { method: 'POST', body: JSON.stringify(payload) }),
  rename: payload => platformHttp.request('/api/sshfile/rename', { method: 'POST', body: JSON.stringify(payload) }),
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
  // 工作台「记录」页:跨项目对话记录 + 计数 + 存储信息(admin)
  records: () => platformHttp.request('/api/workbench/records'),
  summary: () => platformHttp.request('/api/workbench/summary'),
  createProject: payload => platformHttp.request('/api/workbench/projects', { method: 'POST', body: JSON.stringify(payload) }),
  // 无集群项目(2026-08-30):换绑/解绑——clusterId '' = 解绑 → { ok, project }
  updateProjectCluster: (id, clusterId) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/cluster`, { method: 'PUT', body: JSON.stringify({ clusterId }) }),
  getProject: id => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}`),
  // 项目生命周期(T4):重命名/改 recap → { ok, project };删除须确认名逐字一致,不符 400
  updateProject: (id, patch) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteProject: (id, confirmName) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirmName }) }),
  readFile: (id, path) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`),
  writeFile: (id, path, content) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'PUT', body: JSON.stringify({ content }) }),
  deleteFile: (id, path) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/files/${path.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' }),
  commit: (id, message) => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/commit`, { method: 'POST', body: JSON.stringify({ message }) }),
  // 集群台账（cluster-context repo，每集群一份）
  getLedger: clusterId => platformHttp.request(`/api/workbench/ledger?clusterId=${encodeURIComponent(clusterId)}`),
  bootstrapLedger: clusterId => platformHttp.request('/api/workbench/ledger/bootstrap', { method: 'POST', body: JSON.stringify({ clusterId }) }),
  // 台账蒸馏(D2,自我学习):{ clusterId } → { proposed, current, summary, stats }
  distill: clusterId => platformHttp.request('/api/workbench/distill', { method: 'POST', body: JSON.stringify({ clusterId }) }),
  applyDistill: (clusterId, learnings) => platformHttp.request('/api/workbench/distill/apply', { method: 'POST', body: JSON.stringify({ clusterId, learnings }) }),
  dismissDistill: clusterId => platformHttp.request('/api/workbench/distill/dismiss', { method: 'POST', body: JSON.stringify({ clusterId }) }),
  // 项目 reconcile(第 4 阶段):幂等再 apply manifests → { applied, failed, total, ts } | { skipped }
  reconcile: id => platformHttp.request(`/api/workbench/projects/${encodeURIComponent(id)}/reconcile`, { method: 'POST' }),
  // 项目集群资源搜索(P3 @-mention):{ projectId, kind, q } → { items:[{name,namespace,kind}] }(capped 50)
  search: (projectId, kind, q) => platformHttp.request(`/api/workbench/search?projectId=${encodeURIComponent(projectId)}&kind=${encodeURIComponent(kind)}&q=${encodeURIComponent(q || '')}`),
  // 有状态对话(P5):服务端持久化 + 后台执行 + 轮询
  conversations: {
    create: (payload) => platformHttp.request('/api/workbench/conversations', { method: 'POST', body: JSON.stringify(payload) }),
    append: (id, { message, references }) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, references }) }),
    get: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}`),
    list: (projectId) => platformHttp.request(`/api/workbench/conversations?projectId=${encodeURIComponent(projectId)}`),
    approve: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/approve`, { method: 'POST' }),
    deny: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/deny`, { method: 'POST' }),
    cancel: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
    regenerate: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/regenerate`, { method: 'POST' }),
    delete: (id) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    rename: (id, title) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) }),
    compact: (id, instruction) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/compact`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction: instruction || '' }) }),
    // 编辑重发(spec §3.3):body { messageId, content, references? } → { status:'running', context }
    edit: (id, body) => platformHttp.request(`/api/workbench/conversations/${encodeURIComponent(id)}/edit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    // 悬浮入口:跨项目活跃对话原料(running/paused + 24h 内终态;未读判定在前端)
    active: () => platformHttp.request('/api/workbench/conversations/active'),
  },
  // AI 配置透明面板(2026-08-25):只读——生效提示词/工具清单/追加指令/model(不含连接配置)
  aiConfig: () => platformHttp.request('/api/workbench/ai-config'),
}

// 凭据(2026-09-12 spec):admin 管理面;parse 为智能粘贴解析(不落库,人工确认后走 create)
export const credentialsApi = {
  list: () => platformHttp.request('/api/workbench/credentials'),
  get: id => platformHttp.request(`/api/workbench/credentials/${encodeURIComponent(id)}`),
  create: payload => platformHttp.request('/api/workbench/credentials', { method: 'POST', body: JSON.stringify(payload) }),
  update: (id, patch) => platformHttp.request(`/api/workbench/credentials/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id, confirmName) => platformHttp.request(`/api/workbench/credentials/${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ confirmName }) }),
  reveal: (id, fieldKey) => platformHttp.request(`/api/workbench/credentials/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: JSON.stringify({ fieldKey }) }),
  parse: text => platformHttp.request('/api/workbench/credentials/parse', { method: 'POST', body: JSON.stringify({ text }) }),
}

// === 平台认证 API（Layer 1: 用户身份）===
export const authApi = {
  login: payload => platformHttp.request('/api/auth/login', { method: 'POST', body: JSON.stringify(payload) }),
  me: () => platformHttp.request('/api/auth/me'),
  // —— W3 MFA(2026-09-07 Task 4):setup/enable 走 mfaHttp(401 无全局副作用,见实例注释);
  // login/mfa 走 platformHttp(其 401=票据/验码失败,已被 /api/auth/login 前缀豁免全局登出) ——
  mfaSetup: () => mfaHttp.request('/api/auth/mfa/setup', { method: 'POST' }),
  mfaEnable: payload => mfaHttp.request('/api/auth/mfa/enable', { method: 'POST', body: JSON.stringify(payload) }),
  mfaDisable: code => mfaHttp.request('/api/auth/mfa/disable', { method: 'POST', body: JSON.stringify({ code }) }),
  mfaLogin: (username, mfaTicket, code) => platformHttp.request('/api/auth/login/mfa', { method: 'POST', body: JSON.stringify({ username, mfaTicket, code }) }),
  // —— W4 OIDC(2026-09-07):callback 302 回 /login?oidcCode= 后前端兑换码换平台 session。
  // 401(错码/过期/重放)= 兑换码失效,交登录页行内提示(platformHttp 对非 /api/auth/login 前缀
  // 的 401 会清平台 token——登录页本无有效 token,clearPlatformToken 在此无害)。
  oidcExchange: code => platformHttp.request('/api/auth/oidc/exchange', { method: 'POST', body: JSON.stringify({ code }) }),
  stepUp: code => mfaHttp.request('/api/auth/step-up', { method: 'POST', body: JSON.stringify({ code }) }),
  logout: () => platformHttp.request('/api/auth/logout', { method: 'POST' }),
  updateMe: patch => platformHttp.request('/api/auth/me', { method: 'PATCH', body: JSON.stringify(patch) }),
  changePassword: (currentPassword, newPassword) => platformHttp.request('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword, newPassword }) }),
  listSessions: () => platformHttp.request('/api/auth/sessions'),
  revokeSession: fp => platformHttp.request(`/api/auth/sessions/${encodeURIComponent(fp)}`, { method: 'DELETE' }),
  revokeOtherSessions: () => platformHttp.request('/api/auth/sessions/others', { method: 'DELETE' }),
  savePreferences: prefs => platformHttp.request('/api/auth/preferences', { method: 'PUT', body: JSON.stringify(prefs) }),
  myClusters: () => platformHttp.request('/api/my-clusters'),
  connectCluster: id => platformHttp.request('/api/connect-cluster', { method: 'POST', body: JSON.stringify({ clusterId: id }) }),
  // —— Wave1 个人域(2026-09-04)——
  myActivity: (params = {}) => platformHttp.request(`/api/my/activity?${new URLSearchParams(params)}`),
  getPasswordPolicy: () => platformHttp.request('/api/auth/password-policy'),
  myKeysList: () => platformHttp.request('/api/my/keys'),
  myKeysMint: payload => platformHttp.request('/api/my/keys', { method: 'POST', body: JSON.stringify(payload) }),
  myKeysRevoke: id => platformHttp.request(`/api/my/keys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  grantableNs: clusterId => platformHttp.request(`/api/my/grantable-ns?clusterId=${encodeURIComponent(clusterId)}`),
  // W3 Task 6:个人 kubeconfig 下发(text/plain YAML;parseBody 对非 JSON 回原文本)
  myKubeconfig: clusterId => platformHttp.request(`/api/my/kubeconfig?clusterId=${encodeURIComponent(clusterId)}`),
  uploadAvatar: dataUrl => platformHttp.request('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ avatar: dataUrl }) }),
  clearAvatar: () => platformHttp.request('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ avatarClear: true }) }),
  getAvatar: () => platformHttp.request('/api/auth/me/avatar'),
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
    list: (force = false) => platformHttp.request('/api/admin/clusters' + (force ? '?refresh=1' : '')),
    create: payload => platformHttp.request('/api/admin/clusters', { method: 'POST', body: JSON.stringify(payload) }),
    remove: id => platformHttp.request(`/api/admin/clusters/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    namespaces: id => platformHttp.request(`/api/admin/clusters/${encodeURIComponent(id)}/namespaces`),
    nsMode: { set: (id, mode) => platformHttp.request(`/api/admin/clusters/${encodeURIComponent(id)}/ns-auth-mode`, { method: 'PUT', body: JSON.stringify({ mode }) }) },
  },
  groups: {
    list: () => platformHttp.request('/api/admin/groups'),
    create: name => platformHttp.request('/api/admin/groups', { method: 'POST', body: JSON.stringify({ name }) }),
    remove: id => platformHttp.request(`/api/admin/groups/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    members: (id, userIds) => platformHttp.request(`/api/admin/groups/${encodeURIComponent(id)}/members`, { method: 'POST', body: JSON.stringify({ userIds }) }),
    removeMember: (id, userId) => platformHttp.request(`/api/admin/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
    membersList: id => platformHttp.request(`/api/admin/groups/${encodeURIComponent(id)}/members`),
  },
  grants: {
    save: payload => platformHttp.request('/api/admin/grants', { method: 'PUT', body: JSON.stringify(payload) }),
    list: params => platformHttp.request(`/api/admin/grants?${new URLSearchParams(params)}`),
  },
  // 会话治理(W3 Task 5):全用户会话列表(userAgent 原样,前端 uaSummary 摘要)+ 按用户强制下线
  sessions: {
    list: (params = {}) => platformHttp.request(`/api/admin/sessions?${new URLSearchParams(params)}`),
    forceLogout: userId => platformHttp.request(`/api/admin/sessions/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  },
  apikeys: {
    list: () => platformHttp.request('/api/admin/apikeys'),
    create: payload => platformHttp.request('/api/admin/apikeys', { method: 'POST', body: JSON.stringify(payload) }),
    setSshAccess: (id, enabled) => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}/ssh-access`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    remove: id => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}`, { method: 'DELETE' }),
    updateOverrides: (id, tool_overrides) => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}/overrides`, { method: 'PATCH', body: JSON.stringify({ tool_overrides }) }),
    updateNamespaces: (id, allowed_namespaces) => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}/namespaces`, { method: 'PATCH', body: JSON.stringify({ allowed_namespaces }) }),
    health: () => platformHttp.request('/api/admin/apikeys/health'),
    repairSa: (id, body) => platformHttp.request(`/api/admin/apikeys/${encodeURIComponent(id)}/sa/repair`, { method: 'POST', body: JSON.stringify(body || {}) }),
  },
  // 审计流水(Task 5):active/list/verify;GET,query params 直接透传。
  auditTrail: {
    active: (params = {}) => platformHttp.request(`/api/admin/audit-log/active?${new URLSearchParams(params)}`),
    list: (params = {}) => platformHttp.request(`/api/admin/audit-log?${new URLSearchParams(params)}`),
    verify: () => platformHttp.request('/api/admin/audit-log/verify'),
  },
  // 用户中心 Wave1 策略(2026-09-04):GET 回显;PUT 部分更新 → {ok}
  passwordPolicy: {
    get: () => platformHttp.request('/api/admin/password-policy'),
    save: payload => platformHttp.request('/api/admin/password-policy', { method: 'PUT', body: JSON.stringify(payload) }),
  },
  tokenPolicy: {
    get: () => platformHttp.request('/api/admin/token-policy'),
    save: payload => platformHttp.request('/api/admin/token-policy', { method: 'PUT', body: JSON.stringify(payload) }),
  },
  // 全局 MFA 强制开关（W3 §1.5，外评 2026-09-07 修复 1）：GET → {enabled}；PUT ← {enabled} → {enabled}
  mfaPolicy: {
    get: () => platformHttp.request('/api/admin/mfa-policy'),
    save: payload => platformHttp.request('/api/admin/mfa-policy', { method: 'PUT', body: JSON.stringify(payload) }),
  },
  // LLM 配置(baseURL/apiKey/model 存 DB;GET 不回传 key)
  llmConfig: {
    get: () => platformHttp.request('/api/admin/llm-config'),
    save: payload => platformHttp.request('/api/admin/llm-config', { method: 'PUT', body: JSON.stringify(payload) }),
    test: payload => platformHttp.request('/api/admin/llm-config/test', { method: 'POST', body: JSON.stringify(payload || {}) }),
    probeReasoning: payload => platformHttp.request('/api/admin/llm-config/probe-reasoning', { method: 'POST', body: JSON.stringify(payload || {}) }),
  },
  // 悬浮对话入口配置(2026-08-17):{ maxItems, windowMin } → { ok }
  presenceConfig: {
    get: () => platformHttp.request('/api/admin/presence-config'),
    save: payload => platformHttp.request('/api/admin/presence-config', { method: 'PUT', body: JSON.stringify(payload) }),
  },
  // MCP 服务开关(Task 2):GET → {enabled};PUT ← {enabled} → {ok, enabled}
  mcpConfig: {
    get: () => platformHttp.request('/api/admin/mcp-config'),
    update: enabled => platformHttp.request('/api/admin/mcp-config', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  },
  // 状态轴向观测(Wave 0):登记状态聚合快照 + 清扫运行况(只读)
  state: {
    get: () => platformHttp.request('/api/admin/state'),
  },
  // Pod 文件传输限额(单文件 MB,上传下载共用):GET → {limitMb};PUT ← {limitMb} → {ok, limitMb}
  podfileConfig: {
    get: () => platformHttp.request('/api/admin/podfile-config'),
    update: limitMb => platformHttp.request('/api/admin/podfile-config', { method: 'PUT', body: JSON.stringify({ limitMb }) }),
  },
  // SSH 会话回收策略(2026-08-29):GET 回显三阈值;PUT 部分更新(省略键保持现值)→ { ok, policy }
  sshSessionPolicy: {
    get: () => platformHttp.request('/api/admin/ssh-session-policy'),
    update: patch => platformHttp.request('/api/admin/ssh-session-policy', { method: 'PUT', body: JSON.stringify(patch) }),
  },
  // Pod 终端空闲回收策略(2026-09-05「终端与会话」):分钟,0=禁用;PUT 部分更新 → { ok, policy }
  podTerminalPolicy: {
    get: () => platformHttp.request('/api/admin/pod-terminal-policy'),
    update: patch => platformHttp.request('/api/admin/pod-terminal-policy', { method: 'PUT', body: JSON.stringify(patch) }),
  },
  // SSH 异步任务策略(2026-08-30):ttlMin/maxPerServer;PUT 部分更新 → { ok, policy }
  sshJobPolicy: {
    get: () => platformHttp.request('/api/admin/ssh-job-policy'),
    update: patch => platformHttp.request('/api/admin/ssh-job-policy', { method: 'PUT', body: JSON.stringify(patch) }),
  },
  // 工作台 AI 行为配置(2026-08-25):GET → {additionalInstructions, disabledTools, toolCatalog, effectivePreview};PUT ← 同名字段 → {ok}
  workbenchAiConfig: {
    get: () => platformHttp.request('/api/admin/workbench-ai-config'),
    save: payload => platformHttp.request('/api/admin/workbench-ai-config', { method: 'PUT', body: JSON.stringify(payload) }),
  },
  // SSO 登录(OIDC)配置(W4):GET → publicConfig+redirectUri(clientSecret 永不回传,只回 hasSecret);
  // PUT 空 clientSecret=保持现值(llm.apiKey 同惯例);test 走 discovery+JWKS(GET,200+ok:false 是数据不是错误)
  oidcConfig: {
    get: () => platformHttp.request('/api/admin/oidc-config'),
    save: payload => platformHttp.request('/api/admin/oidc-config', { method: 'PUT', body: JSON.stringify(payload) }),
    test: () => platformHttp.request('/api/admin/oidc-config/test'),
  },
}

// Pod exec 终端双向通道：浏览器 WebSocket ↔ Gateway ↔ K8s（SPDY/WS）。
// 二进制帧首字节为通道标识（1 stdin / 2 resize 入向；1 stdout / 2 stderr / 3 exit / 4 error 出向）。
// 返回 { send, resize, close, isOpen } 供 xterm 终端驱动。
export function execStream({ namespace, pod, container = '', command = '/bin/sh', tty = true, attach = false, sid = '', auto = false, onStdout, onStderr, onExit, onError, onClose, onMode, onHandshakeFailure } = {}) {
  const token = getSessionToken()
  const proto = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
  const host = globalThis.location?.host || '127.0.0.1:8787'
  const params = new URLSearchParams({ namespace, pod, tty: tty ? 'true' : 'false' })
  if (container) params.set('container', container)
  if (attach) params.set('mode', 'attach')          // kubectl attach：连主进程 stdio
  else if (command) params.set('command', command)
  if (token) params.set('session', token)
  if (sid) params.set('sid', sid)
  if (auto && !attach) params.set('auto', '1')      // 自动模式：网关探测最优 shell（bash 优先，dash 无补全）
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
    else if (type === 5) { try { onMode?.(JSON.parse(utf8.decode(payload) || '{}')) } catch { onMode?.({}) } }
  }
  ws.onerror = () => onError?.(i18n.global.t('terminal.execConnectError'))
  // 握手失败(未 open 即 close,典型=K8s token 过期被升级门 401 拒)回调:组件借此发廉价
  // 探针走既有 401 拦截器(清 K8s session→选集群页);正常会话结束不触发。
  let opened = false
  ws.onopen = () => { opened = true }
  ws.onclose = ev => { if (!opened) onHandshakeFailure?.(ev?.code); onClose?.() }
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

// SSH 终端双向通道:浏览器 WS ↔ 网关保活会话(浏览器断开不杀 shell,~10min 保活窗口)。
// 帧同 exec + 下行 6=回放(重连同 sid 时网关先发快照再续直播);上行 1=stdin、2=resize。鉴权走平台 token。
export function sshTerminalStream({ serverId, sid, cols = 80, rows = 24, onStdout, onReplay, onError, onClose, onOpen } = {}) {
  const token = getPlatformToken()
  const proto = globalThis.location?.protocol === 'https:' ? 'wss' : 'ws'
  const host = globalThis.location?.host || '127.0.0.1:8787'
  const params = new URLSearchParams({ serverId, sid, cols: String(cols), rows: String(rows) })
  if (token) params.set('session', token)
  const ws = new WebSocket(`${proto}://${host}/api/ssh/terminal?${params}`)
  ws.binaryType = 'arraybuffer'
  const utf8 = new TextDecoder()
  // 握手段失败(从未 open,典型=平台登录过期被 401 拒)→ 廉价探针 /api/auth/me:
  // 过期则 401 自动走既有 onUnauthorized → clearPlatformToken + redirectToLogin(带 redirect 回跳),
  // 用户不再对着「会话已终止」红字无限点重连;非鉴权失败(如会话已被回收)探针 200,照常本地报错。
  let opened = false
  let probed = false
  const probeAuthIfHandshakeFailed = () => {
    if (opened || probed) return
    probed = true
    platformHttp.request('/api/auth/me').catch(() => {})
  }
  ws.onopen = () => { opened = true; onOpen?.() }
  ws.onmessage = ev => {
    const buf = new Uint8Array(ev.data)
    if (!buf.length) return
    const type = buf[0]
    const payload = buf.subarray(1)
    if (type === 1) onStdout?.(payload)
    else if (type === 6) onReplay?.(payload)
    else if (type === 4) onError?.(utf8.decode(payload))
  }
  // 传输错误≠终态(2026-09-08 复查 P0):浏览器对异常断开的既定事件序是 error→close,若 error
  // 也上报 onError,组件会先置 error 终态拦掉随后的 close,自动重连被整个吞掉。onError 仅保留
  // 给 CH_ERROR 帧(服务端明确宣判);传输错误只走鉴权探针(未 open 时),善后归 onClose。
  ws.onerror = () => { probeAuthIfHandshakeFailed() }
  ws.onclose = () => { probeAuthIfHandshakeFailed(); onClose?.() }
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
    send: d => frame(1, d),
    resize: ({ cols, rows }) => frame(2, JSON.stringify({ cols, rows })),
    close: () => { try { ws.close() } catch { /* noop */ } },
    get isOpen() { return ws.readyState === 1 },
  }
}

// 共享内部:NDJSON 逐行读流(读循环/abort/认证/错误语义单一来源,k8sStream/k8sChannel 共用)。
// url 为完整请求地址;按行回调 onMessage;返回 { abort } 供调用方停止。
function ndjsonStream(url, { onMessage, onError, onClose, onOpen } = {}) {
  const controller = new AbortController()
  let reader = null
  let aborted = false
  ;(async () => {
    try {
      const response = await fetch(url, { headers: k8sHttp.authHeaders(), signal: controller.signal })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const body = parseBody(text)
        throw Object.assign(new Error(body?.message || i18n.global.t('store.streamFailed', { status: response.status })), { status: response.status })
      }
      onOpen?.()
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

// 流式读取 K8s 长连接（watch=true / log follow=true）：Gateway 已对这两类请求改为 pipe 透传。
// 按行回调 onMessage（watch 为换行分隔 JSON，log 为换行分隔文本）；返回 { abort } 供调用方停止。
// 认证 header 复用 k8sHttp.authHeaders()，错误体解析复用 parseBody（与 request 同源）。
export function k8sStream(path, handlers = {}) {
  return ndjsonStream(`${k8sHttp.baseUrl}/api/k8s${path}`, handlers)
}

// 网关根路径 NDJSON 通道(不带 /api/k8s 前缀):k8s-watch 多路复用等网关自有端点用。
// 读循环/abort/认证与 k8sStream 完全同源(ndjsonStream),错误语义一致(err.status 附着)。
export function k8sChannel(path, handlers = {}) {
  return ndjsonStream(`${k8sHttp.baseUrl}${path}`, handlers)
}
