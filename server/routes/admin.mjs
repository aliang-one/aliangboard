// 管理 HTTP 端点从 server/index.mjs 抽出(handler/dispatcher 模式)。零行为变更。
// LLM/MCP 配置、集群 CRUD、API keys、审计日志、用户管理 逐字搬迁,仅依赖引用改走 deps 注入。
import { listKeys, mintKey, revokeKey, setKeySaBinding, setKeySshAccess } from '../auth-keys.mjs'
import { managedSaName, rbacTier, groupBindingPlan } from '../sa-provision.mjs'
import { randomUUID as cryptoRandomUUID } from 'node:crypto'
import { limitMbFromValue, PODFILE_LIMIT_DEFAULT_MB } from '../podfile-stream.mjs'
import { normalizeToolOverrides, normalizeAllowedNamespaces } from '../authorize.mjs'
import { activeKeys, queryAuditLog, verifyChain } from '../audit.mjs'
import { clampPresence, getPresenceConfig } from '../workbench-projects.mjs'
import { msg } from '../messages.mjs'
import { resolvePasswordPolicy, firstFailedRule, normalizePolicy } from '../password-policy.mjs'
import { getWorkbenchAiConfig, validateDisabledTools, clampInstructions, getMaxStepsConfig, validateMaxSteps, MAX_STEPS_RANGE,
  getMaxRunningConversationsConfig, validateMaxRunningConversations, MAX_RUNNING_CONVERSATIONS_RANGE,
  getMaxConversationsPerProjectConfig, validateMaxConversationsPerProject, MAX_CONVERSATIONS_PER_PROJECT_RANGE, sshPromptServers } from '../workbench-ai-config.mjs'
import { buildWorkbenchSystemPrompt } from '../workbench-prompt.mjs'
import { registry } from '../tool-registry.mjs'
import { isValidMinutes } from '../ssh/reap-policy.mjs'
import { revokeUserSessions, revokeUserClusterSessions, revokeClusterSessions } from '../session-revoke.mjs'

