// T12 测试:handleMcpMessage 纯逻辑(initialize / tools/list 按 tier / tools/call / 错误)。
// + HTTP 层(2026-08-14 审计 P2:429 Retry-After 头)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { handleMcpMessage, TOOL_META, createMcpServer } from './mcp.mjs'
import { createApiKeysSchema, mintKey } from './auth-keys.mjs'
import { ensureSshSchema } from './ssh/store.mjs'
import { createAuditSchema } from './audit.mjs'
import { checkRate } from './rate-limit.mjs'

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

test('tools/call: PERMISSION_DENIED 带 detail → MCP error 含 detail(可诊断,非裸 policy)', async () => {
  const tools = mockTools({ callTool: async () => { const e = new Error('PERMISSION_DENIED: policy'); e.code = 'PERMISSION_DENIED'; e.reason = 'policy'; e.detail = "namespace 'default' 超出该 API key 绑定作用域 'anydoor'"; throw e } })
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_resources', arguments: {} } }, { keyRow: readKey, cluster, apiKeyTools: tools })
  assert.equal(r.error.code, -32603)
  assert.match(r.error.message, /namespace 'default' 超出该 API key 绑定作用域 'anydoor'/, 'error 应含 detail,不是裸 PERMISSION_DENIED: policy')
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

test('tools/call: 经 MCP 路传 source=mcp 给 callTool', async () => {
  let captured = null
  const apiKeyTools = { ...mockTools(), callTool: async (k, c, t, a, source) => { captured = source; return { tool: t } } }
  await handleMcpMessage({ jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'list_resources', arguments: { namespace: 'ns' } } }, { keyRow: readKey, cluster, apiKeyTools })
  assert.equal(captured, 'mcp')
})

test('tools/list(覆盖): effectiveTools allow 把 admin 工具暴露给 read key', async () => {
  const readWithAllow = { ...readKey, tool_overrides: JSON.stringify({ allow: ['exec_pod'] }) }
  // 内联 apiKeyTools:listTools 含 exec_pod(mockTools 的 listTools 不含,会被 .filter 过滤掉)
  const apiKeyTools = { listTools: () => ['get_pod_logs', 'list_resources', 'get_resource', 'get_events', 'exec_pod'], callTool: async () => ({}) }
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, { keyRow: readWithAllow, cluster, apiKeyTools })
  const names = r.result.tools.map(t => t.name)
  assert.ok(names.includes('exec_pod'), 'allow 越过 tier 出现在 tools/list')
})

// --- P2 协议修补(2026-08-14 审计)---
test('ping: 返回空 result(spec 要求 server 响应 ping;此前 -32601 可能触发客户端断连/重连)', async () => {
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 20, method: 'ping' }, { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  assert.equal(r.error, undefined)
  assert.deepEqual(r.result, {})
})

test('initialize(版本协商): 客户端请求受支持版本 → 回显;未知/缺失 → 回自己最新', async () => {
  const echo = await handleMcpMessage({ jsonrpc: '2.0', id: 21, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '0' } } }, { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  assert.equal(echo.result.protocolVersion, '2025-06-18', '受支持版本应回显客户端请求')
  const unknown = await handleMcpMessage({ jsonrpc: '2.0', id: 22, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  assert.equal(unknown.result.protocolVersion, '2025-11-25', '不支持的版本 → 回自己最新')
})

test('JSON-RPC batch(数组 body): → -32600 明确拒(此前被当 notification 静默吞成 202 空响应)', async () => {
  const r = await handleMcpMessage([{ jsonrpc: '2.0', id: 1, method: 'ping' }], { keyRow: readKey, cluster, apiKeyTools: mockTools() })
  assert.equal(r.error.code, -32600)
  assert.match(r.error.message, /batch/)
})

test('HTTP 层: 限流 429 → 带 Retry-After HTTP 头(此前只在 error message 里)', async () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  const minted = mintKey(db, { owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  for (let i = 0; i < 500; i++) checkRate(minted.id) // 抽干该 key 的 token bucket(capacity 默认 60)
  const handler = createMcpServer({ db, apiKeyTools: mockTools() })
  const req = {
    headers: { authorization: `Bearer ${minted.plaintext}` },
    method: 'POST',
    async *[Symbol.asyncIterator]() { yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}') },
  }
  const headers = {}
  const res = {
    statusCode: null, body: null,
    setHeader(k, v) { headers[k.toLowerCase()] = v },
    writeHead(status, h = {}) { this.statusCode = status; for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v }, // 头名统一小写(HTTP 大小写不敏感)
    end(b) { this.body = b ? JSON.parse(b) : null },
  }
  await handler(req, res)
  assert.equal(res.statusCode, 429)
  assert.ok(Number(headers['retry-after']) >= 1, `Retry-After 头(实际 ${headers['retry-after']})`)
  assert.equal(res.body.error.code, -32002)
})

// 2026-08-27 [object Object] 家族灭绝扫尾:callTool 抛「非 Error 对象」(理论路径——未来
// 新工具 throw 裸对象/字符串)时,错误文本不得塌成 [object Object](String(obj) 家族,
// get_pod_logs previous=true 同族事故的 MCP 协议层残留点)。
test('tools/call: 抛非 Error 对象 → isError 文本为可读 JSON,非 [object Object]', async () => {
  const tools = mockTools({ callTool: async () => { throw { weird: true, detail: 'raw object throw' } } })
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'exec_pod', arguments: {} } }, { keyRow: readKey, cluster, apiKeyTools: tools })
  assert.equal(r.result.isError, true)
  assert.ok(!r.result.content[0].text.includes('[object Object]'), `不得 [object Object],实际: ${r.result.content[0].text}`)
  assert.match(r.result.content[0].text, /raw object throw/)
})

