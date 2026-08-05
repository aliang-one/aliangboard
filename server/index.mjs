import { createServer } from 'node:http'
import { Readable, Writable, PassThrough } from 'node:stream'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { URL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadAll as yamlLoadAll, load as yamlLoad } from 'js-yaml'
import { Agent as UndiciAgent, fetch as kubeFetch } from 'undici'
import { DatabaseSync } from 'node:sqlite'
import { readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { currentEndpoint, currentDispatcher } from './failover.js'

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
const sessions = new Map()
const discoveryCache = new Map()
const sessionTtl = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000)
const allowedHosts = new Set((process.env.K8S_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean))

// === 会话持久化（SQLite）：集群访问配置落盘，网关重启后浏览器 token 仍有效，无需重登 ===
// ⚠️ 库文件含 K8s 凭据（token/账密/客户端证书私钥），须靠主机文件权限保护（默认 0600）。
const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.ALIANG_DB || join(__dirname, '..', 'data', 'aliangboard.db')
mkdirSync(join(__dirname, '..', 'data'), { recursive: true })
const db = new DatabaseSync(dbPath)
try { chmodSync(dbPath, 0o600) } catch { /* 部分文件系统不支持，忽略 */ } // 含 K8s 凭据，收紧为仅属主可读写
db.exec(`CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  apiServer TEXT NOT NULL,
  authHeader TEXT,
  ca TEXT, cert TEXT, key TEXT,
  insecure INTEGER DEFAULT 0,
  version TEXT,
  createdAt INTEGER NOT NULL
)`)
try { db.exec('ALTER TABLE sessions ADD COLUMN endpoints TEXT') } catch { /* 列已存在 */ }
try { db.exec('ALTER TABLE sessions ADD COLUMN endpointIdx INTEGER DEFAULT 0') } catch { /* 列已存在 */ }
const stmtUpsert = db.prepare('INSERT OR REPLACE INTO sessions (token, apiServer, authHeader, ca, cert, key, insecure, version, createdAt, endpoints, endpointIdx) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
// 终端会话持久化（任务栏：多终端、重命名、最小化，刷新不丢）
db.exec(`CREATE TABLE IF NOT EXISTS terminals (
  id TEXT PRIMARY KEY,
  sessionToken TEXT NOT NULL,
  name TEXT NOT NULL,
  namespace TEXT NOT NULL,
  podName TEXT NOT NULL,
  container TEXT,
  command TEXT,
  status TEXT DEFAULT 'minimized',
  createdAt INTEGER NOT NULL
)`)
const stmtDelete = db.prepare('DELETE FROM sessions WHERE token = ?')
const stmtAll = db.prepare('SELECT * FROM sessions')

// === 平台用户管理 + 集群管理 ===
db.exec(`CREATE TABLE IF NOT EXISTS platform_users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  displayName TEXT,
  createdAt INTEGER NOT NULL,
  disabled INTEGER DEFAULT 0
)`)
db.exec(`CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  apiServer TEXT NOT NULL,
  authMethod TEXT NOT NULL DEFAULT 'token',
  authHeader TEXT,
  ca TEXT, cert TEXT, key TEXT,
  insecure INTEGER DEFAULT 0,
  version TEXT,
  createdBy TEXT,
  createdAt INTEGER NOT NULL
)`)
db.exec(`CREATE TABLE IF NOT EXISTS user_clusters (
  userId TEXT NOT NULL,
  clusterId TEXT NOT NULL,
  assignedBy TEXT,
  assignedAt INTEGER NOT NULL,
  PRIMARY KEY (userId, clusterId)
)`)
db.exec(`CREATE TABLE IF NOT EXISTS platform_sessions (
  token TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  username TEXT NOT NULL,
  role TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  k8sSessionToken TEXT
)`)
// scrypt 密码：格式 saltHex:hashHex:N:r:p
const SCRYPT_N = 16384, SCRYPT_R = 8, SCRYPT_P = 1
function hashPassword(password) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return `${salt.toString('hex')}:${hash.toString('hex')}:${SCRYPT_N}:${SCRYPT_R}:${SCRYPT_P}`
}
function verifyPassword(password, stored) {
  try {
    const [saltHex, hashHex, N, r, p] = stored.split(':')
    const salt = Buffer.from(saltHex, 'hex')
    const expected = Buffer.from(hashHex, 'hex')
    const actual = scryptSync(password, salt, expected.length, { N: +N, r: +r, p: +p })
    return timingSafeEqual(expected, actual)
  } catch { return false }
}
// 首次启动 admin 种子
function seedAdminIfNeeded() {
  const count = db.prepare("SELECT COUNT(*) c FROM platform_users WHERE role='admin'").get().c
  if (count > 0) return
  const adminUser = process.env.ADMIN_USERNAME
  const adminPass = process.env.ADMIN_PASSWORD
  if (!adminUser || !adminPass) { console.warn('[auth] 未设置 ADMIN_USERNAME/ADMIN_PASSWORD，无法创建管理员；旧 K8s 直连模式仍可用'); return }
  db.prepare('INSERT INTO platform_users (id, username, passwordHash, role, displayName, createdAt) VALUES (?,?,?,?,?,?)')
    .run(randomUUID(), adminUser, hashPassword(adminPass), 'admin', 'Administrator', Date.now())
  console.log(`[auth] 已创建管理员: ${adminUser}`)
}
// 平台 session（内存 Map + SQLite 持久化）
const platformSessions = new Map()  // token -> {userId, username, role, createdAt, k8sSessionToken}
function loadPersistedPlatformSessions() {
  try {
    const rows = db.prepare('SELECT * FROM platform_sessions').all()
    for (const r of rows) platformSessions.set(r.token, r)
    if (rows.length) console.log(`[auth] 已恢复 ${rows.length} 个平台会话`)
  } catch (e) { console.error('[auth] 恢复平台会话失败', e?.message) }
}
function platformUserFromRequest(req) {
  const token = req.headers['x-platform-token']
  if (!token) return null
  const ps = platformSessions.get(token)
  if (!ps) return null
  if (Date.now() - ps.createdAt > sessionTtl) {
    platformSessions.delete(token)
    try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(token) } catch { /* noop */ }
    return null
  }
  return ps
}
function requirePlatform(req, res) {
  const ps = platformUserFromRequest(req)
  if (!ps) { sendJson(res, 401, { message: '未登录或平台会话已过期' }); return null }
  return ps
}
function requireAdmin(req, res) {
  const ps = requirePlatform(req, res)
  if (!ps) return null
  if (ps.role !== 'admin') { sendJson(res, 403, { message: '需要管理员权限' }); return null }
  return ps
}
// 持久化一个会话（仅存可序列化字段；dispatcher 是运行期对象，重载时重建）
function persistSession(token, session) {
  try {
    stmtUpsert.run(
      token,
      session.apiServer.toString(),
      session.authHeader || null,
      session.ca || null, session.cert || null, session.key || null,
      session.insecure ? 1 : 0,
      session.version || null,
      session.createdAt || Date.now(),
      JSON.stringify((session.endpoints || [session.apiServer]).map(u => u.toString())),
      session.endpointIdx || 0,
    )
  } catch (e) { console.error('[sqlite] persistSession 失败', e?.message || e) }
}
function removePersistedSession(token) { try { stmtDelete.run(token) } catch { /* noop */ } }
// 启动时重载：重建 sessions Map（apiServer 用 normalizeServer 复原为 URL 对象，dispatcher 重建）
function loadPersistedSessions() {
  let rows = []
  try { rows = stmtAll.all() } catch (e) { console.error('[sqlite] loadPersistedSessions 失败', e?.message || e); return }
  for (const r of rows) {
    try {
      const session = {
        apiServer: normalizeServer(r.apiServer),
        endpoints: r.endpoints ? JSON.parse(r.endpoints).map(s => new URL(s)) : [normalizeServer(r.apiServer)],
        endpointIdx: r.endpointIdx || 0,
        authHeader: r.authHeader,
        ca: r.ca, cert: r.cert, key: r.key,
        insecure: !!r.insecure,
        version: r.version || undefined,
        createdAt: r.createdAt,
      }
      session.dispatcher = buildDispatcher(session)
      session.insecureDispatcher = buildDispatcher({ ca: r.ca, cert: r.cert, key: r.key, insecure: true })
      sessions.set(r.token, session)
    } catch { /* 单条损坏跳过，不影响其他 */ }
  }
  if (sessions.size) console.log(`[sqlite] 已恢复 ${sessions.size} 个集群会话`)
}

