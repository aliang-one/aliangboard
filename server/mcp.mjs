// MCP server(T12):把底座 callTool 暴露成 Streamable HTTP MCP,外部 AI 客户端(Claude Code)用 API key 连。
// 传输:无状态 Streamable HTTP(POST-only,JSON 响应;codex #18:同步有界 tool 不需 GET/SSE 流)。
// 鉴权:Authorization: Bearer <apikey>——key 决定 cluster + SA + tier;endpoint /mcp 不含 cluster(eng-review 4A:同进程独立路由)。
import { resolveApiKey } from './api-key-tools.mjs'
import { checkRate } from './rate-limit.mjs'
import { effectiveTools } from './authorize.mjs'
import { registry } from './tool-registry.mjs'

const PROTOCOL = '2025-11-25'

// MCP tool 元数据(描述 + inputSchema):从 tool-registry 派生(单一源,schema 在 tool-registry.mjs)。
// tools/list 按调用者 effectiveTools 过滤(tier ∪ per-key tool_overrides 覆盖;只列能用的,不广告用不了的)。
export const TOOL_META = registry.toMeta()

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })

// 纯逻辑:处理一条 JSON-RPC 消息 → 响应对象(或 null=notification)。可单测,无 HTTP。
export async function handleMcpMessage(msg, { keyRow, cluster, apiKeyTools }) {
  if (!msg || typeof msg !== 'object') return err(null, -32600, 'invalid request')
  if (msg.id == null) return null // notification(如 notifications/initialized)→ 无响应
  const { id, method, params } = msg

  if (method === 'initialize') return ok(id, { protocolVersion: PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'aliangboard', version: '0.1.0' } })

  if (method === 'tools/list') {
    const allowed = effectiveTools(keyRow)
    const tools = apiKeyTools.listTools().filter(t => allowed.has(t)).map(t => ({ name: t, ...TOOL_META[t] }))
    return ok(id, { tools })
  }

  if (method === 'tools/call') {
    const name = params?.name
    if (!cluster) return ok(id, { isError: true, content: [{ type: 'text', text: '集群不存在(API key 绑定的集群已删除?)' }] })
    try {
      const out = await apiKeyTools.callTool(keyRow, cluster, name, params?.arguments || {}, 'mcp')
      return ok(id, { content: [{ type: 'text', text: JSON.stringify(out) }] })
    } catch (e) {
      if (e.code === 'PERMISSION_DENIED') return err(id, -32603, `PERMISSION_DENIED(${e.reason}): ${e.message}`)
      return ok(id, { isError: true, content: [{ type: 'text', text: e.message || String(e) }] })
    }
  }

  return err(id, -32601, `method not found: ${method}`)
}

// HTTP 包装:鉴权 + 解析 body + 派发 handleMcpMessage + 写响应(stateless Streamable HTTP)。
export function createMcpServer({ db, apiKeyTools }) {
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
    if (!_rl.allowed) return write(res, err(null, -32002, `RATE_LIMITED,${_rl.retryAfter}s 后重试`), 429)

    let msg
    try { msg = await readBody(req) } catch { return write(res, err(null, -32700, 'parse error'), 400) }

    const cluster = db.prepare('SELECT * FROM clusters WHERE id=?').get(keyRow.clusterId)
    const resp = await handleMcpMessage(msg, { keyRow, cluster, apiKeyTools })
    if (resp == null) { res.writeHead(202); return res.end() } // notification
    if (msg.method === 'initialize') return write(res, resp, 200, { 'Mcp-Session-Id': 'mcp-' + String(keyRow.id).slice(0, 8) })
    return write(res, resp)
  }
}