// --- T7(SSH 异步任务):sshAccess key 的 job 三工具 —— 可列可调分派 + 审计 verb + write/kill 拒 ---
test('MCP:sshAccess key 可列可调 wb_ssh_run/job_out/job_list;write/kill 不在列且被拒', async () => {
  const sshKey = { ...readKey, sshAccess: 1, prefix: 'ak_test' }
  // 审计捕获桩:reserve/finalize 都走 INSERT,verb 是第 8 个绑定参
  const inserts = []
  const auditDb = { prepare(sql) { return { get: () => ({ hash: 'h' }), run: (...a) => { if (/INSERT/.test(sql)) inserts.push(a); return { lastInsertRowid: 1 } } } } }
  const jobCalls = { run: 0, jobOut: 0, jobList: 0, runArgs: null }
  const jobBridge = {
    run: async (args) => { jobCalls.run++; jobCalls.runArgs = args; return { jobId: 'j1' } },
    jobOut: async () => { jobCalls.jobOut++; return { out: '', running: true } },
    jobList: async () => { jobCalls.jobList++; return { jobs: [] } },
  }
  const bridge = { readLedger: () => ({}), readFile: async () => ({}), exec: async () => ({}) }
  const deps = { keyRow: sshKey, cluster, db: auditDb, sshBridgeFor: () => bridge, sshJobBridgeFor: () => jobBridge,
    apiKeyTools: { listTools: () => [], callTool: async () => { const e = new Error('PERMISSION_DENIED: policy'); e.code = 'PERMISSION_DENIED'; e.reason = 'policy'; e.detail = 'wb_ssh_job_write 仅工作台 AI 支持(需人审),key 通道不可用'; throw e } } }

  // ① 列得出 run/out/list,列不出 write/kill
  const lr = await handleMcpMessage({ jsonrpc: '2.0', id: 30, method: 'tools/list' }, deps)
  const names = lr.result.tools.map(t => t.name)
  for (const n of ['wb_ssh_run', 'wb_ssh_job_out', 'wb_ssh_job_list']) assert.ok(names.includes(n), `tools/list 应含 ${n}`)
  for (const n of ['wb_ssh_job_write', 'wb_ssh_job_kill']) assert.ok(!names.includes(n), `tools/list 不应含 ${n}(keyMode 无人审)`)

  // ② write 不在名单 → 落 callTool 被拒(「仅工作台」文案)
  const wr = await handleMcpMessage({ jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'wb_ssh_job_write', arguments: {} } }, deps)
  assert.equal(wr.error.code, -32603)
  assert.match(wr.error.message, /仅工作台/)

  // ③ run/out/list 分派到达 fake jobBridge
  const rr = await handleMcpMessage({ jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'wb_ssh_run', arguments: { server: 's1', command: 'sleep 5' } } }, deps)
  assert.equal(rr.result.isError, undefined)
  assert.equal(jobCalls.run, 1); assert.equal(jobCalls.runArgs.command, 'sleep 5')
  await handleMcpMessage({ jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'wb_ssh_job_out', arguments: { server: 's1', jobId: 'j1' } } }, deps)
  await handleMcpMessage({ jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'wb_ssh_job_list', arguments: {} } }, deps)
  assert.equal(jobCalls.jobOut, 1); assert.equal(jobCalls.jobList, 1)

  // ④ 审计 intent verb:run=write;job_out/job_list=read;resource 沿 SshServer/<server>
  const runInsert = inserts.find(a => a[8] === 'wb_ssh_run') // 绑定序:ts,status,keyId,owner,clusterId,ns,verb(7),resource(8),tool(9)
  assert.equal(runInsert[6], 'write'); assert.equal(runInsert[7], 'SshServer/s1')
  const outInsert = inserts.find(a => a[8] === 'wb_ssh_job_out')
  assert.equal(outInsert[6], 'read')
  const listInsert = inserts.find(a => a[8] === 'wb_ssh_job_list')
  assert.equal(listInsert[6], 'read'); assert.equal(listInsert[7], 'SshLedger')
})

test('tools/call: 抛裸字符串 → isError 文本为该字符串', async () => {
  const tools = mockTools({ callTool: async () => { throw 'plain string failure' } })
  const r = await handleMcpMessage({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'exec_pod', arguments: {} } }, { keyRow: readKey, cluster, apiKeyTools: tools })
  assert.equal(r.result.isError, true)
  assert.match(r.result.content[0].text, /plain string failure/)
})

