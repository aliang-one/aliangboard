// API-key 工具链(T8 skeleton + T9 有界原语):resolveApiKey + 共用链 runBoundedTool + tools 注册表 + callTool 派发。
// 接线:index.mjs 注入 { db, requestFn(= requestKubernetes) },路由 /api/key/<cluster>/call(POST {tool,args})。
// callTool 是 T12(MCP server)的复用点:MCP tools/call → callTool;tools/list → listTools()。
import { lookupKey, isActive } from './auth-keys.mjs'
import { authorize, PermissionDeniedError } from './authorize.mjs'
import { createSaBinding } from './sa-binding.mjs'
import { reserveAudit, finalizeAudit } from './audit.mjs'
import { buildCallContext } from './call-context.mjs'

const LOG_TAIL_MAX = 500
const LOG_BYTE_MAX = 32768 // 日志输出字节上限(codex #11:单行巨大也会撑爆;Claude Code >10k token 会告警,32KB ≈ 8k token 留余量)
const LIST_MAX = 200
const REPLICA_MAX = 20 // scale 上限(eng-review 9C:禁 scale 到 0 + 范围 guardrail)
const SCALE_KINDS = ['deployments', 'statefulsets']
const RESTART_KINDS = ['deployments', 'statefulsets', 'daemonsets']
const enc = encodeURIComponent

// 解析 API key(Authorization: Bearer)。有效→row;无效/已吊销/空→null。
export function resolveApiKey(db, req) {
  const token = req.headers?.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return null
  const row = lookupKey(db, token)
  return isActive(row) ? row : null
}

// 发现 apiserver issuer(= token audience,prefund 验证),按 apiServer 缓存。
const _issuerCache = new Map()
export function _clearIssuerCacheForTest() { _issuerCache.clear() }
async function getIssuer(requestFn, callCtx) {
  const key = callCtx.apiServer.toString()
  if (_issuerCache.has(key)) return _issuerCache.get(key)
  const { body } = await requestFn(callCtx, '/.well-known/openid-configuration')
  const issuer = body?.issuer || null
  if (issuer) _issuerCache.set(key, issuer)
  return issuer
}

// core 资源 kind → 路径(骨架覆盖最常用;CRD 等走 T12+ 的通用 discovery)。
const LIST_PATH = {
  pods: '/api/v1/namespaces/%ns%/pods',
  services: '/api/v1/namespaces/%ns%/services',
  configmaps: '/api/v1/namespaces/%ns%/configmaps',
  deployments: '/apis/apps/v1/namespaces/%ns%/deployments',
  statefulsets: '/apis/apps/v1/namespaces/%ns%/statefulsets',
  daemonsets: '/apis/apps/v1/namespaces/%ns%/daemonsets',
}
const GET_PATH = {
  pods: (ns, name) => `/api/v1/namespaces/${enc(ns)}/pods/${enc(name)}`,
  services: (ns, name) => `/api/v1/namespaces/${enc(ns)}/services/${enc(name)}`,
  configmaps: (ns, name) => `/api/v1/namespaces/${enc(ns)}/configmaps/${enc(name)}`,
  deployments: (ns, name) => `/apis/apps/v1/namespaces/${enc(ns)}/deployments/${enc(name)}`,
  statefulsets: (ns, name) => `/apis/apps/v1/namespaces/${enc(ns)}/statefulsets/${enc(name)}`,
  daemonsets: (ns, name) => `/apis/apps/v1/namespaces/${enc(ns)}/daemonsets/${enc(name)}`,
}
const WORKLOADS = ['deployments', 'statefulsets', 'daemonsets']
function slimPod(p) { return { name: p.metadata?.name, phase: p.status?.phase, ready: (p.status?.containerStatuses || []).map(c => ({ name: c.name, ready: c.ready })) } }
function slimWorkload(d) { return { name: d.metadata?.name, ready: d.status?.readyReplicas || 0, desired: d.spec?.replicas || 0, updated: d.status?.updatedReplicas || 0 } }

