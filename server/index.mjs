import { createServer } from 'node:http'
import { Readable, Writable, PassThrough } from 'node:stream'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import { randomUUID, scryptSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { URL, fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { loadAll as yamlLoadAll, load as yamlLoad } from 'js-yaml'
import { Agent as UndiciAgent, fetch as kubeFetch } from 'undici'
import { normalizeServer, getDispatcher, buildCallContext } from './call-context.mjs'
import { createClusterProber } from './cluster-probe.mjs'
import { createApiKeysSchema, listKeys } from './auth-keys.mjs'
import { createAuditSchema } from './audit.mjs'
import { resolveApiKey, createApiKeyTools, safePodPath } from './api-key-tools.mjs'
import { createMcpServer } from './mcp.mjs'
import { runBoundedCollect } from './exec-bounds.mjs'
import { pctOf } from './k8s-quantity.mjs'
import { checkRate } from './rate-limit.mjs'
import { extractPlatformToken } from './platform-auth.mjs'
import { createLlmClient } from './llm.mjs'
import { streamDownload, streamUpload, limitMbFromValue, PODFILE_LIMIT_DEFAULT_MB } from './podfile-stream.mjs'
import { createAgentRunner } from './agent-runner.mjs'
import { emit as busEmit, subscribe as busSubscribe, unsubscribe as busUnsubscribe, dispose as busDispose, snapshot as busSnapshot } from './conv-bus.mjs'
import { createWorkbenchSchema, listProjects, getProject, appendHistory, recentHistory, setPendingDistill, setLastDistill, getLastDistill, createConversation, getConversation, updateConversation, listConversations, appendMessage, getMaxSeq, setActiveConversation, listMessages } from './workbench-projects.mjs'
import { k8sSystemPrompt } from './k8s-prompt.mjs'
import { KIND_API_PATH } from './kind-paths.mjs'
import { ensureGitAvailable, initRepo, hasRepo, writeFile as wbWriteFile, readFile as wbReadFile, listFiles as wbListFiles, commit as wbCommit, readManifests as wbReadManifests } from './workbench-repos.mjs'
import { formatIndexMd, verifiedAt } from './workbench-ledger.mjs'
import { runDistill, gatherDistillMaterial, isNewMaterial } from './distill.mjs'
import { maybeSummarize } from './workbench-summarize.mjs'
import { createWorkbenchAgent } from './workbench-agent.mjs'
import { createWorkbenchConvRoutes } from './routes/workbench-conversations.mjs'
import { createWorkbenchProjectRoutes } from './routes/workbench-projects.mjs'
import { createAdminRoutes } from './routes/admin.mjs'
import { WORKBENCH_SYSTEM_PROMPT } from './workbench-prompt.mjs'
import { createAuthRoutes } from './routes/auth.mjs'
import { createIngressControllerRoutes } from './routes/ingress-controllers.mjs'
import { reconcileProject } from './reconcile.mjs'
import { serveStatic } from './static.mjs'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, mkdirSync, chmodSync } from 'node:fs'
import { isFailoverEligible, currentEndpoint, currentDispatcher } from './failover.js'
import { planExec, probeKey, tmuxProbeCommand, isTmuxPresent, tmuxLabel, tmuxSessionName, tmuxKillCommand, pickStaleSids, tmuxCaptureCommand, tmuxAttachOnlyCommand, tmuxNewSessionDetached, tmuxHasSessionCommand, hasHistoryFromCapture, archFromUname, injectDestCandidates } from './tmux-session.mjs'

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
const sessions = new Map()
const discoveryCache = new Map()
const sessionTtl = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000)

// === 会话持久化（SQLite）：集群访问配置落盘，网关重启后浏览器 token 仍有效，无需重登 ===
// ⚠️ 库文件含 K8s 凭据（token/账密/客户端证书私钥），须靠主机文件权限保护（默认 0600）。
const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.ALIANG_DB || join(__dirname, '..', 'data', 'aliangboard.db')
mkdirSync(join(__dirname, '..', 'data'), { recursive: true })
const db = new DatabaseSync(dbPath)
// 工作台 repo 根目录(per-project repo + cluster ledger 的 git repo 落在这下面)
const WORKBENCH_DIR = process.env.ALIANG_WORKBENCH_DIR || join(__dirname, '..', 'data', 'workbench')
const STATIC_DIR = process.env.ALIANG_STATIC_DIR || join(__dirname, '..', 'dist')
mkdirSync(WORKBENCH_DIR, { recursive: true })
ensureGitAvailable().then(() => {}, e => console.error('[workbench] git 二进制不可用,工作台端点将失败:', e.message))
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
db.exec(`CREATE TABLE IF NOT EXISTS file_browsers (
  id TEXT PRIMARY KEY,
  sessionToken TEXT NOT NULL,
  name TEXT NOT NULL,
  namespace TEXT NOT NULL,
  podName TEXT NOT NULL,
  container TEXT,
  status TEXT DEFAULT 'minimized',
  createdAt INTEGER NOT NULL
)`)
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
// API key 表(机器/人绑定的长效凭据):schema + 签发/查询/吊销逻辑见 ./auth-keys.mjs(T4,6A 抽模块 + 可单测)。
createApiKeysSchema(db)
// === 审计日志(按人审计 + 链哈希,codex #9) ===
// seq AUTOINCREMENT:单调序号(链锚点 + 排序,行 id 不重用)。
// status:started(执行前先写,崩溃可追溯)→ finalized(执行后补结果)。codex #9 的两阶段。
// result=denied + reason 也写(含拒绝)。requestSummary 是截断摘要——codex #12:不放原始日志/输出(防注入+泄露)。
// prevHash/hash:链式哈希;node:sqlite DatabaseSync 单进程同步 → 插入天然串行,prevHash 不会读到并发分叉(MVP 单进程)。
createAuditSchema(db)
createWorkbenchSchema(db)
// 启动清理:上次未完成(状态=running)的对话标记为 failed(服务重启后无法恢复后台 Promise)
db.exec("UPDATE workbench_conversations SET status='failed', error='Server restarted' WHERE status='running'")
// === 平台设置(LLM 配置等,key/value 通用)===
db.exec(`CREATE TABLE IF NOT EXISTS platform_settings ( key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL )`)
function getSetting(key) { const r = db.prepare('SELECT value FROM platform_settings WHERE key=?').get(key); return r?.value ?? null }
function setSetting(key, value) { db.prepare('INSERT OR REPLACE INTO platform_settings (key,value,updatedAt) VALUES (?,?,?)').run(key, String(value ?? ''), Date.now()) }
// Pod 文件传输限额(单文件,上传下载共用):默认 1GB,admin 可经 /api/admin/podfile-config 调整
function getPodfileLimitBytes() {
  const mb = limitMbFromValue(getSetting('podfile.limitMb')) ?? PODFILE_LIMIT_DEFAULT_MB
  return mb * 1024 * 1024
}
// LLM 配置:DB 优先,env 回退(管理员未在 UI 配时仍可用 env 跑)
function getLlmConfig() {
  return {
    baseURL: getSetting('llm.baseURL') || process.env.LLM_BASE_URL || '',
    apiKey: getSetting('llm.apiKey') || process.env.LLM_API_KEY || '',
    model: getSetting('llm.model') || process.env.LLM_MODEL || '',
  }
}
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
// 提取平台 token:extractPlatformToken(抽出到 ./platform-auth.mjs 便于单测)。
// 优先 x-platform-token header;缺失时回退 ?token= query(EventSource 不能加自定义 header,SSE 走 query)。
function platformUserFromRequest(req) {
  const token = extractPlatformToken(req)
  if (!token) return null
  let ps = platformSessions.get(token)
  if (!ps) {
    // 懒加载兜底(2026-08-16):Map 未命中查一次 DB(会话可能在别的进程/重启后写入)。
    // 登录主路径不受影响(登录时已双写 Map+DB);此兜底让外部铸的会话免重启网关即可用。
    try {
      const row = db.prepare('SELECT * FROM platform_sessions WHERE token=?').get(token)
      if (row) { platformSessions.set(token, row); ps = row }
    } catch { /* 无表等,视作未命中 */ }
  }
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
        ...buildCallContext({ apiServer: r.apiServer, authHeader: r.authHeader, ca: r.ca, cert: r.cert, key: r.key, insecure: !!r.insecure }),
        endpointIdx: r.endpointIdx || 0,
        version: r.version || undefined,
        createdAt: r.createdAt,
      }
      session.endpoints = r.endpoints ? JSON.parse(r.endpoints).map(s => new URL(s)) : [session.apiServer]
      session.insecureDispatcher = getDispatcher({ ca: r.ca, cert: r.cert, key: r.key, insecure: true })
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
  // 2026-08-16 断流修复·进程级免疫:响应已发 headers(如 SSE 流)后绝不能再 writeHead——
  // 旧实现直接抛 ERR_HTTP_HEADERS_SENT,经 handle().catch 变 unhandledRejection 把整个网关
  // 进程带走(全站 502/终极断流)。已发头只尽力 end,静默跳过。
  if (res.headersSent) { try { res.end() } catch { /* 已断 */ } return }
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

// normalizeServer / getDispatcher / buildCallContext(调用上下文抽象)见 ./call-context.mjs

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

// 调用上下文(call context)抽象:normalizeServer / getDispatcher / buildCallContext 见 ./call-context.mjs
// (T1:抽模块 + 可单测。所有 kube 调用吃 buildCallContext 返回的形状;浏览器 session 与 API-key 共用。)