export function createAdminRoutes(deps) {
  const {
    db, sendJson, readBody, requireAdmin,
    getSetting, setSetting, deleteSetting, getLlmConfig, createLlmClient, probeReasoningSupport,
    clusterProber, clusterCerts, randomUUID,
    parseKubeconfig, certMaterial, normalizeServer, buildCallContext, requestKubernetes,
    hashPassword, getSshSessionPolicy, getSshJobPolicy, getPodTerminalPolicy, writeAudit, platformSessions, sessions,
    oidcProvider, // W4 OIDC:index.mjs 注入的 provider 单例(publicConfig/discovery/jwksFor)
    stateOverview, // 状态轴观测(Wave 0 Task 5):() => { ts, stores, sweeps } 聚合快照
  } = deps

  // ===== W2 Phase E(Task 3):组 RoleBinding 驱动(grants 变更 → 集群侧绑定收敛)=====
  // 双写门:仅 allowlist 集群(open 不隔离,绑定无意义=spec 非目标)。fire-and-forget:失败仅
  // console.warn 不影响响应;漂移由启动期 sweepGroupBindings 兜底删、下次 PUT 自愈(SSA 幂等)。
  // provisionGroupCluster/teardownGroupCluster 为 index.mjs 注入的 per-cluster 包装(requestFn+callCtx)。
  const allowlistRow = (clusterId) => {
    if (!deps.getCluster) return null
    const row = deps.getCluster(clusterId)
    return row && row.nsAuthMode === 'allowlist' ? row : null
  }
  const fireGroupDrive = (clusterId, task) => {
    const row = allowlistRow(clusterId)
    if (!row) return
    Promise.resolve(task(row)).catch(e => console.warn('[admin] group binding drive failed:', e?.message || e))
  }
  // PUT grants 全量替换后的收敛:teardown scope = prev ∪ next(降档旧名/被收 ns 全清)→ 重建当前档。
  // prevRows 由调用方在事务 DELETE 前捕获(提交后旧行已蒸发)。
  function driveGroupAfterReplace(clusterId, subjectId, prevRows) {
    if (!deps.provisionGroupCluster && !deps.teardownGroupCluster) return
    const prev = groupBindingPlan((prevRows || []).map(r => ({ ...r, subjectId }))).get(subjectId)
    const nextRows = db.prepare("SELECT namespace, level FROM ns_grants WHERE subjectType='group' AND subjectId=? AND clusterId=?").all(subjectId, clusterId)
    const next = groupBindingPlan(nextRows.map(r => ({ ...r, subjectId }))).get(subjectId)
    fireGroupDrive(clusterId, async row => {
      const tierChanged = prev && next && prev.tier !== next.tier
      const removedNs = prev && next ? prev.namespaces.filter(ns => !next.namespaces.includes(ns)) : []
      if (prev && deps.teardownGroupCluster && (!next || tierChanged || removedNs.length)) {
        await deps.teardownGroupCluster(row, { groupId: subjectId, namespaces: [...new Set([...prev.namespaces, ...(next?.namespaces || [])])] })
      }
      if (next && deps.provisionGroupCluster) await deps.provisionGroupCluster(row, { groupId: subjectId, tier: next.tier, namespaces: next.namespaces })
    })
  }

  // 匹配 admin 路由;命中并处理返 true(调用方不再继续 dispatch);否则返 false。
  async function handle(req, res, url) {
    // ===== 状态轴向观测(spec §9.1):全部登记状态的聚合快照(值与键永不离开进程) =====
    if (url.pathname === '/api/admin/state' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, deps.stateOverview())
      return true
    }

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
    // ====== SSO 登录(OIDC)配置(Wave 4 §D1):GET(轻量,无 discovery)+ PUT + 测试连接 ======
    if (url.pathname === '/api/admin/oidc-config' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      // publicConfig:clientSecret 永不回传,只回 hasSecret;redirectUri 与 auth.mjs 同推导(配置卡展示/复制用)
      sendJson(res, 200, {
        ...(oidcProvider?.getPublicConfig() || {}),
        redirectUri: `${req.socket?.encrypted ? 'https' : 'http'}://${req.headers.host || 'localhost'}/api/auth/oidc/callback`,
      })
      return true
    }
    if (url.pathname === '/api/admin/oidc-config' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const enabled = input.enabled === true || input.enabled === '1' || input.enabled === 1 ? '1' : '0'
        const issuer = String(input.issuer ?? '').trim()
        const clientId = String(input.clientId ?? '').trim()
        // 校验(W4-A 前瞻裁决 4):issuer 非 http(s):// 形状或带尾斜杠 → 400 就地上拒——否则 discovery 的
        // issuer+path 拼接处会静默畸形(W4-A 审查遗留项:尾斜杠 issuer 让 discovery 恒 503 难排查)。
        if (issuer && !/^https?:\/\/.+[^/]$/.test(issuer)) { sendJson(res, 400, { message: msg(req, 'admin.oidcIssuerInvalid') }); return true }
        if (enabled === '1' && (!issuer || !clientId)) { sendJson(res, 400, { message: msg(req, 'admin.oidcIssuerClientRequired') }); return true }
        setSetting('oidc.enabled', enabled)
        setSetting('oidc.issuer', issuer)
        setSetting('oidc.clientId', clientId)
        if (typeof input.clientSecret === 'string' && input.clientSecret) setSetting('oidc.clientSecret', input.clientSecret) // 留空 = 不修改(llm.apiKey 同惯例)
        setSetting('oidc.scopes', String(input.scopes ?? '').trim())
        setSetting('oidc.groupsClaim', String(input.groupsClaim ?? '').trim())
        setSetting('oidc.usernameClaim', String(input.usernameClaim ?? '').trim())
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'admin_oidc_config', result: 'ok', requestSummary: `enabled=${enabled} issuer=${issuer || '(none)'}`, source: 'platform' })
        sendJson(res, 200, { ok: true })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'admin.saveFailed') }); return true }
    }
    if (url.pathname === '/api/admin/oidc-config/test' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      // 测试连接:discovery + jwks 走 provider 缓存;未配置/任何失败统一 { ok:false, error:'discovery' }
      // (200 + ok:false,与 llm-config/test 同形状——结果是数据不是错误)。
      const cfg = oidcProvider?.getFullConfig?.() || null
      if (!cfg?.issuer) { sendJson(res, 200, { ok: false, error: 'discovery' }); return true }
      try {
        const doc = await oidcProvider.discovery(cfg.issuer)
        const jwks = await oidcProvider.jwksFor(cfg.issuer)
        sendJson(res, 200, {
          ok: true,
          authorizationEndpoint: doc.authorization_endpoint,
          tokenEndpoint: doc.token_endpoint,
          jwksKeys: jwks.keys.length,
          algorithms: [...new Set(jwks.keys.map((k) => k?.kty).filter(Boolean))],
        })
      } catch { sendJson(res, 200, { ok: false, error: 'discovery' }) }
      return true
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
    // ====== SSH 会话回收策略(2026-08-29 spec):四阈值全局,分钟,0=禁用;改动 ≤60s 随 sweep 生效 ======
    if (url.pathname === '/api/admin/ssh-session-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, getSshSessionPolicy())
      return true
    }
    if (url.pathname === '/api/admin/ssh-session-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        // 部分更新语义:仅校验并落库出现的键;省略键保持现值。
        // null(空输入序列化产物)显式 400:isValidMinutes(Number(null))=0 会把清空输入误判成合法「禁用」
        const keys = ['detachedIdleMin', 'attachedIdleMin', 'maxLifetimeMin', 'backendIdleMin']
        for (const k of keys) {
          if (input[k] === undefined) continue
          if (input[k] === null || !isValidMinutes(input[k])) { sendJson(res, 400, { message: msg(req, 'admin.sshPolicyInvalid', { field: k }) }); return true }
        }
        for (const k of keys) if (input[k] !== undefined) setSetting(`ssh.session.${k}`, String(input[k]))
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'ssh_session_policy', result: 'ok', requestSummary: JSON.stringify(input), source: 'platform' })
        sendJson(res, 200, { ok: true, policy: getSshSessionPolicy() })
        return true
      } catch (e) { sendJson(res, 400, { message: e.message }); return true }
    }
    // ====== SSH 异步任务策略(2026-08-30 spec):ttlMin/maxPerServer 全局,部分更新语义 ======
    if (url.pathname === '/api/admin/ssh-job-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, getSshJobPolicy())
      return true
    }
    if (url.pathname === '/api/admin/ssh-job-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const keys = ['ttlMin', 'maxPerServer']
        const range = { ttlMin: [1, 10080], maxPerServer: [1, 16] }
        for (const k of keys) {
          if (input[k] === undefined) continue
          const [lo, hi] = range[k]; const n = Number(input[k])
          // 必须整数(终审 I3):`-mmin +1.5` 让 find 报错(被 2>/dev/null 吞)→ 该服务器每轮 sweep
          // 静默 no-op 而 admin 看到成功。镜像 reap-policy 的 isValidMinutes(Number.isInteger)。
          if (!Number.isInteger(n) || n < lo || n > hi) { sendJson(res, 400, { message: msg(req, 'admin.sshPolicyInvalid', { field: k }) }); return true }
        }
        for (const k of keys) if (input[k] !== undefined) setSetting(`ssh.job.${k}`, String(input[k]))
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'ssh_job_policy', result: 'ok', requestSummary: JSON.stringify(input), source: 'platform' })
        sendJson(res, 200, { ok: true, policy: getSshJobPolicy() })
        return true
      } catch (e) { sendJson(res, 400, { message: e.message }); return true }
    }
    // ====== Pod 终端空闲回收策略(2026-09-05「终端与会话」配置页):分钟,0=禁用;改动 ≤60s 随 sweep 生效 ======
    if (url.pathname === '/api/admin/pod-terminal-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, getPodTerminalPolicy())
      return true
    }
    if (url.pathname === '/api/admin/pod-terminal-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        // null(空输入序列化产物)≠「未传」:Number(null)===0 会被 isValidMinutes 误判成禁用,显式 400
        if (input.idleReapMin === null || (input.idleReapMin !== undefined && !isValidMinutes(input.idleReapMin))) {
          sendJson(res, 400, { message: msg(req, 'admin.sshPolicyInvalid', { field: 'idleReapMin' }) }); return true
        }
        if (input.idleReapMin !== undefined && input.idleReapMin !== null) setSetting('pod.terminal.idleReapMin', String(input.idleReapMin))
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'pod_terminal_policy', result: 'ok', requestSummary: JSON.stringify(input), source: 'platform' })
        sendJson(res, 200, { ok: true, policy: getPodTerminalPolicy() })
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
        maxSteps: getMaxStepsConfig(db), // 最大执行步数(2026-09-03):回显已解析值(0=不限制),所见即所发
        // 对话限额(F6,2026-09-07):同款回显已解析值(0=不限制),所见即所发
        maxRunningConversations: getMaxRunningConversationsConfig(db),
        maxConversationsPerProject: getMaxConversationsPerProjectConfig(db),
        toolCatalog: registry.workbenchTools(),
        // context-assembly-06(2026-09-07 审计批次三):预览传 sshPromptServers(db)(与对话创建/
        // 透明面板同一事实源)——有 AI 暴露服务器时预览含 SSH 段,「所见即所发」;防御式降级
        // 见 sshPromptServers 注释(表缺失 → 空清单,不 500)。
        effectivePreview: buildWorkbenchSystemPrompt({ ...cfg, sshServers: sshPromptServers(db) }),
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
        // 最大执行步数(2026-09-03):null/undefined = 不修改(与 projectMemory 语义一致);0 = 不限制
        const ms = validateMaxSteps(input.maxSteps)
        if (!ms.ok) { sendJson(res, 400, { message: msg(req, 'admin.aiMaxStepsInvalid', { lo: MAX_STEPS_RANGE.lo, hi: MAX_STEPS_RANGE.hi }) }); return true }
        if (ms.value != null) setSetting('workbench.maxSteps', String(ms.value))
        // 对话限额(F6,2026-09-07):同款接线——校验 400 双语文案 → setSetting 落键;0 = 不限制
        const mr = validateMaxRunningConversations(input.maxRunningConversations)
        if (!mr.ok) { sendJson(res, 400, { message: msg(req, 'admin.aiMaxRunningInvalid', { lo: MAX_RUNNING_CONVERSATIONS_RANGE.lo, hi: MAX_RUNNING_CONVERSATIONS_RANGE.hi }) }); return true }
        if (mr.value != null) setSetting('workbench.maxRunningConversations', String(mr.value))
        const mp = validateMaxConversationsPerProject(input.maxConversationsPerProject)
        if (!mp.ok) { sendJson(res, 400, { message: msg(req, 'admin.aiMaxPerProjectInvalid', { lo: MAX_CONVERSATIONS_PER_PROJECT_RANGE.lo, hi: MAX_CONVERSATIONS_PER_PROJECT_RANGE.hi }) }); return true }
        if (mp.value != null) setSetting('workbench.maxConversationsPerProject', String(mp.value))
        sendJson(res, 200, { ok: true })
        return true
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'admin.saveFailed') }); return true }
    }

    // ====== 集群管理 ======
    if (url.pathname === '/api/admin/clusters' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      // 取凭据列(authHeader/ca/cert/key/insecure)仅用于探测,绝不回传前端(见下方白名单 map)。
      const rows = db.prepare('SELECT id,name,apiServer,authMethod,version,insecure,nsAuthMode,createdBy,createdAt,authHeader,ca,cert,key FROM clusters ORDER BY createdAt DESC').all()
      const force = url.searchParams.get('refresh') === '1'
      const probed = await clusterProber.probeAll(
        rows,
        r => buildCallContext({ apiServer: r.apiServer, authHeader: r.authHeader, ca: r.ca, cert: r.cert, key: r.key, insecure: !!r.insecure }),
        { force },
      )
      // 断连归因(2026-09-06 证书可观测):仅 Disconnected 行做 TLS 层诊断(CA 失配/过期/主机名/网络),
      // Healthy 零开销;服务层 60s 缓存,列表刷新不重复拨号。'tls-ok'=证书链无碍,断连在凭据/上游层;
      // 单行归因失败降级为无归因,不拖垮整个列表。
      const enriched = await Promise.all(probed.map(async c => {
        if (c.status !== 'Disconnected') return c
        try { return { ...c, disconnectReason: await clusterCerts.classifyFromRow(c) } } catch { return c }
      }))
      // 白名单回传:前端需要的字段 + 实时探测的 status/nodeCount/podCount + 断连归因(凭据不入列)。
      const clusters = enriched.map(c => ({ id: c.id, name: c.name, apiServer: c.apiServer, authMethod: c.authMethod, version: c.version, insecure: c.insecure, nsAuthMode: c.nsAuthMode, createdBy: c.createdBy, createdAt: c.createdAt, status: c.status, nodeCount: c.nodeCount, podCount: c.podCount, disconnectReason: c.disconnectReason }))
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
      const row = db.prepare('SELECT * FROM clusters WHERE id=?').get(id)
      db.prepare('DELETE FROM clusters WHERE id=?').run(id)
      db.prepare('DELETE FROM user_clusters WHERE clusterId=?').run(id)
      // CSO #11:删集群回收其派生的 K8s 会话凭据。apiServer 匹配是尽力回收
      // (sessions 凭据行无属主列),同址多集群时宁可错杀——孤儿明文凭据更危险。
      if (row) {
        try { db.prepare('DELETE FROM sessions WHERE apiServer=?').run(row.apiServer) } catch { /* noop */ }
        for (const [t, s] of sessions) if (String(s.apiServer) === row.apiServer) sessions.delete(t)
      }
      // W2-0 §0.4-3:归属列/平台链路径全用户该集群 session 吊销(与上面 apiServer 尽力回收互补)。
      const revokedSessions = revokeClusterSessions({ db, sessions, platformSessions }, id)
      clusterProber.invalidate(id)
      writeAudit?.(db, { owner: ps.username, verb: 'delete', tool: 'admin_cluster_delete', result: 'ok', requestSummary: `id=${id} revokedSessions=${revokedSessions}`, source: 'platform' })
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
    if (url.pathname === '/api/admin/password-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, { policy: resolvePasswordPolicy(getSetting) })
      return true
    }
    if (url.pathname === '/api/admin/password-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const input = await readBody(req)
      if (input.minLength != null && (!Number.isFinite(Number(input.minLength)) || Number(input.minLength) < 8)) {
        sendJson(res, 400, { message: msg(req, 'admin.passwordPolicyInvalid') }); return true
      }
      const policy = normalizePolicy(input)
      setSetting('auth.passwordPolicy', JSON.stringify(policy))
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'admin_password_policy', result: 'ok', requestSummary: `minLength=${policy.minLength}`, source: 'platform' })
      sendJson(res, 200, { policy })
      return true
    }
    // W3 §1.5:全局 MFA 强制开关——开后未启用用户登录只发受限 token(mfaPending=1,仅 MFA 引导页
    // 白名单端点可用);已启用用户不受影响。读侧恒 getSetting('auth.mfa.required')==='1' 判开;
    // 关 = 删键(与「从未配置」不可区分,存量部署默认关零感知)。
    if (url.pathname === '/api/admin/mfa-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, { enabled: getSetting('auth.mfa.required') === '1' })
      return true
    }
    if (url.pathname === '/api/admin/mfa-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const input = await readBody(req)
      if (typeof input?.enabled !== 'boolean') { sendJson(res, 400, { message: msg(req, 'admin.mfaPolicyInvalid') }); return true }
      if (input.enabled) setSetting('auth.mfa.required', '1')
      else deleteSetting?.('auth.mfa.required')
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'admin_mfa_policy', result: 'ok', requestSummary: `enabled=${input.enabled}`, source: 'platform' })
      sendJson(res, 200, { enabled: input.enabled })
      return true
    }
    if (url.pathname === '/api/admin/token-policy' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      sendJson(res, 200, { maxTtlDays: Math.min(Math.max(Math.floor(Number(getSetting('apikey.maxTtlDays')) || 90), 1), 365) })
      return true
    }
    if (url.pathname === '/api/admin/token-policy' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const input = await readBody(req)
      const n = Math.floor(Number(input?.maxTtlDays))
      if (!Number.isFinite(n) || n < 1 || n > 365) { sendJson(res, 400, { message: msg(req, 'admin.tokenPolicyInvalid') }); return true }
      setSetting('apikey.maxTtlDays', String(n))
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'admin_token_policy', result: 'ok', requestSummary: `maxTtlDays=${n}`, source: 'platform' })
      sendJson(res, 200, { ok: true, maxTtlDays: n })
      return true
    }

    // ====== 会话治理(W3 Task 5):全用户会话列表 + 强制下线 ======
    // GET:JOIN platform_users 补 username/role/disabled(用户行是权威,会话行 role 是登录快照);
    // userAgent 原样回传(前端 uaSummary 摘要);token 不出端点(管理面只需会话元数据)。
    if (url.pathname === '/api/admin/sessions' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const size = Math.min(Math.max(Number(url.searchParams.get('size')) || 50, 1), 200)
      const page = Math.max(Number(url.searchParams.get('page')) || 1, 1)
      const total = Number(db.prepare('SELECT COUNT(*) AS c FROM platform_sessions').get().c) || 0
      const items = db.prepare(`
        SELECT ps.userId AS userId, u.username AS username, u.role AS role, u.disabled AS disabled,
          ps.mfaPending AS mfaPending, ps.ip AS ip, ps.userAgent AS userAgent,
          ps.createdAt AS createdAt, ps.lastSeenAt AS lastSeenAt
        FROM platform_sessions ps LEFT JOIN platform_users u ON u.id = ps.userId
        ORDER BY COALESCE(ps.lastSeenAt, ps.createdAt) DESC LIMIT ? OFFSET ?`).all(size, (page - 1) * size)
      sendJson(res, 200, { items, total, page, size })
      return true
    }
    // DELETE /:userId:强制下线 —— revokeUserSessions 级联单点(内存 Map+platform_sessions+
    // k8s 凭据三处同清),all-sessions 变体无 exceptToken;审计 admin_force_logout。
    if (url.pathname.startsWith('/api/admin/sessions/') && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const userId = decodeURIComponent(url.pathname.slice('/api/admin/sessions/'.length))
      if (!db.prepare('SELECT 1 FROM platform_users WHERE id=?').get(userId)) {
        sendJson(res, 404, { message: msg(req, 'admin.userNotFound') }); return true
      }
      const revoked = revokeUserSessions({ db, platformSessions, sessions }, userId)
      writeAudit?.(db, { owner: ps.username, verb: 'revoke', tool: 'admin_force_logout', result: 'ok', requestSummary: `userId=${userId} revoked=${revoked}`, source: 'platform' })
      sendJson(res, 200, { ok: true, revoked })
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
        {
          const rule = firstFailedRule(password, resolvePasswordPolicy(getSetting))
          if (rule) {
            const key = rule === 'minLength' ? 'admin.passwordTooShort'
              : rule === 'mixed' ? 'auth.passwordNeedMixed'
              : rule === 'digit' ? 'auth.passwordNeedDigit' : 'auth.passwordNeedSymbol'
            sendJson(res, 400, { message: msg(req, key) }); return true
          }
        }
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
      // Wave1 §3.3:删户级联吊销其名下全部用户 key(禁用不落级联——resolveApiKey 运行时已判死,保留可回逆)
      const revokedKeys = db.prepare('UPDATE api_keys SET revokedAt=? WHERE ownerUserId=? AND revokedAt IS NULL').run(Date.now(), id).changes
      db.prepare('DELETE FROM platform_users WHERE id=?').run(id)
      db.prepare('DELETE FROM user_clusters WHERE userId=?').run(id)
      // W2 Phase A(spec §3):删户级联清组员行与 user 侧 ns_grants(孤儿授权残留 = 阴魂授权)
      db.prepare('DELETE FROM group_members WHERE userId=?').run(id)
      db.prepare("DELETE FROM ns_grants WHERE subjectType='user' AND subjectId=?").run(id)
      writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'admin_user_delete', result: 'ok', requestSummary: `id=${id} revokedKeys=${revokedKeys}`, source: 'platform' })
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
      {
        const rule = firstFailedRule(newPassword, resolvePasswordPolicy(getSetting))
        if (rule) {
          const key = rule === 'minLength' ? 'admin.passwordTooShort'
            : rule === 'mixed' ? 'auth.passwordNeedMixed'
            : rule === 'digit' ? 'auth.passwordNeedDigit' : 'auth.passwordNeedSymbol'
          sendJson(res, 400, { message: msg(req, key) }); return true
        }
      }
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
      const old = db.prepare('SELECT clusterId FROM user_clusters WHERE userId=?').all(userId).map(r => r.clusterId)
      db.prepare('DELETE FROM user_clusters WHERE userId=?').run(userId)
      if (Array.isArray(clusterIds)) {
        const stmt = db.prepare('INSERT INTO user_clusters (userId,clusterId,assignedBy,assignedAt) VALUES (?,?,?,?)')
        for (const cid of clusterIds) stmt.run(userId, cid, ps.username, Date.now())
      }
      // W2-0 §0.4-2:被移除的集群 → 立即吊销该用户的存量 K8s session
      const removed = old.filter(cid => !(Array.isArray(clusterIds) && clusterIds.includes(cid)))
      const revokedSessions = revokeUserClusterSessions({ db, sessions, platformSessions }, userId, removed)
      writeAudit?.(db, { owner: ps.username, verb: 'update', tool: 'admin_user_clusters', result: 'ok', requestSummary: `id=${userId} revokedSessions=${revokedSessions}`, source: 'platform' })
      sendJson(res, 200, { clusterIds: clusterIds || [] })
      return true
    }

    // ====== W2 Phase A 授权管理(组/成员/ns_grants/集群 ns 模式)======
    const NS_NAME_RE = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/ // K8s RFC1123 label(与 authorize.mjs NS_NAME 同款)
    if (url.pathname === '/api/admin/groups' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const groups = db.prepare('SELECT id,name,createdAt FROM groups ORDER BY createdAt').all()
      for (const g of groups) {
        g.memberCount = db.prepare('SELECT COUNT(*) c FROM group_members WHERE groupId=?').get(g.id).c
        g.grants = db.prepare("SELECT COUNT(*) c FROM ns_grants WHERE subjectType='group' AND subjectId=?").get(g.id).c
      }
      sendJson(res, 200, { groups }); return true
    }
    if (url.pathname === '/api/admin/groups' && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const { name } = await readBody(req)
      if (!name || !String(name).trim()) { sendJson(res, 400, { message: msg(req, 'admin.groupNameRequired') }); return true }
      const existing = db.prepare('SELECT 1 FROM groups WHERE name=?').get(String(name).trim())
      if (existing) { sendJson(res, 409, { message: msg(req, 'admin.groupNameTaken') }); return true }
      const id = randomUUID()
      const createdAt = Date.now()
      db.prepare('INSERT INTO groups (id,name,createdAt,createdBy) VALUES (?,?,?,?)').run(id, String(name).trim(), createdAt, ps.username)
      writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'admin_group_create', result: 'ok', requestSummary: `id=${id} name=${name}`, source: 'platform' })
      sendJson(res, 200, { group: { id, name: String(name).trim(), createdAt, memberCount: 0, grants: 0 } }); return true
    }
    if (url.pathname.match(/^\/api\/admin\/groups\/[^/]+$/) && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.slice('/api/admin/groups/'.length))
      const group = db.prepare('SELECT id FROM groups WHERE id=?').get(id)
      if (!group) { sendJson(res, 404, { message: msg(req, 'admin.groupOrUserNotFound') }); return true }
      // W2 Phase E:组 grants 行在事务蒸发前捕获(删组 → 集群侧组绑定须随之回收)。
      const grantClusters = deps.teardownGroupCluster
        ? db.prepare("SELECT clusterId, namespace FROM ns_grants WHERE subjectType='group' AND subjectId=?").all(id)
        : []
      // 三表级联(groups/members/该组 grants)单事务:任一失败整体回滚,不留半删组
      db.exec('BEGIN')
      try {
        db.prepare('DELETE FROM groups WHERE id=?').run(id)
        db.prepare('DELETE FROM group_members WHERE groupId=?').run(id)
        db.prepare("DELETE FROM ns_grants WHERE subjectType='group' AND subjectId=?").run(id) // sweepOrphanGrants 组侧语义内联
        db.exec('COMMIT')
      } catch (e) {
        try { db.exec('ROLLBACK') } catch { /* 事务已不在 */ }
        console.error('[admin] group delete transaction failed:', e?.message || e)
        sendJson(res, 500, { message: msg(req, 'admin.saveFailed') }); return true
      }
      // 集群侧回收(fire-and-forget,失败仅 warn——启动 sweep 兜底):每集群全量两档 teardown。
      for (const clusterId of new Set(grantClusters.map(r => r.clusterId))) {
        const namespaces = grantClusters.filter(r => r.clusterId === clusterId).map(r => r.namespace)
        fireGroupDrive(clusterId, row => deps.teardownGroupCluster(row, { groupId: id, namespaces }))
      }
      writeAudit?.(db, { owner: ps.username, verb: 'delete', tool: 'admin_group_delete', result: 'ok', requestSummary: `id=${id}`, source: 'platform' })
      sendJson(res, 200, { ok: true }); return true
    }
    if (url.pathname.match(/^\/api\/admin\/groups\/[^/]+\/members$/) && req.method === 'POST') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const groupId = url.pathname.split('/')[4]
      if (!db.prepare('SELECT 1 FROM groups WHERE id=?').get(groupId)) { sendJson(res, 404, { message: msg(req, 'admin.groupOrUserNotFound') }); return true }
      const { userIds } = await readBody(req)
      if (!Array.isArray(userIds) || !userIds.length) { sendJson(res, 400, { message: msg(req, 'admin.userIdsRequired') }); return true }
      for (const uid of userIds) {
        if (!db.prepare('SELECT 1 FROM platform_users WHERE id=?').get(uid)) { sendJson(res, 404, { message: msg(req, 'admin.groupOrUserNotFound') }); return true }
      }
      const stmt = db.prepare('INSERT OR IGNORE INTO group_members (groupId,userId,addedBy,createdAt) VALUES (?,?,?,?)')
      for (const uid of userIds) stmt.run(groupId, uid, ps.username, Date.now())
      writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'admin_group_members_add', result: 'ok', requestSummary: `group=${groupId} users=${userIds.join(',')}`, source: 'platform' })
      sendJson(res, 200, { ok: true }); return true
    }
    if (url.pathname.match(/^\/api\/admin\/groups\/[^/]+\/members\/[^/]+$/) && req.method === 'DELETE') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const parts = url.pathname.split('/') // ['', 'api','admin','groups',:id,'members',:userId]
      const groupId = parts[4], userId = decodeURIComponent(parts[6])
      if (!db.prepare('SELECT 1 FROM groups WHERE id=?').get(groupId)) { sendJson(res, 404, { message: msg(req, 'admin.groupOrUserNotFound') }); return true }
      if (!db.prepare('SELECT 1 FROM platform_users WHERE id=?').get(userId)) { sendJson(res, 404, { message: msg(req, 'admin.groupOrUserNotFound') }); return true }
      db.prepare('DELETE FROM group_members WHERE groupId=? AND userId=?').run(groupId, userId)
      writeAudit?.(db, { owner: ps.username, verb: 'delete', tool: 'admin_group_member_remove', result: 'ok', requestSummary: `group=${groupId} user=${userId}`, source: 'platform' })
      sendJson(res, 200, { ok: true }); return true
    }
    // 成员清单(Task 5 管理页数据面):join platform_users 取 username/displayName
    if (url.pathname.match(/^\/api\/admin\/groups\/[^/]+\/members$/) && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const groupId = url.pathname.split('/')[4]
      if (!db.prepare('SELECT 1 FROM groups WHERE id=?').get(groupId)) { sendJson(res, 404, { message: msg(req, 'admin.groupOrUserNotFound') }); return true }
      const members = db.prepare('SELECT m.userId AS userId, u.username AS username, u.displayName AS displayName FROM group_members m LEFT JOIN platform_users u ON u.id = m.userId WHERE m.groupId=? ORDER BY u.username').all(groupId)
      sendJson(res, 200, { members }); return true
    }
    // 授权读回(Task 5 管理页编辑器回显):三参缺一即 400,不猜默认主体
    if (url.pathname === '/api/admin/grants' && req.method === 'GET') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const { subjectType, subjectId, clusterId } = Object.fromEntries(url.searchParams)
      if (!['user', 'group'].includes(subjectType) || !subjectId || !clusterId) { sendJson(res, 400, { message: msg(req, 'admin.grantInvalid') }); return true }
      const namespaces = db.prepare('SELECT namespace, level FROM ns_grants WHERE subjectType=? AND subjectId=? AND clusterId=? ORDER BY namespace').all(subjectType, subjectId, clusterId)
      sendJson(res, 200, { namespaces }); return true
    }
    if (url.pathname === '/api/admin/grants' && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      try {
        const input = await readBody(req)
        const { subjectType, subjectId, clusterId } = input || {}
        if (!['user', 'group'].includes(subjectType)) { sendJson(res, 400, { message: msg(req, 'admin.grantInvalid') }); return true }
        const subjectOk = subjectType === 'user'
          ? db.prepare('SELECT 1 FROM platform_users WHERE id=?').get(subjectId)
          : db.prepare('SELECT 1 FROM groups WHERE id=?').get(subjectId)
        if (!subjectOk) { sendJson(res, 400, { message: msg(req, 'admin.grantInvalid') }); return true }
        if (!db.prepare('SELECT 1 FROM clusters WHERE id=?').get(clusterId)) { sendJson(res, 400, { message: msg(req, 'admin.grantInvalid') }); return true }
        const rows = Array.isArray(input.namespaces) ? input.namespaces : []
        for (const r of rows) {
          if (!r || typeof r.namespace !== 'string' || !NS_NAME_RE.test(r.namespace) || r.namespace.length > 63
            || !['view', 'operate'].includes(r.level)) { sendJson(res, 400, { message: msg(req, 'admin.grantInvalid') }); return true }
        }
        // 同一 body 内重复 namespace → 拒(全量替换语义下重复行是调用方 bug,静默去重会掩盖)
        const nsSet = new Set(rows.map(r => r.namespace))
        if (nsSet.size !== rows.length) { sendJson(res, 400, { message: msg(req, 'admin.grantInvalid') }); return true }
        // 全量替换该 subject+cluster 的 grants(单事务:删+插原子,COMMIT 失败整体回滚)
        // W2 Phase E:组 grants 的替换前行在 DELETE 前捕获——提交后旧行蒸发,组绑定驱动要靠它算
        // teardown scope(降档旧名/被收 ns);仅 subjectType='group' 有集群侧绑定。
        const prevRows = subjectType === 'group'
          ? db.prepare("SELECT namespace, level FROM ns_grants WHERE subjectType='group' AND subjectId=? AND clusterId=?").all(subjectId, clusterId)
          : []
        db.exec('BEGIN')
        try {
          db.prepare('DELETE FROM ns_grants WHERE subjectType=? AND subjectId=? AND clusterId=?').run(subjectType, subjectId, clusterId)
          const stmt = db.prepare('INSERT OR IGNORE INTO ns_grants (id,subjectType,subjectId,clusterId,namespace,level,grantedBy,grantedAt) VALUES (?,?,?,?,?,?,?,?)')
          for (const r of rows) stmt.run(randomUUID(), subjectType, subjectId, clusterId, r.namespace, r.level, ps.username, Date.now())
          db.exec('COMMIT')
        } catch (e) {
          try { db.exec('ROLLBACK') } catch { /* 事务已不在 */ }
          console.error('[admin] grants save transaction failed:', e?.message || e)
          sendJson(res, 500, { message: msg(req, 'admin.saveFailed') }); return true
        }
        if (subjectType === 'group') driveGroupAfterReplace(clusterId, subjectId, prevRows) // fire-and-forget,失败仅 warn
        writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'admin_grant_save', result: 'ok', requestSummary: `${subjectType}=${subjectId} cluster=${clusterId} ns=${rows.length}`, source: 'platform' })
        sendJson(res, 200, { ok: true }); return true
      } catch (e) { sendJson(res, 400, { message: msg(req, 'admin.grantInvalid') }); return true }
    }
    if (url.pathname.match(/^\/api\/admin\/clusters\/[^/]+\/ns-auth-mode$/) && req.method === 'PUT') {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = url.pathname.split('/')[4]
      const { mode } = await readBody(req)
      if (!['open', 'allowlist'].includes(mode)) { sendJson(res, 400, { message: msg(req, 'admin.nsModeInvalid') }); return true }
      const cluster = db.prepare('SELECT id FROM clusters WHERE id=?').get(id)
      if (!cluster) { sendJson(res, 404, { message: msg(req, 'admin.clusterNotFound') }); return true }
      db.prepare('UPDATE clusters SET nsAuthMode=? WHERE id=?').run(mode, id)
      // W2 Phase E:切到 allowlist 即对该集群全部组 grants 逐组供给(fire-and-forget)——
      // impersonation 生效前提是组身份在集群侧有 RoleBinding。切回 open 不回收且启动 sweep 不清
      // (其只扫 allowlist 集群)——残留绑定惰性无害(未被引用),下次切回 allowlist 由 sweep 收敛。
      if (mode === 'allowlist' && deps.provisionGroupCluster) {
        for (const [subjectId, plan] of groupBindingPlan(db.prepare("SELECT subjectId, namespace, level FROM ns_grants WHERE subjectType='group' AND clusterId=?").all(id))) {
          fireGroupDrive(id, row => deps.provisionGroupCluster(row, { groupId: subjectId, tier: plan.tier, namespaces: plan.namespaces }))
        }
      }
      writeAudit?.(db, { owner: ps.username, verb: 'write', tool: 'admin_cluster_nsmode', result: 'ok', requestSummary: `id=${id} mode=${mode}`, source: 'platform' })
      sendJson(res, 200, { ok: true, mode }); return true
    }

    return false // 无匹配
  }

  return { handle }
}
