// v2 闭环 e2e:mock LLM 调 http_request → paused → 「批准并记住」(approve body remember) →
// grants 落库 → 第二次对话同操作免审(approval:auto) → 目标服务收到的 Authorization 为服务端注入,
// LLM 上下文全程无 token;系统提示含 ✓ 标记;库内 fields 纯密文。
// harness 照 wb-credential-ai.test.mjs:mock K8s(/version 探活)+ 状态化 mock LLM(无 role:'tool'
// 回 tool_calls、见 tool 后终答;流式/非流式双形态)+ spawn 真网关 + keepAliveTimeout=30s
// (同 wb-approval-roundtrip 的 keep-alive 竞态根修——Node mock 默认 5s 关闲连,网关 undici 4s
// 回收延迟复用已死 socket → fetch failed → 对话被打成 failed;target 同样吃网关 fetch,一并放宽)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('http_request 闭环:批准并记住→免审二连;token 仅服务端注入', { timeout: 120000 }, async () => {
  // 端口分区互不重叠(K8S 39-43k / LLM 43-46k / TGT 46-47k / GW 48-50k),listen 撞车即测试崩
  const K8S_PORT = 39000 + Math.floor(Math.random() * 4000)
  const LLM_PORT = 43000 + Math.floor(Math.random() * 3000)
  const GW_PORT = 48000 + Math.floor(Math.random() * 2000)
  const TGT_PORT = 46000 + Math.floor(Math.random() * 1000)
  const DIR = mkdtempSync(join(tmpdir(), 'wb-credv2-'))
  const llmRounds = []
  let llmSawSystem = ''
  const targetHits = []
  // mock 目标 API:记录收到的 authorization 头
  const target = createServer((req, res) => {
    targetHits.push({ url: req.url, auth: req.headers.authorization || '' })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ items: [{ id: 1, name: 'release-1' }] }))
  })
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31"}') }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(`{"kind":"Status","message":"nf ${p}"}`)
  })
  const TOOL = 'http_request'
  const ARGS = JSON.stringify({ credential: 'gh', path: '/repos/x/y/releases' })
  const llm = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { messages = [], stream } = JSON.parse(body || '{}')
      llmRounds.push(messages)
      llmSawSystem = messages[0]?.content || llmSawSystem
      const hasTool = messages.some(m => m.role === 'tool')
      const reply = hasTool ? { role: 'assistant', content: '已获取发布列表。' }
        : { role: 'assistant', content: '我调一下 API。', tool_calls: [{ id: 'c1', type: 'function', function: { name: TOOL, arguments: ARGS } }] }
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const ch = d => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`
        if (reply.tool_calls) {
          res.write(ch({ role: 'assistant', content: reply.content }))
          res.write(ch({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: TOOL, arguments: '' } }] }))
          res.write(ch({ tool_calls: [{ index: 0, function: { arguments: ARGS } }] }))
        } else res.write(ch({ role: 'assistant', content: reply.content }))
        res.write('data: [DONE]\n\n'); return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: reply }] }))
    })
  })
  await new Promise(r => target.listen(TGT_PORT, '127.0.0.1', r))
  await new Promise(r => k8s.listen(K8S_PORT, '127.0.0.1', r))
  await new Promise(r => llm.listen(LLM_PORT, '127.0.0.1', r))
  target.keepAliveTimeout = 30_000
  k8s.keepAliveTimeout = 30_000
  llm.keepAliveTimeout = 30_000
  const gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'wb.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const BASE = `http://127.0.0.1:${GW_PORT}`
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/auth/login`, { method: 'POST', body: '{}' }); up = true } catch { await new Promise(r => setTimeout(r, 300)) } }
    assert.ok(up, '网关未启动')
    const lr = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
    const H = { 'content-type': 'application/json', 'x-platform-token': lr.token }
    await fetch(`${BASE}/api/admin/llm-config`, { method: 'PUT', headers: H, body: JSON.stringify({ baseURL: `http://127.0.0.1:${LLM_PORT}`, model: 'mock-1' }) })
    await fetch(`${BASE}/api/workbench/credentials`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'gh', exposeToAi: true, fields: [
      { key: 'base_url', type: 'text', value: `http://127.0.0.1:${TGT_PORT}` }, { key: 'api_token', type: 'password', value: 'ghp_hunter2secret' }] }) })
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: http://127.0.0.1:${K8S_PORT}\n  name: m\ncontexts:\n- context:\n    cluster: m\n    user: m\n  name: m\ncurrent-context: m\nusers:\n- name: m\n  user: {token: d}\n`
    const cr = await (await fetch(`${BASE}/api/admin/clusters`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'mock-k8s', kubeconfig }) })).json()
    const pr = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H, body: JSON.stringify({ name: 't', clusterId: cr.cluster?.id || cr.id }) })).json()
    const mkConv = () => fetch(`${BASE}/api/workbench/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ projectId: pr.project?.id || pr.id, message: '查一下 release 列表' }) }).then(r => r.json())
    const statusOf = async id => { const c = await (await fetch(`${BASE}/api/workbench/conversations/${id}`, { headers: H })).json(); return c.conversation?.status || c.status }
    const waitStatus = async (id, set) => { for (let i = 0; i < 120; i++) { await new Promise(r => setTimeout(r, 400)); const s = await statusOf(id); if (set.includes(s)) return s } return 'timeout' }

    // ── 第一次:paused → 批准并记住 → done ──
    const cv1 = await mkConv()
    assert.equal(await waitStatus(cv1.id, ['paused', 'failed', 'done']), 'paused', '首次应人审')
    const ap = await fetch(`${BASE}/api/workbench/conversations/${cv1.id}/approve`, { method: 'POST', headers: H, body: JSON.stringify({ remember: true }) })
    assert.equal(ap.status, 200)
    assert.equal(await waitStatus(cv1.id, ['done', 'failed']), 'done')
    // 注入面:目标服务收到服务端组装的 Bearer
    assert.equal(targetHits.length, 1)
    assert.equal(targetHits[0].auth, 'Bearer ghp_hunter2secret')
    assert.equal(targetHits[0].url, '/repos/x/y/releases')
    // AI 上下文面:tool 消息与 system 均无 token
    const toolRound = llmRounds.find(ms => ms.some(m => m.role === 'tool'))
    assert.ok(toolRound, '应有工具结果轮次')
    assert.ok(!JSON.stringify(toolRound).includes('ghp_hunter2secret'), 'token 绝不进 AI 上下文')
    assert.ok(llmSawSystem.includes('✓可用: http_request'), '系统提示含匹配标记')
    // grants 落库
    const rdb = new DatabaseSync(join(DIR, 'wb.db'), { readOnly: true })
    const g = rdb.prepare("SELECT adapter FROM credential_grants g JOIN workbench_credentials c ON c.id=g.credential_id WHERE c.name='gh'").all()
    const fields = rdb.prepare("SELECT fields FROM workbench_credentials WHERE name='gh'").get().fields
    rdb.close()
    assert.deepEqual(g.map(x => x.adapter), ['http_request'])
    assert.ok(!fields.includes('ghp_hunter2secret') && fields.includes('v1:'), '库内纯密文')

    // ── 第二次:免审直跑(不 paused)──
    llmRounds.length = 0
    const cv2 = await mkConv()
    assert.equal(await waitStatus(cv2.id, ['done', 'failed']), 'done', 'grant 后同操作免审直达终态')
    assert.equal(targetHits.length, 2, '第二次真实执行')
    // 免审审计标记
    const adb = new DatabaseSync(join(DIR, 'wb.db'), { readOnly: true })
    const auto = adb.prepare("SELECT requestSummary FROM audit_log WHERE tool='http_request' ORDER BY rowid").all()
    adb.close()
    assert.ok(auto.length >= 2 && auto.some(a => (a.requestSummary || '').includes('approval:auto')), '免审行带 approval:auto 标记')
  } finally {
    gw.kill('SIGKILL'); target.close(); k8s.close(); llm.close()
    setTimeout(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} }, 500)
  }
})
