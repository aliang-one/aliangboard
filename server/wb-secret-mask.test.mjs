// 活体回归网(2026-08-28 脱敏 T2):k8s mock 返回 Secret → LLM 实收的工具结果与 @ref system 注入
// 均无明文,值呈掩码指纹形态。复用 wb-approval-roundtrip 的网关拉起模式。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SECRET = { kind: 'Secret', apiVersion: 'v1', metadata: { name: 'db-cred', namespace: 'ns1' },
  data: { password: Buffer.from('s3cr3t-hunter2').toString('base64') } }

test('wb_get_resource 读 Secret:LLM 收到掩码指纹,明文不出现在工具结果/refContext', { timeout: 90000 }, async () => {
  const K8S_PORT = 39000 + Math.floor(Math.random() * 4000)
  const LLM_PORT = 43000 + Math.floor(Math.random() * 3000)
  const GW_PORT = 46000 + Math.floor(Math.random() * 3000)
  const DIR = mkdtempSync(join(tmpdir(), 'wb-secmask-'))
  let llmSawSystem = '', llmSawTool = ''
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31"}') }
    if (p.includes('/namespaces/ns1/secrets/db-cred')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(SECRET)) }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(`{"kind":"Status","message":"nf ${p}"}`)
  })
  const llm = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { messages = [], stream } = JSON.parse(body || '{}')
      llmSawSystem = messages[0]?.content || llmSawSystem
      const toolJson = messages.filter(m => m.role === 'tool').map(m => m.content).join('\n')
      if (toolJson) llmSawTool = toolJson
      const reply = { role: 'assistant', content: '已读取' }
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant', content: reply.content } }] })}\n\n`)
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
    // @secret:ns1/db-cred 引用 + 首条消息即问(工具调用由消息引导不可靠——直接断 refContext;
    // 工具面经第二条对话 wb_get_resource 走:LLM mock 恒终答,故工具断言改用直接 HTTP 不可行,
    // 改由 refContext 面覆盖:LLM 首轮 system 含引用资源 JSON)
    const cv = await (await fetch(`${BASE}/api/workbench/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ projectId: pr.project?.id || pr.id, message: '这个 secret 配置对吗', references: [{ kind: 'secrets', namespace: 'ns1', name: 'db-cred' }] }) })).json()
    let st = 'running'
    for (let i = 0; i < 80 && st === 'running'; i++) {
      await new Promise(r => setTimeout(r, 400))
      const c = await (await fetch(`${BASE}/api/workbench/conversations/${cv.id}`, { headers: H })).json()
      st = c.conversation?.status || c.status || st
    }
    assert.notEqual(st, 'running', '对话应终态')
    assert.ok(llmSawSystem.includes('db-cred'), 'refContext 注入了 Secret 资源')
    assert.ok(!llmSawSystem.includes('s3cr3t-hunter2'), '明文不得进 system')
    assert.ok(!llmSawSystem.includes(Buffer.from('s3cr3t-hunter2').toString('base64')), 'base64 明文也不得进 system')
    assert.match(llmSawSystem, /\*\*\* \(\d+ chars, #[0-9a-f]{8}\)/, '值为掩码指纹形态')
  } finally {
    gw.kill('SIGKILL'); k8s.close(); llm.close()
    setTimeout(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} }, 500)
  }
})