if (process.env.K8S_INSECURE_SKIP_TLS_VERIFY === 'true') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  console.warn('WARNING: Kubernetes TLS certificate verification is disabled')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': process.env.CORS_ORIGIN || '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

// 解析镜像引用 → { registry, repo }：registry 为含 . 或 : 或 localhost 的首段
// 形如 registry.liang.home/library/app:v1 → { registry:'registry.liang.home', repo:'library/app' }
function parseImageRef(image) {
  let s = String(image || '').trim().split('@')[0] // 去 digest
  const slash = s.indexOf('/')
  const colon = s.lastIndexOf(':')
  if (colon > slash) s = s.slice(0, colon) // 去 tag（仅当 : 在最后一个 / 之后）
  const firstSlash = s.indexOf('/')
  const head = firstSlash > -1 ? s.slice(0, firstSlash) : ''
  const isRegistry = head && (head.includes('.') || head.includes(':') || head === 'localhost')
  if (isRegistry) return { registry: head, repo: s.slice(firstSlash + 1) }
  return { registry: '', repo: s } // 无 registry → 视为官方镜像（docker.io）
}

function sessionFromRequest(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const session = token ? sessions.get(token) : null
  if (session && Date.now() - session.createdAt > sessionTtl) {
    sessions.delete(token)
    removePersistedSession(token) // 过期：从库中清除
    return null
  }
  return session
}

function normalizeServer(value) {
  const url = new URL(String(value || ''))
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('API Server 必须使用 http 或 https')
  if (allowedHosts.size && !allowedHosts.has(url.hostname)) throw new Error(`API Server 主机 ${url.hostname} 不在允许列表中`)
  url.pathname = url.pathname.replace(/\/$/, '')
  return url
}

// 解析粘贴进来的 kubeconfig：定位 current-context → cluster（server/CA）+ user（token|账密|客户端证书）。
// 仅支持内联 *-data（base64）或 Gateway 主机上可读的 *-file；不支持 exec 凭证插件（gcp/aws/azure 等）。
function parseKubeconfig(text) {
  let cfg
  try { cfg = yamlLoad(String(text || '')) } catch (e) { throw new Error('kubeconfig 解析失败：' + e.message) }
  if (!cfg || cfg.kind !== 'Config') throw new Error('不是有效的 kubeconfig（缺少 kind: Config）')
  const ctxName = cfg['current-context']
  const ctx = (cfg.contexts || []).find(c => c.name === ctxName)
  if (!ctx?.context) throw new Error(`kubeconfig 中找不到 current-context：${ctxName}`)
  const cluster = (cfg.clusters || []).find(c => c.name === ctx.context.cluster)?.cluster
  const user = (cfg.users || []).find(u => u.name === ctx.context.user)?.user
  if (!cluster?.server) throw new Error('kubeconfig 中找不到 cluster.server')
  if (user?.exec) throw new Error('kubeconfig 使用 exec 凭证插件（如 gcp/aws/azure），AliangBoard 暂不支持，请改用 token 或客户端证书')
  return { server: cluster.server, cluster, user }
}

// 取证书/CA 材料：优先内联 *-data（base64），其次 Gateway 主机上的 *-file
function certMaterial(node, dataKey, fileKey) {
  if (!node) return undefined
  if (node[dataKey]) return Buffer.from(node[dataKey], 'base64').toString('utf8')
  if (node[fileKey]) {
    try { return readFileSync(node[fileKey], 'utf8') } catch { throw new Error(`无法读取证书文件：${node[fileKey]}（请改用内联 *-data 形式）`) }
  }
  return undefined
}

// 为每个会话构建独立的 undici dispatcher：承载 mTLS（client cert+key+CA）与 insecure 开关。
// Node 全局 fetch 接受 dispatcher 选项；故所有 fetch（缓冲式 + 流式）都透传它，统一 TLS 行为。
function buildDispatcher({ ca, cert, key, insecure }) {
  const connect = { rejectUnauthorized: !insecure }
  if (ca) connect.ca = ca
  if (cert) connect.cert = cert
  if (key) connect.key = key
  return new UndiciAgent({ connect })
}

// 自动发现控制面端点：GET /api/v1/nodes → 过滤 control-plane → InternalIP → 候选 https://<ip>:<port>。
// 端口从原始 apiServer 继承；发现失败 → 只返回 [apiServer]（降级不阻断）。
async function discoverEndpoints(session) {
  try {
    const result = await requestKubernetes(session, '/api/v1/nodes?limit=500')
    const nodes = result.body?.items || []
    const port = session.apiServer.port || (session.apiServer.protocol === 'https:' ? '443' : '80')
    const seen = new Set([session.apiServer.origin])
    const candidates = []
    for (const node of nodes) {
      const labels = node.metadata?.labels || {}
      const isCP = labels['node-role.kubernetes.io/control-plane'] !== undefined || labels['node-role.kubernetes.io/master'] !== undefined
      if (!isCP) continue
      const ip = node.status?.addresses?.find(a => a.type === 'InternalIP')?.address
      if (!ip) continue
      const url = new URL(`${session.apiServer.protocol}//${ip}:${port}`)
      if (!seen.has(url.origin)) { seen.add(url.origin); candidates.push(url) }
    }
    const all = [session.apiServer, ...candidates]
    console.log(`[failover] 发现 ${all.length} 个端点: ${all.map(u => u.host).join(', ')}`)
    return all
  } catch (e) {
    console.warn('[failover] 控制面节点发现失败，使用单端点:', e?.message || e)
    return [session.apiServer]
  }
}

async function requestKubernetes(session, path, init = {}) {
  const target = new URL(path, session.apiServer)
  const headers = { accept: 'application/json', ...(init.headers || {}) }
  if (session.authHeader) headers.authorization = session.authHeader
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'

  const response = await kubeFetch(target, {
    ...init,
    headers,
    dispatcher: session.dispatcher,
    signal: AbortSignal.timeout(Number(process.env.K8S_REQUEST_TIMEOUT || 15000)),
  })
  const text = await response.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  if (!response.ok) {
    const message = body?.message || body?.reason || `Kubernetes API 返回 HTTP ${response.status}`
    const error = new Error(message)
    error.status = response.status
    error.details = body
    throw error
  }
  return { status: response.status, headers: response.headers, body }
}

async function discoverResource(session, object) {
  const apiVersion = String(object.apiVersion || '')
  const [group, version] = apiVersion.includes('/') ? apiVersion.split('/', 2) : ['', apiVersion]
  if (!version) throw new Error('YAML 缺少 apiVersion')
  const cacheKey = `${session.apiServer}:${apiVersion}`
  let resources = discoveryCache.get(cacheKey)
  if (!resources) {
    const discoveryPath = group ? `/apis/${group}/${version}` : `/api/${version}`
    resources = (await requestKubernetes(session, discoveryPath)).body?.resources || []
    discoveryCache.set(cacheKey, resources)
  }
  const resource = resources.find(item => item.kind === object.kind && !item.name.includes('/'))
  if (!resource) throw new Error(`集群未发现资源类型 ${object.kind} (${apiVersion})`)
  return { group, version, resource }
}

async function applyYaml(session, yaml) {
  const objects = []
  yamlLoadAll(yaml, object => { if (object) objects.push(object) })
  if (!objects.length) throw new Error('YAML 中没有可应用的资源')
  const results = []
  for (const object of objects) {
    if (!object?.kind || !object?.metadata?.name) throw new Error('YAML 缺少 kind 或 metadata.name')
    const { group, version, resource } = await discoverResource(session, object)
    const prefix = group ? `/apis/${group}/${version}` : `/api/${version}`
    const namespacePart = resource.namespaced
      ? `/namespaces/${encodeURIComponent(object.metadata.namespace || 'default')}`
      : ''
    const path = `${prefix}${namespacePart}/${resource.name}/${encodeURIComponent(object.metadata.name)}?fieldManager=aliangboard&force=true`
    const document = JSON.stringify(object)
    const result = await requestKubernetes(session, path, {
      method: 'PATCH',
      headers: { 'content-type': 'application/apply-patch+yaml' },
      body: document,
    })
    results.push(result.body)
  }
  return results
}

