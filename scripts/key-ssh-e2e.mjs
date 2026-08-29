// per-key SSH 授予 API 级端到端(2026-08-29):需本地 sshd 容器(见 ssh-e2e-checklist.md)+ QA 网关(临时库)。
// 用法:起 QA 实例后 node scripts/key-ssh-e2e.mjs(幂等,自动清既有服务器)。15 项断言:
// 授予/收回即时生效、MCP tools/list 增删、台账 AI 视图脱敏、readonly 策略映射、sudo 恒拒、未暴露不泄露。
const BASE = 'http://127.0.0.1:8788'
const j = (r) => r.json()
const pass = [], fail = []
const ok = (n, cond) => (cond ? pass.push(n) : fail.push(n), console.log(cond ? '  ✓' : '  ✗', n))

// 1) 登录
const login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'qa-pass-123456' }) }).then(j)
const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

// 0) 幂等:清掉既有服务器
const H0 = H
for (const x of (await fetch(`${BASE}/api/ssh/servers`, { headers: H0 }).then(j)).servers || []) {
  await fetch(`${BASE}/api/ssh/servers/${x.id}`, { method: 'DELETE', headers: H0 })
}
// 2) 建服务器(暴露 AI + readonly 策略)
const srv = await fetch(`${BASE}/api/ssh/servers`, { method: 'POST', headers: H,
  body: JSON.stringify({ name: 'e2e-alpine', host: '127.0.0.1', port: 2223, username: 'qa',
    authMethod: 'password', password: 'qa-pass', exposeToAi: true, aiApprovalPolicy: 'readonly' }) }).then(j)
ok('服务器创建', !!srv.server?.id)
// 未暴露的第二台(验证 key 通道不可见)
const hidden = await fetch(`${BASE}/api/ssh/servers`, { method: 'POST', headers: H,
  body: JSON.stringify({ name: 'e2e-hidden', host: '127.0.0.1', port: 1, username: 'x',
    authMethod: 'password', password: 'p', exposeToAi: false }) }).then(j)
ok('第二台(未暴露)创建', !!hidden.server?.id)

// 3) 测试连接 → ok + OS
const t = await fetch(`${BASE}/api/ssh/servers/${srv.server.id}/test`, { method: 'POST', headers: H }).then(j)
ok(`测试连接 ok(OS=${t.osId})`, t.ok === true && t.osId === 'alpinelinux')

// 4) 铸 key(sshAccess=true)
const mint = await fetch(`${BASE}/api/admin/apikeys`, { method: 'POST', headers: H,
  body: JSON.stringify({ owner: 'admin', clusterId: 'none', boundSA_namespace: 'default', boundSA_name: 'sa-e2e',
    tier: 'read', sshAccess: true, label: 'ssh-e2e' }) }).then(j)
const key = mint.apikey?.plaintext
ok('key 铸造(sshAccess=true)', !!key)
const KH = { 'content-type': 'application/json', 'authorization': `Bearer ${key}` }

// 5) 对照组:无 sshAccess 的 key → tools/list 无 SSH 工具
const mint2 = await fetch(`${BASE}/api/admin/apikeys`, { method: 'POST', headers: H,
  body: JSON.stringify({ owner: 'admin', clusterId: 'none', boundSA_namespace: 'default', boundSA_name: 'sa-e2e-no',
    tier: 'read', label: 'no-ssh' }) }).then(j)
const list2 = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'authorization': `Bearer ${mint2.apikey.plaintext}` },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(j)
ok('无授予 key:tools/list 不含 SSH 工具', !JSON.stringify(list2).includes('wb_ssh_exec'))

// 6) 授予 key:tools/list 含三 SSH 工具
const list1 = await fetch(`${BASE}/mcp`, { method: 'POST', headers: KH,
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }).then(j)
const names = (list1.result?.tools || []).map(t => t.name)
ok('授予 key:tools/list 含 wb_ssh_exec/wb_ssh_read_file/read_server_ledger',
  names.includes('wb_ssh_exec') && names.includes('wb_ssh_read_file') && names.includes('read_server_ledger'))
ok('授予 key:不含 write_server_notes(台账写不对 key 开放)', !names.includes('write_server_notes'))

const call = (name, args) => fetch(`${BASE}/mcp`, { method: 'POST', headers: KH,
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) }).then(j)
const text = r => { try { return JSON.parse(r.result?.content?.[0]?.text || '{}') } catch { return {} } }

// 7) read_server_ledger:含 e2e-alpine、不含未暴露台、不含 host:port(redact)
const lg = text(await call('read_server_ledger', {}))
ok('台账含 e2e-alpine', (lg.markdown || '').includes('e2e-alpine'))
ok('台账不含未暴露服务器', !(lg.markdown || '').includes('e2e-hidden'))
ok('AI 视图 redactHost(无 host:port/明文端口 2223)', !(lg.markdown || '').includes('2223'))

// 8) readonly 策略:只读命令放行
const ro = text(await call('wb_ssh_exec', { server: 'e2e-alpine', command: 'uname -a' }))
ok('readonly + 只读命令 → 执行成功(exitCode=0)', ro.exitCode === 0)

// 9) readonly 策略:非只读命令 → 策略拒绝(经桥内 keyGate)
const rw = text(await call('wb_ssh_exec', { server: 'e2e-alpine', command: 'touch /tmp/x' }))
ok('readonly + 非只读命令 → key 通道拒绝', (rw.error || '').includes('readonly'))

// 10) sudo 真值旁路:readonly + 只读命令 + sudo="1" → 策略拒绝(真值进审批语义;key 通道 readonly 拒非只读,但 cat+sudo 是提权——桥内 keyGate 对 readonly 只看命令文本,
//     sudo 在 key 通道应恒拒:验证执行侧带 sudo 的只读命令也被拒)
const su = text(await call('wb_ssh_exec', { server: 'e2e-alpine', command: 'cat /etc/os-release', sudo: '1' }))
ok('readonly + sudo 真值 → key 通道拒绝(提权不可经 key)', (su.error || '').includes('readonly'))

// 11) 未暴露服务器 → not-exposed(不泄露存在性)
const hid = text(await call('wb_ssh_exec', { server: 'e2e-hidden', command: 'ls' }))
ok('未暴露服务器 → not-exposed 拒绝', (hid.error || '').includes('未暴露') || (hid.error || '').includes('不存在'))

// 12) PATCH 收回 sshAccess → tools/list 即时无 SSH 工具
await fetch(`${BASE}/api/admin/apikeys/${mint.apikey.id}/ssh-access`, { method: 'PATCH', headers: H,
  body: JSON.stringify({ enabled: false }) })
const list3 = await fetch(`${BASE}/mcp`, { method: 'POST', headers: KH,
  body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) }).then(j)
ok('PATCH 收回后 tools/list 即时剔除 SSH 工具', !JSON.stringify(list3).includes('wb_ssh_exec'))

console.log(`\n[key-ssh-e2e] ${pass.length} 通过,${fail.length} 失败`)
if (fail.length) process.exit(1)
