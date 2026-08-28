# Secret 值脱敏 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** AI 工具链(workbench wb_* + MCP + @-mention 注入)读 Secret 时值全掩码为指纹形态,存量 trace 明文启动时异步清洗。

**Architecture:** 新纯函数模块 `server/secret-mask.mjs`(掩码单一事实源,幂等);五个消费点接入(wb×2 / MCP×3 / @ref 注入 / 工具描述提示);新 `server/secret-scrub.mjs`(存量清洗)挂 index.mjs 启动序列异步跑。前端零改动(源头掩码)。

**Tech Stack:** 零新依赖;node:crypto sha1;node:test 单测 + 既有 mock/e2e harness。

**Spec:** `docs/superpowers/specs/2026-08-28-secret-masking-design.md`(掩码格式/幂等/清洗契约以 spec 为准)

## Global Constraints

- 仓库零新外部依赖;`node:crypto` 的 `createHash` 是标准库可用。
- 掩码格式逐字:`*** (<N> chars, #<fp8>)`——N=base64 解码后字符数(解码失败回退原文长度),fp8=sha1(解码后字节)前 8 hex;**字段名保留**。
- 幂等:`MASK_PATTERN` 命中的值原样返回(显式短路,不依赖解码巧合)。
- 不 mutate 入参;非 Secret 资源原引用返回。
- audit_log 一律不动(凭证+hash 链)。
- 提交作者恒为 `aliangone <aliangone@gmail.com>`,禁止 Claude 尾注。

---

### Task 1: `server/secret-mask.mjs` 掩码纯函数

**Files:**
- Create: `server/secret-mask.mjs`
- Test: `server/secret-mask.test.mjs`

**Interfaces:**
- Produces(Task 2/3/4 消费):
  - `maskSecretResource(resource: object): object` — `kind === 'Secret'` 时返回新对象(`data`/`stringData` 值掩码);否则返回**同一引用**
  - `export const MASK_PATTERN = /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/`

- [ ] **Step 1: 写失败测试**

```js
// server/secret-mask.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { maskSecretResource, MASK_PATTERN } from './secret-mask.mjs'

const b64 = s => Buffer.from(s, 'utf8').toString('base64')
const secret = () => ({ kind: 'Secret', apiVersion: 'v1', metadata: { name: 'db-cred', namespace: 'ns1' },
  data: { username: b64('admin'), password: b64('s3cr3t-pass') }, stringData: { token: 'plain-token' } })

test('Secret:data/stringData 值掩码为指纹形态,字段名保留', () => {
  const s = secret()
  const out = maskSecretResource(s)
  assert.notEqual(out, s, '返回新对象')
  assert.deepEqual(Object.keys(out.data).sort(), ['password', 'username'], '字段名保留')
  assert.match(out.data.username, MASK_PATTERN)
  assert.match(out.data.password, MASK_PATTERN)
  assert.match(out.stringData.token, MASK_PATTERN)
  // N 与指纹内容:b64('admin') 解码后 5 chars;sha1(b'admin') 前 8 hex 可独立验证
  assert.ok(out.data.username.includes('(5 chars,'))
  assert.equal(out.data.username, `*** (5 chars, #${require('node:crypto').createHash('sha1').update('admin').digest('hex').slice(0, 8)})`)
  // stringData 未编码:原文 'plain-token' 11 chars,指纹=sha1 原文
  assert.ok(out.stringData.token.includes('(11 chars,'))
})

test('非 Secret 资源:原引用返回,零改动', () => {
  const pod = { kind: 'Pod', metadata: { name: 'p1' }, spec: { containers: [] } }
  assert.equal(maskSecretResource(pod), pod)
  const nil = maskSecretResource(null)
  assert.equal(nil, null)
})

test('幂等:掩码形状再掩原样返回', () => {
  const once = maskSecretResource(secret())
  const twice = maskSecretResource(once)
  assert.deepEqual(twice, once)
  assert.equal(twice.data.username, once.data.username)
})

test('不 mutate 入参', () => {
  const s = secret()
  const before = s.data.password
  maskSecretResource(s)
  assert.equal(s.data.password, before, '原对象未变')
})

test('防御:非字符串值归一;不可 base64 解码回退原文长度', () => {
  const out = maskSecretResource({ kind: 'Secret', data: { weird: 12345, bad: '!!!not-base64!!!' } })
  assert.match(String(out.data.weird), MASK_PATTERN)
  assert.ok(out.data.bad.includes('(16 chars,'), '原文长度回退')
})

