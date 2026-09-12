// AI 凭据边界活体回归(2026-09-12 spec §8/§13-4):mock LLM 首轮强制调 read_credential →
// 断言三面:system 注入面(元数据无值)、工具结果面(password 指纹/text 明文)、DB 落库面(纯密文)。
// 审批链:read_credential 恒人审 → paused → approve → 续跑 done。
// 附加用例(Task 6 携带项 a):同名歧义 resolve——dup 两条凭据,工具错误只回候选 id,零明文外泄。
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

// 共享 harness:mock K8s(/version 探活 404 兜底)+ 状态化 mock LLM(无 role:'tool' 回 tool_calls、
// 见 tool 后终答;流式/非流式双形态,照 wb-approval-roundtrip.test.mjs)+ spawn 真网关。
// keepAliveTimeout=30s:同 wb-approval-roundtrip 的 keep-alive 竞态根修——Node mock 默认 5s 关闲连,
// 网关 undici 4s 回收延迟复用已死 socket → fetch failed → 对话被打成 failed。
async function startHarness({ toolArgs, finalText }) {
  const K8S_PORT = 39000 + Math.floor(Math.random() * 4000)
  const LLM_PORT = 43000 + Math.floor(Math.random() * 3000)
  const GW_PORT = 47000 + Math.floor(Math.random() * 2000)
  const DIR = mkdtempSync(join(tmpdir(), 'wb-credai-'))
  const llmRounds = []
  const sawSystem = { text: '' }
  const k8s = createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname
    if (p === '/version') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"major":"1","minor":"31"}') }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end(`{"kind":"Status","message":"nf ${p}"}`)
  })
  const llm = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const { messages = [], stream } = JSON.parse(body || '{}')
      llmRounds.push(messages)
      sawSystem.text = messages[0]?.content || sawSystem.text
      const args = JSON.stringify(toolArgs)
      const hasTool = messages.some(m => m.role === 'tool')
      const reply = hasTool
        ? { role: 'assistant', content: finalText }
        : { role: 'assistant', content: '我读一下该凭据。', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_credential', arguments: args } }] }
      if (stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const ch = d => `data: ${JSON.stringify({ choices: [{ delta: d }] })}\n\n`
        if (reply.tool_calls) {
          res.write(ch({ role: 'assistant', content: reply.content }))
          res.write(ch({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'read_credential', arguments: '' } }] }))
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
  k8s.keepAliveTimeout = 30_000
  llm.keepAliveTimeout = 30_000
  const gw = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(GW_PORT), ALIANG_DB: join(DIR, 'wb.db'), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'x'.repeat(12), ALIANG_STATIC_DIR: DIR, ALIANG_WORKBENCH_DIR: join(DIR, 'wb') },
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const BASE = `http://127.0.0.1:${GW_PORT}`
  const cleanup = () => {
    gw.kill('SIGKILL'); k8s.close(); llm.close()
    setTimeout(() => { try { rmSync(DIR, { recursive: true, force: true }) } catch {} }, 500)
  }
  const login = async () => {
    let up = false
    for (let i = 0; i < 60 && !up; i++) { try { await fetch(`${BASE}/api/auth/login`, { method: 'POST', body: '{}' }); up = true } catch { await new Promise(r => setTimeout(r, 300)) } }
    assert.ok(up, '网关未启动')
    const lr = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(12) }) })).json()
    const H = { 'content-type': 'application/json', 'x-platform-token': lr.token }
    await fetch(`${BASE}/api/admin/llm-config`, { method: 'PUT', headers: H, body: JSON.stringify({ baseURL: `http://127.0.0.1:${LLM_PORT}`, model: 'mock-1' }) })
    return H
  }
  // 造集群+项目+对话,返回 waitStatus 轮询器与对话 id
  const startConversation = async (H, message) => {
    const kubeconfig = `apiVersion: v1\nkind: Config\nclusters:\n- cluster:\n    server: http://127.0.0.1:${K8S_PORT}\n  name: m\ncontexts:\n- context:\n    cluster: m\n    user: m\n  name: m\ncurrent-context: m\nusers:\n- name: m\n  user: {token: d}\n`
    const cr = await (await fetch(`${BASE}/api/admin/clusters`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'mock-k8s', kubeconfig }) })).json()
    const pr = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H, body: JSON.stringify({ name: 't', clusterId: cr.cluster?.id || cr.id }) })).json()
    const cv = await (await fetch(`${BASE}/api/workbench/conversations`, { method: 'POST', headers: H, body: JSON.stringify({ projectId: pr.project?.id || pr.id, message }) })).json()
    const waitStatus = async set => {
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 400))
        const c = await (await fetch(`${BASE}/api/workbench/conversations/${cv.id}`, { headers: H })).json()
        if (set.includes(c.conversation?.status || c.status)) return c.conversation?.status || c.status
      }
      return 'timeout'
    }
    return { cvId: cv.id, waitStatus, approve: () => fetch(`${BASE}/api/workbench/conversations/${cv.id}/approve`, { method: 'POST', headers: H, body: '{}' }) }
  }
  return { DIR, BASE, llmRounds, sawSystem, cleanup, login, startConversation }
}

