# 工作台顶栏胶囊信息丰富化 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 顶栏「工作台」胶囊升级为「入口即仪表」:状态角标(待审批/运行中)+ 悬停概览面板(项目清单/汇总 chips/快捷动作),数据来自单一汇总端点 `GET /api/workbench/summary`,30s 轮询。

**Architecture:** 服务端在 `createWorkbenchProjectRoutes` 增设 summary 分支(纯 SQL 聚合 + `listSshSessions` 按 userId 过滤,归属过滤复用 `listProjects`);前端新组件 `WorkbenchEntryPill.vue` 替换 TopNavBar 内联按钮(Vue Query 轮询,Teleport 悬停面板),点击行为与 C3 胶囊契约不变。规格:`docs/superpowers/specs/2026-08-30-workbench-entry-pill-summary-design.md`。

**Tech Stack:** Node(node:sqlite)/ Vue 3 + @tanstack/vue-query + vue-i18n / 自研零依赖服务端测试运行器(node --test)/ vitest + happy-dom。

## Global Constraints

- **执行隔离**:开工先 `superpowers:using-git-worktrees` 开 worktree 特性分支(用户 2026-08-30 要求);完成后 `--no-ff` 合回 main。
- **提交规范**:作者恒 `aliangone <aliangone@gmail.com>`(repo config 已设);**禁止** `Co-Authored-By: Claude` 尾注;禁改写已推送历史。
- **零依赖政策**:不新增任何 npm 依赖(Vue Query / vue-i18n 均已裁决在库)。
- **既有胶囊契约不破坏**:`TopNavBar.workbench-entry.test.js` 的全部断言(存在/文字标签/位置在刷新前/点击直达 /workbench/激活态类名)保持绿;`TopNavBar.test.js`(溢出回归)与 `TopNavBar.dedup.test.js`(去重)同理——仅允许改**测试挂载桩**(补 VueQueryPlugin/client mock 键),不允许改断言。
- **归属与隐私**:项目按 `listProjects(db,{userId,role})`;SSH 会话数人人只数自己(含 admin);`/api/ssh/sessions` 的 admin 全量语义不动。
- **导航静默**:summary 拉取失败不 toast;保留旧数据(`keepPreviousData`)。
- **路由鉴权**:`/api/workbench/summary` 落在既有 `/api/workbench/` 前缀(platform)覆盖内,不新增 ROUTE_AUTH 登记。
- **z 层**:面板 `z-index` 取 `Z.popover`(`src/styles/zScale.js`),禁止裸 `z-[N]` 魔数。
- **i18n**:所有新键 zh/en 双语齐备;消息值不含 HTML、不含未转义 `@`;`npm run i18n:check` 必绿。
- **node:sqlite 坑**:绑定参数禁止 undefined/对象/数组(写边界 undefined→null);本计划服务端聚合无外部绑定输入,测试 seed 注意。
- **SPA 布局**:胶囊 wrapper 保持 `shrink-0`,顶栏溢出压力仍由左侧搜索收缩链吸收(issue #3 契约)。

---

### Task 1: 服务端 `GET /api/workbench/summary` + 接线 + client 契约

**Files:**
- Create: `server/workbench-summary.test.mjs`(顶层,`node --test server/*.test.mjs` 自动发现;勿放 `server/routes/`——该目录不在测试 glob 内)
- Modify: `server/routes/workbench-projects.mjs`(deps 解构 + summary 分支)、`server/index.mjs:1510-1515`(projectRoutes deps 补 `listSshSessions`)、`server/messages/wbp.mjs`(+1 键)、`src/api/client.js:244` 后(+1 行)

**Interfaces:**
- Consumes: `listProjects(db,{userId,role})`、`createWorkbenchSchema(db)`(server/workbench-projects.mjs 已导出);`handle(req,res,url)` 返回 `{ handle }`、命中返 true。
- Produces: `GET /api/workbench/summary` → `{ projects: [{ id, name, clusterId, clusterName(未绑定=null), lastActiveAt, runningConvs, pendingApprovals }](≤8,待办优先), totals: { projects, runningConvs, pendingApprovals, sshSessions } }`;前端契约 `workbenchApi.summary: () => platformHttp.request('/api/workbench/summary')`(Task 3 消费)。

- [ ] **Step 1: 写失败测试**

```js
// server/workbench-summary.test.mjs
// GET /api/workbench/summary 顶栏胶囊汇总端点:deps 注入(requirePlatform/sendJson/listSshSessions
// 假件)+ 内存 node:sqlite 直调 handle(),不 spawn 网关(避开 spawn 并跑竞态)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { DatabaseSync } from 'node:sqlite'
import { createWorkbenchSchema } from './workbench-projects.mjs'
import { createWorkbenchProjectRoutes } from './routes/workbench-projects.mjs'

function setup({ user = 'u1', role = 'user', ssh = [] } = {}) {
  const db = new DatabaseSync(':memory:')
  createWorkbenchSchema(db)
  db.exec('CREATE TABLE IF NOT EXISTS clusters (id TEXT PRIMARY KEY, name TEXT)')
  db.prepare('INSERT INTO clusters (id, name) VALUES (?,?)').run('c1', 'prod-cluster')
  const sent = []
  const routes = createWorkbenchProjectRoutes({
    db,
    sendJson: (_res, status, body) => sent.push({ status, body }),
    readBody: async () => ({}),
    requirePlatform: () => (user === null ? null : { userId: user, role }),
    requireAdmin: () => null,
    writeAudit: () => {},
    WORKBENCH_DIR: '/tmp/ab-summary-test',
    dbPath: ':memory:',
    listSshSessions: () => ssh,
  })
  return { db, sent, call: () => routes.handle({ headers: {} }, {}, new URL('http://x/api/workbench/summary')) }
}

// 直接 INSERT(不用 createProject):需要受控 id/createdAt 做排序断言
const addProject = (db, name, { ownerId = 'u1', clusterId = 'c1', createdAt = 1 } = {}) =>
  db.prepare('INSERT INTO workbench_projects (id,name,clusterId,ownerId,createdAt,repoRoot) VALUES (?,?,?,?,?,?)')
    .run(`id-${name}`, name, clusterId, ownerId, createdAt, 'projects')

const addConv = (db, projectId, { status = 'running', pending = null, updatedAt = 1000, id } = {}) =>
  db.prepare('INSERT INTO workbench_conversations (id,projectId,status,pendingApproval,createdAt,updatedAt) VALUES (?,?,?,?,?,?)')
    .run(id || `conv-${projectId}-${status}-${Math.random()}`, projectId, status, pending, updatedAt, updatedAt)

test('普通用户只见自己项目,SSH 只数自己的', async () => {
  const { db, sent, call } = setup({ user: 'u1', role: 'user', ssh: [{ userId: 'u1' }, { userId: 'u1' }, { userId: 'u2' }] })
  addProject(db, 'mine')
  addProject(db, 'others', { ownerId: 'u2' })
  await call()
  assert.equal(sent[0].status, 200)
  const { projects, totals } = sent[0].body
  assert.equal(totals.projects, 1)
  assert.equal(projects.length, 1)
  assert.equal(projects[0].name, 'mine')
  assert.equal(projects[0].clusterName, 'prod-cluster')
  assert.equal(totals.sshSessions, 2)
})

test('未绑定(\'\' 哨兵)项目 clusterName=null', async () => {
  const { db, sent, call } = setup()
  addProject(db, 'free', { clusterId: '' })
  await call()
  assert.equal(sent[0].body.projects[0].clusterId, '')
  assert.equal(sent[0].body.projects[0].clusterName, null)
})

test('running/paused 待审批计数;paused 无 pendingApproval 不计', async () => {
  const { db, sent, call } = setup()
  addProject(db, 'p')
  addConv(db, 'id-p', { status: 'running' })
  addConv(db, 'id-p', { status: 'paused', pending: '{"tool":"wb_exec"}', updatedAt: 5000 })
  addConv(db, 'id-p', { status: 'paused', pending: null })
  await call()
  const { projects, totals } = sent[0].body
  assert.equal(projects[0].runningConvs, 1)
  assert.equal(projects[0].pendingApprovals, 1)
  assert.equal(projects[0].lastActiveAt, 5000)
  assert.equal(totals.runningConvs, 1)
  assert.equal(totals.pendingApprovals, 1)
})

test('admin 见全部项目', async () => {
  const { db, sent, call } = setup({ role: 'admin' })
  addProject(db, 'a')
  addProject(db, 'b', { ownerId: 'u2' })
  await call()
  assert.equal(sent[0].body.totals.projects, 2)
})

test('>8 项目截 8 且待办优先,totals 全量', async () => {
  const { db, sent, call } = setup()
  for (let i = 1; i <= 8; i++) addProject(db, `idle${i}`, { createdAt: i })
  addProject(db, 'run', { createdAt: 9 })
  addProject(db, 'pend', { createdAt: 10 })
  addConv(db, 'id-run', { status: 'running', updatedAt: 5000 })
  addConv(db, 'id-pend', { status: 'paused', pending: '{}', updatedAt: 9000 })
  await call()
  const { projects, totals } = sent[0].body
  assert.equal(projects.length, 8)
  assert.equal(projects[0].name, 'pend')   // 待审批最优先
  assert.equal(projects[1].name, 'run')
  assert.equal(totals.projects, 10)
  assert.equal(totals.pendingApprovals, 1)
  assert.equal(totals.runningConvs, 1)
})

test('未认证:requirePlatform 拒绝则不发响应', async () => {
  const { sent, call } = setup({ user: null })
  const handled = await call()
  assert.equal(handled, true)
  assert.equal(sent.length, 0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/workbench-summary.test.mjs`
Expected: FAIL——summary 分支不存在,`routes.handle` 对该 URL 返回 false(`sent.length===0` 断言炸)。

- [ ] **Step 3: 实现端点**

3a. `server/routes/workbench-projects.mjs` — deps 解构(第 24-29 行对象)补一项:

```js
  const {
    db, sendJson, readBody, requirePlatform, requireAdmin, writeAudit,
    WORKBENCH_DIR, dbPath, getLlmConfig, createLlmClient,
    buildCallContext, requestKubernetes, applyYamlPartial,
    bootstrapLedgerForCluster, listSshSessions,
  } = deps
```

3b. 同文件 `handle()` 内,`// ====== 项目 CRUD(W2)。requirePlatform + ownership(ownerId==userId || admin)======` 注释块**之前**插入:

```js
    // GET /api/workbench/summary — 顶栏胶囊单一汇总端点(2026-08-30 spec §3):
    // 项目(归属过滤,待办优先排序,截 8)+ 全量计数(运行中/待审批/SSH 按用户)。
    // 待审批=paused + pendingApproval 非空(workbench-agent 暂停落库/resume 清空,持久权威源)。
    if (url.pathname === '/api/workbench/summary' && req.method === 'GET') {
      const ps = requirePlatform(req, res); if (!ps) return true
      try {
        const projects = listProjects(db, { userId: ps.userId, role: ps.role })
        const clusterNameOf = cid => (cid ? db.prepare('SELECT name FROM clusters WHERE id=?').get(cid)?.name || null : null)
        const byProject = new Map(db.prepare(`
          SELECT projectId,
                 SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS runningConvs,
                 SUM(CASE WHEN status='paused' AND pendingApproval IS NOT NULL THEN 1 ELSE 0 END) AS pendingApprovals,
                 MAX(updatedAt) AS lastActiveAt
          FROM workbench_conversations GROUP BY projectId
        `).all().map(r => [r.projectId, r]))
        const enriched = projects.map(p => {
          const a = byProject.get(p.id)
          return {
            id: p.id, name: p.name, clusterId: p.clusterId || '',
            clusterName: clusterNameOf(p.clusterId),
            lastActiveAt: a?.lastActiveAt || null,
            runningConvs: a?.runningConvs || 0,
            pendingApprovals: a?.pendingApprovals || 0,
          }
        })
        // 待办优先:待审批 ↓ 运行中 ↓ 最近活跃 ↓(并列保 listProjects 的 createdAt DESC 稳定序)
        enriched.sort((a, b) =>
          b.pendingApprovals - a.pendingApprovals ||
          b.runningConvs - a.runningConvs ||
          (b.lastActiveAt || 0) - (a.lastActiveAt || 0))
        const totals = {
          projects: enriched.length,
          runningConvs: enriched.reduce((s, r) => s + r.runningConvs, 0),
          pendingApprovals: enriched.reduce((s, r) => s + r.pendingApprovals, 0),
          sshSessions: (listSshSessions?.() || []).filter(s => s.userId === ps.userId).length,
        }
        sendJson(res, 200, { projects: enriched.slice(0, 8), totals })
      } catch (e) { sendJson(res, 500, { message: e?.message || msg(req, 'wbp.summaryReadFailed') }) }
      return true
    }
```

3c. `server/index.mjs` — `createWorkbenchProjectRoutes({...})`(约 :1510)deps 对象补一行(与 :1513 sshRoutes 的包装同一表达式):

```js
  const projectRoutes = createWorkbenchProjectRoutes({
    db, sendJson, readBody, requirePlatform, requireAdmin, writeAudit,
    WORKBENCH_DIR, dbPath, getLlmConfig, createLlmClient,
    buildCallContext, requestKubernetes, applyYamlPartial,
    bootstrapLedgerForCluster,
    listSshSessions: () => sshTerminals.list(),
  })
```

3d. `server/messages/wbp.mjs` — TABLE 加:

```js
  'wbp.summaryReadFailed': { zh: '读取汇总失败', en: 'Failed to read summary' },
```

3e. `src/api/client.js` — workbenchApi 内 `listProjects` 行(:244)后加:

```js
  summary: () => platformHttp.request('/api/workbench/summary'),
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/workbench-summary.test.mjs`
Expected: PASS(6 tests)

- [ ] **Step 5: 回归 + 提交**

Run: `npm run test:server`
Expected: PASS(全量服务端零回归)

```bash
git add server/workbench-summary.test.mjs server/routes/workbench-projects.mjs server/index.mjs server/messages/wbp.mjs src/api/client.js
git commit -m "feat(workbench): GET /api/workbench/summary 顶栏胶囊汇总端点——项目(待办优先截8)+运行中/待审批/SSH计数,归属过滤"
```

---

### Task 2: WorkbenchShell `?tab=`/`?create=1` 一次性读取 + WorkbenchProjects `openCreate` prop

**Files:**
- Modify: `src/views/WorkbenchShell.vue`(script 加 onMounted query 读取;template projects 分支传 prop)
- Modify: `src/views/WorkbenchProjects.vue`(+openCreate prop + watch)
- Modify: `src/views/__tests__/WorkbenchShell.tabs.test.js`(挂载桩补 vue-router mock——shell 新增 useRoute,不改断言)
- Create: `src/views/__tests__/WorkbenchShell.query-params.test.js`
- Create: `src/views/__tests__/WorkbenchProjects.open-create.test.js`

**Interfaces:**
- Consumes: Task 1 无依赖(独立交付);shell 现有 `activeTab` ref 与四 tab keys(`projects/servers/knowledge/records`)、WorkbenchProjects 的 `showCreate` ref。
- Produces: `WorkbenchProjects` 可选 prop `openCreate: Boolean`(true 时自动开创建弹窗);快捷区落点 `/workbench?tab=records` 与 `/workbench?create=1` 生效(Task 4 消费)。tab 保持组件内状态、不做双向路由同步。

- [ ] **Step 1: 写失败测试(query-params)**

```js
// src/views/__tests__/WorkbenchShell.query-params.test.js
// 顶栏胶囊快捷区落点(2026-08-30 spec §4.3):?tab= 一次性设初值、?create=1 传 openCreate。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const state = vi.hoisted(() => ({ query: {} }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: state.query }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/views/WorkbenchProjects.vue', () => ({ default: { template: '<div data-test-stub="projects" />', props: ['openCreate'] } }))
vi.mock('@/views/WorkbenchLedger.vue', () => ({ default: { template: '<div data-test-stub="ledger" />' } }))
vi.mock('@/views/WorkbenchRecords.vue', () => ({ default: { template: '<div data-test-stub="records" />' } }))
vi.mock('@/views/WorkbenchServers.vue', () => ({ default: { template: '<div data-test-stub="servers" />' } }))
import WorkbenchShell from '@/views/WorkbenchShell.vue'
import WorkbenchProjects from '@/views/WorkbenchProjects.vue'

const mountShell = () => mount(WorkbenchShell, { global: { plugins: [createPinia(), i18n] } })

test('?tab=records → 记录 tab 渲染', async () => {
  state.query = { tab: 'records' }
  const w = mountShell(); await w.vm.$nextTick()
  expect(w.find('[data-test-stub="records"]').exists()).toBe(true)
})

test('非法 tab 值忽略,落默认项目 tab', async () => {
  state.query = { tab: 'nope' }
  const w = mountShell(); await w.vm.$nextTick()
  expect(w.find('[data-test-stub="projects"]').exists()).toBe(true)
})

test('?create=1 → openCreate=true 传给项目 tab;无 query 时 false', async () => {
  state.query = { create: '1' }
  const w = mountShell(); await w.vm.$nextTick()
  expect(w.findComponent(WorkbenchProjects).props('openCreate')).toBe(true)
  w.unmount()
  state.query = {}
  const w2 = mountShell(); await w2.vm.$nextTick()
  expect(w2.findComponent(WorkbenchProjects).props('openCreate')).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchShell.query-params.test.js`
Expected: FAIL——shell 未读 query(records 断言/openCreate prop 断言炸)。

- [ ] **Step 3: 实现 shell + openCreate**

3a. `src/views/WorkbenchShell.vue` script:

```js
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
// ...既有 import 不动...
const route = useRoute()
const activeTab = ref('projects')
onMounted(() => {
  // 顶栏胶囊快捷区落点(2026-08-30 spec §4.3):一次性读 query;tab 仍是组件内状态,不做双向路由同步
  const tab = route.query.tab
  if (typeof tab === 'string' && tabs.value.some(x => x.key === tab)) activeTab.value = tab
})
```

template projects 分支改为:

```html
      <WorkbenchProjects v-if="activeTab === 'projects'" :open-create="route.query.create === '1'" />
```

3b. `src/views/WorkbenchProjects.vue` script(`const showCreate = ref(false)` 附近):

```js
const props = defineProps({ openCreate: { type: Boolean, default: false } })
// 顶栏胶囊快捷区「新建项目」(/workbench?create=1):进页即开创建弹窗
watch(() => props.openCreate, v => { if (v) showCreate.value = true }, { immediate: true })
```

`import { ref, onMounted } from 'vue'` 行补 `watch`。

3c. `src/views/__tests__/WorkbenchShell.tabs.test.js` 顶部 mocks 区加(shell 新依赖 useRoute,无 router 上下文时返回 undefined 会炸):

```js
vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn() }) }))
```

- [ ] **Step 4: 写 openCreate 组件测试并确认通过**

```js
// src/views/__tests__/WorkbenchProjects.open-create.test.js
// openCreate prop(顶栏胶囊快捷区「新建项目」):true 时 Modal 直接开,默认关。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { readFileSync } from 'node:fs'

vi.mock('@/api/client', () => ({
  workbenchApi: { listProjects: vi.fn().mockResolvedValue({ projects: [] }), createProject: vi.fn(), updateProjectCluster: vi.fn() },
  authApi: { myClusters: vi.fn().mockResolvedValue([]) },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/composables/useToast.js', () => ({ notify: vi.fn() }))

import WorkbenchProjects from '@/views/WorkbenchProjects.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })
const mountProjects = props => mount(WorkbenchProjects, { props, global: { plugins: [createPinia(), i18n] } })

test('openCreate=true:创建弹窗直接打开(Teleport 到 body)', async () => {
  const w = mountProjects({ openCreate: true })
  await w.vm.$nextTick()
  expect(document.body.querySelector('input[placeholder="my-project"]')).toBeTruthy()
})
test('默认(false):弹窗不开', async () => {
  const w = mountProjects()
  await w.vm.$nextTick()
  expect(document.body.querySelector('input[placeholder="my-project"]')).toBeFalsy()
})
```

Run: `npx vitest run src/views/__tests__/WorkbenchShell.query-params.test.js src/views/__tests__/WorkbenchProjects.open-create.test.js src/views/__tests__/WorkbenchShell.tabs.test.js src/views/__tests__/WorkbenchProjects.unbound.test.js`
Expected: PASS(新增全绿 + tabs/unbound 桩适配后零回归)

- [ ] **Step 5: 提交**

```bash
git add src/views/WorkbenchShell.vue src/views/WorkbenchProjects.vue src/views/__tests__/WorkbenchShell.query-params.test.js src/views/__tests__/WorkbenchProjects.open-create.test.js src/views/__tests__/WorkbenchShell.tabs.test.js
git commit -m "feat(workbench): shell 一次性读 ?tab=/?create=1 + WorkbenchProjects openCreate——胶囊快捷区落点"
```

---

### Task 3: WorkbenchEntryPill 胶囊本体 + 角标 + Vue Query 数据层

**Files:**
- Create: `src/components/layout/WorkbenchEntryPill.vue`
- Modify: `src/locales/zh.json` / `src/locales/en.json`(`workbench` 块内加 `pill` 子块)
- Create: `src/components/layout/__tests__/WorkbenchEntryPill.test.js`

**Interfaces:**
- Consumes: Task 1 的 `workbenchApi.summary()` 契约;`Z.popover`(Task 4 用);i18n 键 `workbench.pill.*`。
- Produces: 组件根元素 `data-test="wb-pill"`(内含胶囊 button);角标 `[data-test="pill-pending"]`(红数字)/ `[data-test="pill-running"]`(绿点);胶囊 button 类名与 C3 逐字一致(`flex items-center gap-sm rounded-full px-md py-1.5 border transition-colors text-body-sm font-semibold` + 两态类);Task 4 在此文件上扩展面板。

i18n 键(Task 3 用到的四个,入 `workbench.pill`;zh/en 对齐):

```jsonc
// zh.json → "workbench" 块(:3345 起)内加:
"pill": {
  "projects": "{n} 项目",
  "running": "{n} 运行中",
  "pending": "{n} 待审批",
  "ssh": "{n} SSH"
}
// en.json 同位置:
"pill": {
  "projects": "{n} projects",
  "running": "{n} running",
  "pending": "{n} pending approvals",
  "ssh": "{n} SSH"
}
```

- [ ] **Step 1: 写失败测试**

```js
// src/components/layout/__tests__/WorkbenchEntryPill.test.js
// 工作台入口胶囊:① C3 契约(aria/文字/两态类/点击 /workbench);② 角标优先级
// (待审批红数字 > 运行中绿点 > 无);③ summary 数据驱动 title 摘要。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ summary: vi.fn(), push: vi.fn(), path: '/cluster' }))
vi.mock('@/api/client', () => ({
  workbenchApi: { summary: mocks.summary },
  getSession: () => true,
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: mocks.path }),
  useRouter: () => ({ push: mocks.push }),
}))

import WorkbenchEntryPill from '../WorkbenchEntryPill.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })
const mountPill = () => mount(WorkbenchEntryPill, {
  global: { plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }] }],
})

const SUMMARY = (over = {}) => ({
  projects: [{ id: 'p1', name: 'ci-cd', clusterId: 'c1', clusterName: 'prod', lastActiveAt: Date.now(), runningConvs: 0, pendingApprovals: 0 }],
  totals: { projects: 1, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 }, ...over,
})

beforeEach(() => { mocks.summary.mockReset(); mocks.push.mockReset(); mocks.path = '/cluster' })

test('C3 契约:aria-label/文字/图标/默认态描边类', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))   // 挂起,聚焦静态契约
  const w = mountPill(); await flushPromises()
  const btn = w.find('button')
  expect(btn.attributes('aria-label')).toBe('工作台')
  expect(btn.text()).toContain('工作台')
  expect(btn.find('.material-symbols-outlined').text()).toBe('workspaces')
  expect(btn.classes()).toContain('border-primary/40')
  expect(btn.classes()).not.toContain('bg-primary-container')
})

test('激活态:/workbench/* 路由填充类', async () => {
  mocks.path = '/workbench/p1'
  mocks.summary.mockReturnValue(new Promise(() => {}))
  const w = mountPill(); await flushPromises()
  expect(w.find('button').classes()).toContain('bg-primary-container')
})

test('点击直达 /workbench(行为不变)', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))
  const w = mountPill(); await flushPromises()
  await w.find('button').trigger('click')
  expect(mocks.push).toHaveBeenCalledWith('/workbench')
})

test('角标优先级:待审批红数字 > 运行中绿点 > 无', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 1, runningConvs: 2, pendingApprovals: 3, sshSessions: 0 } }))
  let w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-pending"]').text()).toBe('3')
  expect(w.find('[data-test="pill-running"]').exists()).toBe(false)
  w.unmount()

  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 1, runningConvs: 2, pendingApprovals: 0, sshSessions: 0 } }))
  w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-running"]').exists()).toBe(true)
  w.unmount()

  mocks.summary.mockResolvedValue(SUMMARY())
  w = mountPill(); await flushPromises()
  expect(w.find('[data-test="pill-pending"]').exists()).toBe(false)
  expect(w.find('[data-test="pill-running"]').exists()).toBe(false)
})

test('title 摘要由 summary 拼装', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 5, runningConvs: 1, pendingApprovals: 2, sshSessions: 3 } }))
  const w = mountPill(); await flushPromises()
  const title = w.find('button').attributes('title')
  expect(title).toContain('5 项目')
  expect(title).toContain('1 运行中')
  expect(title).toContain('2 待审批')
  expect(title).toContain('3 SSH')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/WorkbenchEntryPill.test.js`
Expected: FAIL——组件文件不存在(无法 resolve)。

- [ ] **Step 3: 实现组件(胶囊+角标+数据;面板留 Task 4)**

```vue
<!-- src/components/layout/WorkbenchEntryPill.vue -->
<script setup>
// 工作台入口胶囊(2026-08-30 信息丰富化):C3 品牌胶囊契约不变(样式/aria/点击),叠加
// 状态角标 + 悬停概览面板。数据 = GET /api/workbench/summary 单一汇总端点,30s 轮询
// (TopNavBar 全站常驻 ⇒ 全站唯一轮询器;标签页隐藏自动暂停,聚焦即刷新)。
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQuery, keepPreviousData } from '@tanstack/vue-query'
import { workbenchApi, getSession } from '@/api/client'
import { Z } from '@/styles/zScale'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

const isWorkbenchActive = computed(() => route.path.startsWith('/workbench'))

// ---- 数据(导航静默:失败不 toast,keepPreviousData 保旧值)----
const q = useQuery({
  queryKey: ['workbench-summary'],
  queryFn: () => workbenchApi.summary(),
  enabled: computed(() => !!getSession()),
  refetchInterval: 30_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  staleTime: 15_000,
  retry: 1,
  placeholderData: keepPreviousData,
})
const totals = computed(() => q.data.value?.totals || {})
const projects = computed(() => q.data.value?.projects || [])
const pendingCount = computed(() => totals.value.pendingApprovals ?? 0)
const runningCount = computed(() => totals.value.runningConvs ?? 0)
const sshCount = computed(() => totals.value.sshSessions ?? 0)

const summaryText = computed(() => [
  t('workbench.pill.projects', { n: totals.value.projects ?? 0 }),
  t('workbench.pill.running', { n: runningCount.value }),
  t('workbench.pill.pending', { n: pendingCount.value }),
  t('workbench.pill.ssh', { n: sshCount.value }),
].join(' · '))

// ---- 悬停面板开关(150ms 开/200ms 宽限关;Escape/外点/链内点击即关)——Task 4 扩展 ----
const btnRef = ref(null)
const panelOpen = ref(false)
const panelStyle = ref({})
let openTimer = null
let closeTimer = null
const PANEL_W = 340
function placePanel() {
  const r = btnRef.value?.getBoundingClientRect()
  if (r) panelStyle.value = {
    top: `${r.bottom + 8}px`,
    left: `${Math.max(16, Math.min(r.right - PANEL_W, window.innerWidth - PANEL_W - 16))}px`,
    width: `${PANEL_W}px`,
    zIndex: Z.popover,
  }
}
function openPanel() {
  clearTimeout(closeTimer)
  clearTimeout(openTimer)
  openTimer = setTimeout(() => { placePanel(); panelOpen.value = true }, 150)
}
function scheduleClose() {
  clearTimeout(openTimer)
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => { panelOpen.value = false }, 200)
}
function closeNow() { clearTimeout(openTimer); clearTimeout(closeTimer); panelOpen.value = false }
function go(path) { closeNow(); router.push(path) }
function onDocClick(e) {
  if (panelOpen.value && !e.target.closest?.('[data-test="wb-pill"], [data-test="wb-panel"]')) closeNow()
}
function onKey(e) { if (e.key === 'Escape') closeNow() }
onMounted(() => { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey) })
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick)
  document.removeEventListener('keydown', onKey)
  closeNow()
})

// ---- 相对时间(刚刚/{n} 分钟前/{n} 小时前/{n} 天前;超 7 天回退 M-D)----
function relTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return t('workbench.pill.relNow')
  if (diff < 3_600_000) return t('workbench.pill.relMin', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return t('workbench.pill.relHour', { n: Math.floor(diff / 3_600_000) })
  if (diff < 7 * 86_400_000) return t('workbench.pill.relDay', { n: Math.floor(diff / 86_400_000) })
  const d = new Date(ts)
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`
}
</script>

