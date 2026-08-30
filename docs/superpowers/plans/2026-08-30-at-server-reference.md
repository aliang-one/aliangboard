# @server 引用 SSH 服务器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工作台对话支持 `@server:关键字` 引用 SSH 服务器(名称/IP/备注单层搜索),选中后 AI 每轮获得脱敏服务器上下文,天然衔接 wb_ssh_* 工具。

**Architecture:** 复用既有 @-mention 管线——search 端点加 `kind=server` 分支(exposedOnly 单一事实源,置于集群校验之前,门 requirePlatform);fetchRefContext 加 server 分支(纯函数 `buildServerRefBlock` 产出脱敏注入块)+ guard 修正(无集群不吞 server refs);前端加 alias/分支/chip 图标。

**Tech Stack:** 零依赖纯逻辑 + node:test(spawn 真网关)、vitest + @vue/test-utils。

**Spec:** `docs/superpowers/specs/2026-08-30-at-server-reference-design.md`

## Global Constraints

- 零新增外部依赖;提交作者恒 `aliangone <aliangone@gmail.com>`,禁止 Co-Authored-By 尾注;git add 只点名文件
- **脱敏红线(spec §4)**:host 参与搜索匹配但**仅 admin 响应携带**;AI 注入块**永不含 host/username**;凭据任何一层不出现
- 数据源单一事实源:`listSshServers(db, { exposedOnly: true })`(未暴露服务器搜不到、ref 标 not found)
- server ref 形状:`{ kind: 'server', namespace: '', name: <服务器名称> }`;kind 比较用**原始值** `ref.kind === 'server'`(`normalizeKind('server')` 不认识它,先判原始值再走 K8s 归一)
- i18n zh/en 双语;`npm run i18n:check` 六项全 0;每任务红→绿→提交;worktree 分支上开发

---

### Task 1: 搜索端点 server 分支

**Files:**
- Modify: `server/routes/workbench-projects.mjs:203-232`(`/api/workbench/search`)
- Test: Create `server/wb-server-ref.test.mjs`

**Interfaces:**
- Produces: `GET /api/workbench/search?projectId&kind=server&q=` → `{ items: [{ kind:'server', name, description, clusterRef, ...(admin ? { host } : {}) }] }`;门=requirePlatform(server 分支)/requireAdmin(K8s 分支维持);server 分支**不要求项目绑集群**(项目须存在)
- 数据源:`listSshServers(db, { exposedOnly: true })`(从 `../ssh/store.mjs` import;该文件已 import normalizeKind)

- [ ] **Step 1: 写失败测试** `server/wb-project-cluster.test.mjs` 的姊妹文件 `server/wb-server-ref.test.mjs`(spawn 骨架逐字照 `server/wb-project-cluster.test.mjs`:PORT `55000 + Math.floor(Math.random() * 2000)`、mkdtemp、ADMIN、waitUp、cleanup;clusters/ssh_servers 行用 node:sqlite 直插网关库——ssh_servers 建表列以 `server/ssh/store.mjs` 的 SANITIZE_COLS/建表语句为准,encXxx 列插 `''` 即可):