// 自动发现控制面端点：GET /api/v1/nodes → 过滤 control-plane → InternalIP → 候选 https://<ip>:<port>。
// 端口从原始 apiServer 继承；发现失败 → 只返回 [apiServer]（降级不阻断）。
async function discoverEndpoints(session) {
  try {
    const result = await requestOnce(session, session.apiServer, '/api/v1/nodes?limit=500')
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

// 单端点请求（不转移）：给指定 endpoint 发一次请求，返回 {status, headers, body}，失败抛错。
async function requestOnce(session, endpoint, path, init = {}) {
  const target = new URL(path, endpoint)
  const headers = { accept: 'application/json', ...(init.headers || {}) }
  if (session.authHeader) headers.authorization = session.authHeader
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'
  const dispatcher = (endpoint.origin === session.apiServer.origin) ? session.dispatcher : (session.insecureDispatcher || session.dispatcher)
  const response = await kubeFetch(target, {
    ...init, headers, dispatcher,
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

// 故障转移包装：按 session.endpoints 迭代；网络错误/5xx/超时 → 试下一个；4xx 立即抛。
async function requestKubernetes(session, path, init = {}) {
  const endpoints = (session.endpoints && session.endpoints.length) ? session.endpoints : [session.apiServer]
  const errors = []
  for (let attempt = 0; attempt < endpoints.length; attempt++) {
    const idx = ((session.endpointIdx || 0) + attempt) % endpoints.length
    const endpoint = endpoints[idx]
    try {
      const result = await requestOnce(session, endpoint, path, init)
      if (attempt > 0) { session.endpointIdx = idx; console.log(`[failover] 切换到端点 ${endpoint.host}`) }
      return result
    } catch (e) {
      if (isFailoverEligible(e) && attempt < endpoints.length - 1) {
        errors.push(`${endpoint.host}: ${e.message}`)
        console.warn(`[failover] 端点 ${endpoint.host} 失败 (${e.message || e.code})，尝试下一个...`)
        continue
      }
      if (isFailoverEligible(e) && errors.length) {
        throw Object.assign(new Error(`所有端点不可达（${endpoints.length}个）：${[...errors, `${endpoint.host}: ${e.message}`].join('; ')}`), { status: 503, details: errors })
      }
      throw e
    }
  }
}

// API-key 工具链(T8 walking skeleton):注入 db + requestKubernetes,路由挂 /api/key/*。
// AI 路径的 execFn 适配:api-key-tools 传第 6 参 bounds(审计 P1a)→ execCapture 第 7 参(raw 固定 false)
const apiKeyTools = createApiKeyTools({ db, requestFn: requestKubernetes, execFn: (ctx, ns, pod, container, command, bounds) => execCapture(ctx, ns, pod, container, command, false, bounds), applyYamlFn: applyYamlPartial, ephemeralFn: attachEphemeral })

// 工作台 wb_exec/wb_read_pod_file 的一次性 exec 界限:与 api-key 路径共用同一 env 旋钮
// (MCP_EXEC_TIMEOUT_MS,默认 30s)+ 同一流式上限——防 agent 用长驻命令(tail -f)挂死对话。
const WB_EXEC_TIMEOUT_MS = Number(process.env.MCP_EXEC_TIMEOUT_MS || 30000)
const WB_EXEC_STREAM_MAX = 262144 // 256KB 流式缓冲(最终 stdout 仍截 32KB)

// 集群列表实时探测(/api/admin/clusters GET 用):注入 requestKubernetes → 并行探每个集群
// 的健康度 + nodes/pods 计数,带 TTL 缓存与单集群超时降级。语义见 ./cluster-probe.mjs。
const clusterProber = createClusterProber({ requestFn: requestKubernetes })
// MCP server(T12):/mcp,API key 鉴权,包 callTool;外部 AI(Claude Code)连。
const mcpHandler = createMcpServer({ db, apiKeyTools })

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
  // 逐资源 server-side apply,各自 try/catch:多文档时先建的不被后建的失败连累(QA ISSUE-002:
  //   Deployment 建成功、Service 失败 → 旧 throw-on-first 整体 500,Deployment 残留且 UI 报失败)。
  //   /api/apply 据 applied.length 判 200(部分或全成功)/422(全失败),保留单资源失败→throw 的旧语义。
  const resources = [], applied = [], failed = []
  for (const object of objects) {
    const label = { kind: object?.kind, name: object?.metadata?.name, namespace: object?.metadata?.namespace }
    try {
      if (!object?.kind || !object?.metadata?.name) throw new Error('YAML 缺少 kind 或 metadata.name')
      const { group, version, resource } = await discoverResource(session, object)
      const prefix = group ? `/apis/${group}/${version}` : `/api/${version}`
      const namespacePart = resource.namespaced
        ? `/namespaces/${encodeURIComponent(object.metadata.namespace || 'default')}`
        : ''
      const path = `${prefix}${namespacePart}/${resource.name}/${encodeURIComponent(object.metadata.name)}?fieldManager=aliangboard&force=true`
      const result = await requestKubernetes(session, path, {
        method: 'PATCH',
        headers: { 'content-type': 'application/apply-patch+yaml' },
        body: JSON.stringify(object),
      })
      resources.push(result.body)
      applied.push(label)
    } catch (e) { failed.push({ ...label, error: e.message }) }
  }
  return { resources, applied, failed, total: objects.length }
}

// 工作台用(W5):逐资源 try/catch,部分失败上报(只回 label,不要 body)。applyYaml 同样逐资源但回 body 给 /api/apply。
async function applyYamlPartial(session, yaml) {
  const objects = []
  yamlLoadAll(yaml, o => { if (o) objects.push(o) })
  const applied = [], failed = []
  for (const object of objects) {
    const label = { kind: object?.kind, name: object?.metadata?.name, namespace: object?.metadata?.namespace }
    try {
      if (!object?.kind || !object?.metadata?.name) throw new Error('YAML 缺少 kind 或 metadata.name')
      const { group, version, resource } = await discoverResource(session, object)
      const prefix = group ? `/apis/${group}/${version}` : `/api/${version}`
      const namespacePart = resource.namespaced ? `/namespaces/${encodeURIComponent(object.metadata.namespace || 'default')}` : ''
      const path = `${prefix}${namespacePart}/${resource.name}/${encodeURIComponent(object.metadata.name)}?fieldManager=aliangboard&force=true`
      await requestKubernetes(session, path, { method: 'PATCH', headers: { 'content-type': 'application/apply-patch+yaml' }, body: JSON.stringify(object) })
      applied.push(label)
    } catch (e) { failed.push({ ...label, error: e.message }) }
  }
  return { applied, failed, total: objects.length }
}

// 工作台:台账 bootstrap(survey 集群 → 事实型 INDEX.md)。/ledger/bootstrap 端点 + agent bootstrap_ledger 工具共用。
async function bootstrapLedgerForCluster(cluster) {
  const session = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
  const safe = async (p) => { try { return (await requestKubernetes(session, p)).body?.items ?? null } catch { return null } }
  const [namespaces, nodes, ingressClasses, storageClasses, crds, deployments, services, ingresses,
    statefulsets, daemonsets, networkPolicies, clusterRoles, clusterRoleBindings, persistentVolumes] = await Promise.all([
    safe('/api/v1/namespaces'), safe('/api/v1/nodes'),
    safe('/apis/networking.k8s.io/v1/ingressclasses'), safe('/apis/storage.k8s.io/v1/storageclasses'),
    safe('/apis/apiextensions.k8s.io/v1/customresourcedefinitions'),
    safe('/apis/apps/v1/deployments'), safe('/api/v1/services'), safe('/apis/networking.k8s.io/v1/ingresses'),
    // SP3: 更丰富的集群 survey(StatefulSet/DaemonSet/NetworkPolicy/RBAC/PV)
    safe('/apis/apps/v1/statefulsets'), safe('/apis/apps/v1/daemonsets'),
    safe('/apis/networking.k8s.io/v1/networkpolicies'),
    safe('/apis/rbac.authorization.k8s.io/v1/clusterroles'), safe('/apis/rbac.authorization.k8s.io/v1/clusterrolebindings'),
    safe('/api/v1/persistentvolumes'),
  ])
  const vat = verifiedAt()
  const index = formatIndexMd({ clusterName: cluster.name, apiServer: cluster.apiServer, verifiedAt: vat, namespaces, nodes, ingressClasses, storageClasses, crds, deployments, services, ingresses, statefulsets, daemonsets, networkPolicies, clusterRoles, clusterRoleBindings, persistentVolumes })
  const repo = join(WORKBENCH_DIR, cluster.id, 'cluster-context')
  if (!(await hasRepo(repo))) await initRepo(repo)
  await wbWriteFile(repo, 'INDEX.md', index)
  await wbCommit(repo, `台账 bootstrap · ${vat}`)
  const list = (items) => (items || []).map(i => i.metadata?.name).filter(Boolean)
  const depNs = new Set((deployments || []).map(d => d.metadata?.namespace).filter(Boolean))
  const summary = `台账已重建(verified_at ${vat}):${(namespaces || []).length} ns,${nodes ? `${nodes.length} 节点` : ''};CRD ${(crds || []).length};工作负载(Deploy ${depNs.size} ns + STS ${(statefulsets||[]).length} + DS ${(daemonsets||[]).length});NetPol ${(networkPolicies||[]).length};ClusterRole ${(clusterRoles||[]).length}+Binding ${(clusterRoleBindings||[]).length};PV ${(persistentVolumes||[]).length}。INDEX.md 已写入,read_ledger 可看详情。`
  return { index, files: await wbListFiles(repo), summary, verifiedAt: vat }
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

// tmux availability cache: probeKey -> { res: {kind, bin}, at }. TTL-bounded; cleared on error.
const tmuxProbeCache = new Map()
const TMUX_PROBE_TTL = Number(process.env.TMUX_PROBE_TTL_MS || 5 * 60 * 1000)
const TMUX_SCROLLBACK_LINES = Number(process.env.TMUX_SCROLLBACK_LINES || 2000)

// idle reaper tracker: tmuxSessionName -> { token, ns, pod, container, terminalId, lastActiveAt }
const idleTracker = new Map()

// 空闲回收：超过 IDLE_TTL 未活动的 tmux 会话 best-effort 杀掉并删行。
// 已知限制：计时在 gateway 内存,重启后已空闲的会话需等下次 attach-再离开才计时,或等 pod 重启。
const IDLE_TTL_MS = Number(process.env.IDLE_TTL_MS || 30 * 60 * 1000)
const idleSweeper = setInterval(() => {
  ;(async () => {
    const now = Date.now()
    for (const name of pickStaleSids(now, idleTracker, IDLE_TTL_MS)) {
      const meta = idleTracker.get(name)
      if (!meta) continue                                   // already gone
      if (Date.now() - meta.lastActiveAt <= IDLE_TTL_MS) continue   // re-attached since pick → leave it alone
      idleTracker.delete(name)
      const session = sessions.get(meta.token)
      if (session) {
        try {
          const { bin } = await resolveTmux(session, meta.ns, meta.pod, meta.container || '')
          await execCapture(session, meta.ns, meta.pod, meta.container || '', tmuxKillCommand(tmuxLabel(meta.token), name, bin))
        } catch { /* pod 不在 / token 已过期 —— 忽略 */ }
      }
      try { db.prepare('DELETE FROM terminals WHERE id = ? AND sessionToken = ?').run(meta.terminalId, meta.token) } catch { /* noop */ }
    }
  })().catch(() => {})
}, 60 * 1000)
idleSweeper.unref()

// 读取随镜像打包的静态 tmux 二进制(server/bin/tmux-<arch>)。缺失 → null(resolveTmux 降级为 ephemeral)。
function readTmuxBinary(arch) {
  const p = join(import.meta.dirname, 'bin', `tmux-${arch}`)
  try { return existsSync(p) ? readFileSync(p) : null } catch { return null }
}

// 读取随镜像打包的 terminfo 压缩包(server/bin/ab-terminfo.tar)。最小镜像缺 terminfo 库,注入 tmux 时一并灌进去。
function readTerminfoTar() {
  const p = join(import.meta.dirname, 'bin', 'ab-terminfo.tar')
  try { return existsSync(p) ? readFileSync(p) : null } catch { return null }
}

// 把 terminfo tar 经 stdin 灌进 pod:tar -xf - 读 stdin,解压到 terminfoDir。需 pod 有 tar(busybox/GNU 均可)。
async function execInjectTerminfo(session, namespace, pod, container, tarBytes, terminfoDir) {
  const { KubeConfig, Exec } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)
  const exec = new Exec(kc)
  const stdin = new PassThrough()
  try {
    const conn = await exec.exec(namespace, pod, container, ['sh', '-c', 'mkdir -p "$1" && tar -xf - -C "$1"', 'ab-ti', terminfoDir], null, null, stdin, false)
    stdin.end(tarBytes)
    await new Promise(resolve => conn.on('close', resolve))
    return true
  } catch { return false }
}

// 把二进制字节经一次性 exec 灌进 pod(cat > dest && chmod +x)。复用 podfile-write 的 stdin 注入模式。
async function execInject(session, namespace, pod, container, bytes, destPath) {
  const { KubeConfig, Exec } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)
  const exec = new Exec(kc)
  const stdin = new PassThrough()
  try {
    const conn = await exec.exec(namespace, pod, container, ['sh', '-c', 'cat > "$1" && chmod +x "$1"', 'ab-inject', destPath], null, null, stdin, false)
    stdin.end(bytes)                       // 写完二进制 + EOF,让 cat 收尾
    await new Promise(resolve => conn.on('close', resolve))
    return true
  } catch { return false }
}

// 验证注入的二进制能跑:<dest> -V 输出含 "tmux <ver>"。
async function verifyTmuxBin(session, namespace, pod, container, binPath) {
  try {
    const r = await execCapture(session, namespace, pod, container, [binPath, '-V'], true)  // raw
    return /tmux\s+\d/.test(r?.stdout?.toString('utf8') || '')
  } catch { return false }
}

// 决定持久化用的 tmux:系统有 → system;否则探测架构 + 注入 → injected;否则 none。
async function resolveTmux(session, namespace, pod, container) {
  const key = probeKey(namespace, pod, container)
  const hit = tmuxProbeCache.get(key)
  if (hit && Date.now() - hit.at < TMUX_PROBE_TTL) return hit.res
  let res = { kind: 'none', bin: 'tmux', terminfoDir: '' }
  try {
    if (isTmuxPresent(await execCapture(session, namespace, pod, container, tmuxProbeCommand()))) res = { kind: 'system', bin: 'tmux', terminfoDir: '' }
  } catch { /* probe 失败 → 尝试注入 */ }
  if (res.kind === 'none') {
    let arch = null
    try { arch = archFromUname((await execCapture(session, namespace, pod, container, ['uname', '-m'])).stdout.toString('utf8')) } catch { /* */ }
    const binary = arch ? readTmuxBinary(arch) : null
    if (arch && binary) {
      for (const dest of injectDestCandidates(arch)) {
        if (await execInject(session, namespace, pod, container, binary, dest) && await verifyTmuxBin(session, namespace, pod, container, dest)) {
          // 最小镜像缺 terminfo 库 → 一并注入(server/bin/ab-terminfo.tar),terminfoDir 与 binary 同目录
          const terminfoDir = dest.slice(0, dest.lastIndexOf('/') + 1) + '.ab-terminfo'
          const ti = readTerminfoTar()
          if (ti) { try { await execInjectTerminfo(session, namespace, pod, container, ti, terminfoDir) } catch { /* terminfo 失败不致命 */ } }
          res = { kind: 'injected', bin: dest, terminfoDir }; break
        }
      }
    }
  }
  tmuxProbeCache.set(key, { res, at: Date.now() })
  return res
}

function buildKubeConfig(KubeConfig, session) {
  const kc = new KubeConfig()
  // 注意：client-node 的 caData/certData/keyData 期望 **base64**（内部 bufferFromFileOrString 会 base64 解码）；
  // 而 session 里存的是已解码的 PEM（供 undici 直用），这里必须再编码回 base64，否则 TLS 报 `PEM routines::no start line`。
  const b64 = s => Buffer.from(s, 'utf8').toString('base64')
  const cluster = {
    name: 'aliangboard',
    // 去尾斜杠：client-node 的 WebSocketHandler 用字符串拼接 server+path，尾斜杠会导致 `//api/v1/…` 双斜杠 → 404
    server: currentEndpoint(session).toString().replace(/\/$/, ''),
    skipTLSVerify: !!session.insecure || (session.endpointIdx || 0) > 0,
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
const CH_STDOUT = 1, CH_STDERR = 2, CH_EXIT = 3, CH_ERROR = 4, CH_MODE = 5

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
  const sid = url.searchParams.get('sid') || ''           // 稳定会话标识 = 前端 terminal.id
  const token = url.searchParams.get('session') || ''     // k8s session token（WS 鉴权同一值）

  // 决定执行命令 + 持久性。tmux 可用且有 sid → 先 detached 建会话(探测 tmux 能否起 server+pane);
  // 成功 → 回放历史 + attach;失败(最小镜像限制:只读/noexec/无 pty/server 崩 等)→ 降级一次性 exec,
  // 刷新不保留但 shell 不挂(planExec 只用于持久性判定)。
  const resolved = mode === 'attach' ? { kind: 'none', bin: 'tmux', terminfoDir: '' } : await resolveTmux(session, namespace, pod, container)
  const present = resolved.kind === 'system' || resolved.kind === 'injected'
  const planned = planExec({ mode, tmuxPresent: present, sid })
  const label = tmuxLabel(token)
  const sessionName = tmuxSessionName(token, sid)
  let execCommand = command   // 默认:一次性 shell(降级 / 非 tmux 路径)
  let persistent = false
  if (planned.persistent) {
    try {
      // 会话已存在(重连)? has-session 退出码判断(execCapture 现返回 status)。
      const has = await execCapture(session, namespace, pod, container,
        tmuxHasSessionCommand(label, sessionName, resolved.bin, resolved.terminfoDir), true)
      if (has?.status?.status !== 'Success') {
        // 首次连接:detached 建会话(探测 tmux 能否起)。失败 → throw → catch 降级。
        const made = await execCapture(session, namespace, pod, container,
          tmuxNewSessionDetached({ tmuxBin: resolved.bin, terminfoDir: resolved.terminfoDir, label, name: sessionName, cols: 80, rows: 24, shell: command }), true)
        if (made?.status?.status !== 'Success') throw new Error('tmux new-session failed')
      }
      // 成功:回放 scrollback(B),再 attach
      try {
        const cap = await execCapture(session, namespace, pod, container, tmuxCaptureCommand(label, sessionName, TMUX_SCROLLBACK_LINES, resolved.bin, resolved.terminfoDir), true)
        if (hasHistoryFromCapture(cap)) wsSend(ws, CH_STDOUT, cap.stdout)   // 回放历史 → xterm
      } catch { /* 首次连接无历史 */ }
      execCommand = tmuxAttachOnlyCommand(label, sessionName, resolved.bin, resolved.terminfoDir)
      persistent = true
      idleTracker.set(sessionName, { token, ns: namespace, pod, container, terminalId: sid, lastActiveAt: Date.now() })
    } catch {
      // tmux 起不来 → 降级一次性 exec(刷新不保留),shell 仍可用
      execCommand = command
    }
  }
  wsSend(ws, CH_MODE, JSON.stringify({ persistent }))   // 告知前端最终是否持久(徽标)

  const { KubeConfig, Exec, Attach } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)

  const stdout = new WsSink(CH_STDOUT, ws)
  const stderr = new WsSink(CH_STDERR, ws)
  const stdin = new PassThrough()
  let conn = null

  try {
    if (mode === 'attach') {
      conn = await new Attach(kc).attach(namespace, pod, container, stdout, stderr, stdin, tty)
    } else {
      conn = await new Exec(kc).exec(namespace, pod, container, execCommand, stdout, stderr, stdin, tty, status => {
        wsSend(ws, CH_EXIT, JSON.stringify({ status: status?.status || 'Success', code: status?.code ?? null }))
      })
    }
  } catch (error) {
    // 探测命中缓存但实际不可用（镜像刚换/缓存 stale）→ 失效缓存,下次重探
    if (planned.kind === 'tmux') tmuxProbeCache.delete(probeKey(namespace, pod, container))
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
    if (type === CH_STDIN) {
      const m = planned.persistent ? idleTracker.get(sessionName) : null
      if (m) m.lastActiveAt = Date.now()
      try { stdin.write(payload) } catch { /* noop */ }
    }
    else if (type === CH_RESIZE) {
      try { const { cols, rows } = JSON.parse(payload.toString('utf8')); stdout.columns = cols; stdout.rows = rows; stdout.emit('resize') } catch { /* 帧格式错误 */ }
    }
  })
  ws.on('close', () => { try { stdin.end() } catch { /* noop */ }; try { conn?.close() } catch { /* noop */ } })
  ws.on('error', () => { try { conn?.close() } catch { /* noop */ } })
}

// 一次性 exec（tty=true，捕获 stdout/stderr）：用于文件浏览（ls / cat / 写入）与 AI 工具（exec_pod 等）。
// command 以数组传入（exec 直接执行，不经 shell，无需转义路径）。
// bounds={timeoutMs,maxBytes}（审计 P1a,2026-08-14）：AI 路径传——超时主动断连（防 tail -f 挂死
// MCP 调用）+ 流式字节上限（防 cat 大文件先吃满内存）；交互/浏览路径不传 → 无界（行为同旧版）。
async function execCapture(session, namespace, pod, container, command, raw = false, bounds = null) {
  const { KubeConfig, Exec } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)
  const exec = new Exec(kc)
  const stdin = new PassThrough() // 不立即 end：过早 EOF 会让本集群 kubelet 在命令执行前关闭 exec 会话
  let exitStatus = null   // 命令退出状态(client-node status 回调,execCapture 不抛于非零退出)
  let collected
  try {
    // tty=true：与终端同路径。本集群 client-node 在 tty=false 下 exec 立即 close 无数据；
    // tty 下输出会带 ANSI/CR，统一剔除后再解析
    collected = await runBoundedCollect({
      timeoutMs: bounds?.timeoutMs || 0,
      maxBytes: bounds?.maxBytes || 0,
      openConn: (stdoutSink, stderrSink) => exec.exec(namespace, pod, container, command, stdoutSink, stderrSink, stdin, true, status => { exitStatus = status }),
    })
  } catch (e) {
    const raw = e?.message || String(e)
    // 500 通常=目标容器已终止(Succeeded/Failed),exec 无法进入;给出可读提示而非裸 ws 报错
    const hint = /Unexpected server response:\s*500/i.test(raw) ? `${raw}（目标容器可能未运行/已终止,exec 无法进入;请确认 Pod 为 Running）` : raw
    console.error(`[exec] 失败 ns=${namespace} pod=${pod} c=${container} cmd=${JSON.stringify(command)} :: ${hint}`)
    throw Object.assign(new Error(hint), { status: 502 })
  }
  // 命令（ls/head/cat）自行退出 → kubelet 关闭 → conn close；不主动关 stdin
  try { stdin.destroy() } catch { /* noop */ }
  await new Promise(r => setImmediate(r))
  const out = { stdout: collected.stdout, stderr: collected.stderr.toString('utf8'), status: exitStatus, timedOut: collected.timedOut, truncated: collected.truncated }
  if (raw) return out
  const rawStr = collected.stdout.toString('utf8')
  const clean = rawStr.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '')
  console.error(`[exec] DONE cmd=${JSON.stringify(command)} raw=${rawStr.length} clean=${clean.length} timedOut=${collected.timedOut} truncated=${collected.truncated} head=${JSON.stringify(clean.slice(0, 80))}`)
  return { ...out, stdout: Buffer.from(clean, 'utf8') }
}