<template>
  <div ref="btnRef" data-test="wb-pill" class="relative shrink-0" @mouseenter="openPanel" @mouseleave="scheduleClose">
    <button
      @click="router.push('/workbench')"
      :aria-label="$t('nav.workbench')"
      :title="summaryText"
      class="flex items-center gap-sm rounded-full px-md py-1.5 border transition-colors text-body-sm font-semibold shrink-0"
      :class="isWorkbenchActive
        ? 'border-primary bg-primary-container text-on-primary-container'
        : 'border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10'"
    >
      <span class="material-symbols-outlined text-lg">workspaces</span>
      {{ $t('nav.workbench') }}
      <!-- 角标同一时刻一枚:待审批红数字(行动性最强)> 运行中静态绿点(无动画)-->
      <span v-if="pendingCount > 0" data-test="pill-pending"
        class="ml-0.5 min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-error text-on-error text-body-xs font-bold leading-none">{{ pendingCount }}</span>
      <span v-else-if="runningCount > 0" data-test="pill-running" class="w-2 h-2 rounded-full bg-status-running"></span>
    </button>
    <!-- 悬停面板:Task 4 接入(Teleport body + fixed + Z.popover) -->
  </div>
</template>
```

同时把 Task 4 要用的 4 个 relTime 键一并入 i18n(本 Task 一次性加全 pill 键族,避免两次碰 locale 文件):

```jsonc
// zh.json "workbench.pill" 补充(与上面四键合并为一个对象):
  "relNow": "刚刚", "relMin": "{n} 分钟前", "relHour": "{n} 小时前", "relDay": "{n} 天前",
  "newProject": "新建项目", "openLedger": "集群台账", "openRecords": "记录",
  "noProjects": "还没有项目", "pendingChip": "{n} 待审",
  "stale": "更新失败,显示 {t}前数据", "loadFailed": "加载失败"
