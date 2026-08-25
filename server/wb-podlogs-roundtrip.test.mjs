// wb_get_pod_logs 全链路回归(mock LLM + mock K8s + 真网关子进程):工具结果必须含真实日志文本。
// 背景(2026-08-25):ctx.wb.getPodLogs 曾把 requestKubernetes 的返回 {status,headers,body} 整个当日志串
// → String({}) = "[object Object]",AI 对话永远看不到真实日志(该闭包在 index.mjs 内联,此前零覆盖)。
// 本测试是唯一覆盖该路径的自动化网:起真 server/index.mjs(临时 DB/WORKBENCH,随机端口),
// mock LLM(OpenAI 兼容,含 SSE)发 wb_get_pod_logs 工具调用并记录第 2 轮收到的 role:'tool' 消息。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKE_LOG = 'postgres FATAL: password authentication failed for user "supabase_admin"'
const ports = () => [19000 + Math.floor(Math.random() * 900), 20000 + Math.floor(Math.random() * 4000), 25000 + Math.floor(Math.random() * 4000)]

test('wb_get_pod_logs:工具结果进 LLM 消息的是真实日志,不是 [object Object]', { timeout: 60000 }, async () => {
  const [K8S_PORT, LLM_PORT, GW_PORT] = ports()
  const DIR = mkdtempSync(join(tmpdir(), 'wb-podlogs-'))
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31","gitVersion":"v1.31.4"}') }
    if (p === '/api/v1/namespaces/ns1/pods/p1/log') { res.writeHead(200, { 'content-type': 'text/plain;charset=utf-8' }); return res.end(FAKE_LOG) }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(`{"kind":"Status","message":"not found: ${p}"}`)
  })
  const llmRounds = []
  const llm = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { messages = [], stream } = JSON.parse(body || '{}')
      llmRounds.push(messages)
      const toolArgs = JSON.stringify({ namespace: 'ns1', pod: 'p1' })
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const ch = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`
        if (!messages.some(m => m.role === 'tool')) {
          res.write(ch({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'wb_get_pod_logs', arguments: '' } }] }))
          res.write(ch({ tool_calls: [{ index: 0, function: { arguments: toolArgs } }] }))
        } else res.write(ch({ role: 'assistant', content: '日志已查看' }))
        res.write('data: [DONE]\n\n'); return res.end()
      }
      const msg = messages.some(m => m.role === 'tool')
        ? { role: 'assistant', content: '日志已查看' }
        : { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wb_get_pod_logs', arguments: toolArgs } }] }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: msg }] }))
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
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/auth/login`, { method: 'POST', body: '{}' }); up = true } catch { await new Promise(r => setTimeout(r, 300)) } }
    assert.ok(up, '网关未启动')
    const lr = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
    const H = { 'content-type': 'application/json', 'x-platform-token': lr.token }
    await fetch(`${BASE}/api/admin/llm-config`, { method: 'PUT', headers: H, body: JSON.stringify({ baseURL: `http://127.0.0.1:${LLM_PORT}`, model: 'mock-1' }) })
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: http://127.0.0.1:${K8S_PORT}\n  name: m\ncontexts:\n- context:\n    cluster: m\n    user: m\n  name: m\ncurrent-context: m\nusers:\n- name: m\n  user:\n    token: d\n`
    const cr = await (await fetch(`${BASE}/api/admin/clusters`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'mock-k8s', kubeconfig }) })).json()
    const pr = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H, body: JSON.stringify({ name: 't', clusterId: cr.cluster?.id || cr.id }) })).json()
    const cv = await (await fetch(`${BASE}/api/workbench/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ projectId: pr.project?.id || pr.id, message: '看日志' }) })).json()
    let status = 'running'
    for (let i = 0; i < 60 && (status === 'running' || status === 'paused'); i++) {
      await new Promise(r => setTimeout(r, 400))
      const c = await (await fetch(`${BASE}/api/workbench/conversations/${cv.id}`, { headers: H })).json()
      status = c.conversation?.status || c.status || status
    }
    const toolMsg = llmRounds.flatMap(m => m.filter(x => x.role === 'tool')).map(x => String(x.content || '')).join('\n')
    assert.ok(toolMsg.includes('password authentication failed'), `工具结果应含真实日志,实际:${toolMsg.slice(0, 200)}`)
    assert.ok(!toolMsg.includes('[object Object]'), '工具结果不得出现 [object Object]')
    // 消息级 trace 持久化(2026-08-25「聊天结束后看不到工具调用」根因:写入端用 out.trace——
    // runner 返回里根本没有该字段,恒落 "[]";对话级 trace 一直是好的,前端重建却吃消息级)。
    const conv = await (await fetch(`${BASE}/api/workbench/conversations/${cv.id}`, { headers: H })).json()
    const asst = (conv.messages || []).filter(m => m.role === 'assistant').pop()
    const msgTrace = typeof asst?.trace === 'string' ? JSON.parse(asst.trace) : asst?.trace
    assert.ok(Array.isArray(msgTrace) && msgTrace.some(e => e.type === 'tool' && e.name === 'wb_get_pod_logs'),
      `assistant 消息 trace 须含本轮工具事件,实际:${String(asst?.trace).slice(0, 120)}`)
  } finally {
    gw.kill('SIGKILL'); k8s.close(); llm.close()
    setTimeout(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} }, 500)
  }
})

test('/api/agent/chat @-mention 注入:进 LLM 的是资源 body,不是 {status,headers,body} 信封', { timeout: 60000 }, async () => {
  const [K8S_PORT, LLM_PORT, GW_PORT] = [28000 + Math.floor(Math.random() * 4000), 32000 + Math.floor(Math.random() * 3000), 36000 + Math.floor(Math.random() * 3000)]
  const DIR = mkdtempSync(join(tmpdir(), 'wb-refs-'))
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31","gitVersion":"v1.31.4"}') }
    if (p === '/api/v1/namespaces/ns1/pods/p1') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ kind: 'Pod', metadata: { name: 'p1', namespace: 'ns1' } })) }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(`{"kind":"Status","message":"not found: ${p}"}`)
  })
  const llmMsgs = []
  const llm = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { messages = [], stream } = JSON.parse(body || '{}')
      llmMsgs.push(...messages)
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: '收到' } }] })}\n\n`)
        res.write('data: [DONE]\n\n'); return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '收到' } }] }))
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
  try {
    let up = false
    for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/auth/login`, { method: 'POST', body: '{}' }); up = true } catch { await new Promise(r => setTimeout(r, 300)) } }
    assert.ok(up, '网关未启动')
    const lr = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
    const H = { 'content-type': 'application/json', 'x-platform-token': lr.token }
    await fetch(`${BASE}/api/admin/llm-config`, { method: 'PUT', headers: H, body: JSON.stringify({ baseURL: `http://127.0.0.1:${LLM_PORT}`, model: 'mock-1' }) })
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: http://127.0.0.1:${K8S_PORT}\n  name: m\ncontexts:\n- context:\n    cluster: m\n    user: m\n  name: m\ncurrent-context: m\nusers:\n- name: m\n  user:\n    token: d\n`
    const cr = await (await fetch(`${BASE}/api/admin/clusters`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'mock-k8s', kubeconfig }) })).json()
    const pr = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H, body: JSON.stringify({ name: 't2', clusterId: cr.cluster?.id || cr.id }) })).json()
    const reply = await (await fetch(`${BASE}/api/agent/chat`, { method: 'POST', headers: H, body: JSON.stringify({ projectId: pr.project?.id || pr.id, message: '看这个 pod', references: [{ kind: 'pods', namespace: 'ns1', name: 'p1' }] }) })).json()
    assert.equal(reply.status, 'done', `对话应完成: ${JSON.stringify(reply).slice(0, 120)}`)
    const userMsg = llmMsgs.filter(m => m.role === 'user').map(m => String(m.content || '')).join('\n')
    assert.ok(userMsg.includes('"kind": "Pod"'), `@-ref 注入应含资源 body: ${userMsg.slice(0, 200)}`)
    assert.ok(!userMsg.includes('"headers"') && !userMsg.includes('"status": 200'), `不得注入 {status,headers,body} 信封: ${userMsg.slice(0, 200)}`)
  } finally {
    gw.kill('SIGKILL'); k8s.close(); llm.close()
    setTimeout(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} }, 500)
  }
})