// pod 文件路径校验:只放行安全字符(防 shell 注入;admin 档虽已可信 exec,仍做纵深防御)
function safePodPath(p) {
  if (!p || typeof p !== 'string') throw new Error('路径为空')
  if (!/^[a-zA-Z0-9._/~: -]+$/.test(p)) throw new Error(`路径含非法字符(仅允许字母数字 . _ / ~ : - 空格): ${p.slice(0, 40)}`)
  return p
}

export function createApiKeyTools({ db, requestFn, execFn, applyYamlFn }) {
  // 共用链:authorize → ns 作用域 → reserve 审计 → 现签 SA token → SA-token ctx → fn → finalize。
  // deny/error 各路径审计。fn 拿 saCtx(无原始 dispatcher 访问器,结构性 enforcement)。
  async function runBoundedTool({ keyRow, cluster, tool, namespace, verb, resource, summary, fn }) {
    const intent = { keyId: keyRow.id, owner: keyRow.owner, clusterId: keyRow.clusterId, namespace, verb, resource, tool, requestSummary: summary }
    const decision = authorize(keyRow, tool)
    if (!decision.allowed) { finalizeAudit(db, intent, { result: 'denied', reason: decision.reason }); throw new PermissionDeniedError(decision.reason, { tool }) }
    if (namespace !== keyRow.boundSA_namespace) { finalizeAudit(db, intent, { result: 'denied', reason: 'policy' }); throw new PermissionDeniedError('policy', { tool, detail: 'namespace 超出绑定 SA 作用域' }) }
    reserveAudit(db, intent)
    try {
      const bootstrapCtx = buildCallContext({ apiServer: cluster.apiServer, authHeader: cluster.authHeader, ca: cluster.ca, cert: cluster.cert, key: cluster.key, insecure: !!cluster.insecure })
      const audience = await getIssuer(requestFn, bootstrapCtx)
      const token = await createSaBinding({ requestFn, audience })(bootstrapCtx, { namespace: keyRow.boundSA_namespace, name: keyRow.boundSA_name })
      const saCtx = buildCallContext({ apiServer: cluster.apiServer, authHeader: `Bearer ${token}`, ca: cluster.ca, insecure: !!cluster.insecure })
      const out = await fn(saCtx)
      finalizeAudit(db, intent, { result: 'ok' })
      return out
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') throw e
      finalizeAudit(db, intent, { result: 'error', reason: e.status ? `http${e.status}` : (e.reason || 'error') })
      throw e
    }
  }

  const tools = {
    get_pod_logs: async (keyRow, cluster, a) => {
      const tailN = Math.min(Math.max(Number(a.tail) || LOG_TAIL_MAX, 1), LOG_TAIL_MAX)
      return runBoundedTool({ keyRow, cluster, tool: 'get_pod_logs', namespace: a.namespace, verb: 'get', resource: `Pod/${a.pod}`,
        summary: `pod=${a.pod} container=${a.container || ''} tail=${tailN}`,
        fn: async (saCtx) => {
          const q = new URLSearchParams({ tailLines: String(tailN) }); if (a.container) q.set('container', a.container)
          const { body } = await requestFn(saCtx, `/api/v1/namespaces/${enc(a.namespace)}/pods/${enc(a.pod)}/log?${q}`)
          // 字节上限(codex #11):单行巨大的日志也会撑爆输出。截断 + 标志,让 AI 知道要更小 tail 重试。
          const buf = Buffer.from(typeof body === 'string' ? body : String(body ?? ''), 'utf8')
          const originalBytes = buf.length
          const truncated = originalBytes > LOG_BYTE_MAX
          const logs = truncated ? buf.subarray(0, LOG_BYTE_MAX).toString('utf8') : buf.toString('utf8')
          return { logs, tail: tailN, truncated, originalBytes, byteCap: LOG_BYTE_MAX }
        } })
    },
    list_resources: async (keyRow, cluster, a) => {
      const kind = String(a.kind || 'pods').toLowerCase()
      const templ = LIST_PATH[kind]
      if (!templ) throw new PermissionDeniedError('policy', { tool: 'list_resources', detail: `不支持的 kind: ${kind}(骨架:pods/services/configmaps/deployments/statefulsets/daemonsets)` })
      return runBoundedTool({ keyRow, cluster, tool: 'list_resources', namespace: a.namespace, verb: 'list', resource: kind, summary: `kind=${kind}`,
        fn: async (saCtx) => {
          const { body } = await requestFn(saCtx, templ.replace('%ns%', enc(a.namespace)))
          const all = body?.items || []
          const items = all.slice(0, LIST_MAX).map(it => kind === 'pods' ? slimPod(it) : WORKLOADS.includes(kind) ? slimWorkload(it) : { name: it.metadata?.name })
          return { kind, count: all.length, returned: items.length, items }
        } })
    },
    get_resource: async (keyRow, cluster, a) => {
      const kind = String(a.kind || 'pods').toLowerCase()
      const getter = GET_PATH[kind]
      if (!getter) throw new PermissionDeniedError('policy', { tool: 'get_resource', detail: `不支持的 kind: ${kind}` })
      return runBoundedTool({ keyRow, cluster, tool: 'get_resource', namespace: a.namespace, verb: 'get', resource: `${kind}/${a.name}`, summary: `kind=${kind} name=${a.name}`,
        fn: async (saCtx) => {
          const { body } = await requestFn(saCtx, getter(a.namespace, a.name))
          if (body?.metadata?.managedFields) delete body.metadata.managedFields // 去噪
          return { resource: body }
        } })
    },
    get_events: async (keyRow, cluster, a) => {
      return runBoundedTool({ keyRow, cluster, tool: 'get_events', namespace: a.namespace, verb: 'list', resource: 'events', summary: `for=${a.name || '(all)'}`,
        fn: async (saCtx) => {
          const url = a.name
            ? `/api/v1/namespaces/${enc(a.namespace)}/events?fieldSelector=${enc('involvedObject.name=' + a.name)}`
            : `/api/v1/namespaces/${enc(a.namespace)}/events`
          const { body } = await requestFn(saCtx, url)
          const all = body?.items || []
          const items = all.slice(0, LIST_MAX).map(e => ({ reason: e.reason, type: e.type, message: String(e.message || '').slice(0, 300), last: e.lastTimestamp }))
          return { count: all.length, returned: items.length, items }
        } })
    },
    scale: async (keyRow, cluster, a) => {
      const kind = String(a.kind || '').toLowerCase()
      return runBoundedTool({ keyRow, cluster, tool: 'scale', namespace: a.namespace, verb: 'patch', resource: `${kind}/${a.name}`, summary: `${kind}/${a.name} → ${a.replicas}`,
        fn: async (saCtx) => {
          if (!SCALE_KINDS.includes(kind)) throw new Error(`scale 仅支持 ${SCALE_KINDS.join('/')},不是 ${kind}`)
          const replicas = Number(a.replicas)
          if (!Number.isInteger(replicas) || replicas < 1 || replicas > REPLICA_MAX) throw new Error(`replicas 必须是 1..${REPLICA_MAX} 的整数(禁止 scale 到 0 / 异常值)`)
          const { body } = await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/${kind}/${enc(a.name)}/scale`, { method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify({ spec: { replicas } }) })
          return { kind, name: a.name, replicas: body?.spec?.replicas ?? replicas }
        } })
    },
    restart: async (keyRow, cluster, a) => {
      const kind = String(a.kind || '').toLowerCase()
      return runBoundedTool({ keyRow, cluster, tool: 'restart', namespace: a.namespace, verb: 'patch', resource: `${kind}/${a.name}`, summary: `${kind}/${a.name}`,
        fn: async (saCtx) => {
          if (!RESTART_KINDS.includes(kind)) throw new Error(`restart 仅支持 ${RESTART_KINDS.join('/')},不是 ${kind}`)
          const restartedAt = new Date().toISOString()
          await requestFn(saCtx, `/apis/apps/v1/namespaces/${enc(a.namespace)}/${kind}/${enc(a.name)}`, { method: 'PATCH', headers: { 'content-type': 'application/strategic-merge-patch+json' }, body: JSON.stringify({ spec: { template: { metadata: { annotations: { 'kubectl.kubernetes.io/restartedAt': restartedAt } } } } }) })
          return { kind, name: a.name, restartedAt }
        } })
    },
    exec_pod: async (keyRow, cluster, a) => {
      const command = Array.isArray(a.command) ? a.command.join(' ') : String(a.command || '')
      return runBoundedTool({ keyRow, cluster, tool: 'exec_pod', namespace: a.namespace, verb: 'exec', resource: `Pod/${a.pod}`, summary: `pod=${a.pod} c=${a.container || ''} cmd=${command.slice(0, 80)}`,
        fn: async (saCtx) => {
          if (!execFn) throw new Error('exec_pod 未启用(网关未注入 execFn)')
          if (!command) throw new Error('exec_pod 缺 command')
          const r = await execFn(saCtx, a.namespace, a.pod, a.container || '', command)
          return { pod: a.pod, container: a.container || '', exitCode: r.status ?? null, stdout: (r.stdout?.toString('utf8') || '').slice(0, 32768), stderr: (r.stderr || '').slice(0, 8192) }
        } })
    },
    browse_files: async (keyRow, cluster, a) => runBoundedTool({
      keyRow, cluster, tool: 'browse_files', namespace: a.namespace, verb: 'get', resource: `Pod/${a.pod}/files`, summary: `pod=${a.pod} path=${(a.path || '/').slice(0, 80)}`,
      fn: async (saCtx) => {
        if (!execFn) throw new Error('browse_files 未启用')
        const r = await execFn(saCtx, a.namespace, a.pod, a.container || '', `ls -la ${safePodPath(a.path || '/')}`)
        return { pod: a.pod, path: a.path || '/', listing: (r.stdout?.toString('utf8') || '').slice(0, 32768) }
      } }),
    read_file: async (keyRow, cluster, a) => runBoundedTool({
      keyRow, cluster, tool: 'read_file', namespace: a.namespace, verb: 'get', resource: `Pod/${a.pod}/file`, summary: `pod=${a.pod} path=${(a.path || '').slice(0, 80)}`,
      fn: async (saCtx) => {
        if (!execFn) throw new Error('read_file 未启用')
        if (!a.path) throw new Error('read_file 缺 path')
        const r = await execFn(saCtx, a.namespace, a.pod, a.container || '', `cat ${safePodPath(a.path)}`)
        return { pod: a.pod, path: a.path, content: (r.stdout?.toString('utf8') || '').slice(0, 32768) }
      } }),
    apply_yaml: async (keyRow, cluster, a) => runBoundedTool({
      keyRow, cluster, tool: 'apply_yaml', namespace: keyRow.boundSA_namespace, verb: 'apply', resource: 'yaml', summary: `apply yaml ${(a.yaml || '').length} chars`,
      fn: async (saCtx) => {
        if (!applyYamlFn) throw new Error('apply_yaml 未启用(网关未注入 applyYamlFn)')
        if (!a.yaml || !a.yaml.trim()) throw new Error('apply_yaml 缺 yaml')
        return applyYamlFn(saCtx, a.yaml)
      } }),
  }

  // 派发:T12 MCP tools/call → callTool;未知工具 → policy 拒(不暴露 tool 存在与否的细节过度,这里直接报)。
  async function callTool(keyRow, cluster, tool, args) {
    const fn = tools[tool]
    if (!fn) throw new PermissionDeniedError('policy', { tool, detail: `未知工具: ${tool}` })
    return fn(keyRow, cluster, args || {})
  }

  return { callTool, getPodLogs: tools.get_pod_logs, listTools: () => Object.keys(tools) }
}
