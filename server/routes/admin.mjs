// 管理 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// LLM/MCP 配置、集群 CRUD、API keys、审计日志、用户管理 逐字搬迁,仅依赖引用改走 deps 注入。
import { listKeys, mintKey, revokeKey, setKeySaBinding, setKeySshAccess } from '../auth-keys.mjs'
import { managedSaName, rbacTier } from '../sa-provision.mjs'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { limitMbFromValue, PODFILE_LIMIT_DEFAULT_MB } from '../podfile-stream.mjs'
import { normalizeToolOverrides, normalizeAllowedNamespaces } from '../authorize.mjs'
import { activeKeys, queryAuditLog, verifyChain } from '../audit.mjs'
import { clampPresence, getPresenceConfig } from '../workbench-projects.mjs'
import { msg } from '../messages.mjs'
import { isPasswordOk } from '../password-policy.mjs'
import { getWorkbenchAiConfig, validateDisabledTools, clampInstructions } from '../workbench-ai-config.mjs'
import { buildWorkbenchSystemPrompt } from '../workbench-prompt.mjs'
import { registry } from '../tool-registry.mjs'
import { isValidMinutes } from '../ssh/reap-policy.mjs'
import { revokeUserSessions } from '../session-revoke.mjs'

export function createAdminRoutes(deps) {
  const {
    db, sendJson, readBody, requireAdmin,
    getSetting, setSetting, getLlmConfig, createLlmClient, probeReasoningSupport,
    clusterProber, randomUUID,
    parseKubeconfig, certMaterial, normalizeServer, buildCallContext, requestKubernetes,
    hashPassword, getSshSessionPolicy, writeAudit, platformSessions, sessions,
  } = deps

  // 匹配 admin 路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {
    // ====== LLM 配置(baseURL/apiKey/model 存 DB;env 回退;GET 不回传 key)======
    if (url.pathname === '/api/admin/llm-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const dbBase = getSetting('llm.baseURL'), dbKey = getSetting('llm.apiKey'), dbModel = getSetting('llm.model')
      const dbTemp = getSetting('llm.temperature'), dbMax = getSetting('llm.maxTokens')
      const src = (db, env) => db ? 'db' : (env ? 'env' : 'none')
      sendJson(res, 200, {
        baseURL: dbBase || process.env.LLM_BASE_URL || '',
        model: dbModel || process.env.LLM_MODEL || '',
        baseURLSource: src(dbBase, process.env.LLM_BASE_URL),
        modelSource: src(dbModel, process.env.LLM_MODEL),
        hasApiKey: !!(dbKey || process.env.LLM_API_KEY),
        apiKeySource: src(dbKey, process.env.LLM_API_KEY),
        temperature: dbTemp || '',
        maxTokens: dbMax || '',
      })
      return true
    }
    if (url.pathname === '/api/admin/llm-config' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        // 校验 temperature/maxTokens(2026-08-25 AI 定制设计)
        const t = input.temperature === '' || input.temperature == null ? '' : Number(input.temperature)
        if (t !== '' && (!Number.isFinite(t) || t < 0 || t > 2)) { sendJson(res, 400, { message: msg(req, 'admin.llmBadTemperature') }); return true }
        const m = input.maxTokens === '' || input.maxTokens == null ? '' : Number(input.maxTokens)
        if (m !== '' && (!Number.isInteger(m) || m < 1 || m > 200000)) { sendJson(res, 400, { message: msg(req, 'admin.llmBadMaxTokens') }); return true }
        setSetting('llm.baseURL', input.baseURL || '')
        setSetting('llm.model', input.model || '')
        if (typeof input.apiKey === 'string' && input.apiKey) setSetting('llm.apiKey', input.apiKey) // 留空 = 不修改
        setSetting('llm.temperature', t === '' ? '' : String(t))
        setSetting('llm.maxTokens', m === '' ? '' : String(m))
        sendJson(res, 200, { ok: true })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'admin.saveFailed') }); return true }
    }
    // ====== 悬浮对话入口配置(maxItems/activityWindowMin 存 DB;clamp 兜底;2026-08-17)======
    if (url.pathname === '/api/admin/presence-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const cfg = getPresenceConfig(db)
      const rawMax = getSetting('presence.maxItems'), rawWin = getSetting('presence.activityWindowMin')
      sendJson(res, 200, {
        maxItems: cfg.maxItems, windowMin: cfg.windowMin,
        maxItemsSource: rawMax ? 'db' : 'default', windowMinSource: rawWin ? 'db' : 'default',
      })
      return true
    }
    if (url.pathname === '/api/admin/presence-config' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const input = await readBody(req)
      const maxItems = Number(input.maxItems), windowMin = Number(input.windowMin)
      if (!Number.isFinite(maxItems) || !Number.isFinite(windowMin)) {
        sendJson(res, 400, { message: msg(req, 'admin.presenceNumeric') }); return true
      }
      setSetting('presence.maxItems', clampPresence('maxItems', maxItems))
      setSetting('presence.activityWindowMin', clampPresence('windowMin', windowMin))
      sendJson(res, 200, { ok: true })
      return true
    }
    if (url.pathname === '/api/admin/llm-config/test' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req).catch(() => ({})) || {}
        const saved = getLlmConfig()
        // 表单值优先(支持"填完即测,不必先保存");空字段(apiKey 留空=不改)回退已保存
        const cfg = { baseURL: input.baseURL || saved.baseURL, model: input.model || saved.model, apiKey: input.apiKey || saved.apiKey }
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 200, { ok: false, message: msg(req, 'admin.llmTestFillFirst') }); return true }
        const client = createLlmClient({ ...cfg, timeoutMs: 20000 })
        const reply = await client.chat({ messages: [{ role: 'user', content: 'ping(仅测连通性,请回 pong)' }] })
        sendJson(res, 200, { ok: true, reply: (reply.content || '').slice(0, 200) })
        return true
      } catch (e) { sendJson(res, 200, { ok: false, message: e?.message || msg(req, 'admin.llmTestConnectFailed') }); return true }
    }
    // 探测当前(或表单)配置的模型是否流式透传思考 token——工作台「思考过程」展示的前提
    if (url.pathname === '/api/admin/llm-config/probe-reasoning' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req).catch(() => ({})) || {}
        const saved = getLlmConfig()
        const cfg = { baseURL: input.baseURL || saved.baseURL, model: input.model || saved.model, apiKey: input.apiKey || saved.apiKey }
        if (!cfg.baseURL || !cfg.model) { sendJson(res, 200, { ok: false, message: msg(req, 'admin.llmProbeFillFirst') }); return true }
        const client = createLlmClient({ ...cfg, idleMs: 30000 })
        const r = await probeReasoningSupport(client)
        sendJson(res, 200, { ok: true, ...r })
        return true
      } catch (e) { sendJson(res, 200, { ok: false, message: e?.message || msg(req, 'admin.probeFailed') }); return true }
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

    // ====== Pod 文件传输限额(上传/下载共用;默认 1GB,1-10240MB)======
    if (url.pathname === '/api/admin/podfile-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const mb = limitMbFromValue(getSetting('podfile.limitMb')) ?? PODFILE_LIMIT_DEFAULT_MB
      sendJson(res, 200, { limitMb: mb })
      return true
    }
    if (url.pathname === '/api/admin/podfile-config' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const mb = limitMbFromValue(input.limitMb)
        if (!mb) { sendJson(res, 400, { message: msg(req, 'admin.podfileLimitInvalid') }); return true }
        setSetting('podfile.limitMb', String(mb))
        sendJson(res, 200, { ok: true, limitMb: mb })
        return true
      } catch (e) { sendJson(res, 400, { message: e.message }); return true }
    }
    // ====== SSH 会话回收策略(2026-08-29 spec):三阈值全局,分钟,0=禁用;改动 ≤60s 随 sweep 生效 ======
    if (url.pathname === '/api/admin/ssh-session-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, getSshSessionPolicy())
      return true
    }
    if (url.pathname === '/api/admin/ssh-session-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        // 部分更新语义:仅校验并落库出现的键;省略键保持现值
        const keys = ['detachedIdleMin', 'attachedIdleMin', 'maxLifetimeMin']
        for (const k of keys) {
          if (input[k] === undefined) continue
          if (!isValidMinutes(input[k])) { sendJson(res, 400, { message: msg(req, 'admin.sshPolicyInvalid', { field: k }) }); return true }
        }
        for (const k of keys) if (input[k] !== undefined) setSetting(`ssh.session.${k}`, String(input[k]))
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'ssh_session_policy', result: 'ok', requestSummary: JSON.stringify(input), source: 'platform' })
        sendJson(res, 200, { ok: true, policy: getSshSessionPolicy() })
        return true
      } catch (e) { sendJson(res, 400, { message: e.message }); return true }
    }
    // ====== 工作台 AI 行为配置(2026-08-25):追加指令 + 工具收紧;预览=服务端实际拼装,所见即所发 ======
    if (url.pathname === '/api/admin/workbench-ai-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const cfg = getWorkbenchAiConfig(db)
      sendJson(res, 200, {
        additionalInstructions: cfg.additionalInstructions,
        disabledTools: cfg.disabledTools,
        projectMemory: cfg.projectMemory, // 项目记忆开关(T2):回显让前端所见即所发
        toolCatalog: registry.workbenchTools(),
        effectivePreview: buildWorkbenchSystemPrompt(cfg),
      })
      return true
    }
    if (url.pathname === '/api/admin/workbench-ai-config' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const v = validateDisabledTools(input.disabledTools)
        if (!v.ok) {
          const message = v.detail.type === 'unknown'
            ? `${msg(req, 'admin.aiToolUnknown')}: ${v.detail.name}`
            : msg(req, 'admin.aiToolsNotArray')
          sendJson(res, 400, { message }); return true
        }
        setSetting('workbench.disabledTools', JSON.stringify(v.value))
        setSetting('workbench.additionalInstructions', clampInstructions(input.additionalInstructions))
        // 项目记忆开关(T2):布尔可选;null/undefined = 不修改(留空不改,与 apiKey 语义一致)
        if (input.projectMemory != null) setSetting('workbench.projectMemory', input.projectMemory === false ? 'false' : 'true')
        sendJson(res, 200, { ok: true })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'admin.saveFailed') }); return true }
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
        if (!input.name) { sendJson(res, 400, { message: msg(req, 'admin.clusterNameRequired') }); return true }
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
        } else { sendJson(res, 400, { message: msg(req, 'admin.credentialsMissing') }); return true }
        const insecure = input.insecure === true
        // 探测版本（经 buildCallContext 构造调用上下文）
        const probe = await requestKubernetes(buildCallContext({ apiServer, authHeader, ca, cert, key, insecure }), '/version')
        const version = probe.body?.gitVersion || 'unknown'
        const id = randomUUID()
        db.prepare('INSERT INTO clusters (id,name,apiServer,authMethod,authHeader,ca,cert,key,insecure,version,createdBy,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, input.name, apiServer.toString(), input.kubeconfig ? 'kubeconfig' : input.token ? 'token' : 'basic', authHeader, ca || null, cert || null, key || null, insecure ? 1 : 0, version, ps.username, Date.now())
        sendJson(res, 200, { cluster: { id, name: input.name, apiServer: apiServer.toString().replace(/\/$/, ''), version } })
        return true
      } catch (e) { sendJson(res, e.status || 502, { message: e?.message || msg(req, 'admin.addClusterFailed') }); return true }
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
    // 按 key 绑定集群拉真实 ns 列表(ns allowlist 下拉候选):用集群表行内凭据,非浏览器会话集群——
    // 多集群下 key 绑 A 而浏览器连 B 时,候选绝不能取 B 的。只回名字、字典序;ns 数量小 limit=500 不分页。
    if (req.method === 'GET' && url.pathname.match(/^\/api\/admin\/clusters\/[^/]+\/namespaces$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.split('/')[4])
      const row = deps.getCluster ? deps.getCluster(id) : null
      if (!row) { sendJson(res, 404, { message: msg(req, 'admin.clusterNotFound') }); return true }
      try {
        const ctx = deps.buildCallContext({ apiServer: row.apiServer, authHeader: row.authHeader, ca: row.ca, cert: row.cert, key: row.key, insecure: !!row.insecure })
        const { body } = await deps.requestKubernetes(ctx, '/api/v1/namespaces?limit=500')
        const namespaces = (body?.items || []).map(it => it?.metadata?.name).filter(Boolean).sort()
        sendJson(res, 200, { namespaces })
      } catch (e) { sendJson(res, 502, { message: msg(req, 'admin.fetchNamespacesFailed', { reason: e?.message || msg(req, 'admin.unknownError') }) }) }
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
        const byo = input.mode === 'byo' || !!input.boundSA_name
        if (byo) {
          const k = mintKey(db, {
            owner: input.owner || ps.username, clusterId: input.clusterId,
            boundSA_namespace: input.boundSA_namespace, boundSA_name: input.boundSA_name,
            tier: input.tier || 'read', tool_overrides: input.tool_overrides ?? null,
            allowed_namespaces: input.allowed_namespaces ?? null, label: input.label || null, createdBy: ps.username, sshAccess: !!input.sshAccess,
          })
          // k.plaintext 仅此次返回(明文不入库);前端须提示复制保存
          sendJson(res, 200, { apikey: k }); return true
        }
        // 托管(默认):先供给集群身份,成功才落库——失败不给「出生即死亡」的 key。
        if (!deps.provisionCluster || !deps.getCluster) { sendJson(res, 503, { message: msg(req, 'admin.mintProvisionUnavailable') }); return true }
        if (!input.boundSA_namespace) { sendJson(res, 400, { message: msg(req, 'admin.mintNamespaceRequired') }); return true }
        const id = (randomUUID || cryptoRandomUUID)()  // deps 注入优先;未注入(测试 harness)回退 node:crypto
        const name = managedSaName(id)
        const tier = rbacTier({ tier: input.tier || 'read', tool_overrides: input.tool_overrides ?? null })
        const prov = await deps.provisionCluster(deps.getCluster(input.clusterId), {
          keyId: id, namespace: input.boundSA_namespace, name, tier,
          namespaces: Array.isArray(input.allowed_namespaces) ? input.allowed_namespaces : [],
        })
        if (!prov.ok) {
          sendJson(res, 502, { message: msg(req, 'admin.mintProvisionFailed', { reason: prov.failed[0]?.error || prov.failed[0]?.kind || msg(req, 'admin.unknownError') }), failed: prov.failed })
          return true
        }
        const k = mintKey(db, {
          id, owner: input.owner || ps.username, clusterId: input.clusterId,
          boundSA_namespace: input.boundSA_namespace, boundSA_name: name, saManaged: 1,
          tier: input.tier || 'read', tool_overrides: input.tool_overrides ?? null,
          allowed_namespaces: input.allowed_namespaces ?? null, label: input.label || null, createdBy: ps.username, sshAccess: !!input.sshAccess,
        })
        // k.plaintext 仅此次返回(明文不入库);前端须提示复制保存
        sendJson(res, 200, { apikey: k }); return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || msg(req, 'admin.mintFailed') }); return true }
    }
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/ssh-access$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const input = await readBody(req)
      const ok = setKeySshAccess(db, id, !!input.enabled)
      if (!ok) { sendJson(res, 404, { message: msg(req, 'admin.apiKeyNotFound') || 'key not found or revoked' }); return true }
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'ssh_key_access', result: 'ok', requestSummary: `${id} → ${!!input.enabled}`, source: 'platform' })
      sendJson(res, 200, { ok: true })
      return true
    }
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/overrides$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = decodeURIComponent(url.pathname.split('/')[4])
        const input = await readBody(req)
        const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND revokedAt IS NULL').get(id)
        if (!row) { sendJson(res, 404, { message: msg(req, 'admin.apikeyNotFound') }); return true }
        const json = normalizeToolOverrides(input.tool_overrides)  // strict: 坏→抛
        // 托管 key:先供给后落库(与 ns PATCH 同语义)——overrides 加开工具面会抬 rbacTier
        // (read+allow scale→operator、危险工具→admin),只改 DB 会造出「策略允许、RBAC 403」;
        // 供给失败 → 502 + 明细,DB 不动。BYO:平台不碰其身份,只落库。
        if (row.saManaged) {
          if (!deps.provisionCluster || !deps.getCluster) { sendJson(res, 503, { message: msg(req, 'admin.overridesUpdateProvisionUnavailable') }); return true }
          const nextTier = rbacTier({ ...row, tool_overrides: json })
          let extraNs = []
          try { extraNs = row.allowed_namespaces ? JSON.parse(row.allowed_namespaces) : [] } catch { extraNs = [] }
          const prov = await deps.provisionCluster(deps.getCluster(row.clusterId), {
            keyId: id, namespace: row.boundSA_namespace, name: row.boundSA_name, tier: nextTier, namespaces: extraNs,
          })
          if (!prov.ok) {
            sendJson(res, 502, { message: msg(req, 'admin.overridesUpdateRbacFailed', { reason: prov.failed[0]?.error || prov.failed[0]?.kind || msg(req, 'admin.unknownError') }), failed: prov.failed })
            return true
          }
          // 档名变更后清旧档名 RBAC 残留(best-effort:失败不回滚;对齐 repair 的 sweepStaleTierBindings)。
          if (deps.sweepStaleCluster && rbacTier(row) !== nextTier) {
            try { await deps.sweepStaleCluster(deps.getCluster(row.clusterId), { keyId: id, namespace: row.boundSA_namespace, keepTier: nextTier, namespaces: extraNs }) } catch { /* best-effort */ }
          }
          db.prepare('UPDATE api_keys SET tool_overrides = ? WHERE id = ? AND revokedAt IS NULL').run(json, id)
          sendJson(res, 200, { ok: true, id, tool_overrides: json, rbac: 'provisioned' })
          return true
        }
        db.prepare('UPDATE api_keys SET tool_overrides = ? WHERE id = ? AND revokedAt IS NULL').run(json, id)
        sendJson(res, 200, { ok: true, id, tool_overrides: json, rbac: 'byo-self-managed' })
        return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || msg(req, 'admin.updateOverridesFailed') }); return true }
    }
    if (req.method === 'PATCH' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/namespaces$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = decodeURIComponent(url.pathname.split('/')[4])
        const input = await readBody(req)
        const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND revokedAt IS NULL').get(id)
        if (!row) { sendJson(res, 404, { message: msg(req, 'admin.apikeyNotFound') }); return true }
        const json = normalizeAllowedNamespaces(input.allowed_namespaces, row.boundSA_namespace)  // strict: 坏→抛
        const nextNs = json ? JSON.parse(json) : []
        let prevNs = []
        try { prevNs = row.allowed_namespaces ? JSON.parse(row.allowed_namespaces) : [] } catch { prevNs = [] }
        // 托管 key:先供给后落库(与托管 mint 同语义)——PATCH 只改 DB 会造出「策略允许、RBAC 403」的假 ns;
        // 供给失败 → 502 + 明细,DB 不动(宁可不改,不落一个不可用的 ns)。BYO:平台不碰其身份,只落库。
        if (row.saManaged) {
          if (!deps.provisionCluster || !deps.getCluster) { sendJson(res, 503, { message: msg(req, 'admin.nsUpdateProvisionUnavailable') }); return true }
          // ns 存在性预检(kind 实测:SSA 往不存在的 ns 打 Role/Binding 必 404,502 报错还难懂)——
          // 提前 400 给明确指引;BYO 不预检(自管 RBAC,「先配 key 后建 ns」对 BYO 合法)。
          if (nextNs.length && deps.requestKubernetes && deps.buildCallContext) {
            const cluster = deps.getCluster(row.clusterId)
            if (!cluster) { sendJson(res, 404, { message: msg(req, 'admin.clusterNotFound') }); return true }
            const checkCtx = deps.buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure })
            for (const ns of nextNs) {
              try { await deps.requestKubernetes(checkCtx, `/api/v1/namespaces/${encodeURIComponent(ns)}`) }
              catch (e) {
                if (e.status === 404) { sendJson(res, 400, { message: msg(req, 'admin.nsNotExistInCluster', { ns }) }); return true }
                throw e
              }
            }
          }
          const tier = rbacTier(row)
          const prov = await deps.provisionCluster(deps.getCluster(row.clusterId), {
            keyId: id, namespace: row.boundSA_namespace, name: row.boundSA_name, tier, namespaces: nextNs,
          })
          if (!prov.ok) {
            sendJson(res, 502, { message: msg(req, 'admin.nsUpdateRbacFailed', { reason: prov.failed[0]?.error || prov.failed[0]?.kind || msg(req, 'admin.unknownError') }), failed: prov.failed })
            return true
          }
          // 清理被移除 ns 的三档名 RBAC 残留(best-effort:失败不回滚 allowlist)。
          const removed = prevNs.filter(ns => !nextNs.includes(ns))
          if (removed.length && deps.sweepNamespacesCluster) {
            try { await deps.sweepNamespacesCluster(deps.getCluster(row.clusterId), { keyId: id, namespaces: removed }) } catch { /* best-effort */ }
          }
          db.prepare('UPDATE api_keys SET allowed_namespaces = ? WHERE id = ? AND revokedAt IS NULL').run(json, id)
          sendJson(res, 200, { ok: true, id, allowed_namespaces: json, rbac: 'provisioned' })
          return true
        }
        db.prepare('UPDATE api_keys SET allowed_namespaces = ? WHERE id = ? AND revokedAt IS NULL').run(json, id)
        sendJson(res, 200, { ok: true, id, allowed_namespaces: json, rbac: 'byo-self-managed' })
        return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || msg(req, 'admin.updateNsFailed') }); return true }
    }
    // SA 健康(列表页红绿点):轻量 GET 每把未吊销 key 的绑定 SA;SA 在 → 追加 RBAC 漂移探测(rbac 字段)。
    if (req.method === 'GET' && url.pathname === '/api/admin/apikeys/health') {
      const ps = requireAdmin(req, res); if (!ps) return true
      if (!deps.probeSa || !deps.getCluster) { sendJson(res, 200, { health: [] }); return true }
      const keys = listKeys(db).filter(k => !k.revokedAt)
      const shared = {} // 本次调用的共享缓存:同 cluster 的 rolebinding/CRB list 只发一次
      const health = await Promise.all(keys.map(async k => {
        const r = await deps.probeSa(deps.getCluster(k.clusterId), k.boundSA_namespace, k.boundSA_name)
        let rbac = { status: 'unknown', issues: [] } // SA 不可达 → 短路 unknown(红点已足够)
        if (r && r.ok && deps.probeDrift) {
          try { rbac = (await deps.probeDrift(deps.getCluster(k.clusterId), k, shared)) || rbac } catch { /* 漂移探测失败不阻塞列表 */ }
        }
        return { id: k.id, prefix: k.prefix, boundSA: `${k.boundSA_namespace}/${k.boundSA_name}`, managed: !!k.saManaged, tier: k.tier, ok: !!(r && r.ok), detail: r?.detail || null, rbac }
      }))
      sendJson(res, 200, { health })
      return true
    }
    // 修复托管身份;takeover=true 时 BYO key 换平台托管名并改绑(解决「SA 被删整 key 灭门」的存量 key)。
    if (req.method === 'POST' && url.pathname.match(/^\/api\/admin\/apikeys\/[^/]+\/sa\/repair$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const id = decodeURIComponent(url.pathname.split('/')[4])
        const input = await readBody(req)
        const row = db.prepare('SELECT * FROM api_keys WHERE id = ? AND revokedAt IS NULL').get(id)
        if (!row) { sendJson(res, 404, { message: msg(req, 'admin.apikeyNotFound') }); return true }
        if (!row.saManaged && !input.takeover) { sendJson(res, 400, { message: msg(req, 'admin.repairTakeoverRequired') }); return true }
        if (!deps.provisionCluster || !deps.getCluster) { sendJson(res, 503, { message: msg(req, 'admin.repairUnavailable') }); return true }
        let name = row.boundSA_name, managed = !!row.saManaged
        if (input.takeover) { name = managedSaName(id); managed = true }
        const tier = rbacTier(row)
        let extraNs = []
        try { extraNs = row.allowed_namespaces ? JSON.parse(row.allowed_namespaces) : [] } catch { extraNs = [] }
        const prov = await deps.provisionCluster(deps.getCluster(row.clusterId), {
          keyId: id, namespace: row.boundSA_namespace, name, tier, namespaces: extraNs,
        })
        if (!prov.ok) { sendJson(res, 502, { message: msg(req, 'admin.repairFailedDetail', { reason: prov.failed[0]?.error || prov.failed[0]?.kind || msg(req, 'admin.unknownError') }), failed: prov.failed }); return true }
        if (deps.sweepStaleCluster) {
          // 清旧档名 RBAC(tier 曾变更后残留),best-effort:失败不影响修复结果。
          try { await deps.sweepStaleCluster(deps.getCluster(row.clusterId), { keyId: id, namespace: row.boundSA_namespace, keepTier: tier, namespaces: extraNs }) } catch { /* best-effort */ }
        }
        if (input.takeover && !setKeySaBinding(db, id, { namespace: row.boundSA_namespace, name, managed: true })) {
          sendJson(res, 404, { message: msg(req, 'admin.apikeyNotFound') }); return true
        }
        sendJson(res, 200, { ok: true, boundSA: `${row.boundSA_namespace}/${name}`, managed }); return true
      } catch (e) { sendJson(res, e.status || 400, { message: e.message || msg(req, 'admin.repairFailed') }); return true }
    }
    if (url.pathname.startsWith('/api/admin/apikeys/') && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/apikeys/'.length))
      const row = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id)
      const revoked = revokeKey(db, id)
      if (row?.saManaged && deps.teardownCluster && deps.getCluster) {
        try {
          let extraNs = []
          try { extraNs = row.allowed_namespaces ? JSON.parse(row.allowed_namespaces) : [] } catch { extraNs = [] }
          await deps.teardownCluster(deps.getCluster(row.clusterId), {
            keyId: id, namespace: row.boundSA_namespace, name: row.boundSA_name, tier: rbacTier(row), namespaces: extraNs,
          })
        } catch { /* 回收 best-effort:吊销已成,失败不回滚 */ }
      }
      sendJson(res, 200, { ok: true, revoked }); return true
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
        tool: q.get('tool') || undefined, toolPrefix: q.get('toolPrefix') || undefined, result: q.get('result') || undefined, source: q.get('source') || undefined,
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
        if (!username || !password) { sendJson(res, 400, { message: msg(req, 'admin.userCredentialsRequired') }); return true }
        if (!isPasswordOk(password)) { sendJson(res, 400, { message: msg(req, 'admin.passwordTooShort') }); return true }
        if (role && !['admin', 'user'].includes(role)) { sendJson(res, 400, { message: msg(req, 'admin.roleInvalid') }); return true }
        const existing = db.prepare('SELECT 1 FROM platform_users WHERE username=?').get(username)
        if (existing) { sendJson(res, 409, { message: msg(req, 'admin.usernameExists') }); return true }
        const id = randomUUID()
        db.prepare('INSERT INTO platform_users (id,username,passwordHash,role,displayName,createdAt) VALUES (?,?,?,?,?,?)')
          .run(id, username, hashPassword(password), role || 'user', displayName || null, Date.now())
        sendJson(res, 200, { user: { id, username, role: role || 'user', displayName, createdAt: Date.now(), clusterIds: [] } })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'admin.createUserFailed') }); return true }
    }
    if (url.pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length))
      const target = db.prepare('SELECT role FROM platform_users WHERE id=?').get(id)
      if (!target) { sendJson(res, 404, { message: msg(req, 'admin.userNotFound') }); return true }
      const adminCount = db.prepare("SELECT COUNT(*) c FROM platform_users WHERE role='admin' AND disabled=0").get().c
      if (target.role === 'admin' && adminCount <= 1) { sendJson(res, 400, { message: msg(req, 'admin.lastAdminProtected') }); return true }
      revokeUserSessions({ db, platformSessions, sessions }, id)
      db.prepare('DELETE FROM platform_users WHERE id=?').run(id)
      db.prepare('DELETE FROM user_clusters WHERE userId=?').run(id)
      writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'admin_user_delete', result: 'ok', requestSummary: `id=${id}`, source: 'platform' })
      sendJson(res, 200, { ok: true })
      return true
    }
    if (url.pathname.startsWith('/api/admin/users/') && req.method === 'PATCH') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/users/'.length))
      const input = await readBody(req)
      const target = db.prepare('SELECT role FROM platform_users WHERE id=?').get(id)
      if (!target) { sendJson(res, 404, { message: msg(req, 'admin.userNotFound') }); return true }
      if (input.role != null && !['admin', 'user'].includes(input.role)) { sendJson(res, 400, { message: msg(req, 'admin.roleInvalid') }); return true }
      // 降级判定:role 从 admin 变非 admin,或禁用一个 admin —— 两者都收权,须过自我/末管保护
      const demoting = (input.role != null && input.role !== 'admin' && target.role === 'admin') || (input.disabled != null && !!input.disabled && target.role === 'admin')
      if (demoting) {
        if (id === ps.userId) { sendJson(res, 400, { message: msg(req, 'admin.selfProtected') }); return true }
        const adminCount = db.prepare("SELECT COUNT(*) c FROM platform_users WHERE role='admin' AND disabled=0").get().c
        if (adminCount <= 1) { sendJson(res, 400, { message: msg(req, 'admin.lastAdminProtected') }); return true }
      }
      const fields = [], vals = []
      for (const k of ['role', 'displayName', 'disabled']) { if (input[k] != null) { fields.push(`${k}=?`); vals.push(input[k]) } }
      if (!fields.length) { sendJson(res, 400, { message: msg(req, 'admin.noUpdateFields') }); return true }
      vals.push(id)
      db.prepare(`UPDATE platform_users SET ${fields.join(',')} WHERE id=?`).run(...vals)
      // CSO #3:role/disabled 变更即级联吊销存量会话(降级后 token 不再是「快照 admin」)
      if (input.disabled != null || input.role != null) revokeUserSessions({ db, platformSessions, sessions }, id)
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'admin_user_update', result: 'ok', requestSummary: `id=${id} fields=${fields.join(',')}`, source: 'platform' })
      sendJson(res, 200, { ok: true })
      return true
    }
    if (url.pathname.match(/\/api\/admin\/users\/[^/]+\/reset-password$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const userId = url.pathname.split('/')[4]
      const { newPassword } = await readBody(req)
      if (!newPassword) { sendJson(res, 400, { message: msg(req, 'admin.newPasswordRequired') }); return true }
      if (!isPasswordOk(newPassword)) { sendJson(res, 400, { message: msg(req, 'admin.passwordTooShort') }); return true }
      db.prepare('UPDATE platform_users SET passwordHash=? WHERE id=?').run(hashPassword(newPassword), userId)
      // CSO #3:重置密码踢掉该用户全部存量会话(防旧 token 继续用旧密码体系外的凭据)
      revokeUserSessions({ db, platformSessions, sessions }, userId)
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'admin_user_reset_password', result: 'ok', requestSummary: `id=${userId}`, source: 'platform' })
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