// PVC 浏览专用 exec：遇 500 自愈一次。500 = helper 容器已终止/不可 exec（sleep 24h 到期、被驱逐、
// 或 ensurePvcBrowser 的 Running 复用检查与 exec 之间的竞态——检查时 Running、exec 时容器已退出）。
// 直接删掉旧 helper、等其消失、经 ensurePvcBrowser 重建（会等到 Running）后再试一次。
// 仍 500 说明是节点/运行时环境问题（非代码可修），向上抛带提示。
async function pvcBrowseExec(session, ns, pvc, podName, command) {
  try {
    return await execCapture(session, ns, podName, 'browser', command)
  } catch (e) {
    if (!/Unexpected server response:\s*500/i.test(e?.message || '')) throw e
    const podPath = `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(podName)}`
    console.error(`[pvcfile] exec 500，自愈：删除旧 helper ${podName} 并重建`)
    try { await requestKubernetes(session, podPath, { method: 'DELETE' }) } catch { /* 已不在则忽略 */ }
    for (let i = 0; i < 20; i++) {                       // 等旧 helper 真正消失，避免重建 POST 409
      try { await requestKubernetes(session, podPath) } catch (e2) { if (e2.status === 404) break }
      await new Promise(r => setTimeout(r, 500))
    }
    const fresh = await ensurePvcBrowser(session, ns, pvc)
    return await execCapture(session, ns, fresh, 'browser', command)
  }
}

