// 平台认证 + 集群接入 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// health / login / me / logout / my-clusters / connect-cluster 逐字搬迁,仅依赖引用改走 deps 注入。
// 用户可见消息走 ../messages.mjs 双语表(msg(req,'auth.xxx'));zh 默认与原文逐字一致。
import { msg } from '../messages.mjs'
import { APP_VERSION } from '../version.mjs'
import { isPasswordOk } from '../password-policy.mjs'
import { unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export function createAuthRoutes(deps) {
  const {
    // 首管一次性凭证文件所在目录(默认 <repo>/data;改密成功即删,CSO #13)
    dataDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'data'),
    db, sendJson, readBody, requirePlatform,
    platformSessions, sessions, persistSession,
    verifyPassword, randomUUID, normalizeServer, buildCallContext, requestKubernetes,
    checkLoginRate, writeAudit,
    enforceSessionCap, maxPlatformSessionsPerUser,
    removeSessionRecord,
    hashPassword, extractPlatformToken,
  } = deps

  // 读用户 prefs:SELECT/parse 全程容错——存量库无 prefs 列、坏 JSON 均回 {}(node:sqlite 拒绝非法绑定,这里只读标量)。
  function readPrefs(db, userId) {
    try {
      const row = db.prepare('SELECT prefs FROM platform_users WHERE id=?').get(userId)
      return JSON.parse(row?.prefs || '{}') || {}
    } catch { return {} }
  }

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
        // 会话数量上限(2026-08-30 设计 §3.2):超出踢最久未活跃的旧会话,刚建的本会话永不踢;
        // 被踢会话的 K8s 凭据由 enforceSessionCap 一并回收。强制失败不阻断登录(降级不踢)。
        try {
          enforceSessionCap?.({ platformSessions, db, sessions, userId: user.id, owner: user.username,
            max: maxPlatformSessionsPerUser, keepToken: token, now: psNow, writeAudit })
        } catch (e) { console.error('[auth] 会话上限强制失败(降级不踢):', e?.message || e) }
        auditLogin('ok')
        sendJson(res, 200, { token, user: { id: user.id, username: user.username, role: user.role, displayName: user.displayName, createdAt: user.createdAt }, prefs: readPrefs(db, user.id) })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.loginFailed') }); return true }
    }

    // GET /api/auth/me — 当前登录用户信息
    if (url.pathname === '/api/auth/me' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const user = db.prepare('SELECT id,username,role,displayName,createdAt FROM platform_users WHERE id=?').get(ps.userId)
      sendJson(res, 200, { user, prefs: readPrefs(db, ps.userId) })
      return true
    }

    // PATCH /api/auth/me — 自助改显示名(2026-08-29 用户中心设计)
    // 白名单:仅 displayName 可改;username/role/passwordHash 等字段静默忽略(防穿越)。
    if (url.pathname === '/api/auth/me' && req.method === 'PATCH') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const input = await readBody(req)
      if (input.displayName == null) { sendJson(res, 400, { message: msg(req, 'auth.noUpdateFields') }); return true }
      const displayName = String(input.displayName).trim().slice(0, 64)
      db.prepare('UPDATE platform_users SET displayName=? WHERE id=?').run(displayName || null, ps.userId)
      const user = db.prepare('SELECT id,username,role,displayName,createdAt FROM platform_users WHERE id=?').get(ps.userId)
      sendJson(res, 200, { user })
      return true
    }

    // PUT /api/auth/preferences — 自助偏好(language/theme;全有或全无校验,防半写)
    const PREF_LANGS = ['en', 'zh']
    // 'auto'=定时自动(07:00–19:00 亮色,判定在前端 theme.js/index.html 镜像;服务端只存值不判定)。
    // 'system' 已移除(旧存量行读取时由前端归一,服务端不再接受新写入)。
    const PREF_THEMES = ['light', 'dark', 'auto']
    if (url.pathname === '/api/auth/preferences' && req.method === 'PUT') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const input = await readBody(req)
      if (input.language != null && !PREF_LANGS.includes(input.language)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      if (input.theme != null && !PREF_THEMES.includes(input.theme)) { sendJson(res, 400, { message: msg(req, 'auth.preferenceInvalid') }); return true }
      const prefs = readPrefs(db, ps.userId)
      if (input.language != null) prefs.language = input.language
      if (input.theme != null) prefs.theme = input.theme
      db.prepare('UPDATE platform_users SET prefs=? WHERE id=?').run(JSON.stringify(prefs), ps.userId)
      sendJson(res, 200, { prefs })
      return true
    }

    // POST /api/auth/change-password — 自助改密(2026-08-29 设计:验旧密 → 新密 ≥8 → 吊销其他会话)
    if (url.pathname === '/api/auth/change-password' && req.method === 'POST') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const { currentPassword, newPassword } = await readBody(req)
        const user = db.prepare('SELECT * FROM platform_users WHERE id=?').get(ps.userId)
        const auditChange = (result, reason = null, summary = null) => writeAudit?.(db, { owner: ps.username, verb: 'change', tool: 'platform_change_password', result, reason, requestSummary: summary, source: 'platform' })
        if (!user || !currentPassword || !verifyPassword(String(currentPassword), user.passwordHash)) {
          auditChange('denied', 'bad-current-password')
          sendJson(res, 401, { message: msg(req, 'auth.currentPasswordWrong') }); return true
        }
        if (!isPasswordOk(newPassword)) { sendJson(res, 400, { message: msg(req, 'auth.passwordTooShort') }); return true }
        db.prepare('UPDATE platform_users SET passwordHash=? WHERE id=?').run(hashPassword(String(newPassword)), ps.userId)
        const currentToken = extractPlatformToken(req)
        let revoked = 0
        for (const [tok, s] of Array.from(platformSessions)) {
          if (s.userId === ps.userId && tok !== currentToken) {
            platformSessions.delete(tok)
            try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(tok) } catch { /* noop */ }
            // 吊销同时回收该会话接入的 K8s 凭据(2026-08-29 终审发现 4:否则被踢设备集群凭据存活至 TTL)
            const k8sTok = s.k8sSessionToken
            if (k8sTok) {
              sessions.delete(k8sTok)
              try { db.prepare('DELETE FROM sessions WHERE token=?').run(k8sTok) } catch { /* noop */ }
            }
            revoked++
          }
        }
        auditChange('ok', null, `revoked=${revoked}`)
        // CSO #13:改密成功即删首管一次性凭证文件(best-effort;不存在/无权限静默忽略)
        try { unlinkSync(join(dataDir, 'first-admin-credentials.txt')) } catch { /* noop */ }
        sendJson(res, 200, { ok: true, revoked })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'auth.changePasswordFailed') }); return true }
    }

    // GET /api/auth/sessions — 当前用户活跃会话(权威源=内存 Map;token 仅回 8 位指纹)
    if (url.pathname === '/api/auth/sessions' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const currentToken = extractPlatformToken(req)
      const list = []
      for (const [tok, s] of platformSessions) {
        if (s.userId !== ps.userId) continue
        list.push({ fingerprint: tok.slice(0, 8), ip: s.ip || null, userAgent: s.userAgent || null, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt || s.createdAt, current: tok === currentToken })
      }
      list.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
      sendJson(res, 200, { sessions: list })
      return true
    }

    // DELETE /api/auth/sessions/others — 原子吊销除当前外全部(先于 :fingerprint 匹配)
    if (url.pathname === '/api/auth/sessions/others' && req.method === 'DELETE') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const currentToken = extractPlatformToken(req)
      let revoked = 0
      for (const [tok, s] of Array.from(platformSessions)) {
        if (s.userId !== ps.userId || tok === currentToken) continue
        platformSessions.delete(tok)
        try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(tok) } catch { /* noop */ }
        // 同步回收被吊会话的 K8s 凭据(当前会话的保留)
        const k8sTok = s.k8sSessionToken
        if (k8sTok) {
          sessions.delete(k8sTok)
          try { db.prepare('DELETE FROM sessions WHERE token=?').run(k8sTok) } catch { /* noop */ }
        }
        revoked++
      }
      writeAudit?.(db, { owner: ps.username, verb: 'revoke', tool: 'platform_session_revoke', result: 'ok', requestSummary: `revoked=${revoked}`, source: 'platform' })
      sendJson(res, 200, { ok: true, revoked })
      return true
    }

    // DELETE /api/auth/sessions/:fingerprint — 按 token 前缀指纹吊销指定会话;当前会话拒吊(防自锁)。
    // 'others' 精确分支在上面已先行返回,此处 [^/]+ 不会误吞;归属过滤(userId)保证只能吊自己的。
    const fpMatch = url.pathname.match(/^\/api\/auth\/sessions\/([^/]+)$/)
    if (fpMatch && req.method === 'DELETE') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const currentToken = extractPlatformToken(req)
      const fp = fpMatch[1]
      if (currentToken && currentToken.slice(0, 8) === fp) { sendJson(res, 400, { message: msg(req, 'auth.sessionCurrentNoRevoke') }); return true }
      let hit = null
      for (const [tok, s] of platformSessions) {
        if (s.userId === ps.userId && tok.slice(0, 8) === fp) { hit = tok; break }
      }
      if (!hit) { sendJson(res, 404, { message: msg(req, 'auth.sessionNotFound') }); return true }
      const revokedPs = platformSessions.get(hit)
      platformSessions.delete(hit)
      try { db.prepare('DELETE FROM platform_sessions WHERE token=?').run(hit) } catch { /* noop */ }
      // 同步回收被吊会话的 K8s 凭据(当前会话已在上文 400 拒吊,不会走到这里)
      const k8sTok = revokedPs?.k8sSessionToken
      if (k8sTok) {
        sessions.delete(k8sTok)
        try { db.prepare('DELETE FROM sessions WHERE token=?').run(k8sTok) } catch { /* noop */ }
      }
      writeAudit?.(db, { owner: ps.username, verb: 'revoke', tool: 'platform_session_revoke', result: 'ok', requestSummary: `fp=${fp}`, source: 'platform' })
      sendJson(res, 200, { ok: true })
      return true
    }

    // POST /api/auth/logout — 登出(三处同清:内存+platform_sessions+K8s 凭据,与 reaper/cap 共用 removeSessionRecord)
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      const token = req.headers['x-platform-token']
      // CSO #11:logout 同时回收该平台会话派生的 K8s 凭据(removeSessionRecord 内含,与 reaper/cap 共用)
      if (token) removeSessionRecord(platformSessions, db, sessions, token)
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
        // CSO #11:重连先吊销旧 k8s token(旧行为只覆盖单标量,旧行留存成孤儿活 8h、重启还复活)
        const oldTok = ps.k8sSessionToken
        if (oldTok) { sessions.delete(oldTok); try { db.prepare('DELETE FROM sessions WHERE token=?').run(oldTok) } catch { /* noop */ } }
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