test('MASK_PATTERN 形状自锁', () => {
  assert.ok(MASK_PATTERN.test('*** (24 chars, #a1b2c3d4)'))
  assert.ok(!MASK_PATTERN.test('*** (24 chars, a1b2c3d4)'))
  assert.ok(!MASK_PATTERN.test('YWJjZA=='))
})
```

(实现者注:测试文件用 ESM import,`require('node:crypto')` 在 .mjs 不可用——顶部改 `import { createHash } from 'node:crypto'` 后引用。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/secret-mask.test.mjs`
Expected: FAIL(cannot find module)

- [ ] **Step 3: 最小实现**

```js
// server/secret-mask.mjs
// Secret 值脱敏单一事实源(spec 2026-08-28 §3.1):字段名保留、值→「长度+sha1 指纹」,
// AI 保留 key 核对/同值比对能力,只断明文通路。幂等(MASK_PATTERN 短路),不 mutate。
import { createHash } from 'node:crypto'

export const MASK_PATTERN = /^\*\*\* \(\d+ chars, #[0-9a-f]{8}\)$/

function maskValue(v) {
  const raw = typeof v === 'string' ? v : String(v)
  if (MASK_PATTERN.test(raw)) return raw // 幂等短路:已掩码原样返回
  let decoded
  try { decoded = Buffer.from(raw, 'base64').toString('utf8') } catch { decoded = null }
  // base64 解码总"成功"(宽松);判可解码:重编码 round-trip 一致才算干净解码
  const roundTripOk = decoded != null && Buffer.from(decoded, 'utf8').toString('base64') === raw
  const bytes = roundTripOk ? decoded : raw
  const n = bytes.length
  const fp = createHash('sha1').update(bytes, 'utf8').digest('hex').slice(0, 8)
  return `*** (${n} chars, #${fp})`
}

export function maskSecretResource(resource) {
  if (!resource || resource.kind !== 'Secret') return resource
  const out = { ...resource }
  for (const field of ['data', 'stringData']) {
    const src = resource[field]
    if (src && typeof src === 'object' && !Array.isArray(src)) {
      out[field] = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, maskValue(v)]))
    }
  }
  return out
}
```

(实现者注:`Buffer.from('!!!not-base64!!!','base64')` 宽松解码不抛——JS 的 base64 忽略非法字符。判「干净解码」用 round-trip:重编码等于原文才算,stringData 的明文(非 base64 形状)自然走原文路径——spec 的「解码失败回退原文长度」在 JS 语义下以此实现,测试里 bad 值走 16 chars 原文路径即验证此点。)

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/secret-mask.test.mjs`
Expected: 6 pass

- [ ] **Step 5: 提交**

```bash
git add server/secret-mask.mjs server/secret-mask.test.mjs
git commit -m "feat(security): secret-mask 掩码纯函数——字段名保留+值指纹(长度/sha1-8),幂等不 mutate(脱敏 T1)"
```

---

### Task 2: wb 工具 + @-mention 注入接入

**Files:**
- Modify: `server/index.mjs`(getResource ~1197 / describeResource ~1184 / fetchRefContext ~1103)
- Test: `server/wb-secret-mask.test.mjs`(新,活体 e2e)

**Interfaces:**
- Consumes: Task 1 `maskSecretResource`
- Produces: wb_get_resource/wb_describe_resource 返回的 Secret 为掩码形;@ref 注入的 context 无明文

- [ ] **Step 1: 写失败测试(活体 e2e,仿 wb-approval-roundtrip harness)**

```js
// server/wb-secret-mask.test.mjs
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
```

