// Preflight MCP server (T2b) — minimal STATELESS Streamable HTTP MCP server.
// 目的:验证 Claude Code / Cursor 能用 --transport http 连上、能发 Authorization: Bearer、
//       有界 tool result 能 roundtrip。这是 T12(MCP server)的原型,也是 codex #18 的 gating 检查。
//
// 跑:  node scripts/preflight-mcp.mjs          (监听 127.0.0.1:9111/mcp)
// 连:  claude mcp add --transport http preflight http://127.0.0.1:9111/mcp \
//        --header "Authorization: Bearer dev-preflight-key"
//       然后在 Claude Code 里看 preflight 工具是否出现、echo/cluster_ping 是否返回。
//
// 设计要点(也指导 T12):
//  - Streamable HTTP(spec 2025-11-25):单端点 /mcp,POST JSON-RPC,application/json 同步响应。
//  - 无状态:不开 GET/SSE server→client 流(同步有界 tool 不需要);GET 返回 405。
//  - 鉴权:校验 Authorization: Bearer,但 preflight 不 block(只报告是否收到),免得 auth 配置问题掩盖传输测试。
//  - 有界:cluster_ping 强制 1..20 行上限(验证"有界 tool result"语义)。
import { createServer } from 'node:http'

const HOST = '127.0.0.1'
const PORT = 9111
const EXPECTED = 'Bearer dev-preflight-key'
const PROTOCOL = '2025-11-25'

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const err = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
const send = (res, obj, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(obj))
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, mcp-session-id')
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS, DELETE')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const { pathname } = new URL(req.url, `http://${req.headers.host}`)
  if (pathname !== '/mcp') { res.writeHead(404); return res.end('not found') }

  const authHeader = req.headers['authorization'] || ''
  const tokenOk = authHeader === EXPECTED

  if (req.method === 'GET') {
    // 无状态同步 server:不支持 server→client 流。
    return send(res, err(null, -32000, 'GET streaming not supported; use POST (stateless synchronous tools)'), 405)
  }
  if (req.method === 'DELETE') { res.writeHead(200); return res.end() } // 会话关闭,stateless:ack
  if (req.method !== 'POST') { res.writeHead(405); return res.end() }

  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let msg
    try { msg = JSON.parse(body) } catch { return send(res, err(null, -32700, 'parse error'), 400) }

    // notification(无 id)→ 202
    if (msg.id === undefined || msg.id === null) { res.writeHead(202); return res.end() }

    const { id, method, params } = msg
    if (method === 'initialize') {
      res.setHeader('Mcp-Session-Id', 'preflight-session')
      return send(res, ok(id, {
        protocolVersion: PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'aliangboard-preflight', version: '0.0.1' }
      }))
    }
    if (method === 'tools/list') {
      return send(res, ok(id, { tools: [
        { name: 'echo', description: '回显文本 + 报告鉴权状态(preflight)。', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
        { name: 'cluster_ping', description: '返回 1..20 行样本,验证有界 tool result。', inputSchema: { type: 'object', properties: { lines: { type: 'number' } } } }
      ]}))
    }
    if (method === 'tools/call') {
      const name = params?.name
      const args = params?.arguments || {}
      if (name === 'echo') {
        return send(res, ok(id, { content: [{ type: 'text', text: `echo: ${args.text ?? '(empty)'} | auth_header=${tokenOk ? 'ok' : 'MISSING'}` }] }))
      }
      if (name === 'cluster_ping') {
        const n = Math.min(Math.max(Number(args.lines) || 5, 1), 20) // 硬上限:有界
        const lines = Array.from({ length: n }, (_, i) => `preflight line ${i + 1}`)
        return send(res, ok(id, { content: [{ type: 'text', text: lines.join('\n') }] }))
      }
      return send(res, err(id, -32601, `unknown tool: ${name}`))
    }
    return send(res, err(id, -32601, `method not found: ${method}`))
  })
})

server.listen(PORT, HOST, () => {
  console.log(`preflight MCP server: http://${HOST}:${PORT}/mcp`)
  console.log(`  claude mcp add --transport http preflight http://${HOST}:${PORT}/mcp --header "Authorization: Bearer dev-preflight-key"`)
})
