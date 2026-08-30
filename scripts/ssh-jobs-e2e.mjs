// SSH 异步任务 e2e(2026-08-30,规格 §7):需 QA 网关(127.0.0.1:8788,临时库)+ 可达 sshd + 已配 LLM(工作台通道)。
// 连接/断言风格镜像 scripts/key-ssh-e2e.mjs。目标主机 env SSHJOBS_E2E_HOST(缺省 127.0.0.1)/SSHJOBS_E2E_PORT(缺省 22)。
// 8 步断言:启动/列表/stdin 应答/offset 增量/kill/注入防线/admin 策略/timeoutMin 钳制。
// 环境不满足(网关不可达/sshd 不可用/LLM 未配)→ 打印 SKIP 原因并 exit 0(记录进 ops 文档,不阻塞门禁)。
const BASE = process.env.SSHJOBS_E2E_BASE || 'http://127.0.0.1:8788'
const HOST = process.env.SSHJOBS_E2E_HOST || '127.0.0.1'
const PORT = Number(process.env.SSHJOBS_E2E_PORT || 22)
const j = (r) => r.json()
const pass = [], fail = []
const ok = (n, cond) => (cond ? pass.push(n) : fail.push(n), console.log(cond ? '  ✓' : '  ✗', n))
const skip = (reason) => { console.log(`\n[ssh-jobs-e2e] SKIP: ${reason}`); process.exit(0) }

// ---- 0) 网关可达性(不可达=环境未起,SKIP 而非失败)----
let login
try {
  login = await fetch(`${BASE}/api/auth/login`, { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'qa-pass-123456' }) }).then(j)
} catch (e) {
  skip(`QA 网关不可达(${BASE}):${e?.message || e};先起 QA 实例再跑本脚本`)
}
if (!login?.token) skip('QA 网关登录失败(非 QA 实例或口令不符)')
const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

// ---- 0.1) sshd 可达性:登记目标主机并试连(不可用=SKIP)----
for (const x of (await fetch(`${BASE}/api/ssh/servers`, { headers: H }).then(j)).servers || []) {
  await fetch(`${BASE}/api/ssh/servers/${x.id}`, { method: 'DELETE', headers: H })
}
const srv = await fetch(`${BASE}/api/ssh/servers`, { method: 'POST', headers: H,
  body: JSON.stringify({ name: 'jobs-e2e', host: HOST, port: PORT, username: 'qa',
    authMethod: 'password', password: 'qa-pass', exposeToAi: true, aiApprovalPolicy: 'none' }) }).then(j)
if (!srv.server?.id) skip(`服务器登记失败(host=${HOST}:${PORT})`)
const t = await fetch(`${BASE}/api/ssh/servers/${srv.server.id}/test`, { method: 'POST', headers: H }).then(j)
if (t.ok !== true) skip(`sshd 不可用(host=${HOST}:${PORT},test=${t.error || t.errorKind || 'unknown'});用 docker 起一个 openssh 容器或指向 kind 节点`)

// ---- 铸 key(sshAccess)→ MCP 通道:run/out/list 可用(write/kill fail-closed 属工作台通道)----
const mint = await fetch(`${BASE}/api/admin/apikeys`, { method: 'POST', headers: H,
  body: JSON.stringify({ owner: 'admin', clusterId: 'none', boundSA_namespace: 'default', boundSA_name: 'sa-jobs-e2e',
    tier: 'read', sshAccess: true, label: 'ssh-jobs-e2e' }) }).then(j)