// PVC 文件浏览：起一个 busybox 只读挂载该 PVC 的 helper Pod（确定性命名、幂等创建），复用 exec ls/cat。
// 集群需允许当前用户 create pods + exec（cluster-admin 通常满足）。Pod 跨多次浏览复用，避免反复创建。
async function ensurePvcBrowser(session, ns, pvc) {
  const safe = String(pvc).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const podName = `aliang-pvc-${safe || 'x'}`.slice(0, 63)
  const podPath = `/api/v1/namespaces/${encodeURIComponent(ns)}/pods/${encodeURIComponent(podName)}`
  // 复用前确认 Running:helper 的 sleep(24h) 到期或被驱逐后会变 Succeeded/Failed,
  // 直接复用会让后续 exec 500(exec 无法进入已终止容器)。非 Running → 删除并等其消失后重建。
  try {
    const existing = (await requestKubernetes(session, podPath)).body
    if (existing?.status?.phase === 'Running') return podName
    try { await requestKubernetes(session, podPath, { method: 'DELETE' }) } catch { /* 删除失败不阻断,下面重建若冲突再报 */ }
    for (let i = 0; i < 20; i++) {                       // 等待旧 Pod 真正消失,避免重建 POST 409
      try { await requestKubernetes(session, podPath) } catch (e) { if (e.status === 404) break }
      await new Promise(r => setTimeout(r, 500))
    }
  } catch (e) {
    if (e.status !== 404) throw e
  }
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

const PODFILE_PREVIEW_LIMIT = 256 * 1024   // 预览最多 256KB
// (下载 16MB 硬上限已废——download 走 streamDownload 流式,限额统一 getPodfileLimitBytes(),admin 可调)

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

// ====== T5: @-ref 漂移修复——提取的 helpers(KIND_API_PATH / withTimeout / fetchRefContext / buildK8sSession)======
// 原 POST 端点内联;现抽取为模块级,run/resumeConversation 也用它每轮刷新 ref context。
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms))])
}
// 并发 fetch 所有 references 的最新资源,拼成 refContext 块。单个 5s 超时;失败/404 → 标 not found(漂移感知)。
async function fetchRefContext(references, k8sSession) {
  if (!Array.isArray(references) || !references.length || !k8sSession) return ''
  const tasks = references.map(async ref => {
    const pathFn = KIND_API_PATH[ref.kind]
    const label = `[${ref.kind}/${ref.namespace || ''}/${ref.name}]`
    if (!pathFn) return `${label}: (不支持的 kind)`
    try {
      const res = await withTimeout(requestKubernetes(k8sSession, pathFn(ref.namespace || '', ref.name)), 5000, `ref ${ref.kind}/${ref.name}`)
      return `${label}:\n${JSON.stringify(res.body, null, 2)}`
    } catch { return `${label}: (not found / 已删除)` }
  })
  const blocks = await Promise.all(tasks)
  return `\n\nReferenced resources (当前状态,供你参考):\n${blocks.join('\n\n')}`
}
// 从 clusterId 重建 k8sSession(POST 端点 + run/resumeConversation 共用,避免 6 字段重复)
function buildK8sSession(clusterId) {
  const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(clusterId)
  if (!cluster) return null
  return { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
}

async function handle(req, res) {
  if (req.method === 'OPTIONS') return sendJson(res, 204, {})
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)

  // === MCP server(T12:Streamable HTTP /mcp,外部 AI 用 API key 连)===
  if (url.pathname === '/mcp') {
    if (req.method !== 'OPTIONS' && getSetting('mcp_enabled') === 'false') return sendJson(res, 503, { jsonrpc: '2.0', error: { code: -32000, message: 'MCP service disabled by admin' } })
    return mcpHandler(req, res)
  }

  // === Agent 聊天(第二阶段切片 3+3b:写操作走 checkpoint/resume 人审,agent 用调用者选的 API key)===
  // 请求:{ apiKeyId, message?, history?, resume? };resume = { runContext, queue, denied, steps, toolCallId, approved }
  // 响应:{ status:'pending_approval', runContext, pending, queue, denied, steps, trace } 或
  //       { status:'done', content, steps, denied, truncated?, trace }
  if (url.pathname === '/api/agent/chat' && req.method === 'POST') {
    const ps = requirePlatform(req, res); if (!ps) return
    try {
      const input = await readBody(req)
      const resuming = !!input.resume
      if (!resuming && !input.message) return sendJson(res, 400, { message: '缺 message' })
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) return sendJson(res, 503, { message: 'LLM 未配置(到管理后台「LLM 配置」设 baseURL + model,或设 LLM_BASE_URL/LLM_MODEL 环境变量)' })
      const llmClient = createLlmClient({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })

      // 项目模式(W4b):workbench-only agent,历史走服务端 workbench_history(不进 git repo)。
      if (input.projectId) {
        const proj = getProject(db, input.projectId)
        if (!proj) return sendJson(res, 404, { message: '项目不存在' })
        if (proj.ownerId !== ps.userId && ps.role !== 'admin') return sendJson(res, 403, { message: '无权访问该项目' })
        const repo = join(WORKBENCH_DIR, proj.clusterId, 'projects', proj.id)
        const ledgerRepo = join(WORKBENCH_DIR, proj.clusterId, 'cluster-context')
        const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(proj.clusterId)
        const k8sSession = cluster ? { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() } : null
        const workbench = {
          readLedger: async () => {
            let out = ''
            try { out += await wbReadFile(ledgerRepo, 'INDEX.md') } catch {}
            try { const l = await wbReadFile(ledgerRepo, 'learnings.md'); if (l && l.trim()) out += '\n\n# Learnings（团队知识/踩坑）\n' + l } catch {}
            return out.trim() || '(集群台账尚未 bootstrap;建议先在「集群台账」页 bootstrap)'
          },
          readFile: (p) => wbReadFile(repo, p),
          writeFile: (p, c) => wbWriteFile(repo, p, c),
          readManifests: async () => { const files = await wbListFiles(repo); const yamls = files.filter(f => f.startsWith('manifests/') && /\.ya?ml$/.test(f)); const cs = await Promise.all(yamls.map(f => wbReadFile(repo, f).catch(() => ''))); return cs.join('\n---\n') },
          applyManifests: async (yaml) => { if (!k8sSession) throw new Error('项目绑定的集群不存在,无法 apply'); return applyYamlPartial(k8sSession, yaml) },
          appendLearning: async (content) => { let prev = ''; try { prev = await wbReadFile(ledgerRepo, 'learnings.md') } catch {}; await wbWriteFile(ledgerRepo, 'learnings.md', (prev && prev.trim() ? prev.trimEnd() + '\n' : '# Learnings\n\n') + `- ${content}\n`) },
          bootstrapLedger: async () => { if (!cluster) throw new Error('项目绑定的集群不存在'); return bootstrapLedgerForCluster(cluster) },
        }
        const { run } = createAgentRunner({ llmClient, workbench })
        const trace = []
        let out
        if (resuming) {
          const r = input.resume || {}
          out = await run({ resume: { messages: r.runContext, queue: r.queue, denied: r.denied, steps: r.steps, toolCallId: r.toolCallId, approved: !!r.approved }, onStep: e => trace.push(e) })
        } else {
          const history = recentHistory(db, proj.id)
          const system = WORKBENCH_SYSTEM_PROMPT

          // @-mention references 注入:fetch 每个 ref 的完整资源 → prepend context block 到 message。
          let messageContent = String(input.message)
          if (Array.isArray(input.references) && input.references.length && k8sSession) {
            const blocks = []
            for (const ref of input.references) {
              const pathFn = KIND_API_PATH[ref.kind]
              const label = `[${ref.kind}/${ref.namespace || ''}/${ref.name}]`
              if (!pathFn) { blocks.push(`${label}: (不支持的 kind)`); continue }
              try {
                const res = await requestKubernetes(k8sSession, pathFn(ref.namespace || '', ref.name))
                blocks.push(`${label}:\n${JSON.stringify(res, null, 2)}`)
              } catch (e) {
                blocks.push(`${label}: (not found)`)
              }
            }
            messageContent = `Referenced resources:\n${blocks.join('\n\n')}\n\n${messageContent}`
          }

          out = await run({ system, history: [...history, { role: 'user', content: messageContent }], onStep: e => trace.push(e) })
          if (out.status !== 'pending_approval') { appendHistory(db, proj.id, 'user', messageContent); appendHistory(db, proj.id, 'assistant', out.content || '') }
        }
        if (out.status === 'pending_approval') return sendJson(res, 200, { status: 'pending_approval', runContext: out.messages, pending: out.pending, queue: out.queue, denied: out.denied, steps: out.steps, trace })
        return sendJson(res, 200, { status: 'done', content: out.content, steps: out.steps, denied: out.denied, truncated: out.truncated, trace })
      }

      // K8s 模式(原):apiKeyId 必填,agent 用所选 key 的 SA + tier
      if (!input.apiKeyId) return sendJson(res, 400, { message: '缺 apiKeyId(K8s 模式)或 projectId(项目模式)' })
      const keyRow = listKeys(db).find(k => k.id === input.apiKeyId && !k.revokedAt)
      if (!keyRow) return sendJson(res, 404, { message: 'API key 不存在或已吊销' })
      const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(keyRow.clusterId)
      if (!cluster) return sendJson(res, 404, { message: '集群不存在' })
      const { run } = createAgentRunner({ llmClient, apiKeyTools, keyRow, cluster })
      const trace = []
      let out
      if (resuming) {
        const r = input.resume || {}
        // 续跑:客户端回传对话状态(runContext/queue)+ 对某 pending 写工具的人审决策;execTool 仍走 callTool 全链(RBAC 兜底)
        out = await run({
          resume: { messages: r.runContext, queue: r.queue, denied: r.denied, steps: r.steps, toolCallId: r.toolCallId, approved: !!r.approved },
          onStep: e => trace.push(e),
        })
      } else {
        const history = Array.isArray(input.history) ? input.history : []
        const system = k8sSystemPrompt(keyRow.tier)
        out = await run({
          system,
          history: [...history, { role: 'user', content: String(input.message) }],
          onStep: e => trace.push(e), // 回传工具调用 trace 供 UI 展示
        })
      }
      if (out.status === 'pending_approval') {
        return sendJson(res, 200, { status: 'pending_approval', runContext: out.messages, pending: out.pending, queue: out.queue, denied: out.denied, steps: out.steps, trace })
      }
      return sendJson(res, 200, { status: 'done', content: out.content, steps: out.steps, denied: out.denied, truncated: out.truncated, trace })
    } catch (e) { return sendJson(res, e.status || 500, { message: e?.message || 'agent 失败' }) }
  }

  // ====== 工作台:有状态对话(P5)——5 端点 + 后台执行(detached Promise) ======

  // 构建 workbench context(复用现有 agent chat 的 projectId 分支逻辑)
  function buildWbCtx(project) {
    const repo = join(WORKBENCH_DIR, project.clusterId, 'projects', project.id)
    const ledgerRepo = join(WORKBENCH_DIR, project.clusterId, 'cluster-context')
    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(project.clusterId)
    const k8sSession = cluster ? { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() } : null
    // K8s 调查 helper:用项目绑定的集群凭据直连(不走 API key/tier),供 WB-principal 工具用
    const WB_K8S_LIST_PATH = {
      pods: '/api/v1/pods', services: '/api/v1/services', configmaps: '/api/v1/configmaps', secrets: '/api/v1/secrets',
      deployments: '/apis/apps/v1/deployments', statefulsets: '/apis/apps/v1/statefulsets', daemonsets: '/apis/apps/v1/daemonsets',
      nodes: '/api/v1/nodes', persistentvolumes: '/api/v1/persistentvolumes', persistentvolumeclaims: '/api/v1/persistentvolumeclaims',
      storageclasses: '/apis/storage.k8s.io/v1/storageclasses', networkpolicies: '/apis/networking.k8s.io/v1/networkpolicies',
      serviceaccounts: '/api/v1/serviceaccounts', ingresses: '/apis/networking.k8s.io/v1/ingresses', namespaces: '/api/v1/namespaces',
    }
    const WB_K8S_GET_PATH = {
      pods: (ns, name) => `/api/v1/namespaces/${ns}/pods/${name}`, services: (ns, name) => `/api/v1/namespaces/${ns}/services/${name}`,
      deployments: (ns, name) => `/apis/apps/v1/namespaces/${ns}/deployments/${name}`, statefulsets: (ns, name) => `/apis/apps/v1/namespaces/${ns}/statefulsets/${name}`,
      daemonsets: (ns, name) => `/apis/apps/v1/namespaces/${ns}/daemonsets/${name}`, configmaps: (ns, name) => `/api/v1/namespaces/${ns}/configmaps/${name}`,
      secrets: (ns, name) => `/api/v1/namespaces/${ns}/secrets/${name}`, nodes: (_ns, name) => `/api/v1/nodes/${name}`,
      persistentvolumes: (_ns, name) => `/api/v1/persistentvolumes/${name}`, persistentvolumeclaims: (ns, name) => `/api/v1/namespaces/${ns}/persistentvolumeclaims/${name}`,
      storageclasses: (_ns, name) => `/apis/storage.k8s.io/v1/storageclasses/${name}`, networkpolicies: (ns, name) => `/apis/networking.k8s.io/v1/namespaces/${ns}/networkpolicies/${name}`,
      serviceaccounts: (ns, name) => `/api/v1/namespaces/${ns}/serviceaccounts/${name}`, ingresses: (ns, name) => `/apis/networking.k8s.io/v1/namespaces/${ns}/ingresses/${name}`,
      namespaces: (_ns, name) => `/api/v1/namespaces/${name}`,
    }
    const enc = encodeURIComponent
    const LOG_TAIL = 200, LOG_MAX = 16384
    return {
      ctx: {
        readLedger: async () => {
          let out = ''
          try { out += await wbReadFile(ledgerRepo, 'INDEX.md') } catch {}
          try { const l = await wbReadFile(ledgerRepo, 'learnings.md'); if (l && l.trim()) out += '\n\n# Learnings（团队知识/踩坑）\n' + l } catch {}
          return out.trim() || '(集群台账尚未 bootstrap;建议先在「集群台账」页 bootstrap)'
        },
        readFile: (p) => wbReadFile(repo, p),
        writeFile: (p, c) => wbWriteFile(repo, p, c),
        readManifests: async () => { const files = await wbListFiles(repo); const yamls = files.filter(f => f.startsWith('manifests/') && /\.ya?ml$/.test(f)); const cs = await Promise.all(yamls.map(f => wbReadFile(repo, f).catch(() => ''))); return cs.join('\n---\n') },
        applyManifests: async (yaml) => { if (!k8sSession) throw new Error('项目绑定的集群不存在,无法 apply'); return applyYamlPartial(k8sSession, yaml) },
        appendLearning: async (content) => { let prev = ''; try { prev = await wbReadFile(ledgerRepo, 'learnings.md') } catch {}; await wbWriteFile(ledgerRepo, 'learnings.md', (prev && prev.trim() ? prev.trimEnd() + '\n' : '# Learnings\n\n') + `- ${content}\n`) },
        bootstrapLedger: async () => { if (!cluster) throw new Error('项目绑定的集群不存在'); return bootstrapLedgerForCluster(cluster) },
        // === K8s 调查(workbench-principal,直连集群凭据) ===
        listResources: async (kind, namespace) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const k = String(kind || 'pods').toLowerCase()
          const listPath = WB_K8S_LIST_PATH[k]
          if (!listPath) throw new Error(`不支持的 kind: ${k}`)
          const path = namespace && namespace !== '_' ? listPath.replace('/pods', `/namespaces/${enc(namespace)}/pods`).replace('/services', `/namespaces/${enc(namespace)}/services`).replace('/deployments', `/namespaces/${enc(namespace)}/deployments`).replace('/configmaps', `/namespaces/${enc(namespace)}/configmaps`).replace('/secrets', `/namespaces/${enc(namespace)}/secrets`).replace('/statefulsets', `/namespaces/${enc(namespace)}/statefulsets`).replace('/daemonsets', `/namespaces/${enc(namespace)}/daemonsets`).replace('/persistentvolumeclaims', `/namespaces/${enc(namespace)}/persistentvolumeclaims`).replace('/networkpolicies', `/namespaces/${enc(namespace)}/networkpolicies`).replace('/serviceaccounts', `/namespaces/${enc(namespace)}/serviceaccounts`).replace('/ingresses', `/namespaces/${enc(namespace)}/ingresses`) : listPath
          const resp = await requestKubernetes(k8sSession, path)
          const items = (resp?.body?.items || []).slice(0, 50).map(it => ({ name: it.metadata?.name, namespace: it.metadata?.namespace || '', kind: k }))
          return { kind: k, count: resp?.body?.items?.length || 0, returned: items.length, items }
        },
        getPodLogs: async (args) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const tailN = Math.min(Math.max(Number(args.tail) || LOG_TAIL, 1), LOG_TAIL)
          const q = new URLSearchParams({ tailLines: String(tailN) })
          if (args.container) q.set('container', args.container)
          if (args.previous) q.set('previous', 'true')
          if (args.timestamps) q.set('timestamps', 'true')
          const resp = await requestKubernetes(k8sSession, `/api/v1/namespaces/${enc(args.namespace)}/pods/${enc(args.pod)}/log?${q}`)
          const buf = Buffer.from(typeof resp === 'string' ? resp : String(resp ?? ''), 'utf8')
          const truncated = buf.length > LOG_MAX
          return { logs: truncated ? buf.subarray(0, LOG_MAX).toString('utf8') : buf.toString('utf8'), tail: tailN, previous: !!args.previous, truncated, originalBytes: buf.length }
        },
        // 读 pod 内文件(cat via exec):路径过 safePodPath 白名单(无 ;|&$ 等 shell 元字符)→
        // 命令不可注入,只读语义 → 免人审。ConfigMap/Secret 看不到的容器内落盘文件用它。
        readPodFile: async (args) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          if (!args.pod) throw new Error('缺 pod')
          const p = safePodPath(args.path)
          // `--` 止参:白名单允许 `-` 开头的路径,防被 cat 当选项(纵深防御,一字之差)
          const r = await execCapture(k8sSession, args.namespace, args.pod, args.container || '', `cat -- ${p}`, false, { timeoutMs: WB_EXEC_TIMEOUT_MS, maxBytes: WB_EXEC_STREAM_MAX })
          return { pod: args.pod, path: p, content: (r.stdout?.toString('utf8') || '').slice(0, 32768), timedOut: !!r.timedOut, truncated: !!r.truncated }
        },
        describeResource: async (namespace, kind, name) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const k = String(kind || 'pods').toLowerCase()
          const getter = WB_K8S_GET_PATH[k]
          if (!getter) throw new Error(`不支持的 kind: ${k}`)
          const resResp = await requestKubernetes(k8sSession, getter(namespace, name))
          const resBody = resResp?.body
          if (resBody?.metadata?.managedFields) delete resBody.metadata.managedFields
          let events = []
          try { const evtResp = await requestKubernetes(k8sSession, `/api/v1/namespaces/${enc(namespace)}/events?fieldSelector=${enc('involvedObject.name=' + name)}`); events = (evtResp?.body?.items || []).slice(0, 20).map(e => ({ reason: e.reason, type: e.type, message: String(e.message || '').slice(0, 300), last: e.lastTimestamp })) } catch {}
          return { resource: resBody, events: { count: events.length, items: events } }
        },
        // 轻量 GET:单个资源完整对象(无 events),适合 ConfigMap/Service/Secret 等不需要事件的场景
        getResource: async (namespace, kind, name) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const k = String(kind || 'pods').toLowerCase()
          const getter = WB_K8S_GET_PATH[k]
          if (!getter) throw new Error(`不支持的 kind: ${k}`)
          const resp = await requestKubernetes(k8sSession, getter(namespace, name))
          const body = resp?.body
          if (body?.metadata?.managedFields) delete body.metadata.managedFields
          return { resource: body }
        },
        getEvents: async (namespace, name) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const path = name ? `/api/v1/namespaces/${enc(namespace)}/events?fieldSelector=${enc('involvedObject.name=' + name)}` : `/api/v1/namespaces/${enc(namespace)}/events`
          const resp = await requestKubernetes(k8sSession, path)
          const items = (resp?.body?.items || []).slice(0, 50).map(e => ({ reason: e.reason, type: e.type, message: String(e.message || '').slice(0, 300), last: e.lastTimestamp }))
          return { count: resp?.body?.items?.length || 0, returned: items.length, items }
        },
        rolloutStatus: async (namespace, name) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const resp = await requestKubernetes(k8sSession, `/apis/apps/v1/namespaces/${enc(namespace)}/deployments/${enc(name)}`)
          const body = resp?.body
          if (!body) throw new Error(`Deployment ${name} 不存在`)
          const s = body.status || {}
          const conditions = (s.conditions || []).map(c => ({ type: c.type, status: c.status, reason: c.reason, message: String(c.message || '').slice(0, 200) }))
          const replicas = { desired: s.replicas ?? 0, ready: s.readyReplicas ?? 0, updated: s.updatedReplicas ?? 0, available: s.availableReplicas ?? 0, unavailable: s.unavailableReplicas ?? 0 }
          const prog = conditions.find(c => c.type === 'Progressing')
          const summary = `${replicas.ready}/${replicas.desired} ready, ${replicas.updated} updated${prog ? `, ${prog.reason || prog.status}` : ''}`
          return { name: body.metadata?.name, replicas, conditions, summary }
        },
        // 实时资源用量(kubectl top 等价):metrics.k8s.io + limits/capacity join,
        // 算好 cpuPct/memPct(OOM 前兆/CPU 打满一眼可见,agent 不用自己换算数量单位)。
        topUsage: async (args) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          try {
            const scope = String(args.scope || 'pods').toLowerCase()
            if (scope === 'nodes') {
              const mResp = await requestKubernetes(k8sSession, '/apis/metrics.k8s.io/v1beta1/nodes')
              const caps = {}
              try {
                const nResp = await requestKubernetes(k8sSession, '/api/v1/nodes')
                for (const n of (nResp?.body?.items || [])) caps[n.metadata?.name] = { cpu: n.status?.capacity?.cpu, memory: n.status?.capacity?.memory }
              } catch { /* capacity join 失败不致命:只给绝对用量 */ }
              const items = (mResp?.body?.items || []).map(it => {
                const cap = caps[it.metadata?.name] || {}
                return {
                  name: it.metadata?.name, cpu: it.usage?.cpu, memory: it.usage?.memory,
                  cpuCapacity: cap.cpu || null, memoryCapacity: cap.memory || null,
                  cpuPct: pctOf(it.usage?.cpu, cap.cpu), memoryPct: pctOf(it.usage?.memory, cap.memory),
                }
              })
              return { scope: 'nodes', count: items.length, items }
            }
            // 默认 pods(ns 必填;pod 可选 → 单 pod 精查)
            const ns = args.namespace
            if (!ns) throw new Error('scope=pods 需要 namespace')
            const mResp = await requestKubernetes(k8sSession, args.pod
              ? `/apis/metrics.k8s.io/v1beta1/namespaces/${enc(ns)}/pods/${enc(args.pod)}`
              : `/apis/metrics.k8s.io/v1beta1/namespaces/${enc(ns)}/pods`)
            const limits = {}
            try {
              const pResp = await requestKubernetes(k8sSession, args.pod
                ? `/api/v1/namespaces/${enc(ns)}/pods/${enc(args.pod)}`
                : `/api/v1/namespaces/${enc(ns)}/pods`)
              const pods = Array.isArray(pResp?.body?.items) ? pResp.body.items : [pResp?.body].filter(Boolean)
              for (const p of pods) for (const c of (p.spec?.containers || [])) limits[`${p.metadata?.name}/${c.name}`] = { cpu: c.resources?.limits?.cpu, memory: c.resources?.limits?.memory }
            } catch { /* limits join 失败不致命 */ }
            const mItems = Array.isArray(mResp?.body?.items) ? mResp.body.items : [mResp?.body].filter(Boolean)
            const items = mItems.map(it => ({
              name: it.metadata?.name, namespace: ns,
              containers: (it.containers || []).map(c => {
                const lim = limits[`${it.metadata?.name}/${c.name}`] || {}
                return {
                  name: c.name, cpu: c.usage?.cpu, memory: c.usage?.memory,
                  cpuLimit: lim.cpu || null, memoryLimit: lim.memory || null,
                  cpuPct: pctOf(c.usage?.cpu, lim.cpu), memoryPct: pctOf(c.usage?.memory, lim.memory),
                }
              }),
            }))
            return { scope: 'pods', namespace: ns, count: items.length, items }
          } catch (e) {
            // metrics.k8s.io 未注册/未就绪:404(无该 API)或 503( aggregated 未路出)——给可读指引
            if (e.status === 404 || e.status === 503) throw new Error('metrics-server 未安装或未就绪(kubectl top 同样不可用);装好后再试。原始错误: ' + e.message)
            throw e
          }
        },
        // === K8s 运维(scale/restart,用项目绑定集群凭据,需人审) ===
        scale: async (namespace, kind, name, replicas) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const k = String(kind || '').toLowerCase()
          if (!['deployments', 'statefulsets'].includes(k)) throw new Error(`scale 仅支持 deployments/statefulsets,不是 ${k}`)
          const n = Math.min(Math.max(Number(replicas) | 0, 1), 20) // 钳到 1..20
          const resp = await requestKubernetes(k8sSession, `/apis/apps/v1/namespaces/${enc(namespace)}/${k}/${enc(name)}/scale`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ spec: { replicas: n } }) })
          return { kind: k, name, replicas: resp?.body?.spec?.replicas ?? n, message: `${namespace}/${name} 已调整到 ${n} 副本` }
        },
        restart: async (namespace, kind, name) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const k = String(kind || '').toLowerCase()
          if (!['deployments', 'statefulsets', 'daemonsets'].includes(k)) throw new Error(`restart 仅支持 deployments/statefulsets/daemonsets,不是 ${k}`)
          const ts = new Date().toISOString()
          const resp = await requestKubernetes(k8sSession, `/apis/apps/v1/namespaces/${enc(namespace)}/${k}/${enc(name)}`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': ts } } } } }) })
          return { kind: k, name, restartedAt: ts, message: `${namespace}/${name} 已触发滚动重启` }
        },
        updateImage: async (namespace, kind, name, image, container) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          const k = String(kind || '').toLowerCase()
          if (!['deployments', 'statefulsets', 'daemonsets'].includes(k)) throw new Error(`updateImage 仅支持 deployments/statefulsets/daemonsets,不是 ${k}`)
          if (!image) throw new Error('image 不能为空')
          const resp = await requestKubernetes(k8sSession, `/apis/apps/v1/namespaces/${enc(namespace)}/${k}/${enc(name)}`)
          const body = resp?.body
          if (!body) throw new Error(`${k}/${name} 不存在`)
          const containers = body.spec?.template?.spec?.containers || []
          const idx = container ? containers.findIndex(c => c.name === container) : 0
          if (idx < 0) throw new Error(`容器 ${container} 不存在`)
          const patch = { spec: { template: { spec: { containers: containers.map((c, i) => i === idx ? { ...c, image } : c) } } } }
          await requestKubernetes(k8sSession, `/apis/apps/v1/namespaces/${enc(namespace)}/${k}/${enc(name)}`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(patch) })
          const updatedContainers = container ? [{ name: container, image }] : [{ name: containers[0]?.name || '', image }]
          return { kind: k, name, containers: updatedContainers, message: `${namespace}/${name} 镜像更新为 ${image}` }
        },
        rolloutUndo: async (namespace, name, toRevision) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          // apps/v1 已移除 deployments/rollback 子资源,kubectl rollout undo 实为客户端行为:
          // 取目标 revision 的 ReplicaSet 完整 template,merge-patch 回 Deployment(与前端 rollbackWorkload 同源)。
          const depResp = await requestKubernetes(k8sSession, `/apis/apps/v1/namespaces/${enc(namespace)}/deployments/${enc(name)}`)
          const dep = depResp?.body
          if (!dep) throw new Error(`deployments/${name} 不存在`)
          const uid = dep.metadata?.uid
          const rsResp = await requestKubernetes(k8sSession, `/apis/apps/v1/namespaces/${enc(namespace)}/replicasets`)
          const revisions = (rsResp?.body?.items || [])
            .filter(rs => (rs.metadata?.ownerReferences || []).some(o => o.uid === uid))
            .map(rs => ({ rev: Number(rs.metadata?.annotations?.['deployment.kubernetes.io/revision'] || 0), template: rs.spec?.template, image: rs.spec?.template?.spec?.containers?.[0]?.image }))
            .filter(r => r.rev > 0 && r.template)
            .sort((a, b) => b.rev - a.rev)
          if (!revisions.length) throw new Error(`${namespace}/${name} 没有可回滚的 revision`)
          const target = toRevision ? revisions.find(r => r.rev === Number(toRevision)) : revisions[1]
          if (!target) {
            if (toRevision) throw new Error(`revision ${toRevision} 不存在,可用: ${revisions.map(r => r.rev).join(', ')}`)
            throw new Error(`${namespace}/${name} 没有更早的 revision 可回滚`)
          }
          await requestKubernetes(k8sSession, `/apis/apps/v1/namespaces/${enc(namespace)}/deployments/${enc(name)}`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ spec: { template: target.template } }) })
          return { name, fromRevision: revisions[0]?.rev, toRevision: target.rev, image: target.image, availableRevisions: revisions.map(r => r.rev), message: `${namespace}/${name} 已回滚到 revision ${target.rev}` }
        },
        // === 容器内诊断 exec(需人审):nc/curl/mysql ping 等连通性检查 ===
        // 复用 execCapture(超时 + 流式上限 + ANSI 清洗);非交互一次性。命令原文进审批弹窗,人看到才跑。
        execInPod: async (args) => {
          if (!k8sSession) throw new Error('项目绑定的集群不存在')
          if (!args.pod) throw new Error('缺 pod')
          const command = Array.isArray(args.command) ? args.command.join(' ') : String(args.command || '')
          if (!command.trim()) throw new Error('缺 command')
          const r = await execCapture(k8sSession, args.namespace, args.pod, args.container || '', command, false, { timeoutMs: WB_EXEC_TIMEOUT_MS, maxBytes: WB_EXEC_STREAM_MAX })
          return {
            pod: args.pod, container: args.container || '', exitCode: r.status ?? null,
            stdout: (r.stdout?.toString('utf8') || '').slice(0, 32768),
            stderr: (r.stderr || '').slice(0, 8192),
            timedOut: !!r.timedOut, truncated: !!r.truncated,
            ...(r.timedOut ? { hint: `命令超时(>${Math.round(WB_EXEC_TIMEOUT_MS / 1000)}s)被中止,输出为已收部分;一次性 exec 不适用于长驻命令(tail -f/top/交互式)` } : {}),
          }
        },
      },
      k8sSession,
    }
  }

  // SP2: agent loop 抽到 workbench-agent.mjs(factory,可单测)。零行为变更。
  const wbAgent = createWorkbenchAgent({ db, buildWbCtx, buildK8sSession, fetchRefContext, createAgentRunner, busEmit, busDispose })
  // SP3: 7 个工作台对话 HTTP 端点 + buildRefsContext 抽到 routes/workbench-conversations.mjs(handler/dispatcher)。
  // 零行为变更:端点块逐字搬迁,仅依赖引用改走 deps 注入。
  const convRoutes = createWorkbenchConvRoutes({
    db, sendJson, readBody, requireAdmin, wbAgent,
    getLlmConfig, createLlmClient, buildCallContext, requestKubernetes,
    busSubscribe, busUnsubscribe, busSnapshot,
  })
  // SP3: 工作台对话端点 dispatcher(7 端点抽到 routes/workbench-conversations.mjs)。命中即 return。
  // 放在 convRoutes 构造后、项目 CRUD 前——无路径冲突,仅须早于 404 兜底。
  if (await convRoutes.handle(req, res, url)) return

  // SP4: 离散路由抽出 — auth / admin / workbench-projects(handler/dispatcher 模式)。零行为变更。
  // 构造放 handle() 内(与 convRoutes 一致:closure deps 此处可见)。dispatch 顺序无要求(路由不重叠)。
  const authRoutes = createAuthRoutes({
    db, sendJson, readBody, requirePlatform,
    platformSessions, sessions, persistSession,
    verifyPassword, randomUUID, normalizeServer, buildCallContext, requestKubernetes,
  })
  const adminRoutes = createAdminRoutes({
    db, sendJson, readBody, requireAdmin,
    getSetting, setSetting, getLlmConfig, createLlmClient,
    clusterProber, randomUUID,
    parseKubeconfig, certMaterial, normalizeServer, buildCallContext, requestKubernetes,
    hashPassword,
  })
  const projectRoutes = createWorkbenchProjectRoutes({
    db, sendJson, readBody, requirePlatform, requireAdmin,
    WORKBENCH_DIR, dbPath, getLlmConfig, createLlmClient,
    buildCallContext, requestKubernetes, applyYamlPartial,
    bootstrapLedgerForCluster,
  })
  const ingressControllerRoutes = createIngressControllerRoutes({ sendJson })
  if (await authRoutes.handle(req, res, url)) return
  if (await adminRoutes.handle(req, res, url)) return
  if (await projectRoutes.handle(req, res, url)) return
  if (await ingressControllerRoutes.handle(req, res, url)) return

  // === API-key 工具路由(T8 walking skeleton:仅 get_pod_logs;MCP 包装在 T12)===
  // 鉴权:Authorization: Bearer <apikey>(路径 /api/key/* 与浏览器 gateway 鉴权隔离)。
  if (url.pathname.startsWith('/api/key/') && req.method === 'GET') {
    const keyRow = resolveApiKey(db, req)
    if (!keyRow) return sendJson(res, 401, { error: 'PERMISSION_DENIED', reason: 'revoked', message: '无效或已吊销的 API key' })
    const _rl = checkRate(keyRow.id)
    if (!_rl.allowed) return sendJson(res, 429, { error: 'RATE_LIMITED', retryAfter: _rl.retryAfter })
    const m = url.pathname.match(/^\/api\/key\/([^/]+)\/namespaces\/([^/]+)\/pods\/([^/]+)\/logs$/)
    if (!m) return sendJson(res, 404, { message: '未知的 API-key 工具路由(骨架仅支持 .../pods/<pod>/logs)' })
    const clusterId = decodeURIComponent(m[1]), namespace = decodeURIComponent(m[2]), pod = decodeURIComponent(m[3])
    if (clusterId !== keyRow.clusterId) return sendJson(res, 403, { error: 'PERMISSION_DENIED', reason: 'policy', message: 'API key 未绑定此集群' })
    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(clusterId)
    if (!cluster) return sendJson(res, 404, { message: '集群不存在' })
    try {
      const out = await apiKeyTools.getPodLogs(keyRow, cluster, {
        namespace, pod,
        container: url.searchParams.get('container'),
        tail: url.searchParams.get('tail'),
      }, 'direct')
      return sendJson(res, 200, out)
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') return sendJson(res, 403, { error: e.code, reason: e.reason, message: e.message })
      return sendJson(res, e.status || 502, { message: e.message || '拉取日志失败' })
    }
  }

  // === API-key 工具派发(T9:POST {tool,args} → callTool;T12 MCP server 复用此入口)===
  const callMatch = req.method === 'POST' && url.pathname.match(/^\/api\/key\/([^/]+)\/call$/)
  if (callMatch) {
    const keyRow = resolveApiKey(db, req)
    if (!keyRow) return sendJson(res, 401, { error: 'PERMISSION_DENIED', reason: 'revoked', message: '无效或已吊销的 API key' })
    const _rl = checkRate(keyRow.id)
    if (!_rl.allowed) return sendJson(res, 429, { error: 'RATE_LIMITED', retryAfter: _rl.retryAfter })
    const clusterId = decodeURIComponent(callMatch[1])
    if (clusterId !== keyRow.clusterId) return sendJson(res, 403, { error: 'PERMISSION_DENIED', reason: 'policy', message: 'API key 未绑定此集群' })
    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(clusterId)
    if (!cluster) return sendJson(res, 404, { message: '集群不存在' })
    try {
      const input = await readBody(req)
      const out = await apiKeyTools.callTool(keyRow, cluster, input.tool, input.args || {}, 'direct')
      return sendJson(res, 200, out)
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') return sendJson(res, 403, { error: e.code, reason: e.reason, message: e.message })
      return sendJson(res, e.status || 502, { message: e.message || '工具调用失败' })
    }
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
      const sessionId = randomUUID()
      const session = { ...buildCallContext({ apiServer, authHeader, ca, cert, key, insecure }), createdAt: Date.now() }
      const probe = await requestKubernetes(session, '/version')
      session.version = probe.body?.gitVersion || 'unknown'
      session.endpoints = await discoverEndpoints(session)
      session.endpointIdx = 0
      session.insecureDispatcher = getDispatcher({ ca, cert, key, insecure: true })
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
      const { resources, applied, failed, total } = await applyYaml(session, String(input.yaml || ''))
      // 全失败 → 422:保留单资源「失败即抛错」语义(remoteCreate/remoteUpdate/CRD 等走 catch 回滚)
      if (!applied.length) {
        return sendJson(res, 422, { message: failed[0]?.error || '应用 YAML 失败', details: { failed, total } })
      }
      // 部分或全成功 → 200 + 每资源明细(resources 向后兼容单资源调用方;applied/failed 供前端识别部分成功)
      return sendJson(res, 200, { resources, applied, failed, total })
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
        const r = await pvcBrowseExec(session, input.namespace, input.pvc, podName, ['ls', '-1Ap', fullPath])
        const errText = r.stderr.trim()
        if (errText && !r.stdout.length) throw Object.assign(new Error(errText), { status: 404 })
        const entries = r.stdout.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
          const isDir = line.endsWith('/')
          return { name: isDir ? line.slice(0, -1) : line, type: isDir ? 'dir' : 'file' }
        })
        return sendJson(res, 200, { path: '/' + sub, entries })
      }
      if (action === 'read') {
        const r = await pvcBrowseExec(session, input.namespace, input.pvc, podName, ['head', '-c', String(PODFILE_PREVIEW_LIMIT + 1), fullPath])
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
      // upload:二进制流式(元信息走查询串,请求体 pipe → exec stdin,不经 base64/不整包缓冲)。
      // 必须在 readBody 之前——readBody 会把整个请求体缓冲进内存。
      if (action === 'upload') {
        const q = url.searchParams
        const namespace = q.get('namespace'), pod = q.get('pod')
        const container = q.get('container') || '', path = q.get('path') || ''
        if (!namespace || !pod || !path) return sendJson(res, 400, { message: '缺少 namespace / pod / path' })
        const contentLength = parseInt(req.headers['content-length'] || '', 10)
        const { KubeConfig, Exec } = await k8sClient()
        const exec = new Exec(buildKubeConfig(KubeConfig, session))
        try {
          const r = await streamUpload({
            contentLength, limitBytes: getPodfileLimitBytes(), req,
            openConn: (input, stderrSink) => {
              const stdin = new PassThrough()   // 过早 EOF 会让 kubelet 提前关 exec(见 execCapture 注释),pipe 保持到 req end
              input.pipe(stdin)
              return exec.exec(namespace, pod, container, ['sh', '-c', 'cat > "$1"', 'podfile-upload', path], null, stderrSink, stdin, false)
            },
          })
          return sendJson(res, 200, { ...r, path })
        } catch (error) {
          console.error('[podfile/upload]', error?.status || '', error?.message || error)
          if (error.canceled) return sendJson(res, 499, { message: '客户端中断上传' })
          return sendJson(res, error.status || 502, { message: error?.message || '上传失败' })
        }
      }
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
        // 流式:先 stat 大小(404/413 在头部发出前判定),再 exec base64 输出逐行解码转发(见 podfile-stream)
        const stat = await execCapture(session, namespace, pod, container, ['sh', '-c', 'wc -c < "$1"', 'wc', path], true)
        const statBytes = parseInt(stat.stdout.toString('utf8').trim(), 10)
        const base = ((path.split('/').pop() || 'download').replace(/[^\w.-]/g, '_')) || 'download'
        try {
          // CORS 头沿用原 download 分支(setHeader 与 streamDownload 内的 writeHead 合并下发)
          res.setHeader('access-control-allow-origin', process.env.CORS_ORIGIN || '*')
          res.setHeader('access-control-expose-headers', 'content-disposition')
          await streamDownload({
            statBytes, limitBytes: getPodfileLimitBytes(), res, filename: base,
            openConn: async (stdoutSink, stderrSink) => {   // async:streamDownload 内 await openConn,兼容 k8sClient() 异步加载
              const { KubeConfig, Exec } = await k8sClient()
              const exec = new Exec(buildKubeConfig(KubeConfig, session))
              return exec.exec(namespace, pod, container, ['sh', '-c', 'base64 "$1"', 'base64', path], stdoutSink, stderrSink, new PassThrough(), true)
            },
          })
        } catch (error) {
          console.error('[podfile/download]', error?.status || '', error?.message || error)
          if (!res.headersSent) return sendJson(res, error.status || 502, { message: error?.message || '下载失败' })
        }
        return
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
        const id = input.id || `term-${randomUUID().slice(0, 8)}`   // 用前端 id(=WS sid),刷新后重连同会话
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
        // 取行（含 ns/pod/container）以便 best-effort 杀掉 pod 内的 tmux 会话
        const row = db.prepare('SELECT namespace, podName, container FROM terminals WHERE id = ? AND sessionToken = ?').get(id, token)
        db.prepare('DELETE FROM terminals WHERE id = ? AND sessionToken = ?').run(id, token)
        idleTracker.delete(tmuxSessionName(token, id))
        if (row) {
          try {
            const { bin } = await resolveTmux(session, row.namespace, row.podName, row.container || '')
            await execCapture(session, row.namespace, row.podName, row.container || '',
              tmuxKillCommand(tmuxLabel(token), tmuxSessionName(token, id), bin))
          } catch { /* pod 已不在 / 无 tmux —— 忽略 */ }
        }
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 405, { message: 'Method not allowed' })
    } catch (error) { return sendJson(res, 500, { message: error?.message || '终端会话操作失败' }) }
  }
  // === 文件浏览窗口管理(任务栏:CRUD + 持久化,与 terminals 同构;无 WS 会话,DELETE 仅删行) ===
  if (url.pathname === '/api/file-browsers') {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    try {
      if (req.method === 'GET') {
        const rows = db.prepare('SELECT * FROM file_browsers WHERE sessionToken = ? ORDER BY createdAt').all(token)
        return sendJson(res, 200, { browsers: rows.map(r => ({ ...r, status: 'minimized' })) })  // 刷新后全部最小化
      }
      if (req.method === 'POST') {
        const input = await readBody(req)
        const b = {
          id: input.id || `fb-${randomUUID().slice(0, 8)}`, sessionToken: token,
          name: input.name || `${input.podName}/${input.container || 'main'}`,
          namespace: input.namespace, podName: input.podName, container: input.container || '',
          status: 'open', createdAt: Date.now(),
        }
        db.prepare('INSERT INTO file_browsers (id, sessionToken, name, namespace, podName, container, status, createdAt) VALUES (?,?,?,?,?,?,?,?)')
          .run(b.id, b.sessionToken, b.name, b.namespace, b.podName, b.container, b.status, b.createdAt)
        return sendJson(res, 200, b)
      }
      return sendJson(res, 405, { message: 'Method not allowed' })
    } catch (error) { return sendJson(res, 500, { message: error?.message || '文件窗口操作失败' }) }
  }
  if (url.pathname.startsWith('/api/file-browsers/')) {
    const session = sessionFromRequest(req)
    if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
    const id = decodeURIComponent(url.pathname.slice('/api/file-browsers/'.length))
    try {
      if (req.method === 'PATCH') {
        const input = await readBody(req)
        const fields = [], vals = []
        for (const k of ['name', 'status']) { if (input[k] != null) { fields.push(`${k} = ?`); vals.push(input[k]) } }
        if (!fields.length) return sendJson(res, 400, { message: '无更新字段' })
        vals.push(id, token)
        db.prepare(`UPDATE file_browsers SET ${fields.join(', ')} WHERE id = ? AND sessionToken = ?`).run(...vals)
        return sendJson(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        db.prepare('DELETE FROM file_browsers WHERE id = ? AND sessionToken = ?').run(id, token)
        return sendJson(res, 200, { ok: true })
      }
      return sendJson(res, 405, { message: 'Method not allowed' })
    } catch (error) { return sendJson(res, 500, { message: error?.message || '文件窗口操作失败' }) }
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

  // 非 /api/* 的 GET/HEAD:尝试服务 dist/ 静态前端(SPA)。serveStatic 内部已 guard /api 前缀(返 false)。
  // 必须在 isK8s/isPlatform 分发门之前 —— 否则非 API 路径直接被下方 isK8s/isPlatform 门 404 吞掉,SPA 永远到不了。
  if (serveStatic(req, res, url, { root: STATIC_DIR })) return

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
      const target = new URL(kubernetesPath, currentEndpoint(session))
      const upstream = await kubeFetch(target, {
        method: 'GET',
        headers: { accept: 'application/json', ...(session.authHeader ? { authorization: session.authHeader } : {}) },
        dispatcher: currentDispatcher(session),
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

  // 兜底:未匹配的路由返 404。否则 handle() 直接 return、响应永不结束 → 前端 fetch 挂起
  // (如旧 gateway 缺新端点时,LLM 配置页一直转圈)。所有路由块都显式 return,此处只在无匹配时触发。
  return sendJson(res, 404, { message: `not found: ${req.method} ${url.pathname}` })
}

const httpServer = createServer((req, res) => {
  // 兜底 catch 自身也 try/catch:sendJson 若因 headersSent 等再抛,会变 unhandledRejection
  // 直接杀死进程(曾致网关整体宕机)。错误打日志,进程必须活着。
  handle(req, res).catch(error => {
    console.error('[http] handle 未捕获:', error?.stack || error?.message || error)
    try { sendJson(res, 500, { message: error.message || '服务器错误' }) } catch { /* res 已不可写 */ }
  })
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

// 定时蒸馏 scheduler(D4):DISTILL_INTERVAL_MS 触发,对"近期有活动"的集群跑蒸馏 → 存待审 pending(不自动 commit)。
// 默认 1 小时(3600000ms);设 0 关闭。蒸馏是 agent 自学习的核心——定期从操作审计+对话蒸馏知识进 learnings.md。
const distillInterval = Number(process.env.DISTILL_INTERVAL_MS ?? 3600000)
if (distillInterval > 0) {
  const tickDistill = async () => {
    try {
      const cfg = getLlmConfig()
      if (!cfg.baseURL || !cfg.model) return // 未配 LLM,跳过本次
      const llmClient = createLlmClient({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })
      const since = Date.now() - 7 * 86400000 // 近 7 天有 audit 或有项目的集群
      const rows = db.prepare(`SELECT DISTINCT clusterId FROM (
        SELECT clusterId FROM audit_log WHERE clusterId IS NOT NULL AND ts > ?
        UNION SELECT clusterId FROM workbench_projects WHERE clusterId IS NOT NULL
      )`).all(since)
      for (const { clusterId } of rows) {
        try {
          const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(clusterId)
          if (!cluster) continue
          // 水位跳过:先取原料(纯查询,不烧 LLM),与上次蒸馏水位一致 → 无新证据,跳过。
          // pending 被审掉(apply/dismiss)后 last_distills 仍在,不会重产同样待审。
          const material = await gatherDistillMaterial(db, clusterId, join(WORKBENCH_DIR, clusterId, 'cluster-context'))
          const last = getLastDistill(db, clusterId)
          if (last && !isNewMaterial(material.watermark, last.stats)) continue
          const out = await runDistill({ llmClient, db, clusterId, clusterName: cluster.name, material })
          setPendingDistill(db, clusterId, { proposed: out.proposed, current: out.material.currentLearnings, summary: out.summary, stats: out.stats })
          setLastDistill(db, clusterId, out.stats)
          console.log(`[distill] ${cluster.name}: ${out.summary} → 待审`)
        } catch (e) { console.error(`[distill] cluster ${clusterId} 失败:`, e.message) }
      }
    } catch (e) { console.error('[distill] scheduler tick 失败:', e.message) }
  }
  setInterval(tickDistill, distillInterval).unref()
  console.log(`[distill] 定时蒸馏已启用:每 ${Math.round(distillInterval / 1000)}s 一轮(活跃集群,产待审 pending)`)
}

// 定时 reconcile scheduler(第 4 阶段 R3):RECONCILE_INTERVAL_MS 触发,对所有有集群的项目幂等再 apply → 存 last_reconcile。
const reconcileInterval = Number(process.env.RECONCILE_INTERVAL_MS || 0)
if (reconcileInterval > 0) {
  const tickReconcile = async () => {
    try {
      for (const p of listProjects(db, { userId: '', role: 'admin' })) {
        try {
          const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(p.clusterId)
          if (!cluster) continue
          const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
          const r = await reconcileProject({ db, projectId: p.id, readManifests: () => wbReadManifests(join(WORKBENCH_DIR, p.clusterId, 'projects', p.id)), applyYaml: (yaml) => applyYamlPartial(k8sSession, yaml) })
          if (r.failed?.length) console.error(`[reconcile] ${p.name}: ${r.failed.length} 失败`)
        } catch (e) { console.error(`[reconcile] project ${p.id} 失败:`, e.message) }
      }
    } catch (e) { console.error('[reconcile] scheduler tick 失败:', e.message) }
  }
  setInterval(tickReconcile, reconcileInterval).unref()
  console.log(`[reconcile] 定时 reconcile 已启用:每 ${Math.round(reconcileInterval / 1000)}s 一轮(所有项目)`)
}