// en.json 对应:
  "relNow": "just now", "relMin": "{n}m ago", "relHour": "{n}h ago", "relDay": "{n}d ago",
  "newProject": "New project", "openLedger": "Cluster ledger", "openRecords": "Records",
  "noProjects": "No projects yet", "pendingChip": "{n} pending",
  "stale": "Update failed, showing data from {t}", "loadFailed": "Failed to load"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/WorkbenchEntryPill.test.js && npm run i18n:check`
Expected: PASS + i18n 门禁绿

- [ ] **Step 5: 提交**

```bash
git add src/components/layout/WorkbenchEntryPill.vue src/components/layout/__tests__/WorkbenchEntryPill.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(workbench): WorkbenchEntryPill 胶囊+状态角标+summary 30s 轮询——C3 契约不变"
```

---

### Task 4: 悬停概览面板(Teleport/fixed/Z.popover)

**Files:**
- Modify: `src/components/layout/WorkbenchEntryPill.vue`(template 接入面板)
- Modify: `src/components/layout/__tests__/WorkbenchEntryPill.test.js`(+面板用例)

**Interfaces:**
- Consumes: Task 3 组件内的 `panelOpen/panelStyle/projects/pendingCount/runningCount/sshCount/relTime/go/scheduleClose/closeNow` 与 i18n `workbench.pill.*` 全键(Task 3 已入)。
- Produces: `[data-test="wb-panel"]`(Teleport 到 body);项目行 `[data-test="panel-project"]` 点击 → `/workbench/:id`;快捷区三键 → `/workbench?create=1`、`/workbench/ledger`、`/workbench?tab=records`(Task 2 已消费 query)。

- [ ] **Step 1: 追加失败测试(在同测试文件尾部)**

> 顶部补集中 mock(vi.mock 会提升到模块顶层,禁止写在 test 内):`const toast = vi.hoisted(() => ({ notify: vi.fn() }))` + `vi.mock('@/composables/useToast.js', () => ({ notify: toast.notify }))`。Teleport 内容**不在 wrapper DOM 内**,一律查 `document.body`;关闭断言前必须 `await flushPromises()`(Vue 更新是异步的)。

```js
// ===== Task 4:悬停面板 =====
test('悬停 150ms 开面板;面板含汇总 chips 与项目行', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY({
    projects: [{ id: 'p1', name: 'ci-cd', clusterId: 'c1', clusterName: 'prod', lastActiveAt: Date.now() - 120_000, runningConvs: 1, pendingApprovals: 2 }],
    totals: { projects: 1, runningConvs: 1, pendingApprovals: 2, sshSessions: 0 },
  }))
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()   // 未到延迟
  vi.advanceTimersByTime(150); await flushPromises()
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel).toBeTruthy()
  expect(panel.textContent).toContain('ci-cd')
  expect(panel.textContent).toContain('prod')
  expect(panel.textContent).toContain('2 待审')            // pendingChip
  expect(panel.textContent).toContain('2 分钟前')           // relTime
  vi.useRealTimers()
  w.unmount()
})