test('read_credential:password 指纹/text 明文;system 只有元文;审批 paused→approve→done', { timeout: 120000 }, async () => {
  const h = await startHarness({
    toolArgs: { credential: 'gh' },   // 不带 field → 全字段返回:text 明文 + password 指纹,一次读齐
    finalText: '已读取凭据指纹,结论如上。',
  })
  try {
    const H = await h.login()
    // 造凭据(exposeToAi=1)。text 值用带后缀的独立串:裸 'liang' 与固定提示词里的
    // 'aliangboard'(含子串 liang)天然碰撞,断言会永假——见任务报告偏差记录。
    const TEXT_VALUE = 'liang-plain-user'
    await fetch(`${h.BASE}/api/workbench/credentials`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'gh', exposeToAi: true, fields: [
      { key: 'user', type: 'text', value: TEXT_VALUE }, { key: 'token', type: 'password', value: 'ghp_hunter2secret' }] }) })
    // 造集群+项目+对话
    const { cvId, waitStatus, approve } = await h.startConversation(H, '读一下 gh 凭据的 token 字段')
    // paused(审批) → approve → done
    let st = await waitStatus(['paused', 'failed', 'done'])
    assert.equal(st, 'paused', `read_credential 应停在审批,实际 ${st}`)
    const ap = await approve()
    assert.equal(ap.status ?? 200, 200, 'approve 应 2xx')
    st = await waitStatus(['done', 'failed'])
    assert.equal(st, 'done', `approve 后应终态,实际 ${st}`)
    // 面一:system 注入面——元数据在,值不在
    const sys = h.sawSystem.text
    assert.ok(sys.includes('gh') && sys.includes('token(password)'), '清单含名称+字段结构')
    assert.ok(!sys.includes('ghp_hunter2secret') && !sys.includes(TEXT_VALUE), '值不进 system')
    // 面二:工具结果面——tool 消息里 password 指纹 + ref 协议 + text 明文(全字段读取,断言用包含而非
    // JSON.parse:content 序列化形态由 agent.mjs 决定,包含断言对两种形态都成立)
    const toolRound = h.llmRounds.find(ms => ms.some(m => m.role === 'tool'))
    assert.ok(toolRound, '应有回填 tool 消息的轮次')
    const toolMsg = JSON.stringify(toolRound.find(m => m.role === 'tool'))
    assert.match(toolMsg, /\*\*\* \(\d+ chars, #[0-9a-f]{8}\)/, 'password 指纹')
    assert.match(toolMsg, /cred:.{8,}#token/, 'ref 协议在案')
    assert.ok(!toolMsg.includes('ghp_hunter2secret'), 'password 明文绝不出现在 AI 上下文')
    assert.ok(toolMsg.includes(TEXT_VALUE), 'text 字段明文为设计允许')
    // 面三:DB 落库面——fields 纯密文
    const rdb = new DatabaseSync(join(h.DIR, 'wb.db'), { readOnly: true })
    const row = rdb.prepare("SELECT fields FROM workbench_credentials WHERE name='gh'").get()
    rdb.close()
    assert.ok(!row.fields.includes('ghp_hunter2secret') && row.fields.includes('v1:'), '库内只有密文')
    assert.ok(!row.fields.includes(TEXT_VALUE), 'text 值也须密文落库')
  } finally {
    h.cleanup()
  }
})

// Task 6 携带项 a:同名 dup 两条(exposeToAi=1,值不同)→ read_credential 按名解析歧义 →
// 工具错误回候选 id(审批先于执行:paused→approve 后工具才报错)→ 错误喂回 LLM → 终态。
test('同名歧义:read_credential 错误只回候选 id,不含任一明文;对话仍达终态', { timeout: 120000 }, async () => {
  const h = await startHarness({
    toolArgs: { credential: 'dup', field: 'token' },
    finalText: '名称对应多条凭据,需要用户指明,结论如上。',
  })
  try {
    const H = await h.login()
    for (const [user, token] of [['dup-a', 'ghp_dup_one_secret'], ['dup-b', 'ghp_dup_two_secret']]) {
      const r = await fetch(`${h.BASE}/api/workbench/credentials`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'dup', exposeToAi: true, fields: [
        { key: 'user', type: 'text', value: user }, { key: 'token', type: 'password', value: token }] }) })
      assert.equal(r.status, 200, `dup 凭据应创建成功(${user})`)
    }
    const { waitStatus, approve } = await h.startConversation(H, '读一下 dup 凭据的 token')
    let st = await waitStatus(['paused', 'failed', 'done'])
    assert.equal(st, 'paused', `歧义路径同样先过审批门,实际 ${st}`)
    await approve()
    st = await waitStatus(['done', 'failed'])
    assert.equal(st, 'done', `工具报错后 LLM 应终答,实际 ${st}`)
    const toolRound = h.llmRounds.find(ms => ms.some(m => m.role === 'tool'))
    assert.ok(toolRound, '应有回填 tool 错误的轮次')
    const toolMsg = JSON.stringify(toolRound.find(m => m.role === 'tool'))
    assert.ok(toolMsg.includes('候选 id:'), `歧义错误须回候选 id,实际:${toolMsg.slice(0, 200)}`)
    assert.ok(!toolMsg.includes('ghp_dup_one_secret') && !toolMsg.includes('ghp_dup_two_secret'), '任一 password 明文不得出现在错误回执')
  } finally {
    h.cleanup()
  }
})