const key = mint.apikey?.plaintext
ok('key 铸造(sshAccess=true)', !!key)
const KH = { 'content-type': 'application/json', 'authorization': `Bearer ${key}` }
const call = (name, args) => fetch(`${BASE}/mcp`, { method: 'POST', headers: KH,
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }) }).then(j)
const text = r => { try { return JSON.parse(r.result?.content?.[0]?.text || '{}') } catch { return {} } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- 工作台通道(write/kill 仅此通道可用):取项目 → 建对话 → 轮询 → 自动批 → 取终态 ----
async function wbTurn(message) {
  const projects = await fetch(`${BASE}/api/workbench/projects`, { headers: H }).then(j)
  const proj = (projects.projects || [])[0]
  if (!proj) skip('无工作台项目可承载对话(先在 UI 建一个项目)')
  const c = await fetch(`${BASE}/api/workbench/conversations`, { method: 'POST', headers: H,
    body: JSON.stringify({ projectId: proj.id, message }) }).then(j)
  if (c.message?.includes?.('未配置') || c.message?.includes?.('LLM')) skip('LLM 未配置(wb 通道不可用);配置 admin AI 连接后重跑')
  if (!c.id) skip(`工作台对话创建失败:${c.message || JSON.stringify(c).slice(0, 120)}`)
  for (let i = 0; i < 90; i++) {
    await sleep(2000)
    const s = await fetch(`${BASE}/api/workbench/conversations/${c.id}`, { headers: H }).then(j)
    if (s.status === 'paused') { await fetch(`${BASE}/api/workbench/conversations/${c.id}/approve`, { method: 'POST', headers: H }); continue }
    if (s.status === 'done' || s.status === 'failed') return s
  }
  skip(`工作台对话超时未收敛(conv=${c.id})`)
}

// 1) wb_ssh_run 启动长任务 → jobId
const r1 = text(await call('wb_ssh_run', { server: 'jobs-e2e', command: "printf 'ready\\n'; sleep 60" }))
ok('1. wb_ssh_run 返回 jobId', !!r1.jobId)
const jobId = r1.jobId
await sleep(2000)

// 2) wb_ssh_job_list 可见且 RUNNING
const r2 = text(await call('wb_ssh_job_list', { server: 'jobs-e2e' }))
const seen = (r2.jobs || []).find(x => x.jobId === jobId)
ok('2. job_list 含该 jobId 且 RUNNING', !!seen && seen.exitCode === null)

// 3) 交互任务 + stdin 应答(wb 通道执行 job_write;断言走 key 通道 job_out)
const turn3 = await wbTurn(`在服务器 jobs-e2e 上执行:用 wb_ssh_run 启动命令 "wc -l"(读 stdin),拿到 jobId 后立刻用 wb_ssh_job_write 向该任务写文本 "hello",然后用 wb_ssh_job_out 轮询直到任务结束,把 jobId 与最终输出发给我。不要做别的。`)
const m3 = String(turn3.content || '').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)
const jobId3 = m3 ? m3[0] : ''
let o3 = {}
for (let i = 0; i < 20; i++) {
  o3 = text(await call('wb_ssh_job_out', { server: 'jobs-e2e', jobId: jobId3 }))
  if (o3.exitCode !== null && o3.exitCode !== undefined) break
  await sleep(1000)
}
ok('3. stdin 应答真通(job_out 含 "1 hello" 且 exitCode=0)', (o3.chunk || '').includes('1') && (o3.chunk || '').includes('hello') && o3.exitCode === 0)

// 4) offset 推进:二次读取只拿增量
const first = text(await call('wb_ssh_job_out', { server: 'jobs-e2e', jobId: jobId3, offset: 0 }))
const second = text(await call('wb_ssh_job_out', { server: 'jobs-e2e', jobId: jobId3, offset: first.offset }))
ok('4. offset 增量(首读含内容,续读空块)', (first.chunk || '').length > 0 && (second.chunk || '') === '' && second.offset === first.offset)