test('未绑定行显示未绑定徽章;行点击跳项目并关面板', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY({
    projects: [{ id: 'p9', name: 'free', clusterId: '', clusterName: null, lastActiveAt: null, runningConvs: 0, pendingApprovals: 0 }],
    totals: { projects: 1, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 },
  }))
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]').textContent).toContain('未绑定集群')
  document.body.querySelector('[data-test="panel-project"]').click()      // Teleport:查 body
  expect(mocks.push).toHaveBeenCalledWith('/workbench/p9')
  await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()
  vi.useRealTimers()
  w.unmount()
})

test('快捷区三键落点正确', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  const btnByText = txt => [...panel.querySelectorAll('button')].find(b => b.textContent.includes(txt))
  btnByText('新建项目').click(); expect(mocks.push).toHaveBeenLastCalledWith('/workbench?create=1')
  btnByText('集群台账').click(); expect(mocks.push).toHaveBeenLastCalledWith('/workbench/ledger')
  btnByText('记录').click(); expect(mocks.push).toHaveBeenLastCalledWith('/workbench?tab=records')
  vi.useRealTimers()
  w.unmount()
})

test('Escape 与点击外部关面板', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeTruthy()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()

  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  document.body.dispatchEvent(new Event('click', { bubbles: true }))
  await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]')).toBeFalsy()
  vi.useRealTimers()
  w.unmount()
})

