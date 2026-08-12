// 管理 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// LLM/MCP 配置、集群 CRUD、API keys、审计日志、用户管理 逐字搬迁,仅依赖引用改走 deps 注入。
import { listKeys, mintKey, revokeKey } from '../auth-keys.mjs'
import { normalizeToolOverrides, normalizeAllowedNamespaces } from '../authorize.mjs'
import { activeKeys, queryAuditLog, verifyChain } from '../audit.mjs'

export function createAdminRoutes(deps) {
  const {
    db, sendJson, readBody, requireAdmin,
    getSetting, setSetting, getLlmConfig, createLlmClient,
    clusterProber, randomUUID,
    parseKubeconfig, certMaterial, normalizeServer, buildCallContext, requestKubernetes,
    hashPassword,
  } = deps

  // 匹配 admin 路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {
    // ====== LLM 配置(baseURL/apiKey/model 存 DB;env 回退;GET 不回传 key)======
    if (url.pathname === '/api/admin/llm-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const dbBase = getSetting('llm.baseURL'), dbKey = getSetting('llm.apiKey'), dbModel = getSetting('llm.model')
      const src = (db, env) => db ? 'db' : (env ? 'env' : 'none')
      sendJson(res, 200, {
        baseURL: dbBase || process.env.LLM_BASE_URL || '',
        model: dbModel || process.env.LLM_MODEL || '',
        baseURLSource: src(dbBase, process.env.LLM_BASE_URL),
        modelSource: src(dbModel, process.env.LLM_MODEL),
        hasApiKey: !!(dbKey || process.env.LLM_API_KEY),
        apiKeySource: src(dbKey, process.env.LLM_API_KEY),
      })
      return true
    }
    if (url.pathname === '/api/admin/llm-config' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        setSetting('llm.baseURL', input.baseURL || '')
        setSetting('llm.model', input.model || '')
        if (typeof input.apiKey === 'string' && input.apiKey) setSetting('llm.apiKey', input.apiKey) // 留空 = 不修改
        sendJson(res, 200, { ok: true })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || '保存失败' }); return true }
    }
    if (url.pathname === '/api/admin/llm-config/test' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req).catch(() => ({})) || {}
        const saved = getLlmConfig()
        // 表单值优先(支持"填完即测,不必先保存");空字段(apiKey 留空=不改)回退已保存
        const cfg = { baseURL: input.baseURL || saved.baseURL, model: input.model || saved.model, apiKey: input.apiKey || saved.apiKey }
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 200, { ok: false, message: '先填 baseURL + model(保存、或在上方填入后测试)' }); return true }
        const client = createLlmClient({ ...cfg, timeoutMs: 20000 })
        const msg = await client.chat({ messages: [{ role: 'user', content: 'ping(仅测连通性,请回 pong)' }] })
        sendJson(res, 200, { ok: true, reply: (msg.content || '').slice(0, 200) })
        return true
      } catch (e) { sendJson(res, 200, { ok: false, message: e?.message || '连接失败' }); return true }
    }
    if (url.pathname === '/api/admin/mcp-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, { enabled: getSetting('mcp_enabled') !== 'false' })
      return true
    }
    if (url.pathname === '/api/admin/mcp-config' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        setSetting('mcp_enabled', input.enabled === false ? 'false' : 'true')
        sendJson(res, 200, { ok: true, enabled: input.enabled !== false })
        return true
      } catch (e) { sendJson(res, 400, { message: e.message }); return true }
    }

    // ====== 集群管理 ======
    if (url.pathname === '/api/admin/clusters' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      // 取凭据列(authHeader/ca/cert/key/insecure)仅用于探测,绝不回传前端(见下方白名单 map)。
      const rows = db.prepare('SELECT id,name,apiServer,authMethod,version,insecure,createdBy,createdAt,authHeader,ca,cert,key FROM clusters ORDER BY createdAt DESC').all()
      const force = url.searchParams.get('refresh') === '1'
      const probed = await clusterProber.probeAll(
        rows,
        r => buildCallContext({ apiServer: r.apiServer, authHeader: r.authHeader, ca: r.ca, cert: r.cert, key: r.key, insecure: !!r.insecure }),
        { force },
      )
      // 白名单回传:前端需要的字段 + 实时探测的 status/nodeCount/podCount(凭据不入列)。
      const clusters = probed.map(c => ({ id: c.id, name: c.name, apiServer: c.apiServer, authMethod: c.authMethod, version: c.version, insecure: c.insecure, createdBy: c.createdBy, createdAt: c.createdAt, status: c.status, nodeCount: c.nodeCount, podCount: c.podCount }))
      sendJson(res, 200, { clusters })
      return true
    }
    if (url.pathname === '/api/admin/clusters' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        if (!input.name) { sendJson(res, 400, { message: '集群名称不能为空' }); return true }
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
        } else { sendJson(res, 400, { message: '缺少凭据（token / 账密 / kubeconfig / 客户端证书）' }); return true }
        const insecure = input.insecure === true
        // 探测版本（经 buildCallContext 构造调用上下文）
        const probe = await requestKubernetes(buildCallContext({ apiServer, authHeader, ca, cert, key, insecure }), '/version')
        const version = probe.body?.gitVersion || 'unknown'
        const id = randomUUID()
        db.prepare('INSERT INTO clusters (id,name,apiServer,authMethod,authHeader,ca,cert,key,insecure,version,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, input.name, apiServer.toString(), input.kubeconfig ? 'kubeconfig' : input.token ? 'token' : 'basic', authHeader, ca || null, cert || null, key || null, insecure ? 1 : 0, version, ps.username, Date.now())
        sendJson(res, 200, { cluster: { id, name: input.name, apiServer: apiServer.toString().replace(/\/$/, ''), version } })
        return true
      } catch (e) { sendJson(res, e.status || 502, { message: e?.message || '添加集群失败（凭据无效或无法连接）' }); return true }
    }
    if (url.pathname.startsWith('/api/admin/clusters/') && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/clusters/'.length))
      db.prepare('DELETE FROM clusters WHERE id=?').run(id)
      db.prepare('DELETE FROM user_clusters WHERE clusterId=?').run(id)
      clusterProber.invalidate(id)
      sendJson(res, 200, { ok: true })
      return true
    }

    // ====== API Keys 管理(T13:签发/列表/吊销,逻辑见 ./auth-keys.mjs)======
    if (url.pathname === '/api/admin/apikeys' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, { apikeys: listKeys(db) })
      return true
    }
    if (url.pathname === '/api/admin/apikeys' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const k = mintKey(db, {
          owner: input.owner || ps.username,
          clusterId: input.clusterId,
          boundSA_namespace: input.boundSA_namespace,
          boundSA_name: input.boundSA_name,
          tier: input.tier || 'read',
          tool_overrides: input.tool_overrides ?? null,
          allowed_namespaces: input.allowed_namespaces ?? null,
          label: input.label || null,
          createdBy: ps.username,
        })
        // k.plaintext 仅此次返回(明文不入库);前端须提示复制保存
        sendJson(res, 200, { apikey: k })
        return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || '签发 API key 失败' }); return true }
    }
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/overrides$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = decodeURIComponent(url.pathname.split('/')[4])
        const input = await readBody(req)
        const json = normalizeToolOverrides(input.tool_overrides)  // strict: 坏→抛
        const changes = db.prepare('UPDATE api_keys SET tool_overrides = ? WHERE id = ? AND revokedAt IS NULL').run(json, id).changes
        if (!changes) { sendJson(res, 404, { message: 'API key 不存在或已吊销' }); return true }
        sendJson(res, 200, { ok: true, id, tool_overrides: json })
        return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || '更新覆盖失败' }); return true }
    }
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/namespaces$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = decodeURIComponent(url.pathname.split('/')[4])
        const input = await readBody(req)
        const key = db.prepare('SELECT boundSA_namespace FROM api_keys WHERE id = ? AND revokedAt IS NULL').get(id)
        if (!key) { sendJson(res, 404, { message: 'API key 不存在或已吊销' }); return true }
        const json = normalizeAllowedNamespaces(input.allowed_namespaces, key.boundSA_namespace)  // strict: 坏→抛
        db.prepare('UPDATE api_keys SET allowed_namespaces = ? WHERE id = ?').run(json, id)
        sendJson(res, 200, { ok: true, id, allowed_namespaces: json })
        return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || '更新 ns allowlist 失败' }); return true }
    }
    if (url.pathname.startsWith('/api/admin/apikeys/') && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/apikeys/'.length))
      const revoked = revokeKey(db, id)
      sendJson(res, 200, { ok: true, revoked })
      return true
    }

    // ====== 审计流水(active/log/verify;Task 5)======
    if (req.method === 'GET' && url.pathname === '/api/admin/audit-log/active') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const windowSec = Math.min(Math.max(Number(url.searchParams.get('window')) || 900, 1), 86400)
      const source = url.searchParams.get('source') || null
      sendJson(res, 200, { active: activeKeys(db, { windowSec, source }) })
      return true
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/audit-log') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const q = url.searchParams
      const out = queryAuditLog(db, {
        keyId: q.get('key') || undefined, owner: q.get('owner') || undefined, clusterId: q.get('cluster') || undefined,
        tool: q.get('tool') || undefined, result: q.get('result') || undefined, source: q.get('source') || undefined,
        since: q.get('since') || undefined, until: q.get('until') || undefined,
        page: q.get('page') || undefined, size: q.get('size') || undefined,
      })
      sendJson(res, 200, out)
      return true
    }
    if (req.method === 'GET' && url.pathname === '/api/admin/audit-log/verify') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, verifyChain(db))
      return true
    }

    // ====== 用户管理 ======
    if (url.pathname === '/api/admin/users' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const users = db.prepare('SELECT id,username,role,displayName,createdAt,disabled FROM platform_users ORDER BY createdAt').all()
      for (const u of users) u.clusterIds = db.prepare('SELECT clusterId FROM user_clusters WHERE userId=?').all(u.id).map(r => r.clusterId)
      sendJson(res, 200, { users })
      return true
    }
    if (url.pathname === '/api/admin/users' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const { username, password, role, displayName } = await readBody(req)
        if (!username || !password) { sendJson(res, 400, { message: '用户名和密码不能为空' }); return true }
        if (role && !['admin', 'user'].includes(role)) { sendJson(res, 400, { message: '角色只能是 admin 或 user' }); return true }
        const existing = db.prepare('SELECT 1 FROM platform_users WHERE username=?').get(username)
        if (existing) { sendJson(res, 409, { message: '用户名已存在' }); return true }
        const id = randomUUID()
        db.prepare('INSERT INTO platform_users (id,username,passwordHash,role,displayName,createdAt) VALUES (?,?,?,?,?,?)')
          .run(id, username, hashPassword(password), role || 'user', displayName || null, Date.now())
        sendJson(res, 200, { user: { id, username, role: role || 'user', displayName, createdAt: Date.now(), clusterIds: [] } })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || '创建用户失败' }); return true }
    }
    if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length))
      const target = db.prepare('SELECT role FROM platform_users WHERE id=?').get(id)
      if (!target) { sendJson(res, 404, { message: '用户不存在' }); return true }
      const adminCount = db.prepare("SELECT COUNT(*) c FROM platform_users WHERE role='admin' AND disabled=0").get().c
      if (target.role === 'admin' && adminCount <= 1) { sendJson(res, 400, { message: '不能删除最后一个管理员' }); return true }
      db.prepare('DELETE FROM platform_users WHERE id=?').run(id)
      db.prepare('DELETE FROM user_clusters WHERE userId=?').run(id)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (url.pathname.startsWith('/api/admin/users/') && req.method === 'PATCH') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length))
      const input = await readBody(req)
      const fields = [], vals = []
      for (const k of ['role', 'displayName', 'disabled']) { if (input[k] != null) { fields.push(`${k}=?`); vals.push(input[k]) } }
      if (!fields.length) { sendJson(res, 400, { message: '无更新字段' }); return true }
      vals.push(id)
      db.prepare(`UPDATE platform_users SET ${fields.join(',')} WHERE id=?`).run(...vals)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (url.pathname.match(/\/api\/admin\/users\/[^/]+\/reset-password$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const userId = url.pathname.split('/')[4]
      const { newPassword } = await readBody(req)
      if (!newPassword) { sendJson(res, 400, { message: '新密码不能为空' }); return true }
      db.prepare('UPDATE platform_users SET passwordHash=? WHERE id=?').run(hashPassword(newPassword), userId)
      sendJson(res, 200, { ok: true })
      return true
    }
    if (url.pathname.match(/\/api\/admin\/users\/[^/]+\/clusters$/) && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const userId = url.pathname.split('/')[4]
      const { clusterIds } = await readBody(req)
      db.prepare('DELETE FROM user_clusters WHERE userId=?').run(userId)
      if (Array.isArray(clusterIds)) {
        const stmt = db.prepare('INSERT INTO user_clusters (userId,clusterId,assignedBy,assignedAt) VALUES (?,?,?,?)')
        for (const cid of clusterIds) stmt.run(userId, cid, ps.username, Date.now())
      }
      sendJson(res, 200, { clusterIds: clusterIds || [] })
      return true
    }

    return false // 无匹配
  }

  return { handle }
}