// === 实时交互通道：Pod exec 终端 / 端口转发 ===
// exec 与 port-forward 走 SPDY/WebSocket 多路复用，原生 fetch 透传无法承载，
// 故仅这两类操作引入 @kubernetes/client-node（CRUD 仍走原生 fetch 透传，保持轻量）。
// 浏览器 ↔ Gateway 用 WebSocket；Gateway ↔ K8s 的协议升级由 client-node 处理。

let _k8sClient = null
function k8sClient() {
  // 懒加载：隔离 client-node 加载失败对核心网关的影响
  if (!_k8sClient) _k8sClient = import('@kubernetes/client-node')
  return _k8sClient
}

function buildKubeConfig(KubeConfig, session) {
  const kc = new KubeConfig()
  // 注意：client-node 的 caData/certData/keyData 期望 **base64**（内部 bufferFromFileOrString 会 base64 解码）；
  // 而 session 里存的是已解码的 PEM（供 undici 直用），这里必须再编码回 base64，否则 TLS 报 `PEM routines::no start line`。
  const b64 = s => Buffer.from(s, 'utf8').toString('base64')
  const cluster = {
    name: 'aliangboard',
    // 去尾斜杠：client-node 的 WebSocketHandler 用字符串拼接 server+path，尾斜杠会导致 `//api/v1/…` 双斜杠 → 404
    server: session.apiServer.toString().replace(/\/$/, ''),
    skipTLSVerify: !!session.insecure,
    ...(session.ca ? { caData: b64(session.ca) } : {}),
  }
  const user = { name: 'aliangboard' }
  const header = session.authHeader || ''
  if (/^bearer\s/i.test(header)) user.token = header.replace(/^bearer\s+/i, '')
  else if (/^basic\s/i.test(header)) {
    const decoded = Buffer.from(header.replace(/^basic\s+/i, ''), 'base64').toString('utf8')
    const idx = decoded.indexOf(':')
    user.username = idx >= 0 ? decoded.slice(0, idx) : decoded
    user.password = idx >= 0 ? decoded.slice(idx + 1) : ''
  }
  // 客户端证书（kubeconfig client-cert/key）：client-node 的 *Data 期望 base64
  if (session.cert) user.certData = b64(session.cert)
  if (session.key) user.keyData = b64(session.key)
  kc.loadFromClusterAndUser(cluster, user)
  return kc
}

// exec 浏览器↔网关 二进制帧首字节（流标识），客户端按首字节解帧
const CH_STDIN = 1, CH_RESIZE = 2
const CH_STDOUT = 1, CH_STDERR = 2, CH_EXIT = 3, CH_ERROR = 4

// 把 exec 的 stdout/stderr 字节流写入浏览器 WS（带通道前缀）；
// 兼具「可缩放」语义（rows/columns + resize 事件）以触发 client-node 自动转发终端尺寸。
class WsSink extends Writable {
  constructor(prefix, ws) { super(); this.prefix = prefix; this.ws = ws; this.rows = 24; this.columns = 80 }
  _write(chunk, _enc, cb) {
    wsSend(this.ws, this.prefix, chunk)
    cb()
  }
}

function wsSend(ws, type, payload) {
  try {
    if (ws.readyState !== 1) return
    const body = Buffer.concat([Buffer.from([type]), Buffer.from(payload)])
    ws.send(body)
  } catch { /* ws 已断，忽略 */ }
}

// 建立 Pod exec 终端会话
async function handleExec(ws, session, url) {
  const namespace = url.searchParams.get('namespace')
  const pod = url.searchParams.get('pod')
  if (!namespace || !pod) { wsSend(ws, CH_ERROR, '缺少 namespace / pod 参数'); return ws.close() }
  const container = url.searchParams.get('container') || ''
  const mode = url.searchParams.get('mode')   // 'attach' = 连接主进程 stdio；否则 exec 开新 shell
  const command = (url.searchParams.get('command') || '/bin/sh').trim().split(/\s+/)
  const tty = url.searchParams.get('tty') !== 'false'

  const { KubeConfig, Exec, Attach } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)

  const stdout = new WsSink(CH_STDOUT, ws)
  const stderr = new WsSink(CH_STDERR, ws)
  const stdin = new PassThrough()
  let conn = null

  try {
    if (mode === 'attach') {
      // kubectl attach：连接容器主进程（PID 1）的 stdio，不开新 shell
      conn = await new Attach(kc).attach(namespace, pod, container, stdout, stderr, stdin, tty)
    } else {
      conn = await new Exec(kc).exec(namespace, pod, container, command, stdout, stderr, stdin, tty, status => {
        wsSend(ws, CH_EXIT, JSON.stringify({ status: status?.status || 'Success', code: status?.code ?? null }))
      })
    }
  } catch (error) {
    wsSend(ws, CH_ERROR, error?.message || `${mode === 'attach' ? 'attach' : 'exec'} 会话建立失败（容器可能未就绪或镜像内无 shell）`)
    return ws.close()
  }

  conn.on('close', () => { try { ws.close() } catch { /* noop */ } })
  conn.on('error', () => { try { ws.close() } catch { /* noop */ } })

  ws.on('message', data => {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
    if (!buf.length) return
    const type = buf[0]
    const payload = buf.subarray(1)
    if (type === CH_STDIN) { try { stdin.write(payload) } catch { /* noop */ } }
    else if (type === CH_RESIZE) {
      try { const { cols, rows } = JSON.parse(payload.toString('utf8')); stdout.columns = cols; stdout.rows = rows; stdout.emit('resize') } catch { /* 帧格式错误 */ }
    }
  })
  ws.on('close', () => { try { stdin.end() } catch { /* noop */ }; try { conn?.close() } catch { /* noop */ } })
  ws.on('error', () => { try { conn?.close() } catch { /* noop */ } })
}

// 一次性 exec（tty=false，捕获 stdout/stderr）：用于文件浏览（ls / cat / 写入）。
// command 以数组传入（exec 直接执行，不经 shell，无需转义路径）。
async function execCapture(session, namespace, pod, container, command) {
  const { KubeConfig, Exec } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)
  const exec = new Exec(kc)
  const stdout = [], stderr = []
  const stdoutSink = new Writable({ write(c, _e, cb) { stdout.push(Buffer.from(c)); cb() } })
  const stderrSink = new Writable({ write(c, _e, cb) { stderr.push(Buffer.from(c)); cb() } })
  const stdin = new PassThrough() // 不立即 end：过早 EOF 会让本集群 kubelet 在命令执行前关闭 exec 会话
  let conn
  try {
    // tty=true：与终端同路径。本集群 client-node 在 tty=false 下 exec 立即 close 无数据；
    // tty 下输出会带 ANSI/CR，统一剔除后再解析
    conn = await exec.exec(namespace, pod, container, command, stdoutSink, stderrSink, stdin, true)
  } catch (e) {
    console.error(`[exec] 失败 ns=${namespace} pod=${pod} c=${container} cmd=${JSON.stringify(command)} :: ${e?.message || e}`)
    throw e
  }
  // 命令（ls/head/cat）自行退出 → kubelet 关闭 → conn close；不主动关 stdin
  await new Promise(resolve => conn.on('close', resolve))
  try { stdin.destroy() } catch { /* noop */ }
  await new Promise(r => setImmediate(r))
  const raw = Buffer.concat(stdout).toString('utf8')
  const clean = raw.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '')
  console.error(`[exec] DONE cmd=${JSON.stringify(command)} raw=${raw.length} clean=${clean.length} head=${JSON.stringify(clean.slice(0, 80))}`)
  return { stdout: Buffer.from(clean, 'utf8'), stderr: Buffer.concat(stderr).toString('utf8'), status: null }
}