```js
test('@server 搜索:exposedOnly+三路命中+host 仅 admin;未绑集群可用;K8s 分支门不回退', { timeout: 60000 }, async () => {
  await waitUp()
  const login = await adminLogin()
  const H = { 'content-type': 'application/json', 'x-platform-token': login.token }
  // 未绑定集群建项目(clusterId 缺省,wb-project-cluster 特性)
  const proj = await (await fetch(`${BASE}/api/workbench/projects`, { method: 'POST', headers: H, body: JSON.stringify({ name: 'ref-p' }) })).json()
  const pid = proj.project.id
  // 直插两台服务器:一台 exposed(gw/10.0.0.1),一台未暴露(hidden/10.0.0.2)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(DIR, 'wb.db'))
  const ins = db.prepare('INSERT INTO ssh_servers (id,name,host,port,username,authMethod,description,clusterRef,exposeToAi,aiApprovalPolicy,status,createdAt,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  ins.run('s1', '网关机', '10.0.0.1', 22, 'ops', 'password', '入口网关', 'ck-t1', 1, 'readonly', 'ok', Date.now(), Date.now())
  ins.run('s2', '隐藏机', '10.0.0.2', 22, 'ops', 'password', '不该出现', '', 0, 'always', 'ok', Date.now(), Date.now())
  db.close()

  // admin:name/host/备注 三路命中;未暴露不可见;host 字段在
  const byName = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=${encodeURIComponent('网关')}`, { headers: H })).json()
  assert.equal(byName.items.length, 1); assert.equal(byName.items[0].name, '网关机'); assert.equal(byName.items[0].host, '10.0.0.1')
  const byIp = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=10.0.0.1`, { headers: H })).json()
  assert.equal(byIp.items.length, 1)
  const byDesc = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=${encodeURIComponent('入口')}`, { headers: H })).json()
  assert.equal(byDesc.items.length, 1)

  // 平台用户:可见 exposed;命中同样工作;响应无 host 字段
  const mk = await fetch(`${BASE}/api/admin/users`, { method: 'POST', headers: H, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })
  assert.ok([200, 201].includes(mk.status))
  const plogin = await (await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'peon', password: 'p'.repeat(12) }) })).json()
  const PH = { 'content-type': 'application/json', 'x-platform-token': plogin.token }
  const pRes = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=10.0.0.1`, { headers: PH })).json()
  assert.equal(pRes.items.length, 1)
  assert.equal('host' in pRes.items[0], false, '非 admin 响应不得携带 host')
  const pHidden = await (await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=server&q=隐藏`, { headers: PH })).json()
  assert.equal(pHidden.items.length, 0, '未暴露服务器不可见')

  // K8s 分支回归:非 admin → 401/403(requireAdmin 仍在);server 分支放行不等于 K8s 分支放行
  const k8sGate = await fetch(`${BASE}/api/workbench/search?projectId=${pid}&kind=pod&q=x`, { headers: PH })
  assert.ok([401, 403].includes(k8sGate.status))
})
```

(实现者注意:平台用户建项目即 owner;spawn 骨架的 waitUp/login/cleanup 照姊妹文件;admin 建用户端点字段以 routes/admin.mjs 实际为准。)

- [ ] **Step 2: 跑红**:`node --test server/wb-server-ref.test.mjs` → FAIL(server 分支不存在:normalizeKind('server') 落 kindUnsupported 400 或 admin 门 401)

- [ ] **Step 3: 实现** — 该路由块改为:

```js
    if (url.pathname === '/api/workbench/search' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      const projectId = url.searchParams.get('projectId')
      const kindRaw = (url.searchParams.get('kind') || '').toLowerCase()
      const q = (url.searchParams.get('q') || '').toLowerCase()
      if (!projectId) { sendJson(res, 400, { message: msg(req, 'wbp.projectIdRequired') }); return true }
      const p = db.prepare('SELECT * FROM workbench_projects WHERE id=?').get(projectId)
      if (!p) { sendJson(res, 404, { message: msg(req, 'wbp.projectNotFound') }); return true }
      // server 分支(2026-08-30 @server spec §3):与集群无关;exposedOnly 单一事实源;host 仅 admin 响应携带
      if (kindRaw === 'server') {
        const items = listSshServers(db, { exposedOnly: true })
          .filter(s => !q || s.name.toLowerCase().includes(q) || String(s.host || '').toLowerCase().includes(q) || String(s.description || '').toLowerCase().includes(q))
          .slice(0, 50)
          .map(s => ({ kind: 'server', name: s.name, description: s.description || '', clusterRef: s.clusterRef || '', ...(ps.role === 'admin' ? { host: s.host } : {}) }))
        sendJson(res, 200, { items })
        return true
      }
      const psAdmin = requireAdmin(req, res); if (!psAdmin) return true   // K8s 分支维持 admin(原函数级门下移到分支内)
      if (!p.clusterId) { sendJson(res, 400, { message: msg(req, 'wbp.noBoundCluster') }); return true }
      const kind = normalizeKind(kindRaw) || 'pods'
      // …以下原 K8s 逻辑逐行保留(cluster 查询/listPath/requestKubernetes/filtered),仅 kind 来源改为 kindRaw 归一
```

(import 行加 `listSshServers`;原 `requireAdmin` 函数级门**移除**,由分支内 K8s 门承担;原 `const kind = normalizeKind(...) || 'pods'` 行删除,如上归并。)

- [ ] **Step 4: 跑绿**:新测试全 PASS;`node --test server/route-auth-map.test.mjs` PASS;`npm run test:server` 全量绿

- [ ] **Step 5: 提交**

```bash
git add server/routes/workbench-projects.mjs server/wb-server-ref.test.mjs
git commit -m "feat(workbench): @server 搜索端点——kind=server 分支(exposedOnly 单源/三路命中/host 仅 admin),K8s 分支 admin 门下移分支内"
```

---

### Task 2: fetchRefContext server 分支 + 无集群 guard 修正

**Files:**
- Create: `server/ssh/ref-block.mjs`(纯函数)
- Modify: `server/index.mjs:1143-1161`(fetchRefContext)
- Test: Create `server/ssh/ref-block.test.mjs`

**Interfaces:**
- Produces:
  - `buildServerRefBlock(label, rows, ref)` → 字符串。`rows` 为 exposedOnly 行数组;按 `name` 精确匹配(兜底 `id`),未命中返 `` `${label}: (not found / 已不可用)` ``;命中返 `formatRefBlock` 围栏块,JSON 字段恰为 `{ name, description, clusterRef, os, status, approvalPolicy, capabilities }`——**构造时不取行上的 host/username 字段**(脱敏由「不选择」保证,测试断言输出无这些子串)
  - fetchRefContext 行为:`ref.kind === 'server'`(原始值比较)→ 上述分支;K8s refs 在 `!k8sSession` 时逐条 `…: (not found / 无集群)`;仅含 server refs 时无 k8sSession 也正常注入

- [ ] **Step 1: 写失败测试** `server/ssh/ref-block.test.mjs`(纯逻辑,`node --test`):

```js
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildServerRefBlock } from './ref-block.mjs'

