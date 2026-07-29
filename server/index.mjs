import { createServer } from 'node:http'
import { Readable, Writable, PassThrough } from 'node:stream'
import net from 'node:net'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { URL } from 'node:url'
import { loadAll as yamlLoadAll } from 'js-yaml'

const port = Number(process.env.PORT || 8787)
const host = process.env.HOST || '127.0.0.1'
const sessions = new Map()
const discoveryCache = new Map()
const sessionTtl = Number(process.env.SESSION_TTL_MS || 8 * 60 * 60 * 1000)
const allowedHosts = new Set((process.env.K8S_ALLOWED_HOSTS || '').split(',').map(value => value.trim()).filter(Boolean))

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

function sessionFromRequest(req) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '')
  const session = token ? sessions.get(token) : null
  if (session && Date.now() - session.createdAt > sessionTtl) {
    sessions.delete(token)
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

async function requestKubernetes(session, path, init = {}) {
  const target = new URL(path, session.apiServer)
  const headers = { accept: 'application/json', ...(init.headers || {}) }
  if (session.authHeader) headers.authorization = session.authHeader
  if (init.body && !headers['content-type']) headers['content-type'] = 'application/json'

  const response = await fetch(target, {
    ...init,
    headers,
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
  const cluster = {
    name: 'aliangboard',
    server: session.apiServer.toString(),
    skipTLSVerify: process.env.K8S_INSECURE_SKIP_TLS_VERIFY === 'true',
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
  const command = (url.searchParams.get('command') || '/bin/sh').trim().split(/\s+/)
  const tty = url.searchParams.get('tty') !== 'false'

  const { KubeConfig, Exec } = await k8sClient()
  const kc = buildKubeConfig(KubeConfig, session)
  const exec = new Exec(kc)

  const stdout = new WsSink(CH_STDOUT, ws)
  const stderr = new WsSink(CH_STDERR, ws)
  const stdin = new PassThrough()
  let conn = null

  try {
    conn = await exec.exec(namespace, pod, container, command, stdout, stderr, stdin, tty, status => {
      wsSend(ws, CH_EXIT, JSON.stringify({ status: status?.status || 'Success', code: status?.code ?? null }))
    })
  } catch (error) {
    wsSend(ws, CH_ERROR, error?.message || 'exec 会话建立失败（可能镜像内无 shell，或容器未就绪）')
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
  const stdin = new PassThrough(); stdin.end()
  let status = null
  const conn = await exec.exec(namespace, pod, container, command, stdoutSink, stderrSink, stdin, false, s => { status = s })
  await new Promise(resolve => conn.on('close', resolve))
  return { stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString('utf8'), status }
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
  return (await requestKubernetes(session, subPath, { method: 'PUT', body: JSON.stringify(body) })).body
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
      const apiServer = normalizeServer(input.apiServer)
      const authHeader = input.authMethod === 'basic'
        ? `Basic ${Buffer.from(`${input.username || ''}:${input.password || ''}`).toString('base64')}`
        : `Bearer ${String(input.token || '')}`
      if (input.authMethod === 'basic' && (!input.username || !input.password)) {
        return sendJson(res, 400, { message: '用户名和密码不能为空' })
      }
      if (input.authMethod !== 'basic' && !input.token) return sendJson(res, 400, { message: 'Bearer Token 不能为空' })
      const sessionId = randomUUID()
      const session = { apiServer, authHeader, createdAt: Date.now() }
      const probe = await requestKubernetes(session, '/version')
      session.version = probe.body?.gitVersion || 'unknown'
      sessions.set(sessionId, session)
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
        const result = await execCapture(session, namespace, pod, container, ['ls', '-1Ap', path])
        const errText = result.stderr.trim()
        if (errText && !result.stdout.length) throw Object.assign(new Error(errText), { status: 404 })
        const entries = result.stdout.toString('utf8').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
          const isDir = line.endsWith('/')
          return { name: isDir ? line.slice(0, -1) : line, type: isDir ? 'dir' : 'file' }
        })
        return sendJson(res, 200, { path, entries })
      }
      if (action === 'read') {
        const result = await execCapture(session, namespace, pod, container, ['head', '-c', String(PODFILE_PREVIEW_LIMIT + 1), path])
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
        const result = await execCapture(session, namespace, pod, container, ['cat', path])
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
      return sendJson(res, error.status || 502, { message: error?.message || 'Pod 文件操作失败' })
    }
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

  if (!url.pathname.startsWith('/api/k8s/')) return sendJson(res, 404, { message: 'Not found' })
  const session = sessionFromRequest(req)
  if (!session) return sendJson(res, 401, { message: '未登录或会话已过期' })

  const kubernetesPath = decodeURIComponent(url.pathname.slice('/api/k8s'.length)) + (url.search || '')

  // 流式透传：watch=true（资源监听）与 follow=true（日志跟随）需要长连接，
  // 不能走缓冲式 requestKubernetes（它会 await 全文）。这里直接 pipe 上游字节流。
  const isStreaming = req.method === 'GET' && /(?:[?&]watch=true)|(?:[?&]follow=true)/.test(kubernetesPath)
  if (isStreaming) {
    try {
      const target = new URL(kubernetesPath, session.apiServer)
      const upstream = await fetch(target, {
        method: 'GET',
        headers: { accept: 'application/json', ...(session.authHeader ? { authorization: session.authHeader } : {}) },
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
    const result = await requestKubernetes(session, kubernetesPath, { method: req.method, body })
    return sendJson(res, result.status, result.body ?? {})
  } catch (error) {
    return sendJson(res, error.status || 502, { message: error.message || 'Kubernetes API 请求失败', details: error.details })
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

httpServer.listen(port, host, () => {
  console.log(`AliangBoard API listening on http://${host}:${port}`)
})