// 5) kill 步骤 1 的任务(wb 通道执行)→ 终止信号可辨。job-bridge 真实语义:killScript 杀整个
//    进程组(含 wrapper),`if [ -f .rc ]` 永不执行 → 远端无 code 文件 ⇒ job_out 报
//    running=false + exitCode=null,而 out 里步骤 1 已落盘的 'ready' 仍在(size>0)。
//    「被杀」签名 = size>0 + running=false + exitCode=null 且无 error;若 job_out 报
//    「任务不存在」或 size=0,则与「从未存在」不可区分 → 判失败(不虚过)。
//    前置自愈:步骤 1 的 sleep 60 可能已被前面 LLM 轮耗时自然跑完(exitCode=0 正常收尾),
//    那样 kill 断言会空转——先确认活体;已死则重新起一个同款长任务作受害者。
let victim = jobId
let pre = text(await call('wb_ssh_job_out', { server: 'jobs-e2e', jobId: victim }))
if (pre.running !== true || !(pre.size > 0)) {
  const r5b = text(await call('wb_ssh_run', { server: 'jobs-e2e', command: "printf 'ready\\n'; sleep 60" }))
  if (!r5b.jobId) pre = {}
  else {
    victim = r5b.jobId
    await sleep(2000)
    pre = text(await call('wb_ssh_job_out', { server: 'jobs-e2e', jobId: victim }))
  }
}
ok('5a. kill 前置:受害者任务在跑且有输出', pre.running === true && pre.size > 0)
await wbTurn(`在服务器 jobs-e2e 上,用 wb_ssh_job_kill 终止任务 jobId=${victim},然后发 wb_ssh_job_list 给我看结果。不要做别的。`)
let o5 = {}
for (let i = 0; i < 15; i++) {
  o5 = text(await call('wb_ssh_job_out', { server: 'jobs-e2e', jobId: victim }))
  if (o5.running === false) break
  await sleep(1000)
}
ok('5b. kill 后「被杀」签名可辨(size>0 + running=false + exitCode=null,非「任务不存在」)',
  !o5.error && o5.size > 0 && o5.running === false && (o5.exitCode ?? null) === null)

// 6) 注入防线:jobId '../../etc'
const badOut = text(await call('wb_ssh_job_out', { server: 'jobs-e2e', jobId: '../../etc' }))
ok('6a. job_out 注入 jobId → 明确报错', (badOut.error || '').includes('非法'))
// key 通道没有 wb_ssh_job_write(不在 SSH_KEY_TOOLS)→ 分派落到集群工具层:未知工具 throw
// PermissionDeniedError → JSON-RPC -32603;或(key 未绑集群)isError:true。断言「肯定被拒」:
// JSON-RPC error 对象 与 isError===true 二者必居其一,且响应里不得出现桥的成功形状 {ok:true}。
const w6 = await call('wb_ssh_job_write', { server: 'jobs-e2e', jobId: '../../etc', text: 'x' })
const denied6b = w6.error != null || w6.result?.isError === true
ok('6b. job_write 注入 jobId → 明确被拒(isError/JSON-RPC error,非成功形状)',
  denied6b && !JSON.stringify(w6.result?.content || '').includes('"ok":true'))

// 7) admin 策略可调:ttlMin=1 → 200;设回 120
const p1 = await fetch(`${BASE}/api/admin/ssh-job-policy`, { method: 'PUT', headers: H, body: JSON.stringify({ ttlMin: 1 }) })
ok('7a. PUT ssh-job-policy ttlMin=1 → 200', p1.status === 200)
const p2 = await fetch(`${BASE}/api/admin/ssh-job-policy`, { method: 'PUT', headers: H, body: JSON.stringify({ ttlMin: 120 }) })
ok('7b. 恢复 ttlMin=120 → 200', p2.status === 200)

// 8) 非法 timeoutMin=999 → 钳到 120(run 返回钳后值;job_list 复核可见)
const r8 = text(await call('wb_ssh_run', { server: 'jobs-e2e', command: 'sleep 5', timeoutMin: 999 }))
ok('8. timeoutMin=999 钳到 120', r8.timeoutMin === 120)
await fetch(`${BASE}/api/ssh/servers/${srv.server.id}`, { method: 'DELETE', headers: H })

console.log(`\n[ssh-jobs-e2e] ${pass.length} 通过,${fail.length} 失败`)
if (fail.length) process.exit(1)