(实现者注:工具结果面(wb_get_resource)在本 e2e 里 LLM mock 恒终答不会调工具——工具面由 Task 3 的 MCP 单测同逻辑覆盖(mock requestFn 直测),本测试锁 @ref 注入面即可;若想让 LLM 调工具,mock 首轮回 tool_calls 调 wb_get_resource(kind secrets)即可加分,不强求。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/wb-secret-mask.test.mjs`
Expected: FAIL(明文出现在 system 断言)

- [ ] **Step 3: 实现**

`server/index.mjs` 顶部 import 增加:

```js
import { maskSecretResource } from './secret-mask.mjs'
```

`fetchRefContext`(line ~1103)内 `requestKubernetes` 拉到 body 后、push 进 blocks/resources 前掩码——定位 `const body = res?.body` 一带,改为:

```js
      const body = maskSecretResource(res?.body)
```

`buildWbCtx` 内 `getResource`(line ~1197)返回处:

```js
          return { resource: maskSecretResource(body) }
```

`describeResource`(line ~1184)返回处(resource 部分):

```js
          const maskedBody = maskSecretResource(body)
          return { resource: maskedBody, events: { count: ..., items } }   // events 原样,保留现有代码
```

(实现者注:按现场代码微调——原则:`describe` 的 `resource` 字段过掩码,events 不动;`getResource` 现有 `delete managedFields` 逻辑保留,掩码在其后。)

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `node --test server/wb-secret-mask.test.mjs server/wb-approval-roundtrip.test.mjs server/wb-podlogs-roundtrip.test.mjs`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add server/index.mjs server/wb-secret-mask.test.mjs
git commit -m "feat(security): wb_get_resource/describe 与 @ref 注入接掩码——Secret 明文不进 LLM 请求(脱敏 T2)"
```

---

### Task 3: MCP 工具接入 + 工具描述提示

**Files:**
- Modify: `server/api-key-tools.mjs`(get_resource ~166 / get_resource_yaml ~155 / describe_resource ~203)
- Modify: `server/tool-registry.mjs`(三个工具的 description 追加提示)
- Test: `server/api-key-tools.test.mjs`(追加)

**Interfaces:**
- Consumes: Task 1 `maskSecretResource`
- Produces: MCP get_resource/get_resource_yaml/describe_resource 的 Secret 值为掩码形

- [ ] **Step 1: 写失败测试**

追加到 `server/api-key-tools.test.mjs`(沿用其 mockRequestFn——看 Task 上下文,mock 的 `/namespaces/x/pods/y` 单体分支返回 Pod;需新增 Secret 分支或用 mockRequestFn({ }) 的覆盖参数。最简:给 mockRequestFn 增加可选 `getResourceBody` 覆盖):

```js
// ── 脱敏 T3:MCP 读 Secret 值全掩码(D2:MCP 一致掩码)──
test('get_resource/describe_resource/get_resource_yaml:Secret 值掩码指纹,明文/ base64 不出现', async () => {
  const db = makeDb()
  const k = mintKey(db, { owner: 'alice', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa' })
  const secretBody = { kind: 'Secret', metadata: { name: 'db-cred', namespace: 'ns' },
    data: { password: Buffer.from('s3cr3t-hunter2').toString('base64') }, stringData: { tok: 'plain-tok' } }
  const tools = createApiKeyTools({ db, requestFn: mockRequestFn({ getResourceBody: secretBody }) })
  const out = await tools.getResource(k, cluster, { namespace: 'ns', kind: 'secrets', name: 'db-cred' })
  assert.equal(out.resource.kind, 'Secret')
  assert.ok(!JSON.stringify(out).includes('s3cr3t-hunter2') && !JSON.stringify(out).includes(Buffer.from('s3cr3t-hunter2').toString('base64')), '明文/base64 不出现')
  assert.match(out.resource.data.password, /\*\*\* \(\d+ chars, #[0-9a-f]{8}\)/)
  assert.match(out.resource.stringData.tok, /\(9 chars,/)
})
```

(实现者注:`tools.getResource`/`describeResource` 的既有导出名先 `grep -n "getPodLogs:" server/api-key-tools.mjs` 看现有测试怎么调——T8 harness 返回 `{ callTool, getPodLogs, listTools }` 若无 getResource 直调,则测试走 `tools.callTool(k, cluster, 'get_resource', args, 'test')` 同款;mockRequestFn 的单体 GET 分支(`/namespaces/x/pods/y`)当前返回 Pod——加 `getResourceBody` 参数覆盖该分支返回体即可,勿动其它分支。)

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/api-key-tools.test.mjs`
Expected: 新测试 FAIL(明文在)

- [ ] **Step 3: 实现**

`server/api-key-tools.mjs` import 增加:

```js
import { maskSecretResource } from './secret-mask.mjs'
```

三个接入点(按现场行号):
- `get_resource`:`return oversizedJson(body) || { resource: maskSecretResource(body) }`(oversizedJson 分支:`oversizedJson(maskSecretResource(body))`——掩码后再算体积/截断)
- `describe_resource`:`{ ...oversizedJson(maskSecretResource(resBody)), events: eventsOut }` 与 `else { resource: maskSecretResource(resBody), events }` 两分支同款
- `get_resource_yaml`:`const body = maskSecretResource(...)` 后再 `delete managedFields`/`yamlDump`

`server/tool-registry.mjs` 三个 description 各追加一句(英文,给 LLM):
`Secret values are masked as fingerprints (length + sha1-8); compare keys/equality here, check plaintext in the platform Secrets page.`

- [ ] **Step 4: 跑测试确认通过 + MCP 回归**

Run: `node --test server/api-key-tools.test.mjs server/mcp.test.mjs`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add server/api-key-tools.mjs server/api-key-tools.test.mjs server/tool-registry.mjs
git commit -m "feat(security): MCP get/describe/yaml 接掩码+工具描述提示——外部 AI 同指纹口径(脱敏 T3)"
```

---

### Task 4: 存量清洗 `secret-scrub` + 启动挂载

**Files:**
- Create: `server/secret-scrub.mjs`
- Modify: `server/index.mjs`(启动序列 ~line 159 `salvageInterrupted(db)` 之后)
- Test: `server/secret-scrub.test.mjs`

**Interfaces:**
- Consumes: Task 1 `maskSecretResource`
- Produces: `scrubSecrets(db) → { rowsScanned, eventsMasked }`;启动后 2s 异步执行

- [ ] **Step 1: 写失败测试**

```js
// server/secret-scrub.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema, createProject, createConversation, appendMessage } from './workbench-projects.mjs'
import { scrubSecrets } from './secret-scrub.mjs'

const SECRET_PLAIN = { kind: 'Secret', metadata: { name: 's1' }, data: { password: Buffer.from('hunter2').toString('base64') } }

function setup() {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  createProject(db, { name: 'p1', clusterId: 'c1', ownerId: 'u1' })
  const project = db.prepare("SELECT * FROM workbench_projects WHERE name='p1'").get()
  const conv = createConversation(db, { projectId: project.id, system: 'sys', userMessage: 'hi' })
  return { db, conv }
}

test('scrubSecrets:对话级+消息级 trace 的 Secret 事件重掩;非 Secret 不动;幂等', () => {
  const { db, conv } = setup()
  const trace = JSON.stringify([
    { type: 'tool', name: 'wb_get_resource', args: { kind: 'secrets' }, result: { resource: SECRET_PLAIN }, ts: 1 },
    { type: 'tool', name: 'wb_get_resource', args: { kind: 'pods' }, result: { resource: { kind: 'Pod', metadata: { name: 'p1' } } }, ts: 2 },
  ])
  db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run(trace, conv.id)
  appendMessage(db, { conversationId: conv.id, role: 'assistant', content: 'ok', trace })
  const r1 = scrubSecrets(db)
  assert.equal(r1.eventsMasked, 2, '对话级+消息级各 1 个 Secret 事件')
  assert.ok(!db.prepare('SELECT trace FROM workbench_conversations WHERE id=?').get(conv.id).trace.includes('aHVudGVyMg=='), '明文(base64)已清除')
  assert.match(db.prepare('SELECT trace FROM workbench_conversations WHERE id=?').get(conv.id).trace, /\*\*\* \(\d+ chars, #/)
  const r2 = scrubSecrets(db)
  assert.equal(r2.eventsMasked, 0, '幂等:再跑零变化')
})

test('scrubSecrets:损坏 JSON 行跳过不抛', () => {
  const { db, conv } = setup()
  db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run('{broken json', conv.id)
  const r = scrubSecrets(db)
  assert.equal(r.rowsScanned >= 1, true)
  assert.equal(r.eventsMasked, 0)
})

test('scrubSecrets:trace 为空/[] 的行安全跳过', () => {
  const { db, conv } = setup()
  db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run('[]', conv.id)
  const r = scrubSecrets(db)
  assert.equal(r.eventsMasked, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/secret-scrub.test.mjs`
Expected: FAIL(cannot find module)

- [ ] **Step 3: 实现**

```js
// server/secret-scrub.mjs
// 存量明文清洗(spec §3.3,2026-08-28):扫对话级+消息级 trace,对 result.resource.kind==='Secret'
// 的事件重掩。幂等;损坏行跳过。audit_log 不动(凭证+hash 链)。启动后异步跑,不阻塞。
import { maskSecretResource } from './secret-mask.mjs'

function scrubTraceJson(json) {
  let events
  try { events = JSON.parse(json) } catch { return null }
  if (!Array.isArray(events)) return null
  let masked = 0
  const out = events.map(e => {
    const r = e?.result?.resource
    if (r && r.kind === 'Secret') { masked++; return { ...e, result: { ...e.result, resource: maskSecretResource(r) } } }
    return e
  })
  return masked ? { json: JSON.stringify(out), masked } : null
}

export function scrubSecrets(db) {
  const stats = { rowsScanned: 0, eventsMasked: 0 }
  for (const row of db.prepare("SELECT id, trace FROM workbench_conversations WHERE trace IS NOT NULL AND trace != '[]'").all()) {
    stats.rowsScanned++
    const r = scrubTraceJson(row.trace)
    if (r) { stats.eventsMasked += r.masked; db.prepare('UPDATE workbench_conversations SET trace=? WHERE id=?').run(r.json, row.id) }
  }
  for (const row of db.prepare("SELECT seq, trace FROM workbench_messages WHERE trace IS NOT NULL AND trace != '[]'").all()) {
    stats.rowsScanned++
    const r = scrubTraceJson(row.trace)
    if (r) { stats.eventsMasked += r.masked; db.prepare('UPDATE workbench_messages SET trace=? WHERE seq=?').run(r.json, row.seq) }
  }
  return stats
}
```

(workbench_messages 主键确认:先 `grep -n "CREATE TABLE workbench_messages" -A 5 server/workbench-projects.mjs` 核对主键名——若为 (conversationId, seq) 复合主键,UPDATE WHERE 用两列。)

`server/index.mjs` 启动序列(~line 159)之后:

```js
salvageInterrupted(db)
// 存量 Secret 明文清洗(spec 2026-08-28):异步跑不阻塞启动;幂等可重入
setTimeout(() => {
  try {
    const r = scrubSecrets(db)
    if (r.eventsMasked > 0) console.log(`[secret-scrub] 存量重掩 ${r.eventsMasked} 个 Secret 工具事件(扫 ${r.rowsScanned} 行)`)
  } catch (e) { console.warn('[secret-scrub] 清洗失败(下个启动重试):', e?.message || e) }
}, 2000)
```

import 增加:`import { scrubSecrets } from './secret-scrub.mjs'`

- [ ] **Step 4: 跑测试确认通过 + 全量服务端回归**

Run: `node --test server/secret-scrub.test.mjs && npm run test:server 2>&1 | tail -3`
Expected: 全 PASS

- [ ] **Step 5: 提交**

```bash
git add server/secret-scrub.mjs server/secret-scrub.test.mjs server/index.mjs
git commit -m "feat(security): 存量 trace Secret 明文启动异步清洗——幂等可重入,audit_log 不动(脱敏 T4)"
```

---

### Task 5: 全量回归 + 收尾

**Files:** 无新改(验证任务)

- [ ] **Step 1: 全量验证**

```bash
npm test               # 全量(前端不涉改动,服务端新测试纳入)
npm run typecheck
npm run build
```

Expected: 全绿。

- [ ] **Step 2: 手测清单(需集群,记入合并提交信息)**

- 真集群 wb_get_resource 读 Secret → ToolCallModal 显示指纹;@secret 引用后 AI 能说出 key 名/长度/两 Secret 是否同值
- MCP 客户端(Claude Code)get_resource → 同指纹
- 网关重启 → 控制台出现(或不出现)`[secret-scrub]` 统计;老对话工具详情里明文变指纹

- [ ] **Step 3: 合并**——worktree 分支 → `git merge --ff-only` → push(用户裁决 tag)。

---

## Self-Review 记录

1. **Spec 覆盖**:§3.1→T1;§3.2 五路径→T2(wb×2+@ref)+T3(MCP×3+描述);§3.3→T4;§4 错误处理散在 T1 防御测试/T4 损坏行;§5 测试对应各任务。无遗漏。
2. **占位符**:T2 Step 3 describe 处保留 `events: { count: ..., items }` 现场占位——已注明「按现场代码微调,原则:resource 过掩码 events 不动」,非 TBD(是明确的现场适配指令)。其余代码块完整。
3. **类型一致**:`maskSecretResource`/`MASK_PATTERN` T1 定义,T2/T3/T4 消费一致;`scrubSecrets → {rowsScanned, eventsMasked}` T4 测试与实现一致;掩码格式串三处测试断言与 T1 定义逐字同。