const rows = [{ id: 's1', name: '网关机', host: '10.0.0.1', username: 'ops', description: '入口网关', clusterRef: 'ck-1', osName: 'ubuntu-22.04', status: 'ok', aiApprovalPolicy: 'readonly' }]

test('server ref 块:字段齐全且不含 host/username(脱敏红线)', () => {
  const out = buildServerRefBlock('[server//网关机]', rows, { kind: 'server', namespace: '', name: '网关机' })
  assert.ok(out.includes('网关机') && out.includes('入口网关') && out.includes('ubuntu-22.04') && out.includes('readonly'))
  assert.ok(!out.includes('10.0.0.1'), '块内不得出现 host')
  assert.ok(!out.includes('ops'), '块内不得出现 username')
  assert.ok(out.startsWith('[server//网关机]:'))
})

test('server ref:id 兜底命中;未命中/未暴露清单 → not found 文案', () => {
  assert.ok(buildServerRefBlock('[server//x]', rows, { kind: 'server', namespace: '', name: 's1' }).includes('"name"'))
  const nf = buildServerRefBlock('[server//没了]', rows, { kind: 'server', namespace: '', name: '没了' })
  assert.ok(nf.includes('(not found / 已不可用)'))
  assert.equal(buildServerRefBlock('[server//x]', [], { kind: 'server', namespace: '', name: 'x' }).includes('(not found / 已不可用)'), true)
})
```

- [ ] **Step 2: 跑红**:`node --test server/ssh/ref-block.test.mjs` → FAIL(模块不存在)

- [ ] **Step 3: 实现** `server/ssh/ref-block.mjs`:

```js
// @server 引用注入块(2026-08-30 spec §5):脱敏由「构造时不取 host/username」保证——
// 行对象虽带这些列,这里只挑白名单字段;名称寻址(wb_ssh_exec 按 server=name),AI 无需 IP。
import { formatRefBlock } from '../ref-context.mjs'