test('空状态:0 项目 → 还没有项目+新建按钮', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY({ projects: [], totals: { projects: 0, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 } }))
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel.textContent).toContain('还没有项目')
  ;[...panel.querySelectorAll('button')].find(b => b.textContent.includes('新建项目')).click()
  expect(mocks.push).toHaveBeenLastCalledWith('/workbench?create=1')
  vi.useRealTimers(); w.unmount()
})

test('拉取失败静默:notify 不被调;首次失败面板显示加载失败', async () => {
  vi.useFakeTimers()
  toast.notify.mockClear()
  mocks.summary.mockRejectedValue(new Error('boom'))
  const w = mountPill(); await flushPromises()
  await w.find('[data-test="wb-pill"]').trigger('mouseenter')
  vi.advanceTimersByTime(150); await flushPromises()
  expect(document.body.querySelector('[data-test="wb-panel"]').textContent).toContain('加载失败')
  expect(toast.notify).not.toHaveBeenCalled()
  vi.useRealTimers()
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/WorkbenchEntryPill.test.js`
Expected: 新增 5 用例 FAIL(面板不存在),Task 3 五用例仍 PASS。

- [ ] **Step 3: 实现——template 接入面板(Task 3 已备好开关/定位/relTime/go)**

在胶囊 button 之后(`<!-- 悬停面板 -->` 注释处)替换为:

```vue
    <Teleport to="body">
      <div v-if="panelOpen" data-test="wb-panel"
        @mouseenter="clearTimeout(closeTimer)" @mouseleave="scheduleClose"
        class="fixed bg-surface-container-lowest border border-outline-variant rounded-xl shadow-dropdown p-md"
        :style="panelStyle">
        <!-- 汇总 chips -->
        <div class="flex items-center gap-xs flex-wrap mb-sm text-body-xs">
          <span class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{{ t('workbench.pill.projects', { n: totals.projects ?? 0 }) }}</span>
          <span class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{{ t('workbench.pill.running', { n: runningCount }) }}</span>
          <span class="px-1.5 py-0.5 rounded bg-error/10 text-error">{{ t('workbench.pill.pending', { n: pendingCount }) }}</span>
          <span class="px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant">{{ t('workbench.pill.ssh', { n: sshCount }) }}</span>
        </div>
        <!-- 项目行(≤8,服务端已待办优先排序) -->
        <div v-if="!projects.length" class="py-md text-center">
          <p class="text-body-sm text-on-surface-variant">{{ t('workbench.pill.noProjects') }}</p>
          <button @click="go('/workbench?create=1')" class="mt-sm px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">{{ t('workbench.pill.newProject') }}</button>
        </div>
        <div v-else class="max-h-72 overflow-y-auto">
          <button v-for="p in projects" :key="p.id" data-test="panel-project" @click="go('/workbench/' + p.id)"
            class="w-full flex items-center justify-between gap-sm px-xs py-sm rounded-lg hover:bg-surface-container text-left">
            <span class="min-w-0">
              <span class="block text-body-sm font-semibold text-on-surface truncate">{{ p.name }}</span>
              <span class="block text-body-xs text-on-surface-variant">
                <template v-if="p.clusterId">{{ p.clusterName }}</template>
                <template v-else><span class="inline-block px-1 py-px rounded bg-warning/10 text-warning">{{ t('workbench.unboundBadge') }}</span></template>
              </span>
            </span>
            <span class="flex items-center gap-xs shrink-0 text-body-xs text-on-surface-variant">
              <span v-if="p.pendingApprovals > 0" class="px-1.5 py-0.5 rounded bg-error/10 text-error">{{ t('workbench.pill.pendingChip', { n: p.pendingApprovals }) }}</span>
              <span v-if="p.runningConvs > 0" class="w-1.5 h-1.5 rounded-full bg-status-running"></span>
              <span v-if="p.lastActiveAt">{{ relTime(p.lastActiveAt) }}</span>
            </span>
          </button>
        </div>
        <!-- 快捷动作区 -->
        <div class="flex items-center gap-md mt-sm pt-sm border-t border-outline-variant">
          <button @click="go('/workbench?create=1')" class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined text-sm">add</span>{{ t('workbench.pill.newProject') }}</button>
          <button @click="go('/workbench/ledger')" class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined text-sm">menu_book</span>{{ t('workbench.pill.openLedger') }}</button>
          <button @click="go('/workbench?tab=records')" class="flex items-center gap-xs text-body-xs text-on-surface-variant hover:text-primary"><span class="material-symbols-outlined text-sm">history</span>{{ t('workbench.pill.openRecords') }}</button>
        </div>
        <!-- 降级细字:失败有旧数据 → stale;首次失败 → loadFailed -->
        <p v-if="q.isError.value && q.data.value" class="mt-xs text-body-xs text-on-surface-variant/70">{{ t('workbench.pill.stale', { t: relTime(q.dataUpdatedAt.value) }) }}</p>
        <p v-else-if="q.isError.value && !q.data.value" class="mt-xs text-body-xs text-on-surface-variant/70">{{ t('workbench.pill.loadFailed') }}</p>
      </div>
    </Teleport>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/WorkbenchEntryPill.test.js && npm run i18n:check`
Expected: PASS(10 用例)+ i18n 绿

- [ ] **Step 5: 提交**

```bash
git add src/components/layout/WorkbenchEntryPill.vue src/components/layout/__tests__/WorkbenchEntryPill.test.js
git commit -m "feat(workbench): 胶囊悬停概览面板——汇总chips/项目行(待办chip+相对时间)/快捷区/降级细字,Z.popover 传送层"
```

---

### Task 5: TopNavBar 换装 + 既有测试桩适配 + 全量门禁

**Files:**
- Modify: `src/components/layout/TopNavBar.vue`(内联按钮 → 组件)
- Modify: `src/components/layout/__tests__/TopNavBar.workbench-entry.test.js`(桩:补 VueQueryPlugin + client mock 补 workbenchApi;断言不动)
- Modify: `src/components/layout/__tests__/TopNavBar.dedup.test.js`(桩:补 VueQueryPlugin + client mock 补 `getSession`/`workbenchApi`、确认 vue-router mock 含 `useRoute`;断言不动)
- Modify: `src/components/layout/__tests__/TopNavBar.test.js`(预期免改:已装 VueQueryPlugin(:16)且未 mock client;跑挂确认,若 client mock 缺键则同款补键)

**Interfaces:**
- Consumes: Task 3/4 的 `WorkbenchEntryPill.vue`(自含数据与面板,无 props)。
- Produces: 无新接口;顶栏 DOM 契约(`header button[aria-label="nav.workbench"]` 位置/类名)由既有测试锁死。

- [ ] **Step 1: TopNavBar 换装**

`src/components/layout/TopNavBar.vue` script 加:

```js
import WorkbenchEntryPill from './WorkbenchEntryPill.vue'
```

template 右区(现 :267-280)整块替换(注释更新,按钮本体移入组件;`isWorkbenchActive` computed 若仅胶囊使用则一并删除):

```html
    <div class="flex items-center gap-md">
      <!-- 工作台入口:品牌胶囊 + 状态角标 + 悬停概览(2026-08-30 信息丰富化,规格 specs/2026-08-30-workbench-entry-pill-summary-design.md)
           ——导航级入口排工具按钮前;shrink-0 使溢出压力全部由左侧搜索收缩链吸收(issue #3 契约) -->
      <WorkbenchEntryPill />
      <button @click="refreshPage" ...原样保留...></button>
      <div class="h-8 w-px bg-outline-variant mx-2"></div>
      <UserMenu />
    </div>
```

- [ ] **Step 2: 先跑既有三测试,按实报补桩**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.workbench-entry.test.js src/components/layout/__tests__/TopNavBar.dedup.test.js src/components/layout/__tests__/TopNavBar.test.js`

预期两类失败及修法(只动桩,不动断言):

- `No QueryClient` → mountIt 的 `global.plugins` 加 `[[VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]]`(顶部 `import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'`)。
- client mock 缺键(`getSession`/`workbenchApi`)→ mock 工厂补 `getSession: () => false, workbenchApi: { summary: vi.fn().mockResolvedValue({ projects: [], totals: { projects: 0, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 } }) }`(`getSession:false` ⇒ query 不发;workbench-entry 现有 `getSession: () => false` 保留,同样只补 workbenchApi)。

Expected: 三文件全绿,**断言逐字未动**。

- [ ] **Step 3: 全量门禁**

Run: `npm test && npm run i18n:check && npm run typecheck && npm run build`
Expected: 全绿(服务端+前端单测+i18n 三合一+语法基线+构建)。

- [ ] **Step 4: 提交**

```bash
git add src/components/layout/TopNavBar.vue src/components/layout/__tests__/TopNavBar.workbench-entry.test.js src/components/layout/__tests__/TopNavBar.dedup.test.js src/components/layout/__tests__/TopNavBar.test.js
git commit -m "feat(workbench): 顶栏换装 WorkbenchEntryPill——入口即仪表,既有胶囊契约测试保持绿(仅挂载桩适配)"
```

---

## 收尾(执行完 Task 1-5 后)

1. 手测清单(需真机+网关重启,规格 §6):角标 30s 更新/聚焦刷新;窄窗口面板不裁切;`?create=1` 自动开弹窗;`?tab=records` 直落记录 tab;普通用户 SSH 数不含他人;待审批真实对话计数;重启后待审批仍在。
2. worktree 分支 `--no-ff` 合回 main(禁 squash,保任务粒度历史)。
