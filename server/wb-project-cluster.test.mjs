// 项目后绑集群端点集成测试:spawn 真网关(模式同 ssh/routes.test.mjs)。
// 覆盖:未绑定建项目(clusterId='' 哨兵)→ 绑不存在集群 404 → 插集群行绑定 → 解绑 '' → 他人 403 + 审计落账。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')  // 本文件在 server/ 直下(ROOT=仓库根),与 server/ssh/routes.test.mjs 的 ../.. 不同
const GW_PORT = 53000 + Math.floor(Math.random() * 2000)
const BASE = `http://127.0.0.1:${GW_PORT}`
const DIR = mkdtempSync(join(tmpdir(), 'wb-proj-cluster-'))

const gw = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'wb.db'),
    ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
  stdio: ['ignore', 'ignore', 'ignore'],
})

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/api/health`); return } catch { await new Promise(r => setTimeout(r, 300)) }
  }
  throw new Error('gateway 未启动')
}

test('项目后绑集群:未绑定建项目→404 防呆→插集群行→绑定→解绑;他人 403', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }

  // 未绑定建项目(clusterId 缺省)
  const created = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H,
    body: JSON.stringify({ name: 'no-cluster-p' }) })).json()
  assert.equal(created.project.clusterId, '')
  const pid = created.project.id

  // 绑定不存在的集群 → 404
  const nf = await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: 'no-such' }) })
  assert.equal(nf.status, 404)

  // 测试直接往网关库插一条集群行(node:sqlite 打开同一 ALIANG_DB),再绑定
  // (clusters 建表列已对 server/index.mjs 核对:authMethod 有默认、createdBy 可空,其余列与 INSERT 对齐)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DIR, 'wb.db'))
  db.prepare('INSERT INTO clusters (id, name, apiServer, authHeader, ca, cert, key, insecure, version, createdAt) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run('ck-t1', '测试集群', 'https://127.0.0.1:6443', 'Basic eDp5', '', '', '', 0, 'v1.29', Date.now())
  db.close()
  const bind = await (await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: 'ck-t1' }) })).json()
  assert.equal(bind.project.clusterId, 'ck-t1')
  assert.equal(bind.project.clusterName, '测试集群')

  // 解绑('' 哨兵)→ 恢复未绑定
  const unbind = await (await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H, body: JSON.stringify({ clusterId: '' }) })).json()
  assert.equal(unbind.project.clusterId, '')

  // 他人(非 owner 非 admin)→ 403:建普通用户并登录(POST /api/admin/users 字段 username/password 已核对)
  const mk = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })
  assert.ok([200, 201].includes(mk.status))
  const plogin = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })).json()
  const forbidden = await fetch(`${BASE}/api/workbench/projects/${pid}/cluster`, { method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-platform-token': plogin.token }, body: JSON.stringify({ clusterId: 'ck-t1' }) })
  assert.equal(forbidden.status, 403)

  // 审计落账
  const db2 = new DatabaseSync(join(DIR, 'wb.db'))
  const row = db2.prepare("SELECT count(*) c FROM audit_log WHERE tool='workbench_project_cluster'").get()
  assert.ok(row.c >= 2)  // 绑定 + 解绑
  db2.close()
})

// teardown:与 ssh/routes.test.mjs 一致,SIGKILL + rmSync
test.after(() => {
  try { gw.kill('SIGKILL') } catch { /* noop */ }
  try { rmSync(DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

// ═══ gap3-03(2026-09-07 审计批次三):换绑/解绑与在途对话协调 ═══
// 契约:PUT /:id/cluster 换绑/解绑(clusterId 实际变化)时,对该项目的在途对话:
//   running → 失效(epoch 中止,终态 failed + error「项目集群已变更」);
//   paused → pendingApproval 失效(拒绝语义,终态 failed)。
// 同值重放(绑同一个集群)不失效(幂等不误杀)。失效后再 approve → 400 notPaused(CAS)。
// 装置:独立网关 + mock LLM(慢流=running 在途 / wb_exec 工具调用=paused 审批)+ mock K8s。
test('gap3-03 换绑协调:running 在途 run 中止 + paused 审批失效;同值重放不误杀', { timeout: 90000 }, async () => {
  const K8S_PORT = 39000 + Math.floor(Math.random() * 4000)
  const LLM_PORT = 43000 + Math.floor(Math.random() * 3000)
  const GW2 = 46000 + Math.floor(Math.random() * 3000)
  const DIR2 = mkdtempSync(join(tmpdir(), 'wb-rebind-conv-'))
  let execCalls = 0
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31","gitVersion":"v1.31.4"}') }
    if (req.method === 'POST' && p.includes('/exec')) { execCalls++; res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ stdout: 'ok', stderr: '', exitCode: 0 })) }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(`{"kind":"Status","message":"nf ${p}"}`)
  })
  // 慢流对话(恒 running 在途):首字后每 400ms 滴一字,~20s 跑不完——换绑窗口内在途
  const llm = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { messages = [], stream } = JSON.parse(body || '{}')
      const slow = messages.some(m => m.role === 'user' && String(m.content).includes('慢'))
      const hasTool = messages.some(m => m.role === 'tool')
      if (!stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })) }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (slow) {
        const ch = d => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`
        res.write(ch({ role: 'assistant', content: '慢' }))
        let n = 0
        const t = setInterval(() => { res.write(ch({ content: `字${n++}` })) }, 400)
        req.on('close', () => clearInterval(t)) // 客户端断开(abort)即停
        return
      }
      const args = JSON.stringify({ namespace: 'ns1', pod: 'p1', command: ['ls'] })
      const reply = hasTool
        ? { role: 'assistant', content: '执行完成' }
        : { role: 'assistant', content: '看下', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'wb_exec', arguments: args } }] }
      const ch = d => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`
      if (reply.tool_calls) {
        res.write(ch({ role: 'assistant', content: reply.content }))
        res.write(ch({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'wb_exec', arguments: '' } }] }))
        res.write(ch({ tool_calls: [{ index: 0, function: { arguments: args } }] }))
      } else res.write(ch({ role: 'assistant', content: reply.content }))
      res.write('data: [DONE]\n\n'); res.end()
    })
  })
  k8s.keepAliveTimeout = 30_000
  llm.keepAliveTimeout = 30_000
  await new Promise(r => k8s.listen(K8S_PORT, '127.0.0.1', r))
  await new Promise(r => llm.listen(LLM_PORT, '127.0.0.1', r))
  const gw2 = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT, env: { ...process.env, PORT: String(GW2), ALIANG_DB: join(DIR2, 'wb.db'),
      ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR2, ALIANG_WORKBENCH_DIR: join(DIR2, 'wb') },
    stdio: ['ignore', 'ignore', 'ignore'] })
  const B2 = `http://127.0.0.1:${GW2}`
  const getConv = async (id, hh) => (await (await fetch(`${B2}/api/workbench/conversations/${id}`, { headers: hh })).json())
  try {
    for (let i = 0; i < 60; i++) { try { await fetch(`${B2}/api/health`); break } catch { await new Promise(r => setTimeout(r, 300)) } }
    const lr = await (await fetch(`${B2}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
    const H2 = { 'content-type': 'application/json', 'x-platform-token': lr.token }
    await fetch(`${B2}/api/admin/llm-config`, { method: 'PUT', headers: H2, body: JSON.stringify({ baseURL: `http://127.0.0.1:${LLM_PORT}`, model: 'mock-1' }) })
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: http://127.0.0.1:${K8S_PORT}\n  name: m\ncontexts:\n- context:\n    cluster: m\n    user: m\n  name: m\ncurrent-context: m\nusers:\n- name: m\n  user:\n    token: d\n`
    const cr1 = await (await fetch(`${B2}/api/admin/clusters`, { method: 'POST', headers: H2, body: JSON.stringify({ name: 'k8s-a', kubeconfig }) })).json()
    const cid1 = cr1.cluster?.id || cr1.id
    const cr2 = await (await fetch(`${B2}/api/admin/clusters`, { method: 'POST', headers: H2, body: JSON.stringify({ name: 'k8s-b', kubeconfig }) })).json()
    const cid2 = cr2.cluster?.id || cr2.id
    const pr = await (await fetch(`${B2}/api/workbench/projects`, { method: 'POST', headers: H2, body: JSON.stringify({ name: 'rebind-p', clusterId: cid1 }) })).json()
    const pid = pr.project?.id || pr.id

    // convA:慢流 → running 在途;convB:wb_exec 审批 → paused
    const cvA = await (await fetch(`${B2}/api/workbench/conversations`, { method: 'POST', headers: H2, body: JSON.stringify({ projectId: pid, message: '慢慢分析一下' }) })).json()
    const cvB = await (await fetch(`${B2}/api/workbench/conversations`, { method: 'POST', headers: H2, body: JSON.stringify({ projectId: pid, message: '看下容器' }) })).json()
    let stA = 'running', stB = 'running'
    for (let i = 0; i < 60 && !(stA === 'running' && stB === 'paused'); i++) {
      await new Promise(r => setTimeout(r, 300))
      stA = (await getConv(cvA.id, H2)).status
      stB = (await getConv(cvB.id, H2)).status
    }
    assert.equal(stA, 'running', `convA 应在途 running,实际 ${stA}`)
    assert.equal(stB, 'paused', `convB 应停在审批,实际 ${stB}`)
    // gap3-02 顺带断言:审批载荷带集群戳(创建时绑 cid1)
    const convB = await getConv(cvB.id, H2)
    assert.equal(JSON.parse(convB.pendingApproval).clusterId, cid1, '审批盖创建时集群戳')

    // 换绑 cid1 → cid2:两对话即刻失效
    const rb = await (await fetch(`${B2}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H2, body: JSON.stringify({ clusterId: cid2 }) })).json()
    assert.equal(rb.project.clusterId, cid2)
    assert.equal(rb.invalidatedConversations, 2, '响应回带失效计数(running+paused 各一)')
    const rowA = await getConv(cvA.id, H2)
    assert.equal(rowA.status, 'failed', 'running 对话随换绑中止 → failed')
    assert.equal(rowA.error, '项目集群已变更', '失败原因落库')
    const rowB = await getConv(cvB.id, H2)
    assert.equal(rowB.status, 'failed', 'paused 审批随换绑失效 → failed')
    assert.equal(rowB.pendingApproval, null, 'pendingApproval 已消费')
    assert.equal(rowB.error, '项目集群已变更')

    // 失效后 approve → 400(CAS 挡住,审批不再有执行面)
    const ap = await fetch(`${B2}/api/workbench/conversations/${cvB.id}/approve`, { method: 'POST', headers: H2, body: '{}' })
    assert.equal(ap.status, 400, '失效审批再 approve → notPaused 400')
    assert.equal(execCalls, 0, 'wb_exec 从未执行(换绑后零工具执行)')

    // 换绑后等 2s:被取代的慢流 run 迟到产出不复活对话(状态保持 failed)
    await new Promise(r => setTimeout(r, 2000))
    assert.equal((await getConv(cvA.id, H2)).status, 'failed', '迟到产出不覆写 failed(epoch 闸)')

    // 同值重放(cid2 → cid2)不再失效:convC 起一个 running,重放同值,应保持 running
    const cvC = await (await fetch(`${B2}/api/workbench/conversations`, { method: 'POST', headers: H2, body: JSON.stringify({ projectId: pid, message: '慢慢再分析' }) })).json()
    await new Promise(r => setTimeout(r, 800))
    const rb2 = await (await fetch(`${B2}/api/workbench/projects/${pid}/cluster`, { method: 'PUT', headers: H2, body: JSON.stringify({ clusterId: cid2 }) })).json()
    assert.equal(rb2.invalidatedConversations, 0, '同值重放零失效(clusterId 未变)')
    assert.equal((await getConv(cvC.id, H2)).status, 'running', '同值重放不误杀在途对话')
  } finally {
    try { gw2.kill('SIGKILL') } catch { /* noop */ }
    // close() 只停 listener,不拆 keep-alive 存量连接——慢流 SSE 连接(gw2 侧被杀后 FIN 到达
    // 有时序窗口)可让句柄滞留、事件循环不排空,曾实测挂起 node --test 子进程 20+ 分钟。
    // closeAllConnections(Node 18.2+)确定性拆掉全部 socket,子进程必退。
    try { k8s.close(); k8s.closeAllConnections?.() } catch { /* noop */ }
    try { llm.close(); llm.closeAllConnections?.() } catch { /* noop */ }
    try { rmSync(DIR2, { recursive: true, force: true }) } catch { /* noop */ }
  }
})
