// 平台认证 + 集群接入 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// health / login / me / logout / my-clusters / connect-cluster 逐字搬迁,仅依赖引用改走 deps 注入。
// 用户可见消息走 ../messages.mjs 双语表(msg(req,'auth.xxx'));zh 默认与原文逐字一致。
import { msg } from '../messages.mjs'
import { APP_VERSION } from '../version.mjs'

export function createAuthRoutes(deps) {
  const {
    db, sendJson, readBody, requirePlatform,
    platformSessions, sessions, persistSession,
    verifyPassword, randomUUID, normalizeServer, buildCallContext, requestKubernetes,
    checkLoginRate, writeAudit,
    hashPassword, extractPlatformToken,
  } = deps

  // 匹配 auth 路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {
    // GET /api/health — 无鉴权健康检查(负载均衡/存活探针)
    if (req.method === 'GET' && url.pathname === '/api/health') {
      sendJson(res, 200, { ok: true, service: 'aliangboard-api', time: new Date().toISOString(), version: APP_VERSION })
      return true
    }

    // POST /api/auth/login — 平台登录(用户名/密码 → 平台 session)
    // 安全(2026-08-28 CSO 审计 #3):按 IP+用户名限流(防无限速暴力破解,checkRate 此前只挂 /api/key/*);
    // 失败/成功均写审计(tool=platform_login)——用户名不存在同样消耗预算,防枚举式并行爆破。
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      try {
        const { username, password } = await readBody(req)
        if (!username || !password) { sendJson(res, 400, { message: msg(req, 'auth.emptyCredentials') }); return true }
        const ip = req.socket?.remoteAddress || 'unknown'
        const rl = checkLoginRate(`${ip}|${username}`)
        if (!rl.allowed) {
          writeAudit?.(db, { owner: String(username), verb: 'login', tool: 'platform_login', result: 'ratelimited', reason: 'too-many-attempts', requestSummary: `ip=${ip}`, source: 'platform' })
          sendJson(res, 429, { message: msg(req, 'auth.rateLimited'), retryAfter: rl.retryAfter })
          return true
        }
        const auditLogin = (result, reason = null) => writeAudit?.(db, { owner: String(username), verb: 'login', tool: 'platform_login', result, reason, requestSummary: `ip=${ip}`, source: 'platform' })
        const user = db.prepare('SELECT * FROM platform_users WHERE username=?').get(username)
        if (!user || user.disabled || !verifyPassword(password, user.passwordHash)) {
          auditLogin('denied', 'bad-credentials')
          sendJson(res, 401, { message: msg(req, 'auth.badCredentials') }); return true
        }
        const token = randomUUID()
        const psNow = Date.now()
        const ps = { token, userId: user.id, username: user.username, role: user.role, createdAt: psNow, k8sSessionToken: null, ip, userAgent: String(req.headers['user-agent'] || ''), lastSeenAt: psNow }
        platformSessions.set(token, ps)
        db.prepare('INSERT INTO platform_sessions (token,userId,username,role,createdAt,ip,userAgent,lastSeenAt) VALUES (?,?,?,?,?,?,?,?)')
          .run(token, user.id, user.username, user.role, psNow, ip, String(req.headers['user-agent'] || ''), psNow)
        auditLogin('ok')
        sendJson(res, 200, { token, user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName } })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.loginFailed') }); return true }
    }

    // GET /api/auth/me — 当前登录用户信息
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const user = db.prepare('SELECT id,username,role,displayName FROM platform_users WHERE id=?').get(ps.userId)
      sendJson(res, 200, { user })
      return true
    }

    // POST /api/auth/logout — 登出(删平台 session)
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = req.headers['x-platform-token']
      if (token) { platformSessions.delete(token); try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(token) } catch { /* noop */ } }
      sendJson(res, 200, { ok: true })
      return true
    }

    // GET /api/my-clusters — 当前用户可接入的集群列表(Layer 2 集群选择)
    if (url.pathname === '/api/my-clusters' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      let rows
      if (ps.role === 'admin') {
        rows = db.prepare('SELECT id,name,apiServer,version,authMethod,createdAt FROM clusters ORDER BY name').all()
      } else {
        rows = db.prepare(`SELECT c.id,c.name,c.apiServer,c.version,c.authMethod,c.createdAt FROM clusters c
          JOIN user_clusters uc ON uc.clusterId=c.id WHERE uc.userId=? ORDER BY c.name`).all(ps.userId)
      }
      sendJson(res, 200, { clusters: rows })
      return true
    }

    // POST /api/connect-cluster — 平台用户接入指定集群(经 buildCallContext 构造 K8s session → 探测 → 持久化)
    if (url.pathname === '/api/connect-cluster' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const { clusterId } = await readBody(req)
        const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(clusterId)
        if (!cluster) { sendJson(res, 404, { message: msg(req, 'auth.clusterNotFound') }); return true }
        if (ps.role !== 'admin') {
          const assigned = db.prepare('SELECT 1 FROM user_clusters WHERE userId=? AND clusterId=?').get(ps.userId, clusterId)
          if (!assigned) { sendJson(res, 403, { message: msg(req, 'auth.clusterForbidden') }); return true }
        }
        // 从 clusters 行构造 K8s session（字段与 sessions 表完全一致;经 buildCallContext 统一形状）
        const apiServer = normalizeServer(cluster.apiServer)
        const k8sSession = { ...buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure }), createdAt: Date.now() }
        const probe = await requestKubernetes(k8sSession, '/version')
        k8sSession.version = probe.body?.gitVersion || 'unknown'
        const k8sToken = randomUUID()
        sessions.set(k8sToken, k8sSession)
        persistSession(k8sToken, k8sSession)
        // 更新平台会话的 k8sSessionToken
        ps.k8sSessionToken = k8sToken
        platformSessions.set(req.headers['x-platform-token'], ps)
        db.prepare('UPDATE platform_sessions SET k8sSessionToken=? WHERE token=?').run(k8sToken, req.headers['x-platform-token'])
        sendJson(res, 200, { token: k8sToken, cluster: { apiServer: apiServer.toString().replace(/\/$/, ''), version: k8sSession.version } })
        return true
      } catch (e) { sendJson(res, e.status || 502, { message: e?.message || msg(req, 'auth.connectFailed') }); return true }
    }

    return false // 无匹配
  }

  return { handle }
}
