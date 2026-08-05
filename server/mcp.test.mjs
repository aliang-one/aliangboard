// T12 测试:handleMcpMessage 纯逻辑(initialize / tools/list 按 tier / tools/call / 错误)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { handleMcpMessage, TOOL_META } from './mcp.mjs'

function mockTools({ callTool } = {}) {
  return {
    listTools: () => ['get_pod_logs', 'list_resources', 'get_resource', 'get_events'],
    callTool: callTool || (async (k, c, t, a) => ({ tool: t, args: a, ns: k.boundSA_namespace })),
  }
}
const readKey = { id: 'k1', owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', tier: 'read' }
const opKey = { ...readKey, tier: 'operator' }
const cluster = { id: 'c1', apiServer: 'https://10.0.0.1:6443' }

test('initialize: 返回 protocolVersion + capabilities + serverInfo', async () => {
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  assert.equal(r.id, 1)
  assert.equal(r.result.protocolVersion, '2025-11-25')
  assert.ok(r.result.capabilities.tools)
  assert.equal(r.result.serverInfo.name, 'aliangboard')
})

test('tools/list(read): 只列 tier 允许的工具(各带 description + inputSchema)', async () => {
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  const names = r.result.tools.map(t => t.name)
  assert.ok(names.includes('get_pod_logs') && names.includes('list_resources'))
  assert.ok(!names.includes('exec_pod'), 'read 不应含危险工具')
  // 每个工具带 meta
  for (const t of r.result.tools) { assert.ok(t.description); assert.ok(t.inputSchema) }
})

test('tools/list: 按 tier 过滤(同 read 集合,因注册的都是有界只读)', async () => {
  const rOp = await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, { keyRow: opKey, cluster, apiKeyTools: mockTools() })
  assert.ok(rOp.result.tools.length >= 4, 'operator 至少含 read 的工具')
})

test('tools/call: 调 callTool → MCP content(JSON)', async () => {
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_resources', arguments: { namespace: 'ns', kind: 'pods' } } }, { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  assert.equal(r.id, 4)
  assert.equal(r.result.content[0].type, 'text')
  const parsed = JSON.parse(r.result.content[0].text)
  assert.equal(parsed.tool, 'list_resources')
})

test('tools/call: callTool 抛 PERMISSION_DENIED → MCP error(非 isError,明确拒)', async () => {
  const tools = mockTools({ callTool: async () => { const e = new Error('no'); e.code = 'PERMISSION_DENIED'; e.reason = 'policy'; throw e } })
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'exec_pod', arguments: {} } }, { keyRow: readKey, cluster, apiKeyTools: tools })
  assert.ok(r.error)
  assert.equal(r.error.code, -32603)
  assert.match(r.error.message, /PERMISSION_DENIED\(policy\)/)
})

test('tools/call: 非权限错(kube 失败)→ isError result(让 AI 看到错误文本)', async () => {
  const tools = mockTools({ callTool: async () => { throw new Error('pod not found') } })
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'get_pod_logs', arguments: {} } }, { keyRow: readKey, cluster, apiKeyTools: tools })
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /pod not found/)
})

test('tools/call: 集群不存在 → isError', async () => {
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_resources', arguments: {} } }, { keyRow: readKey, cluster: null, apiKeyTools: mockTools() })
  assert.equal(r.result.isError, true)
})

test('未知 method → -32601', async () => {
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 8, method: 'prompts/list' }, { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  assert.equal(r.error.code, -32601)
})

test('notification(无 id)→ null(无响应)', async () => {
  const r = await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  assert.equal(r, null)
})
