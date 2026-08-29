// MCP server(T12):把底座 callTool 暴露成 Streamable HTTP MCP,外部 AI 客户端(Claude Code)用 API key 连。
// 传输:无状态 Streamable HTTP(POST-only,JSON 响应;codex #18:同步有界 tool 不需 GET/SSE 流)。
// 鉴权:Authorization: Bearer <apikey>——key 决定 cluster + SA + tier;endpoint /mcp 不含 cluster(eng-review 4A:同进程独立路由)。
import { resolveApiKey } from './api-key-tools.mjs'
import { checkRate } from './rate-limit.mjs'
import { effectiveTools, SSH_KEY_TOOLS } from './authorize.mjs'
import { createSshAgentBridge } from './ssh/agent-bridge.mjs'
import { reserveAudit, finalizeAudit } from './audit.mjs'
import { registry } from './tool-registry.mjs'

// 支持的协议版本(按新→旧;最后一个是「自己最新」)。我们只实现 initialize/ping/tools 的
// POST-only 无状态子集,该子集在所列版本间 wire 兼容 → 客户端请求哪个就回显哪个。
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-11-25']
const PROTOCOL = SUPPORTED_PROTOCOL_VERSIONS[SUPPORTED_PROTOCOL_VERSIONS.length - 1]

// MCP tool 元数据(描述 + inputSchema):从 tool-registry 派生(单一源,schema 在 tool-registry.mjs)。
// tools/list 按调用者 effectiveTools 过滤(tier ∪ per-key tool_overrides 覆盖;只列能用的,不广告用不了的)。
export const TOOL_META = registry.toMeta()

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

// 工具异常 → AI 可读文本([object Object] 家族灭绝,2026-08-27):当前工具链 throw 均为
// Error/PermissionDeniedError(e.message 恒有),但未来新工具 throw 裸对象/字符串时,
// String(obj) 会塌成 [object Object](get_pod_logs previous=true 同族事故的协议层残留点)。
// 契约:Error → message;字符串 → 原文;其它 → JSON 序列化(序列化自身失败才 String 兜底)。
function describeThrow(e) {
  if (e?.message) return String(e.message)
  if (typeof e === 'string') return e
  try { const j = JSON.stringify(e); return j ?? String(e) } catch { return String(e) }
}

// 纯逻辑:处理一条 JSON-RPC 消息 → 响应对象(或 null=notification)。可单测,无 HTTP。
export async function handleMcpMessage(msg, { keyRow, cluster, apiKeyTools, db = null, sshBridgeFor = () => { throw new Error('ssh bridge unavailable') } }) {
  if (!msg || typeof msg !== 'object') return err(null, -32600, 'invalid request')
  if (Array.isArray(msg)) return err(null, -32600, 'invalid request: batch(JSON-RPC 数组)不支持,请逐条 POST') // 审计 P2:数组曾被当 notification 静默吞成 202
  if (msg.id == null) return null // notification(如 notifications/initialized)→ 无响应
  const { id, method, params } = msg

  if (method === 'ping') return ok(id, {}) // spec 要求 server 响应 ping(空 result);此前 -32601 会让部分客户端断连/重连

  // 版本协商(审计 P2):支持客户端请求的版本就回显,否则回自己最新(由客户端决定是否断开)
  if (method === 'initialize') {
    const requested = params?.protocolVersion
    const negotiated = SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL
    return ok(id, { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: { name: 'aliangboard', version: '0.1.0' } })
  }

  if (method === 'tools/list') {
    const allowed = effectiveTools(keyRow)
    const tools = apiKeyTools.listTools().filter(t => allowed.has(t)).map(t => ({ name: t, ...TOOL_META[t] }))
    if (keyRow?.sshAccess) for (const n of SSH_KEY_TOOLS) if (allowed.has(n) && TOOL_META[n]) tools.push({ name: n, ...TOOL_META[n] })
    return ok(id, { tools })
  }

  if (method === 'tools/call') {
    const name = params?.name
    // per-key SSH 工具先于集群守卫分派:SSH 通道不依赖 K8s 集群(key 可只授 SSH 不绑集群)。
    // 曾放反位置 → 「集群不存在」把 SSH 调用全数拦死(2026-08-29 e2e 实测抓出)。
    if (SSH_KEY_TOOLS.includes(name)) {
      if (!effectiveTools(keyRow).has(name)) return err(id, -32603, 'PERMISSION_DENIED(policy): 该 key 未授予 SSH 服务器访问')
      const bridge = sshBridgeFor(keyRow)
      const args = params?.arguments || {}
      const intent = { owner: keyRow.owner || keyRow.prefix || 'key', clusterId: keyRow.clusterId || null,
        verb: name === 'wb_ssh_exec' ? 'write' : 'read', resource: args?.server ? `SshServer/${args.server}` : 'SshLedger',
        tool: name, source: 'mcp', requestSummary: JSON.stringify(args).slice(0, 120) }
      reserveAudit(db, intent)
      try {
        const out = name === 'read_server_ledger' ? bridge.readLedger(args)
          : name === 'wb_ssh_read_file' ? await bridge.readFile(args)
          : await bridge.exec(args)
        finalizeAudit(db, intent, out?.error ? { result: 'error', reason: String(out.error?.message || out.error).slice(0, 80) } : { result: 'ok' })
        return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }] })
      } catch (e) {
        finalizeAudit(db, intent, { result: 'error', reason: String(e?.message || e).slice(0, 80) })
        return ok(id, { isError: true, content: [{ type: 'text', text: describeThrow(e) }] })
      }
    }
    if (!cluster) return ok(id, { isError: true, content: [{ type: 'text', text: '集群不存在(API key 绑定的集群已删除?)' }] })
    try {
      const out = await apiKeyTools.callTool(keyRow, cluster, name, params?.arguments || {}, 'mcp')
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }] })
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') return err(id, -32603, `PERMISSION_DENIED(${e.reason}): ${e.detail || e.message}`)
      return ok(id, { isError: true, content: [{ type: 'text', text: describeThrow(e) }] })
    }
  }

  return err(id, -32601, `method not found: ${method}`)
}