export function buildServerRefBlock(label, rows, ref) {
  const s = rows.find(r => r.name === ref.name) || rows.find(r => r.id === ref.name)
  if (!s) return `${label}: (not found / 已不可用)`
  const body = {
    name: s.name,
    description: s.description || '',
    clusterRef: s.clusterRef || '',
    os: s.osName || s.osId || '',
    status: s.status || '',
    approvalPolicy: s.aiApprovalPolicy || 'always',
    capabilities: ['wb_ssh_exec(按服务器策略审批)', 'wb_ssh_read_file', 'read_server_ledger', 'write_server_notes'],
  }
  return formatRefBlock(label, JSON.stringify(body, null, 2))
}
```

(`formatRefBlock` 的实际导出位置先 grep 核对——它在 index.mjs 内联还是已有模块;若内联则把该函数原样抽到本模块并让 index.mjs 改从这里 import,行为零变化。)

- [ ] **Step 4: 接线 fetchRefContext** — `server/index.mjs:1143`:

```js
async function fetchRefContext(references, k8sSession) {
  if (!Array.isArray(references) || !references.length) return ''
  const budget = createRefContextBudget()
  const tasks = references.map(async ref => {
    const label = `[${ref.kind}/${ref.namespace || ''}/${ref.name}]`
    // @server 引用(spec §5):原始值比较(normalizeKind 不识别 server);不依赖 k8sSession——无集群项目可用
    if (ref.kind === 'server') {
      const rows = listSshServers(db, { exposedOnly: true })
      const block = buildServerRefBlock(label, rows, ref)
      if (!budget.take(block.length)) return `${label}: …(引用上下文预算已满,略)`
      return block
    }
    if (!k8sSession) return `${label}: (not found / 无集群)`   // guard 修正:K8s ref 无集群逐条标注,不再整块吞掉
    const path = getApiPath(normalizeKind(ref.kind), ref.namespace || '', ref.name)
    // …以下原样保留
  })
  const blocks = await Promise.all(tasks)
  return `\n\n${REFS_CTX_HEADER}${blocks.join('\n\n')}`
}
```

(import `listSshServers` 自 './ssh/store.mjs'(并入现有 ssh/store import 行)、`buildServerRefBlock` 自 './ssh/ref-block.mjs'。)

- [ ] **Step 5: 跑绿**:ref-block 测试 PASS;`npm run test:server` 全量绿(既有 wb roundtrip 用例证明 refs 管线不破)

- [ ] **Step 6: 提交**

```bash
git add server/ssh/ref-block.mjs server/ssh/ref-block.test.mjs server/index.mjs
git commit -m "feat(workbench): @server 引用注入——buildServerRefBlock 脱敏白名单块+fetchRefContext server 分支+无集群 guard 修正"
```

---

### Task 3: 前端(alias/分支/chips/文案)

**Files:**
- Modify: `src/components/workbench/WorkbenchChat.vue`(KIND_ALIASES/KIND_LABELS、watch 分支、refIcon、下拉项渲染)
- Modify: `src/locales/zh.json` / `src/locales/en.json`(atMentionHint 文案)
- Test: 追加到 `src/components/workbench/__tests__/WorkbenchChat.test.js`(宿主已有 `search: vi.fn()` mock 与 `mountChat` 助手,`:707` 有 `input.setValue` 先例)

**Interfaces:**
- Consumes: Task 1 端点(`workbenchApi.search(projectId,'server',q)` 形状不变)
- Produces: refs 条目 `{ kind:'server', namespace:'', name }`(编辑重发链路零特判自动往返)

- [ ] **Step 1: 写失败测试**(追加到宿主文件;`api.search` 是模块顶 mock——用例内 `api.search.mockResolvedValue(...)` 按实参分派;宿主顶部若 search 为共用 vi.fn,用例前置 `api.search.mockReset()` 并自行设实现):

```js
test('@server:关键字 → server 搜索分支 + dns chip(无 namespace 空串)', async () => {
  api.search.mockImplementation(async (_pid, kind, q) => {
    if (kind !== 'server') return { items: [] }
    return '网关机'.includes(q || '') ? { items: [{ kind: 'server', name: '网关机', description: '入口网关', clusterRef: 'ck-1' }] } : { items: [] }
  })
  const w = await mountChat()
  const input = w.find('textarea')
  await input.setValue('看下 @server:网关')
  await flushPromises()   // debounce 200ms → 用 vi.useFakeTimers 或等待;宿主既有节奏若无 fake timers,改为 await new Promise(r => setTimeout(r, 260)) 后再 flushPromises
  expect(api.search).toHaveBeenCalledWith(expect.any(String), 'server', '网关')
  // 下拉项含名称与备注
  const drop = w.find('[class*="mention"], [class*="dropdown"]')
  expect(drop.exists()).toBe(true)
  expect(drop.text()).toContain('网关机')
  expect(drop.text()).toContain('入口网关')
  // 选中 → chip:dns 图标 + 名称,且无空 namespace 文本
  await drop.findAll('button').find(b => b.text().includes('网关机')).trigger('click')
  await flushPromises()
  const chip = w.findAll('div').find(d => d.classes().join(' ').includes('bg-primary/10') && d.text().includes('网关机'))
  expect(chip).toBeTruthy()
  const icon = chip.find('.material-symbols-outlined')
  expect(icon.text()).toBe('dns')
  expect(chip.text()).not.toContain('undefined')
})
```

(实现者注:①debounce 处理优先用 `vi.useFakeTimers()` + `vi.advanceTimersByTime(200)`——若与宿主既有 fake-timer 用法冲突,退回真实 260ms 等待;②下拉/节点选择器以 WorkbenchChat.vue 模板实际 class 为准核对,断言意图(可见名称+备注、dns 图标、无 undefined)不变。)

- [ ] **Step 2: 跑红** → FAIL

- [ ] **Step 3: 实现** WorkbenchChat.vue:
  - `KIND_ALIASES` 加 `server:'server', ssh:'server'`;`KIND_LABELS` 加 `server:'Server'`
  - watch(input) 的 MENTION_RE 分支:`alias === 'server'`(归一后)时走 `doServerSearch(q)`——与 doSearch 同构但**不做 ns/ 斜杠解析**;doServerSearch 复用 `workbenchApi.search(props.projectId,'server',q)`,结果直置 `searchResults.value`
  - 下拉项模板:kind==='server' 时显示 `名称 + description`(次要文字)+ clusterRef 小标签;其余维持
  - `refIcon(kind)` 加 `server → 'dns'`(先 grep 现函数位置);chip 模板 `{{ r.namespace }}` 改 `v-if="r.namespace"`(server 无 namespace 不渲染空串)
  - 选中处理(selectRef 现逻辑)零改动即可落 `{kind:'server',namespace:'',name}`——核验 `item.namespace` 为 undefined 时落 `''`
  - `atMentionHint` 文案更新提及 @server(zh:`@ 资源引用(pod/deploy/…)与 @server 服务器`;en 对应)

- [ ] **Step 4: 跑绿**:组件测试 PASS;`npm run i18n:check` 六项全 0;`npx vitest run src/components/workbench` 目录回归不破

- [ ] **Step 5: 提交**

```bash
git add src/components/workbench/WorkbenchChat.vue src/locales/zh.json src/locales/en.json <测试宿主文件>
git commit -m "feat(workbench): @server 前端——alias/搜索分支/dns chip/下拉项与可发现性文案"
```

---

### Task 4: 全量门禁 + 终审 + 手测清单落档

- [ ] **Step 1:** `npm test` + `npm run i18n:check` + `npm run typecheck` 全绿(worktree 分支)
- [ ] **Step 2:** 全分支终审(最强可用模型),范围=merge-base..HEAD;重点接缝:server 分支与 K8s 分支的门隔离、脱敏(响应/注入块两层)、refs 往返
- [ ] **Step 3:** 手测 5 项待真机:①`@server:IP片段` 能定位(admin);②非 admin 账号下拉无 host 列且响应无 IP;③选中后 AI 上下文出现服务器块、AI 能直接 `wb_ssh_exec`(按审批策略);④取消暴露后下一轮 ref 标 not found;⑤无集群项目 @server 全流程可用