// PVC 文件浏览：起一个 busybox 只读挂载该 PVC 的 helper Pod（确定性命名、幂等创建），复用 exec ls/cat。
// 集群需允许当前用户 create pods + exec（cluster-admin 通常满足）。Pod 跨多次浏览复用，避免反复创建。
async function ensurePvcBrowser(session, ns, pvc) {
  const safe = String(pvc).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const podName = `aliang-pvc-${safe || 'x'}`.slice(0, 63)
  const podPath = `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(podName)}`
  try { await requestKubernetes(session, podPath); return podName }   // 已存在 → 复用
  catch (e) {
    if (e.status !== 404) throw e
    const body = {
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: podName, namespace: ns, labels: { app: 'aliang-pvc-browser' }, annotations: { 'aliangboard.io/purpose': 'pvc-file-browser' } },
      spec: {
        restartPolicy: 'Never', terminationGracePeriodSeconds: 1,
        containers: [{ name: 'browser', image: 'busybox:1.36', command: ['sh', '-c', 'sleep 86400'], volumeMounts: [{ name: 'data', mountPath: '/data', readOnly: true }], resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { memory: '64Mi' } } }],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: pvc } }],
      },
    }
    try { await requestKubernetes(session, `/api/v1/namespaces/${encodeURIComponent(ns)}/pods`, { method: 'POST', body: JSON.stringify(body) }) }
    catch (err) { throw Object.assign(new Error(`创建 PVC 浏览器 Pod 失败：${err.message}（需 create pods 权限）`), { status: err.status || 403 }) }
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        const p = (await requestKubernetes(session, podPath)).body
        if (p.status?.phase === 'Running') return podName
        if (p.status?.phase === 'Failed') throw Object.assign(new Error('PVC 浏览器 Pod 启动失败（PVC 可能未绑定或挂载失败）'), { status: 502 })
      } catch (waitErr) { if (waitErr.status === 502) throw waitErr }
    }
    throw Object.assign(new Error('PVC 浏览器 Pod 启动超时（镜像拉取中？请稍后重试）'), { status: 502 })
  }
}

const PODFILE_PREVIEW_LIMIT = 256 * 1024   // 预览最多 256KB
const PODFILE_DOWNLOAD_LIMIT = 16 * 1024 * 1024  // 下载最多 16MB（超出请用终端）

// 注入 Ephemeral Container（kubectl debug 语义）：向 pods/ephemeralcontainers 子资源
// 先 GET 已有列表再 PUT 追加，避免覆盖同名临时容器。需集群启用 EphemeralContainers（1.25+ 默认开启）。
async function attachEphemeral(session, namespace, pod, spec) {
  const subPath = `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods/${encodeURIComponent(pod)}/ephemeralcontainers`
  let existing = null
  try { existing = (await requestKubernetes(session, subPath)).body } catch (e) {
    if (e.status !== 404 && e.status !== 405) throw e   // 404/405 = 尚无临时容器，从空列表开始
  }
  const list = existing?.spec?.ephemeralContainers || []
  if (list.some(c => c.name === spec.name)) throw Object.assign(new Error(`已存在同名临时容器 ${spec.name}`), { status: 409 })
  const container = { name: spec.name, image: spec.image, command: spec.command, stdin: spec.stdin !== false, tty: spec.tty !== false }
  if (spec.targetContainerName) container.targetContainerName = spec.targetContainerName
  list.push(container)
  const body = { kind: 'EphemeralContainers', apiVersion: 'v1', metadata: { name: pod, namespace }, spec: { ephemeralContainers: list } }
  // ephemeralcontainers 子资源只支持 POST（PUT 会落到 Pod handler → "cannot be handled as a Pod"）
  return (await requestKubernetes(session, subPath, { method: 'POST', body: JSON.stringify(body) })).body
}

// 手动触发 CronJob（kubectl create job --from 语义）：读 jobTemplate 创建一个 Job，
// 带 cronjob.kubernetes.io/instantiate=manual 注解 + ownerReference 指向 CronJob。
async function triggerCronJob(session, namespace, name, jobName) {
  const cj = (await requestKubernetes(session, `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/cronjobs/${encodeURIComponent(name)}`)).body
  const template = cj?.spec?.jobTemplate
  if (!template?.spec) throw Object.assign(new Error('CronJob 缺少 jobTemplate.spec'), { status: 422 })
  const uid = cj?.metadata?.uid
  const job = {
    apiVersion: 'batch/v1',
    kind: 'Job',
    metadata: {
      namespace,
      ...(jobName ? { name: jobName } : { generateName: `${name}-` }),
      labels: template.metadata?.labels || {},
      annotations: { ...(template.metadata?.annotations || {}), 'cronjob.kubernetes.io/instantiate': 'manual' },
      ...(uid ? { ownerReferences: [{ apiVersion: 'batch/v1', kind: 'CronJob', name, uid, controller: true }] } : {}),
    },
    spec: template.spec,
  }
  return (await requestKubernetes(session, `/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`, { method: 'POST', body: JSON.stringify(job) })).body
}

// 资源拓扑：沿 metadata.ownerReferences 向上解析归属链（Pod→ReplicaSet→Deployment…）。
const KIND_PLURAL = {
  Pod: 'pods', ReplicaSet: 'replicasets', Deployment: 'deployments', StatefulSet: 'statefulsets', DaemonSet: 'daemonsets',
  Job: 'jobs', CronJob: 'cronjobs', Service: 'services', ConfigMap: 'configmaps', Secret: 'secrets',
  PersistentVolumeClaim: 'persistentvolumeclaims', Ingress: 'ingresses', ServiceAccount: 'serviceaccounts',
}
function pathFor(apiVersion, kind, ns, name) {
  const plural = KIND_PLURAL[kind]
  if (!plural) return null
  const [group, version] = String(apiVersion || '').includes('/') ? String(apiVersion).split('/') : ['', apiVersion || 'v1']
  if (!version) return null
  const base = group ? `/apis/${group}/${version}` : `/api/${version}`
  return `${base}/namespaces/${encodeURIComponent(ns)}/${plural}/${encodeURIComponent(name)}`
}
async function resolveOwnerTree(session, ns, kind, name, apiVersion, depth = 0) {
  if (depth > 8) return { kind, name, namespace: ns, error: '归属链过深，已截断' }
  const path = pathFor(apiVersion, kind, ns, name)
  if (!path) return { kind, name, namespace: ns, error: `暂不支持解析 ${kind} 的归属链` }
  let obj
  try { obj = (await requestKubernetes(session, path)).body } catch (e) { return { kind, name, namespace: ns, error: e.message } }
  const node = { kind, name, namespace: ns, apiVersion: obj?.apiVersion, createdAt: obj?.metadata?.creationTimestamp, owner: null }
  const ownerRef = (obj?.metadata?.ownerReferences || [])[0]
  if (ownerRef) node.owner = await resolveOwnerTree(session, ns, ownerRef.kind, ownerRef.name, ownerRef.apiVersion, depth + 1)
  return node
}

// === 端口转发 ===
// 在网关主机开本地 TCP 监听，每个进入的 TCP 连接经 client-node portForward 转发到 Pod；
// 语义等同 kubectl port-forward（默认绑 127.0.0.1，浏览器需能访问该地址）。
const forwards = new Map()   // id -> { server, pf, sessionId, namespace, pod, targetPort, localPort, host }

// Service/Deployment/StatefulSet 等非 Pod 目标：经 endpoints 解析到一个可用 Pod，并把「服务端口」映射为容器端口
async function resolveForwardTarget(session, kind, namespace, name, port) {
  kind = kind || 'Pod'
  if (kind === 'Pod') return { pod: name, targetPort: port }
  const svc = await requestKubernetes(session, `/api/v1/namespaces/${encodeURIComponent(namespace)}/services/${encodeURIComponent(name)}`)
  // 服务端口 -> 容器端口（targetPort 为数字时直接用；为名称时回退用服务端口本身尽力而为）
  let containerPort = port
  const sp = (svc.body?.spec?.ports || []).find(p => p.port === port)
  if (sp?.targetPort != null) containerPort = typeof sp.targetPort === 'number' ? sp.targetPort : port
  const ep = await requestKubernetes(session, `/api/v1/namespaces/${encodeURIComponent(namespace)}/endpoints/${encodeURIComponent(name)}`)
  const subset = ep.body?.subsets?.find(s => Array.isArray(s.addresses) && s.addresses.length) || ep.body?.subsets?.[0]
  const addr = subset?.addresses?.[0] || subset?.notReadyAddresses?.[0]
  if (!addr?.ip) throw new Error(`${kind}/${name} 没有可用端点（endpoints 为空）`)
  const pods = await requestKubernetes(session, `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?limit=500`)
  const pod = (pods.body?.items || []).find(p => p.status?.podIP === addr.ip)
  if (!pod?.metadata?.name) throw new Error(`未找到 IP=${addr.ip} 的 Pod`)
  return { pod: pod.metadata.name, targetPort: containerPort }
}