// HTTP 包装:鉴权 + 解析 body + 派发 handleMcpMessage + 写响应(stateless Streamable HTTP)。
export function createMcpServer({ db, apiKeyTools, cryptKey, sshPool, getSetting = () => '', setSetting = () => {} }) {
  // key 主体 SSH 桥(2026-08-29 per-key sshAccess):keyMode 策略闸在桥内(always→拒 exec,
  // readonly→仅只读命令,none→放行;台账写恒拒)。每 key 一个懒建桥,actor 记 key 前缀。
  const sshBridges = new Map()
  function sshBridgeFor(keyRow) {
    const id = keyRow.id || keyRow.prefix
    if (!sshBridges.has(id)) sshBridges.set(id, createSshAgentBridge({
      db, key: cryptKey, pool: sshPool, projectId: '__key__', actor: keyRow.prefix || keyRow.owner || 'key',
      getSetting, setSetting, keyMode: true,
    }))
    return sshBridges.get(id)
  }
  async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); const b = Buffer.concat(chunks).toString('utf8'); return b ? JSON.parse(b) : {} }
  function write(res, obj, status = 200, headers = {}) { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)) }

  return async function handleMcp(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-session-id')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE')
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }
    if (req.method === 'DELETE') { res.writeHead(200); return res.end() } // 会话关闭,stateless:ack
    if (req.method === 'GET') return write(res, err(null, -32000, 'stateless server: 用 POST(同步有界 tool,无 GET 流)'), 405) // codex #18
    if (req.method !== 'POST') { res.writeHead(405); return res.end() }

    const keyRow = resolveApiKey(db, req)
    if (!keyRow) return write(res, err(null, -32001, '无效或已吊销的 API key'), 401)
    const _rl = checkRate(keyRow.id)
    if (!_rl.allowed) return write(res, err(null, -32002, `RATE_LIMITED,${_rl.retryAfter}s 后重试`), 429, { 'Retry-After': String(_rl.retryAfter) })

    let msg
    try { msg = await readBody(req) } catch { return write(res, err(null, -32700, 'parse error'), 400) }

    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(keyRow.clusterId)
    const resp = await handleMcpMessage(msg, { keyRow, cluster, apiKeyTools, db, sshBridgeFor })
    if (resp == null) { res.writeHead(202); return res.end() } // notification
    if (msg.method === 'initialize') return write(res, resp, 200, { 'Mcp-Session-Id': 'mcp-' + String(keyRow.id).slice(0, 8) })
    return write(res, resp)
  }
}
