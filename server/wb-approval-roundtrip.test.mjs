// 审批链活体回归(2026-08-25 用户报「审批确认后对话从页面消失」,七路径人工排查无复现;
// 本测试把审批→批准→续跑→终答链固化成自动化网,防复发):mock LLM 首轮发需审批的 wb_exec →
// 对话 paused → API approve → 续跑 → done。断言:状态迁移、消息级 trace 含 tool+瘦身 assistant
// (交错渲染数据)、GET 回读完整。mock K8s 提供 /exec(POST)端点。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('审批链:wb_exec 待审批 → approve → 续跑 → done;消息 trace 含工具与瘦身 assistant 文本', { timeout: 90000 }, async () => {
  const K8S_PORT = 39000 + Math.floor(Math.random() * 4000)
  const LLM_PORT = 43000 + Math.floor(Math.random() * 3000)
  const GW_PORT = 46000 + Math.floor(Math.random() * 3000)
  const DIR = mkdtempSync(join(tmpdir(), 'wb-approval-'))
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31","gitVersion":"v1.31.4"}') }
    if (req.method === 'POST' && p.includes('/exec')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ stdout: 'bin\netc', stderr: '', exitCode: 0 })) }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(`{"kind":"Status","message":"nf ${p}"}`)
  })
  const llmRounds = []
  const llm = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { messages = [], stream } = JSON.parse(body || '{}')
      llmRounds.push(messages)
      const args = JSON.stringify({ namespace: 'ns1', pod: 'p1', command: ['ls', '/'] })
      const hasTool = messages.some(m => m.role === 'tool')
      const reply = hasTool
        ? { role: 'assistant', content: '执行完成,结论如上。' }
        : { role: 'assistant', content: '我先看下容器内容。', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'wb_exec', arguments: args } }] }
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const ch = d => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`
        if (reply.tool_calls) {
          if (reply.content) res.write(ch({ role: 'assistant', content: reply.content }))  // 真实 LLM:先流中间文本
          res.write(ch({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'wb_exec', arguments: '' } }] }))
          res.write(ch({ tool_calls: [{ index: 0, function: { arguments: args } }] }))
        } else res.write(ch({ role: 'assistant', content: reply.content }))
        res.write('data: [DONE]\n\n'); return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: reply }] }))
    })
  })
  await new Promise(r => k8s.listen(K8S_PORT, '127.0.0.1', r))
  await new Promise(r => llm.listen(LLM_PORT, '127.0.0.1', r))
  const gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'wb.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const BASE = `http://127.0.0.1:${GW_PORT}`
  const waitStatus = async (id, want, tries = 80) => {
    let st = 'running'
    for (let i = 0; i < tries && !want.includes(st); i++) {
      await new Promise(r => setTimeout(r, 400))
      const c = await (await fetch(`${BASE}/api/workbench/conversations/${id}`, { headers: H })).json()
      st = c.conversation?.status || c.status || st
    }
    return st
  }
  let H
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/auth/login`, { method: 'POST', body: '{}' }); up = true } catch { await new Promise(r => setTimeout(r, 300)) } }
    assert.ok(up, '网关未启动')
    const lr = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
    H = { 'content-type': 'application/json', 'x-platform-token': lr.token }
    await fetch(`${BASE}/api/admin/llm-config`, { method: 'PUT', headers: H, body: JSON.stringify({ baseURL: `http://127.0.0.1:${LLM_PORT}`, model: 'mock-1' }) })
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: http://127.0.0.1:${K8S_PORT}\n  name: m\ncontexts:\n- context:\n    cluster: m\n    user: m\n  name: m\ncurrent-context: m\nusers:\n- name: m\n  user:\n    token: d\n`
    const cr = await (await fetch(`${BASE}/api/admin/clusters`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'mock-k8s', kubeconfig }) })).json()
    const pr = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H, body: JSON.stringify({ name: 't', clusterId: cr.cluster?.id || cr.id }) })).json()
    const cv = await (await fetch(`${BASE}/api/workbench/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ projectId: pr.project?.id || pr.id, message: '看下容器' }) })).json()

    // ① 跑到 paused(审批)
    let st = await waitStatus(cv.id, ['paused', 'failed', 'done'])
    assert.equal(st, 'paused', `应停在审批,实际 ${st}`)

    // ② 批准 → 续跑 → done
    const ap = await fetch(`${BASE}/api/workbench/conversations/${cv.id}/approve`, { method: 'POST', headers: H, body: '{}' })
    assert.equal(ap.status, 200)
    st = await waitStatus(cv.id, ['done', 'failed'])
    assert.equal(st, 'done', `批准后应跑完,实际 ${st}`)

    // ③ 数据完整性:消息级 trace 含 tool(wb_exec)与瘦身 assistant(中间文本+终答,交错渲染数据)
    const conv = await (await fetch(`${BASE}/api/workbench/conversations/${cv.id}`, { headers: H })).json()
    const asst = (conv.messages || []).filter(m => m.role === 'assistant').pop()
    const trace = typeof asst?.trace === 'string' ? JSON.parse(asst.trace) : asst?.trace
    assert.ok(Array.isArray(trace) && trace.some(e => e.type === 'tool' && e.name === 'wb_exec'), `trace 须含 wb_exec 工具事件: ${String(asst?.trace).slice(0, 150)}`)
    assert.ok(trace.some(e => e.type === 'assistant' && e.content === '我先看下容器内容。'), 'trace 须含瘦身 assistant 中间文本')
    assert.ok(trace.some(e => e.type === 'assistant' && e.content === '执行完成,结论如上。'), 'trace 须含终答文本(交错终块)')
    assert.equal(asst.content, '执行完成,结论如上。', '消息 content=终答(与末 assistant 块一致,前端去重依据)')
  } finally {
    gw.kill('SIGKILL'); k8s.close(); llm.close()
    setTimeout(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} }, 500)
  }
})