async function startForward(session, sessionId, kind, namespace, name, port, localPort) {
  const { pod, targetPort } = await resolveForwardTarget(session, kind, namespace, name, port)
  const { KubeConfig, PortForward } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)
  const pf = new PortForward(kc)
  const server = net.createServer(socket => {
    socket.on('error', () => { /* 对端异常，忽略 */ })
    pf.portForward(namespace, pod, [targetPort], socket, null, socket).catch(() => { try { socket.destroy() } catch { /* noop */ } })
  })
  return new Promise((resolve, reject) => {
    const onError = err => reject(err)
    server.once('error', onError)
    const host = process.env.PORT_FORWARD_HOST || '127.0.0.1'
    server.listen(localPort || 0, host, () => {
      server.removeListener('error', onError)
      const id = randomUUID()
      const actualPort = server.address().port
      forwards.set(id, { server, pf, sessionId, id, kind, namespace, name, pod, targetPort, localPort: actualPort, host })
      resolve({ id, kind, namespace, name, pod, targetPort, localPort: actualPort, host })
    })
  })
}

function stopForward(id) {
  const f = forwards.get(id)
  if (!f) return false
  try { f.server.close() } catch { /* noop */ }
  forwards.delete(id)
  return true
}

function listForwards(sessionId) {
  return [...forwards.values()].filter(f => f.sessionId === sessionId).map(({ server, pf, sessionId, ...rest }) => rest)
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {})
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, service: 'aliangboard-api', time: new Date().toISOString() })
  }

  if (req.method === 'POST' && url.pathname === '/api/session') {
    try {
      const input = await readBody(req)
      let apiServer, authHeader = null, ca, cert, key
      if (input.authMethod === 'kubeconfig') {
        // 直接粘贴 kubeconfig：从中解析 server / CA / 凭据（token|账密|客户端证书）
        const parsed = parseKubeconfig(input.kubeconfig)
        apiServer = normalizeServer(parsed.server)
        ca = certMaterial(parsed.cluster, 'certificate-authority-data', 'certificate-authority')
        cert = certMaterial(parsed.user, 'client-certificate-data', 'client-certificate')
        key = certMaterial(parsed.user, 'client-key-data', 'client-key')
        if (parsed.user?.token) authHeader = `Bearer ${parsed.user.token}`
        else if (parsed.user?.username != null || parsed.user?.password != null) {
          authHeader = `Basic ${Buffer.from(`${parsed.user.username || ''}:${parsed.user.password || ''}`).toString('base64')}`
        }
        if (!authHeader && !(cert && key)) throw new Error('kubeconfig 未包含可用凭据（需 token / 账号密码 / 客户端证书）')
      } else if (input.authMethod === 'basic') {
        if (!input.username || !input.password) return sendJson(res, 400, { message: '用户名和密码不能为空' })
        apiServer = normalizeServer(input.apiServer)
        authHeader = `Basic ${Buffer.from(`${input.username}:${input.password}`).toString('base64')}`
      } else {
        if (!input.token) return sendJson(res, 400, { message: 'Bearer Token 不能为空' })
        apiServer = normalizeServer(input.apiServer)
        authHeader = `Bearer ${String(input.token)}`
      }
      const insecure = input.insecure === true || process.env.K8S_INSECURE_SKIP_TLS_VERIFY === 'true'
      const dispatcher = buildDispatcher({ ca, cert, key, insecure })
      const sessionId = randomUUID()
      const session = { apiServer, authHeader, dispatcher, ca, cert, key, insecure, createdAt: Date.now() }
      const probe = await requestKubernetes(session, '/version')
      session.version = probe.body?.gitVersion || 'unknown'
      session.endpoints = await discoverEndpoints(session)
      session.endpointIdx = 0
      session.insecureDispatcher = buildDispatcher({ ca, cert, key, insecure: true })
      sessions.set(sessionId, session)
      persistSession(sessionId, session) // 落盘：重启后浏览器 token 仍有效
      return sendJson(res, 200, {
        token: sessionId,
        cluster: { apiServer: apiServer.toString().replace(/\/$/, ''), version: session.version },
      })
    } catch (error) {
      return sendJson(res, error.status || 400, { message: error.message || '连接 Kubernetes 集群失败' })
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/session') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    return sendJson(res, 200, {
      cluster: { apiServer: session.apiServer.toString().replace(/\/$/, ''), version: session.version || 'unknown' },
    })
  }

  if (req.method === 'DELETE' && url.pathname === '/api/session') {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (token) {
      sessions.delete(token)
      removePersistedSession(token)
      for (const id of [...forwards.keys()]) if (forwards.get(id).sessionId === token) stopForward(id)
    }
    return sendJson(res, 204, {})
  }

  if (req.method === 'POST' && url.pathname === '/api/apply') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    try {
      const input = await readBody(req)
      const resources = await applyYaml(session, String(input.yaml || ''))
      return sendJson(res, 200, { resources })
    } catch (error) {
      return sendJson(res, error.status || 422, { message: error.message || '应用 YAML 失败', details: error.details })
    }
  }

  // 端口转发管理（创建 / 列表 / 停止）
  if (url.pathname === '/api/portforward') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const token = req.headers.authorization.replace(/^Bearer\s+/i, '')
    if (req.method === 'POST') {
      try {
        const input = await readBody(req)
        const port = Number(input.port)
        const localPort = input.localPort ? Number(input.localPort) : 0
        if (!input.namespace || !input.name || !port) return sendJson(res, 400, { message: '缺少 namespace / name / port' })
        const fwd = await startForward(session, token, input.kind, input.namespace, input.name, port, localPort)
        return sendJson(res, 200, fwd)
      } catch (error) {
        return sendJson(res, error.status || 400, { message: error?.message || '端口转发建立失败' })
      }
    }
    if (req.method === 'GET') return sendJson(res, 200, { forwards: listForwards(token) })
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/portforward/')) {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const id = decodeURIComponent(url.pathname.slice('/api/portforward/'.length))
    const removed = stopForward(id)
    return sendJson(res, removed ? 200 : 404, { ok: removed })
  }

  // PVC 文件浏览（helper busybox Pod 只读挂载 + exec ls/cat；只读，不支持写入）
  if (url.pathname.startsWith('/api/pvcfile/')) {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const action = url.pathname.slice('/api/pvcfile/'.length)
    try {
      const input = await readBody(req)
      if (!input.namespace || !input.pvc) return sendJson(res, 400, { message: '缺少 namespace / pvc' })
      const podName = await ensurePvcBrowser(session, input.namespace, input.pvc)
      const sub = (input.path || '/').replace(/^\//, '')
      const fullPath = sub ? `/data/${sub}`.replace(/\/$/, '') : '/data'
      if (action === 'list') {
        const r = await execCapture(session, input.namespace, podName, 'browser', ['ls', '-1Ap', fullPath])
        const errText = r.stderr.trim()
        if (errText && !r.stdout.length) throw Object.assign(new Error(errText), { status: 404 })
        const entries = r.stdout.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
          const isDir = line.endsWith('/')
          return { name: isDir ? line.slice(0, -1) : line, type: isDir ? 'dir' : 'file' }
        })
        return sendJson(res, 200, { path: '/' + sub, entries })
      }
      if (action === 'read') {
        const r = await execCapture(session, input.namespace, podName, 'browser', ['head', '-c', String(PODFILE_PREVIEW_LIMIT + 1), fullPath])
        const errText = r.stderr.trim()
        if (errText && !r.stdout.length) throw Object.assign(new Error(errText), { status: 404 })
        const truncated = r.stdout.length > PODFILE_PREVIEW_LIMIT
        const buf = truncated ? r.stdout.subarray(0, PODFILE_PREVIEW_LIMIT) : r.stdout
        return sendJson(res, 200, { path: '/' + sub, content: buf.toString('utf8'), truncated, binary: r.stdout.includes(0) })
      }
      return sendJson(res, 404, { message: `未知 pvcfile 操作：${action}（只读浏览，仅支持 list / read）` })
    } catch (error) {
      return sendJson(res, error.status || 502, { message: error?.message || 'PVC 文件浏览失败' })
    }
  }

  // Pod 文件浏览（基于一次性 exec：ls / cat / 写入）
  if (url.pathname.startsWith('/api/podfile/')) {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const action = url.pathname.slice('/api/podfile/'.length)
    try {
      const input = await readBody(req)
      const namespace = input.namespace, pod = input.pod, container = input.container || ''
      const path = input.path || '/'
      if (!namespace || !pod) return sendJson(res, 400, { message: '缺少 namespace / pod' })

      if (action === 'list') {
        const result = await execCapture(session, namespace, pod, container, ['sh', '-c', 'ls -1Ap "$1"', 'ls', path])
        const errText = result.stderr.trim()
        if (errText && !result.stdout.length) throw Object.assign(new Error(errText), { status: 404 })
        const entries = result.stdout.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
          const isDir = line.endsWith('/')
          return { name: isDir ? line.slice(0, -1) : line, type: isDir ? 'dir' : 'file' }
        })
        return sendJson(res, 200, { path, entries })
      }
      if (action === 'read') {
        const result = await execCapture(session, namespace, pod, container, ['sh', '-c', 'head -c "$1" "$2"', 'head', String(PODFILE_PREVIEW_LIMIT + 1), path])
        const errText = result.stderr.trim()
        if (errText && !result.stdout.length) throw Object.assign(new Error(errText), { status: 404 })
        const truncated = result.stdout.length > PODFILE_PREVIEW_LIMIT
        const buf = truncated ? result.stdout.subarray(0, PODFILE_PREVIEW_LIMIT) : result.stdout
        return sendJson(res, 200, { path, content: buf.toString('utf8'), truncated, binary: result.stdout.includes(0) })
      }
      if (action === 'write') {
        // data 为 base64（支持二进制）；用 sh -c 'cat > "$1"' 避免路径转义
        const bytes = Buffer.from(String(input.data || ''), 'base64')
        const { KubeConfig, Exec } = await k8sClient()
        const kc = buildKubeConfig(KubeConfig, session)
        const exec = new Exec(kc)
        const stdin = new PassThrough()
        const conn = await exec.exec(namespace, pod, container, ['sh', '-c', 'cat > "$1"', 'podfile-write', path], null, null, stdin, false)
        stdin.end(bytes)
        await new Promise(resolve => conn.on('close', resolve))
        return sendJson(res, 200, { ok: true, path, bytes: bytes.length })
      }
      if (action === 'download') {
        const result = await execCapture(session, namespace, pod, container, ['sh', '-c', 'cat "$1"', 'cat', path])
        const errText = result.stderr.trim()
        if (errText && !result.stdout.length) throw Object.assign(new Error(errText), { status: 404 })
        if (result.stdout.length > PODFILE_DOWNLOAD_LIMIT) return sendJson(res, 413, { message: `文件过大（>${Math.round(PODFILE_DOWNLOAD_LIMIT / 1024 / 1024)}MB），请在终端中下载` })
        const base = (path.split('/').pop() || 'download').replace(/[^\w.-]/g, '_')
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${base}"`,
          'content-length': result.stdout.length,
          'access-control-allow-origin': process.env.CORS_ORIGIN || '*',
          'access-control-expose-headers': 'content-disposition',
        })
        return res.end(result.stdout)
      }
      return sendJson(res, 404, { message: `未知 podfile 操作：${action}` })
    } catch (error) {
      console.error(`[podfile/${action}]`, error?.status || '', error?.message || error)
      return sendJson(res, error.status || 502, { message: error?.message || 'Pod 文件操作失败' })
    }
  }

  // === 终端会话管理（任务栏：CRUD + 持久化） ===
  // GET    /api/terminals           → 列出当前登录用户的终端会话
  // POST   /api/terminals           → 创建（打开新终端）
  // PATCH  /api/terminals/:id       → 更新（重命名 / 最小化 / 恢复）
  // DELETE /api/terminals/:id       → 关闭并删除
  if (url.pathname === '/api/terminals') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    try {
      if (req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM terminals WHERE sessionToken = ? ORDER BY createdAt').all(token)
        return sendJson(res, 200, { terminals: rows.map(r => ({ ...r, status: 'minimized' })) }) // 刷新后全部最小化
      }
      if (req.method === 'POST') {
        const input = await readBody(req)
        const id = `term-${randomUUID().slice(0, 8)}`
        const term = {
          id, sessionToken: token,
          name: input.name || `${input.podName}/${input.container || 'main'}`,
          namespace: input.namespace, podName: input.podName,
          container: input.container || '', command: input.command || 'sh',
          status: 'open', createdAt: Date.now(),
        }
        db.prepare('INSERT INTO terminals (id, sessionToken, name, namespace, podName, container, command, status, createdAt) VALUES (?,?,?,?,?,?,?,?,?)')
          .run(term.id, term.sessionToken, term.name, term.namespace, term.podName, term.container, term.command, term.status, term.createdAt)
        return sendJson(res, 200, term)
      }
      return sendJson(res, 405, { message: 'Method not allowed' })
    } catch (error) { return sendJson(res, 500, { message: error?.message || '终端会话操作失败' }) }
  }
  if (url.pathname.startsWith('/api/terminals/')) {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const id = decodeURIComponent(url.pathname.slice('/api/terminals/'.length))
    try {
      if (req.method === 'PATCH') {
        const input = await readBody(req)
        const fields = []
        const vals = []
        for (const k of ['name', 'status']) { if (input[k] != null) { fields.push(`${k} = ?`); vals.push(input[k]) } }
        if (!fields.length) return sendJson(res, 400, { message: '无更新字段' })
        vals.push(id, token)
        db.prepare(`UPDATE terminals SET ${fields.join(', ')} WHERE id = ? AND sessionToken = ?`).run(...vals)
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM terminals WHERE id = ? AND sessionToken = ?').run(id, token)
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 405, { message: 'Method not allowed' })
    } catch (error) { return sendJson(res, 500, { message: error?.message || '终端会话操作失败' }) }
  }

  // 注入 Ephemeral Container（kubectl debug），用于调试无 shell / distroless 镜像
  if (req.method === 'POST' && url.pathname === '/api/pod/debug') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    try {
      const input = await readBody(req)
      if (!input.namespace || !input.pod || !input.image) return sendJson(res, 400, { message: '缺少 namespace / pod / image' })
      const name = input.name || 'debugger'
      await attachEphemeral(session, input.namespace, input.pod, {
        name,
        image: input.image,
        command: Array.isArray(input.command) ? input.command : (input.command ? String(input.command).split(/\s+/) : ['sh']),
        targetContainerName: input.targetContainer || '',
        tty: input.tty !== false,
        stdin: input.stdin !== false,
      })
      return sendJson(res, 200, { ok: true, container: name })
    } catch (error) {
      return sendJson(res, error.status || 422, { message: error?.message || '注入临时容器失败（集群可能未启用 EphemeralContainers，需 K8s 1.25+）' })
    }
  }

  // 手动触发 CronJob（kubectl create job --from）
  if (req.method === 'POST' && url.pathname === '/api/cronjob/trigger') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    try {
      const input = await readBody(req)
      if (!input.namespace || !input.name) return sendJson(res, 400, { message: '缺少 namespace / name' })
      const job = await triggerCronJob(session, input.namespace, input.name, input.jobName)
      return sendJson(res, 200, { ok: true, job: job?.metadata?.name || '' })
    } catch (error) {
      return sendJson(res, error.status || 422, { message: error?.message || '触发 CronJob 失败' })
    }
  }

  // 镜像仓库可用版本：查询 registry v2 /v2/<repo>/tags/list
  // 支持自签证书（跳过 TLS 校验）、明文 http 自动回退、可选 basic auth（私有仓库）
  if (req.method === 'POST' && url.pathname === '/api/registry/tags') {
    try {
      const input = await readBody(req)
      const ref = parseImageRef(String(input.image || ''))
      if (!ref.registry || !ref.repo) return sendJson(res, 400, { message: '无法解析镜像仓库地址（需含 registry 主机，如 registry.example.com/repo/app）' })
      const headers = {}
      if (input.username || input.password) {
        headers.authorization = 'Basic ' + Buffer.from(`${input.username || ''}:${input.password || ''}`).toString('base64')
      }
      const agent = new UndiciAgent({ connect: { rejectUnauthorized: false } })
      const path = `/v2/${ref.repo}/tags/list?n=100`
      let r
      try {
        r = await kubeFetch(`https://${ref.registry}${path}`, { headers, dispatcher: agent })
      } catch (e) {
        // https 不可达（明文 registry / 端口未开 TLS）→ 回退 http
        r = await kubeFetch(`http://${ref.registry}${path}`, { headers, dispatcher: agent })
      }
      if (r.status === 401) return sendJson(res, 401, { message: 'Registry 需要认证，请填写账号密码', needsAuth: true })
      if (r.status === 404) return sendJson(res, 404, { message: `仓库 ${ref.repo} 不存在` })
      if (!r.ok) {
        const t = await r.text().catch(() => '')
        return sendJson(res, 502, { message: `Registry 返回 ${r.status}：${t.slice(0, 200)}` })
      }
      const data = await r.json()
      const tags = Array.isArray(data.tags) ? data.tags.slice().sort().reverse() : []
      return sendJson(res, 200, { registry: ref.registry, repo: ref.repo, tags })
    } catch (error) {
      return sendJson(res, 502, { message: `无法访问 Registry：${error?.message || error}` })
    }
  }

  // 资源归属拓扑（ownerReferences 链）
  if (req.method === 'GET' && url.pathname === '/api/resource/tree') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const ns = url.searchParams.get('namespace')
    const kind = url.searchParams.get('kind')
    const name = url.searchParams.get('name')
    const apiVersion = url.searchParams.get('apiVersion') || 'v1'
    if (!ns || !kind || !name) return sendJson(res, 400, { message: '缺少 namespace / kind / name' })
    try {
      const tree = await resolveOwnerTree(session, ns, kind, name, apiVersion)
      return sendJson(res, 200, tree)
    } catch (error) {
      return sendJson(res, error.status || 502, { message: error?.message || '解析归属链失败' })
    }
  }

  // K8s 代理 vs 平台 API 路由分发
  const isK8s = url.pathname.startsWith('/api/k8s/')
  const isPlatform = url.pathname.startsWith('/api/auth/') || url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/my-clusters') || url.pathname.startsWith('/api/connect-cluster')
  if (!isK8s && !isPlatform) return sendJson(res, 404, { message: 'Not found' })

  if (isK8s) {
  const session = sessionFromRequest(req)
  if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })

  const kubernetesPath = decodeURIComponent(url.pathname.slice('/api/k8s'.length)) + (url.search || '')

  // 流式透传：watch=true（资源监听）与 follow=true（日志跟随）需要长连接，
  // 不能走缓冲式 requestKubernetes（它会 await 全文）。这里直接 pipe 上游字节流。
  const isStreaming = req.method === 'GET' && /(?:[?&]watch=true)|(?:[?&]follow=true)/.test(kubernetesPath)
  if (isStreaming) {
    try {
      const target = new URL(kubernetesPath, session.apiServer)
      const upstream = await kubeFetch(target, {
        method: 'GET',
        headers: { accept: 'application/json', ...(session.authHeader ? { authorization: session.authHeader } : {}) },
        dispatcher: session.dispatcher,
        signal: AbortSignal.timeout(Number(process.env.K8S_WATCH_TIMEOUT_MS || 10 * 60 * 60 * 1000)),
      })
      if (!upstream.ok || !upstream.body) {
        const text = await upstream.text().catch(() => '')
        let errBody = text
        try { errBody = JSON.parse(text) } catch { /* 非 JSON，保留原文 */ }
        return sendJson(res, upstream.status || 502, errBody?.message ? errBody : { message: text || `Kubernetes API 返回 HTTP ${upstream.status}` })
      }
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-cache',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': process.env.CORS_ORIGIN || '*',
      })
      const pipe = Readable.fromWeb(upstream.body)
      pipe.on('data', chunk => res.write(chunk))
      pipe.on('end', () => res.end())
      pipe.on('error', () => { try { res.end() } catch { /* 连接已断 */ } })
      // 客户端断开时中止上游连接，避免泄漏
      req.on('close', () => { try { pipe.destroy() } catch { /* noop */ } })
      return
    } catch (error) {
      return sendJson(res, error.status || 502, { message: error.message || 'Kubernetes 流式请求失败' })
    }
  }

  try {
    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? JSON.stringify(await readBody(req)) : undefined
    // 透传客户端 content-type（PATCH 的 merge-patch/strategic-merge-patch/json-patch 必须原样转发，
    // 否则 requestKubernetes 会回退成 application/json → K8s 返回 415 Unsupported Media Type）
    const ct = req.headers['content-type']
    const result = await requestKubernetes(session, kubernetesPath, {
      method: req.method,
      body,
      ...(ct ? { headers: { 'content-type': ct } } : {}),
    })
    return sendJson(res, result.status, result.body ?? {})
  } catch (error) {
    return sendJson(res, error.status || 502, { message: error.message || 'Kubernetes API 请求失败', details: error.details })
  }
  } // end if (isK8s)

  // ====== 平台认证 API ======
  if (url.pathname === '/api/auth/login' && req.method === 'POST') {
    try {
      const { username, password } = await readBody(req)
      if (!username || !password) return sendJson(res, 400, { message: '用户名和密码不能为空' })
      const user = db.prepare('SELECT * FROM platform_users WHERE username=?').get(username)
      if (!user || user.disabled || !verifyPassword(password, user.passwordHash))
        return sendJson(res, 401, { message: '用户名或密码错误' })
      const token = randomUUID()
      const ps = { token, userId: user.id, username: user.username, role: user.role, createdAt: Date.now(), k8sSessionToken: null }
      platformSessions.set(token, ps)
      db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt) VALUES (?,?,?,?,?)').run(token, user.id, user.username, user.role, ps.createdAt)
      return sendJson(res, 200, { token, user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName } })
    } catch (e) { return sendJson(res, 500, { message: e?.message || '登录失败' }) }
  }
  if (url.pathname === '/api/auth/me' && req.method === 'GET') {
    const ps = requirePlatform(req, res); if (!ps) return
    const user = db.prepare('SELECT id,username,role,displayName FROM platform_users WHERE id=?').get(ps.userId)
    return sendJson(res, 200, { user })
  }
  if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
    const token = req.headers['x-platform-token']
    if (token) { platformSessions.delete(token); try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(token) } catch { /* noop */ } }
    return sendJson(res, 200, { ok: true })
  }

  // ====== 集群选择（Layer 2） ======
  if (url.pathname === '/api/my-clusters' && req.method === 'GET') {
    const ps = requirePlatform(req, res); if (!ps) return
    let rows
    if (ps.role === 'admin') {
      rows = db.prepare('SELECT id,name,apiServer,version,authMethod,createdAt FROM clusters ORDER BY name').all()
    } else {
      rows = db.prepare(`SELECT c.id,c.name,c.apiServer,c.version,c.authMethod,c.createdAt FROM clusters c
        JOIN user_clusters uc ON uc.clusterId=c.id WHERE uc.userId=? ORDER BY c.name`).all(ps.userId)
    }
    return sendJson(res, 200, { clusters: rows })
  }
  if (url.pathname === '/api/connect-cluster' && req.method === 'POST') {
    const ps = requirePlatform(req, res); if (!ps) return
    try {
      const { clusterId } = await readBody(req)
      const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(clusterId)
      if (!cluster) return sendJson(res, 404, { message: '集群不存在' })
      if (ps.role !== 'admin') {
        const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(ps.userId, clusterId)
        if (!assigned) return sendJson(res, 403, { message: '无权访问此集群' })
      }
      // 从 clusters 行构造 K8s session（字段与 sessions 表完全一致）
      const apiServer = normalizeServer(cluster.apiServer)
      const dispatcher = buildDispatcher({ ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure })
      const k8sSession = { apiServer, authHeader: cluster.authHeader, dispatcher, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure, createdAt: Date.now() }
      const probe = await requestKubernetes(k8sSession, '/version')
      k8sSession.version = probe.body?.gitVersion || 'unknown'
      const k8sToken = randomUUID()
      sessions.set(k8sToken, k8sSession)
      persistSession(k8sToken, k8sSession)
      // 更新平台会话的 k8sSessionToken
      ps.k8sSessionToken = k8sToken
      platformSessions.set(req.headers['x-platform-token'], ps)
      db.prepare('UPDATE platform_sessions SET k8sSessionToken=? WHERE token=?').run(k8sToken, req.headers['x-platform-token'])
      return sendJson(res, 200, { token: k8sToken, cluster: { apiServer: apiServer.toString().replace(/\/$/, ''), version: k8sSession.version } })
    } catch (e) { return sendJson(res, e.status || 502, { message: e?.message || '连接集群失败' }) }
  }

  // ====== Admin: 集群管理 ======
  if (url.pathname === '/api/admin/clusters' && req.method === 'GET') {
    const ps = requireAdmin(req, res); if (!ps) return
    const rows = db.prepare('SELECT id,name,apiServer,authMethod,version,insecure,createdBy,createdAt FROM clusters ORDER BY createdAt DESC').all()
    return sendJson(res, 200, { clusters: rows })
  }
  if (url.pathname === '/api/admin/clusters' && req.method === 'POST') {
    const ps = requireAdmin(req, res); if (!ps) return
    try {
      const input = await readBody(req)
      if (!input.name) return sendJson(res, 400, { message: '集群名称不能为空' })
      // 解析凭据（复用 POST /api/session 的逻辑）
      let apiServer, authHeader = null, ca, cert, key
      if (input.kubeconfig) {
        const parsed = parseKubeconfig(input.kubeconfig)
        apiServer = normalizeServer(parsed.server)
        ca = certMaterial(parsed.cluster, 'certificate-authority-data', 'certificate-authority')
        cert = certMaterial(parsed.user, 'client-certificate-data', 'client-certificate')
        key = certMaterial(parsed.user, 'client-key-data', 'client-key')
        if (parsed.user?.token) authHeader = `Bearer ${parsed.user.token}`
        else if (parsed.user?.username != null) authHeader = `Basic ${Buffer.from(`${parsed.user.username}:${parsed.user.password || ''}`).toString('base64')}`
      } else if (input.token) {
        apiServer = normalizeServer(input.apiServer)
        authHeader = `Bearer ${input.token}`
      } else if (input.username) {
        apiServer = normalizeServer(input.apiServer)
        authHeader = `Basic ${Buffer.from(`${input.username}:${input.password || ''}`).toString('base64')}`
      } else if (input.cert || input.authHeader) {
        // 直接传 PEM 凭据（客户端证书 / 已构造的 authHeader）
        apiServer = normalizeServer(input.apiServer)
        authHeader = input.authHeader || null
        ca = input.ca || null
        cert = input.cert || null
        key = input.key || null
      } else { return sendJson(res, 400, { message: '缺少凭据（token / 账密 / kubeconfig / 客户端证书）' }) }
      const insecure = input.insecure === true
      // 探测版本
      const dispatcher = buildDispatcher({ ca, cert, key, insecure })
      const probe = await requestKubernetes({ apiServer, authHeader, dispatcher, ca, cert, key, insecure }, '/version')
      const version = probe.body?.gitVersion || 'unknown'
      const id = randomUUID()
      db.prepare('INSERT INTO clusters (id,name,apiServer,authMethod,authHeader,ca,cert,key,insecure,version,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, input.name, apiServer.toString(), input.kubeconfig ? 'kubeconfig' : input.token ? 'token' : 'basic', authHeader, ca || null, cert || null, key || null, insecure ? 1 : 0, version, ps.username, Date.now())
      return sendJson(res, 200, { cluster: { id, name: input.name, apiServer: apiServer.toString().replace(/\/$/, ''), version } })
    } catch (e) { return sendJson(res, e.status || 502, { message: e?.message || '添加集群失败（凭据无效或无法连接）' }) }
  }
  if (url.pathname.startsWith('/api/admin/clusters/') && req.method === 'DELETE') {
    const ps = requireAdmin(req, res); if (!ps) return
    const id = decodeURIComponent(url.pathname.slice('/api/admin/clusters/'.length))
    db.prepare('DELETE FROM clusters WHERE id=?').run(id)
    db.prepare('DELETE FROM user_clusters WHERE clusterId=?').run(id)
    return sendJson(res, 200, { ok: true })
  }

  // ====== Admin: 用户管理 ======
  if (url.pathname === '/api/admin/users' && req.method === 'GET') {
    const ps = requireAdmin(req, res); if (!ps) return
    const users = db.prepare('SELECT id,username,role,displayName,createdAt,disabled FROM platform_users ORDER BY createdAt').all()
    for (const u of users) u.clusterIds = db.prepare('SELECT clusterId FROM user_clusters WHERE userId=?').all(u.id).map(r => r.clusterId)
    return sendJson(res, 200, { users })
  }
  if (url.pathname === '/api/admin/users' && req.method === 'POST') {
    const ps = requireAdmin(req, res); if (!ps) return
    try {
      const { username, password, role, displayName } = await readBody(req)
      if (!username || !password) return sendJson(res, 400, { message: '用户名和密码不能为空' })
      if (role && !['admin', 'user'].includes(role)) return sendJson(res, 400, { message: '角色只能是 admin 或 user' })
      const existing = db.prepare('SELECT 1 FROM platform_users WHERE username=?').get(username)
      if (existing) return sendJson(res, 409, { message: '用户名已存在' })
      const id = randomUUID()
      db.prepare('INSERT INTO platform_users (id,username,passwordHash,role,displayName,createdAt) VALUES (?,?,?,?,?,?)')
        .run(id, username, hashPassword(password), role || 'user', displayName || null, Date.now())
      return sendJson(res, 200, { user: { id, username, role: role || 'user', displayName, createdAt: Date.now(), clusterIds: [] } })
    } catch (e) { return sendJson(res, 500, { message: e?.message || '创建用户失败' }) }
  }
  if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
    const ps = requireAdmin(req, res); if (!ps) return
    const id = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length))
    const target = db.prepare('SELECT role FROM platform_users WHERE id=?').get(id)
    if (!target) return sendJson(res, 404, { message: '用户不存在' })
    const adminCount = db.prepare("SELECT COUNT(*) c FROM platform_users WHERE role='admin' AND disabled=0").get().c
    if (target.role === 'admin' && adminCount <= 1) return sendJson(res, 400, { message: '不能删除最后一个管理员' })
    db.prepare('DELETE FROM platform_users WHERE id=?').run(id)
    db.prepare('DELETE FROM user_clusters WHERE userId=?').run(id)
    return sendJson(res, 200, { ok: true })
  }
  if (url.pathname.startsWith('/api/admin/users/') && req.method === 'PATCH') {
    const ps = requireAdmin(req, res); if (!ps) return
    const id = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length))
    const input = await readBody(req)
    const fields = [], vals = []
    for (const k of ['role', 'displayName', 'disabled']) { if (input[k] != null) { fields.push(`${k}=?`); vals.push(input[k]) } }
    if (!fields.length) return sendJson(res, 400, { message: '无更新字段' })
    vals.push(id)
    db.prepare(`UPDATE platform_users SET ${fields.join(',')} WHERE id=?`).run(...vals)
    return sendJson(res, 200, { ok: true })
  }
  if (url.pathname.match(/\/api\/admin\/users\/[^/]+\/reset-password$/) && req.method === 'POST') {
    const ps = requireAdmin(req, res); if (!ps) return
    const userId = url.pathname.split('/')[4]
    const { newPassword } = await readBody(req)
    if (!newPassword) return sendJson(res, 400, { message: '新密码不能为空' })
    db.prepare('UPDATE platform_users SET passwordHash=? WHERE id=?').run(hashPassword(newPassword), userId)
    return sendJson(res, 200, { ok: true })
  }
  if (url.pathname.match(/\/api\/admin\/users\/[^/]+\/clusters$/) && req.method === 'PUT') {
    const ps = requireAdmin(req, res); if (!ps) return
    const userId = url.pathname.split('/')[4]
    const { clusterIds } = await readBody(req)
    db.prepare('DELETE FROM user_clusters WHERE userId=?').run(userId)
    if (Array.isArray(clusterIds)) {
      const stmt = db.prepare('INSERT INTO user_clusters (userId,clusterId,assignedBy,assignedAt) VALUES (?,?,?,?)')
      for (const cid of clusterIds) stmt.run(userId, cid, ps.username, Date.now())
    }
    return sendJson(res, 200, { clusterIds: clusterIds || [] })
  }
}

const httpServer = createServer((req, res) => {
  handle(req, res).catch(error => sendJson(res, 500, { message: error.message || '服务器错误' }))
})

// WebSocket 升级：仅 /api/exec（exec 终端需要双向通道）
const wsServer = new WebSocketServer({ noServer: true })
httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== '/api/exec') { socket.destroy(); return }
  const token = url.searchParams.get('session')
  const session = token ? sessions.get(token) : null
  if (!session || Date.now() - session.createdAt > sessionTtl) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }
  wsServer.handleUpgrade(req, socket, head, ws => handleExec(ws, session, url))
})

loadPersistedSessions() // 启动时恢复持久化的集群会话（重启不掉线）
seedAdminIfNeeded()
loadPersistedPlatformSessions()

httpServer.listen(port, host, () => {
  console.log(`AliangBoard API listening on http://${host}:${port}`)
})