// --- 终审 I4:走 createMcpServer 真实工厂的 keyMode 集成测试 ---
// 既有 T7 测试注入 sshJobBridgeFor 桩,真实惰性工厂(含 keyMode:true 与 getJobPolicy 兜底)从未被
// 走到:若 mcp.mjs 丢了 keyMode:true,没有任何测试会红,key 通道将对 always 策略服务器获得无人审的
// wb_ssh_run。这里用真 sqlite(api_keys + ssh_servers 行)+ 真 createMcpServer 直打 HTTP handler。
test('MCP 真实工厂:keyMode fail-closed(always 拒 / none 放行)+ getJobPolicy 被消费', async () => {
  const db = new DatabaseSync(':memory:')
  createApiKeysSchema(db)
  createAuditSchema(db)
  db.exec('CREATE TABLE IF NOT EXISTS clusters (id TEXT PRIMARY KEY, name TEXT)')
  ensureSshSchema(db)
  const insServer = db.prepare(`INSERT INTO ssh_servers
    (id,name,host,port,username,authMethod,status,exposeToAi,aiApprovalPolicy,createdAt,updatedAt)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
  insServer.run('srv-always', 'always-box', '203.0.113.10', 22, 'root', 'password', 'ok', 1, 'always', 1, 1)
  insServer.run('srv-none', 'none-box', '203.0.113.11', 22, 'root', 'password', 'ok', 1, 'none', 1, 1)
  const minted = mintKey(db, { owner: 'ssh-op', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa', sshAccess: 1 })

  // 假 ssh 池:记录每条 exec 并按命令形态回放(list=空清单 / launch=pid 行 + OK)
  const execs = []
  let listOut = ''
  const fakeSshPool = { acquire: async serverId => ({ client: {
    exec: (cmd, cb) => {
      execs.push([serverId, cmd])
      const s = new EventEmitter(); s.stderr = new EventEmitter()
      cb(null, s)
      setImmediate(() => {
        if (cmd.includes('setsid')) { s.emit('data', Buffer.from('42\nOK\n')) } else { s.emit('data', Buffer.from(listOut)) }
        s.emit('exit', 0); s.emit('close')
      })
    },
    end: () => {} }, release: () => {} }) }
  let jobPolicy = { ttlMin: 60, maxPerServer: 4 }
  const handler = createMcpServer({ db, apiKeyTools: mockTools(), sshPool: fakeSshPool, getJobPolicy: () => jobPolicy })
  const call = async body => {
    const req = { headers: { authorization: `Bearer ${minted.plaintext}` }, method: 'POST',
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
    const res = { statusCode: null, body: null, setHeader() {}, writeHead(s) { this.statusCode = s }, end(b) { this.body = b ? JSON.parse(b) : null } }
    await handler(req, res)
    return res.body
  }
  const callTool = async (name, args) => {
    const r = await call({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    return JSON.parse(r.result.content[0].text)
  }

  // ① sshAccess key 列得出异步任务三工具
  const lr = await call({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  const names = lr.result.tools.map(t => t.name)
  for (const n of ['wb_ssh_run', 'wb_ssh_job_out', 'wb_ssh_job_list']) assert.ok(names.includes(n), `应含 ${n}`)

  // ② always 策略服务器 → keyMode fail-closed 拒启动,且零远端动作(闸在桥内,先于任何 exec)
  const denied = await callTool('wb_ssh_run', { server: 'always-box', command: 'apt install -y htop' })
  assert.ok(/key 通道无人审不可启动/.test(denied.error || ''), JSON.stringify(denied))
  assert.equal(execs.length, 0, `fail-closed 不得触碰远端,实际: ${JSON.stringify(execs)}`)

  // ③ none 策略服务器 → 真实桥走 list+launch 放行,返回 jobId/pid(证明 ② 拒的是 keyMode 闸,非链路坏)
  const okRun = await callTool('wb_ssh_run', { server: 'none-box', command: 'make all' })
  assert.ok(/^[0-9a-f-]{36}$/.test(okRun.jobId || ''), JSON.stringify(okRun))
  assert.equal(okRun.pid, '42')
  assert.equal(execs.length, 2, 'list + launch 两条 exec')
  assert.ok(execs[1][1].includes('setsid') && execs[1][0] === 'srv-none')
  // 注册表分派确认:到达的是 job 桥(mcp.mjs sshJobBridgeFor)而非同步 exec 桥
  assert.ok(execs[1][1].includes('mkfifo in'), 'launch 脚本形态 = 异步任务桥')

  // ④ getJobPolicy 被真实工厂消费:maxPerServer=1 + 远端 1 个 RUNNING → 并发上限拒
  jobPolicy = { ttlMin: 60, maxPerServer: 1 }
  listOut = `${randomUUID()} RUNNING\n`
  const capped = await callTool('wb_ssh_run', { server: 'none-box', command: 'x' })
  assert.ok(/并发已达上限\(1\)/.test(capped.error || ''), JSON.stringify(capped))
})
