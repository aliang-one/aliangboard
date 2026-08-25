# ns allowlist 下拉选择 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API key 的 namespace 允许集编辑器从手输改为「下拉(key 绑定集群的真实 ns)为主 + 手输兜底」。

**Architecture:** 新 admin 端点用**集群表行内凭据**(非浏览器会话集群)拉 `/api/v1/namespaces`,前端 composable 消费,`NsAllowlistEditor` 加 `clusterId` prop 内部拉取,双态切换,mint/编辑两处只多传 prop。chips/校验/保存语义(含 provision-first)不动。

**Tech Stack:** Node 原生 http 路由(routes/admin.mjs)、Vue 3 + vitest + @vue/test-utils、vue-i18n 双语。

**Spec:** `docs/superpowers/specs/2026-08-25-ns-allowlist-dropdown-design.md`

## Global Constraints

- 仓库**不新增外部依赖**(CLAUDE.md 政策)
- i18n 双语同步:zh/en 键必须对齐,`npm run i18n:check` 必须绿;消息值含 HTML 不适用本特性(纯文本)
- 测试分工:服务端 `node --test server/*.test.mjs`;前端 vitest;`npm run typecheck`(node --check)
- `docs/superpowers/` 在 .gitignore 内,**提交须 `git add -f`**
- 组件测试惯例:vitest + `mount` + 真 `i18n` 插件(`import { i18n } from '@/i18n'`);mock 模块用 `vi.mock('@/api/client', ...)`
- 当前分支:`feat-ns-allowlist-dropdown`(基于 main de5f6f3,worktree `.claude/worktrees/fix-apikey-ns-allowlist`)

---

### Task 1: 服务端端点 GET /api/admin/clusters/:id/namespaces

**Files:**
- Create: `server/admin-cluster-namespaces.test.mjs`
- Modify: `server/routes/admin.mjs`(在 `DELETE /api/admin/clusters/:id` 处理块之后、`GET /api/admin/apikeys` 之前插入,约 line 196)

**Interfaces:**
- Consumes: `createAdminRoutes(deps)` 现有 deps:`getCluster(id)`、`buildCallContext(clusterRowSubset)`、`requestKubernetes(ctx, path)`(返回 `{ body }`,body 形如 K8s list:`{ items: [{ metadata: { name } }] }`)
- Produces: `GET /api/admin/clusters/:id/namespaces` → 200 `{ namespaces: string[] }`(字典序)| 404 `{ message: '集群不存在' }` | 502 `{ message }`;admin 权限经 `requireAdmin`

- [ ] **Step 1: 写失败测试**

```js
// server/admin-cluster-namespaces.test.mjs
// GET /api/admin/clusters/:id/namespaces 契约:ns allowlist 下拉候选源。
// 必须用 key 绑定集群自己的凭据拉(非浏览器会话集群,多集群防错位);只回名字、字典序;失败 502。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createAdminRoutes } from './routes/admin.mjs'

const ns = name => ({ metadata: { name } })

function makeHarness({ clusterRow, k8s } = {}) {
  const sent = [], k8sCalls = []
  const routes = createAdminRoutes({
    db: {}, sendJson: (r, s, j) => { sent.push({ status: s, json: j }) },
    readBody: async () => ({}), requireAdmin: () => ({ role: 'admin', username: 'admin' }),
    getCluster: id => (clusterRow && id === clusterRow.id) ? clusterRow : null,
    buildCallContext: c => ({ apiServer: c.apiServer, authHeader: c.authHeader, insecure: !!c.insecure }),
    requestKubernetes: async (ctx, path) => { k8sCalls.push({ ctx, path }); return k8s(path) },
  })
  return { sent, k8sCalls, call: (m, p) => routes.handle({ method: m, on: () => {} }, { writeHead: () => {}, end: () => {} }, new URL(`http://x${p}`)) }
}

const ROW = { id: 'c1', apiServer: 'https://10.0.0.1:6443', authHeader: 'Bearer x', insecure: 1 }

test('200:只回名字且字典序;requestKubernetes 收到集群行凭据 + limit=500', async () => {
  const h = makeHarness({ clusterRow: ROW, k8s: async () => ({ body: { items: [ns('zeta'), ns('alpha'), ns('kube-system')] } }) })
  await h.call('GET', '/api/admin/clusters/c1/namespaces')
  assert.equal(h.sent[0].status, 200)
  assert.deepEqual(h.sent[0].json.namespaces, ['alpha', 'kube-system', 'zeta'])
  assert.equal(h.k8sCalls.length, 1)
  assert.equal(h.k8sCalls[0].path, '/api/v1/namespaces?limit=500')
  assert.equal(h.k8sCalls[0].ctx.authHeader, 'Bearer x')
  assert.equal(h.k8sCalls[0].ctx.apiServer, ROW.apiServer)
})

test('集群不存在 → 404,零 K8s 调用', async () => {
  const h = makeHarness({ clusterRow: null, k8s: async () => { throw new Error('不应被调') } })
  await h.call('GET', '/api/admin/clusters/nope/namespaces')
  assert.equal(h.sent[0].status, 404)
  assert.equal(h.k8sCalls.length, 0)
})

test('K8s 拉取失败 → 502 透出 message', async () => {
  const h = makeHarness({ clusterRow: ROW, k8s: async () => { throw Object.assign(new Error('boom'), { status: 401 }) } })
  await h.call('GET', '/api/admin/clusters/c1/namespaces')
  assert.equal(h.sent[0].status, 502)
  assert.match(h.sent[0].json.message, /boom/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/admin-cluster-namespaces.test.mjs`
Expected: 3 FAIL(路由不存在 → 返回 undefined 未写响应,断言 actual undefined)

- [ ] **Step 3: 实现路由**

在 `server/routes/admin.mjs` 的 `DELETE /api/admin/clusters/:id` 处理块(以 `db.prepare('DELETE FROM user_clusters WHERE clusterId=?').run(id)` 结尾那个 if)之后插入:

```js
    // 按 key 绑定集群拉真实 ns 列表(ns allowlist 下拉候选):用集群表行内凭据,非浏览器会话集群——
    // 多集群下 key 绑 A 而浏览器连 B 时,候选绝不能取 B 的。只回名字、字典序;ns 数量小 limit=500 不分页。
    if (req.method === 'GET' && url.pathname.match(/^\/api\/admin\/clusters\/[^/]+\/namespaces$/)) {
      const ps = requireAdmin(req, res); if (!ps) return true
      const id = decodeURIComponent(url.pathname.split('/')[4])
      const row = deps.getCluster ? deps.getCluster(id) : null
      if (!row) { sendJson(res, 404, { message: '集群不存在' }); return true }
      try {
        const ctx = deps.buildCallContext({ apiServer: row.apiServer, authHeader: row.authHeader, ca: row.ca, cert: row.cert, key: row.key, insecure: !!row.insecure })
        const { body } = await deps.requestKubernetes(ctx, '/api/v1/namespaces?limit=500')
        const namespaces = (body?.items || []).map(it => it?.metadata?.name).filter(Boolean).sort()
        sendJson(res, 200, { namespaces })
      } catch (e) { sendJson(res, 502, { message: `拉取 namespace 列表失败: ${e?.message || '未知错误'}` }) }
      return true
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/admin-cluster-namespaces.test.mjs`
Expected: 3 PASS

- [ ] **Step 5: 提交**

```bash
git add server/admin-cluster-namespaces.test.mjs server/routes/admin.mjs
git commit -m "feat(admin): GET /api/admin/clusters/:id/namespaces——按集群行凭据拉真实 ns(ns allowlist 下拉候选源)"
```

---

### Task 2: 前端 API + useClusterNamespaces composable

**Files:**
- Modify: `src/api/client.js`(clusters 块,~line 269-273)
- Create: `src/composables/useClusterNamespaces.js`
- Test: `src/composables/__tests__/useClusterNamespaces.test.js`

**Interfaces:**
- Consumes: Task 1 的端点;`adminApi.clusters.namespaces(id)` → `Promise<{ namespaces: string[] }>`
- Produces: `useClusterNamespaces(fetchNs = adminApi.clusters.namespaces)` → `{ list: Ref<string[]>, loading: Ref<boolean>, error: Ref<Error|null>, load(clusterId: string): Promise<void> }`(供 Task 3 组件消费;失败清空 list 不残留旧集群候选;竞态守卫)

- [ ] **Step 1: 写失败测试**

```js
// src/composables/__tests__/useClusterNamespaces.test.js
// useClusterNamespaces:按 clusterId 拉 ns 候选。失败清空不残留;空 id 直清;慢旧响应不得覆盖新结果。
import { test, expect } from 'vitest'
import { useClusterNamespaces } from '@/composables/useClusterNamespaces'

test('成功:list 填响应;loading 先真后假', async () => {
  const fetchNs = async () => ({ namespaces: ['default', 'kube-system'] })
  const { list, loading, error, load } = useClusterNamespaces(fetchNs)
  const p = load('c1')
  expect(loading.value).toBe(true)
  await p
  expect(list.value).toEqual(['default', 'kube-system'])
  expect(loading.value).toBe(false)
  expect(error.value).toBeNull()
})

test('失败:清空 list(不残留上一集群候选)+ error 填错', async () => {
  const fetchNs = async id => id === 'bad' ? Promise.reject(new Error('boom')) : { namespaces: ['a'] }
  const { list, error, load } = useClusterNamespaces(fetchNs)
  await load('c1'); expect(list.value).toEqual(['a'])
  await load('bad')
  expect(list.value).toEqual([])
  expect(error.value.message).toBe('boom')
})

test('空 clusterId:清空态不残留,且不发请求', async () => {
  const calls = []
  const fetchNs = async id => { calls.push(id); return { namespaces: [id] } }
  const { list, error, load } = useClusterNamespaces(fetchNs)
  await load('c1')
  expect(list.value).toEqual(['c1'])
  await load('')
  expect(list.value).toEqual([]); expect(error.value).toBeNull()
  expect(calls).toEqual(['c1'])   // 空 id 没有再发
})

test('竞态守卫:c1 慢响应晚于 c2 完成 → 保留 c2 结果', async () => {
  let resolveSlow
  const fetchNs = id => id === 'slow' ? new Promise(r => { resolveSlow = () => r({ namespaces: ['slow-ns'] }) }) : Promise.resolve({ namespaces: ['fast-ns'] })
  const { list, load } = useClusterNamespaces(fetchNs)
  const p1 = load('slow')
  const p2 = load('fast')
  await p2
  resolveSlow(); await p1
  expect(list.value).toEqual(['fast-ns'])
})
```

注意第 3 个用例里 `const { list: l2 } = { list }` 是笔误示范陷阱——实现时直接写 `await load('')` 后断言即可,删掉那行。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/useClusterNamespaces.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现**

`src/api/client.js` clusters 块加一行(remove 之后):

```js
    namespaces: id => platformHttp.request(`/api/admin/clusters/${encodeURIComponent(id)}/namespaces`),
```

`src/composables/useClusterNamespaces.js` 全文:

```js
// 按 key 绑定集群拉真实 ns 列表(ns allowlist 下拉候选源)。fetch 可注入(测试)。
// 纪律:切集群绝不残留上一集群候选(失败/空 id 清空);慢旧响应不得覆盖新结果(seq 守卫)。
import { ref } from 'vue'
import { adminApi } from '@/api/client'

export function useClusterNamespaces(fetchNs = adminApi.clusters.namespaces) {
  const list = ref([])
  const loading = ref(false)
  const error = ref(null)
  let seq = 0
  async function load(clusterId) {
    const my = ++seq
    if (!clusterId) { list.value = []; error.value = null; loading.value = false; return }
    loading.value = true; error.value = null
    try {
      const res = await fetchNs(clusterId)
      if (my !== seq) return
      list.value = Array.isArray(res?.namespaces) ? res.namespaces : []
    } catch (e) {
      if (my !== seq) return
      list.value = []; error.value = e
    } finally {
      if (my === seq) loading.value = false
    }
  }
  return { list, loading, error, load }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/useClusterNamespaces.test.js`
Expected: 4 PASS

- [ ] **Step 5: 提交**

```bash
git add src/api/client.js src/composables/useClusterNamespaces.js src/composables/__tests__/useClusterNamespaces.test.js
git commit -m "feat(ui): adminApi.clusters.namespaces + useClusterNamespaces(候选源 composable,竞态守卫)"
```

---

### Task 3: NsAllowlistEditor 双态改造 + i18n 双语

**Files:**
- Modify: `src/components/common/NsAllowlistEditor.vue`(全文替换,下方给完整代码)
- Modify: `src/locales/zh.json` / `src/locales/en.json`(nsAllowlist 块,~line 3401-3415)
- Test: `src/components/common/__tests__/NsAllowlistEditor.test.js`

**Interfaces:**
- Consumes: Task 2 的 `useClusterNamespaces`;现有 props `boundNs`/`modelValue` 语义不变
- Produces: 新 prop `clusterId: String`(默认 '',= 手输态);新增 data-testid `ns-select` / `ns-manual-input` / `ns-mode-toggle`(测试与将来 E2E 用);chips/校验/`update:modelValue` 契约不变

- [ ] **Step 1: 写失败测试**

```js
// src/components/common/__tests__/NsAllowlistEditor.test.js
// ns allowlist 编辑器:下拉为主(候选=集群 ns−已选−绑定 ns,选中即 chip 且复位)、手输兜底
// (未选集群/拉取失败自动落,可双向切回)、手输校验回归。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const nsMock = vi.fn()
vi.mock('@/api/client', () => ({ adminApi: { clusters: { namespaces: (...a) => nsMock(...a) } } }))

import NsAllowlistEditor from '@/components/common/NsAllowlistEditor.vue'

const mountEd = (props = {}) => mount(NsAllowlistEditor, {
  props: { boundNs: 'ns-bound', modelValue: [], clusterId: 'c1', ...props },
  global: { plugins: [i18n] },
})

test('下拉候选 = 集群 ns − 绑定 ns − 已选 chip', async () => {
  nsMock.mockResolvedValue({ namespaces: ['ns-bound', 'ns-picked', 'default', 'kube-system'] })
  const w = mountEd({ modelValue: ['ns-picked'] })
  await flushPromises()
  const opts = w.find('[data-testid="ns-select"]').findAll('option').filter(o => o.attributes('value'))
  expect(opts.map(o => o.attributes('value'))).toEqual(['default', 'kube-system'])
})

test('下拉选中 → 加 chip + select 复位(可连续添加)', async () => {
  nsMock.mockResolvedValue({ namespaces: ['default', 'kube-system'] })
  const w = mountEd()
  await flushPromises()
  const sel = w.find('[data-testid="ns-select"]')
  await sel.setValue('default')
  expect(w.emitted('update:modelValue')[0]).toEqual([['default']])
  expect(sel.element.value).toBe('')          // 复位待连续添加
  await sel.setValue('kube-system')
  expect(w.emitted('update:modelValue')[1]).toEqual([['default', 'kube-system']])
})

test('拉取失败 → 自动手输态 + 提示;可切回下拉(显示提示)', async () => {
  nsMock.mockRejectedValue(new Error('boom'))
  const w = mountEd()
  await flushPromises()
  expect(w.find('[data-testid="ns-manual-input"]').exists()).toBe(true)
  expect(w.text()).toContain('boom')
  await w.find('[data-testid="ns-mode-toggle"]').trigger('click')   // 切回下拉
  expect(w.find('[data-testid="ns-select"]').exists()).toBe(true)
  expect(w.text()).toContain('boom')                                // 提示仍在
})

test('clusterId 空(mint 未选集群)→ 手输态,不发请求', () => {
  const w = mountEd({ clusterId: '' })
  expect(w.find('[data-testid="ns-manual-input"]').exists()).toBe(true)
  expect(nsMock).not.toHaveBeenCalled()
})

test('手输校验回归:非法名 errMsg、合法名加 chip', async () => {
  nsMock.mockResolvedValue({ namespaces: [] })
  const w = mountEd({ clusterId: '' })
  const inp = w.find('[data-testid="ns-manual-input"]')
  await inp.setValue('Bad_Ns'); await inp.trigger('keydown.enter')
  expect(w.text()).toContain(i18n.global.t('nsAllowlist.invalid'))
  expect(w.emitted('update:modelValue')).toBeUndefined()
  await inp.setValue('demo-ns'); await inp.trigger('keydown.enter')
  expect(w.emitted('update:modelValue')[0]).toEqual([['demo-ns']])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/NsAllowlistEditor.test.js`
Expected: FAIL(无 ns-select,现组件是纯文本输入)

- [ ] **Step 3: 实现组件(全文替换 NsAllowlistEditor.vue)**

```vue
<script setup>
// ns allowlist 编辑器:boundSA_namespace 永远在(不可删)+ 额外 ns「下拉为主、手输兜底」双态。
// 候选 = clusterId 对应集群的真实 ns(经 useClusterNamespaces,key 绑定集群,非浏览器会话集群);
// 未选集群/拉取失败/候选全被已选排除 → 自动落手输态(可手动切回)。v-model 一个「额外 ns」数组。
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { useClusterNamespaces } from '@/composables/useClusterNamespaces'

const props = defineProps({
  boundNs: { type: String, default: '' },
  modelValue: { type: Array, default: () => [] },
  clusterId: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const mode = ref('select')   // 'select'(默认) | 'manual'
const input = ref('')
const errMsg = ref('')
const NS_NAME = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/
const extra = computed(() => props.modelValue || [])
const { list, loading, error, load } = useClusterNamespaces(adminApi.clusters.namespaces)
watch(() => props.clusterId, id => load(id), { immediate: true })  // mint 切集群时候选跟随

const candidates = computed(() => list.value.filter(ns => ns !== props.boundNs && !extra.value.includes(ns)))
// 自动落手输的原因(空串 = 下拉可用)。候选全被排除时不静默——告诉用户为什么只剩手输。
const fallbackReason = computed(() => {
  if (!props.clusterId) return t('nsAllowlist.noCluster')
  if (error.value) return `${t('nsAllowlist.loadFailed')}: ${error.value.message || ''}`
  if (!loading.value && list.value.length && !candidates.value.length) return t('nsAllowlist.allAdded')
  return ''
})
watch(fallbackReason, r => { if (r) mode.value = 'manual' })  // 原因出现 → 自动落手输(切回下拉自由)

function commit(next) { emit('update:modelValue', next) }
function pick(e) {                 // 选中即加 chip,select 复位待连续添加
  const v = e.target.value
  e.target.value = ''
  if (v && !extra.value.includes(v)) commit([...extra.value, v])
}
function add() {                   // 手输路径(校验逻辑与旧版一致)
  const v = input.value.trim()
  if (!v) { input.value = ''; errMsg.value = ''; return }
  if (v === props.boundNs) { errMsg.value = t('nsAllowlist.dup'); input.value = ''; return }
  if (!NS_NAME.test(v) || v.length > 63) { errMsg.value = t('nsAllowlist.invalid'); input.value = ''; return }
  if (extra.value.includes(v)) { errMsg.value = t('nsAllowlist.dup'); input.value = ''; return }
  commit([...extra.value, v]); input.value = ''; errMsg.value = ''
}
function remove(ns) { commit(extra.value.filter(x => x !== ns)) }
</script>
<template>
  <div class="bg-surface-container-low border border-outline-variant rounded-lg p-sm flex flex-col gap-xs">
    <div class="flex flex-wrap gap-1 items-center">
      <span v-if="boundNs" class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-primary/15 text-primary">{{ boundNs }}</span>
      <span v-if="boundNs" class="text-body-xs text-on-surface-variant">{{ t('nsAllowlist.boundAlways') }}</span>
      <span v-for="ns in extra" :key="ns" class="px-1.5 py-0.5 rounded text-body-xs font-mono bg-status-running/15 text-status-running flex items-center gap-0.5">
        {{ ns }}<button type="button" @click="remove(ns)" class="hover:text-error">×</button>
      </span>
    </div>
    <div class="flex items-center gap-xs">
      <select v-if="mode === 'select'" data-testid="ns-select" :disabled="loading"
        class="flex-1 bg-surface border-b border-outline-variant text-body-xs font-mono px-1 py-0.5 outline-none focus:border-primary"
        @change="pick">
        <option value="" disabled selected>{{ loading ? t('nsAllowlist.loading') : t('nsAllowlist.selectPlaceholder') }}</option>
        <option v-for="ns in candidates" :key="ns" :value="ns">{{ ns }}</option>
      </select>
      <input v-else v-model="input" data-testid="ns-manual-input" @keydown.enter.prevent="add" :placeholder="t('nsAllowlist.addPlaceholder')"
        class="flex-1 bg-transparent border-b border-outline-variant text-body-xs font-mono px-1 py-0.5 outline-none focus:border-primary min-w-[12rem]" />
      <button type="button" data-testid="ns-mode-toggle" class="text-body-xs text-primary underline underline-offset-2 shrink-0"
        @click="mode = mode === 'select' ? 'manual' : 'select'">
        {{ mode === 'select' ? t('nsAllowlist.switchToManual') : t('nsAllowlist.switchToSelect') }}
      </button>
    </div>
    <p v-if="errMsg" class="text-body-xs text-error">{{ errMsg }}</p>
    <p v-if="fallbackReason" class="text-body-xs text-on-surface-variant">{{ fallbackReason }}</p>
  </div>
</template>
```

i18n:zh.json 的 nsAllowlist 块(`"updated"` 之前)插入:

```json
    "selectPlaceholder": "选择 namespace",
    "switchToManual": "手动输入",
    "switchToSelect": "下拉选择",
    "loading": "加载中…",
    "loadFailed": "namespace 列表拉取失败",
    "emptyList": "集群无 namespace",
    "allAdded": "集群 ns 已全部添加",
    "noCluster": "未选择集群,请手动输入",
```

en.json 同位置:

```json
    "selectPlaceholder": "Select namespace",
    "switchToManual": "Manual input",
    "switchToSelect": "Dropdown",
    "loading": "Loading…",
    "loadFailed": "Failed to load namespace list",
    "emptyList": "No namespaces in cluster",
    "allAdded": "All cluster namespaces already added",
    "noCluster": "No cluster selected, type manually",
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/NsAllowlistEditor.test.js`
Expected: 5 PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/common/NsAllowlistEditor.vue src/components/common/__tests__/NsAllowlistEditor.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(ui): NsAllowlistEditor 下拉为主+手输兜底双态(候选=key 绑定集群真实 ns)"
```

---

### Task 4: 调用点接线(ApiKeyManagement 两处传 clusterId)

**Files:**
- Modify: `src/views/admin/ApiKeyManagement.vue`(mint 弹窗 ~line 247、编辑弹窗 ~line 297 的 NsAllowlistEditor 标签)

**Interfaces:**
- Consumes: Task 3 的 `clusterId` prop
- Produces: 无(纯接线);现有视图测试(`src/views/__tests__/ApiKeyManagement.*.test.js`)必须保持绿

- [ ] **Step 1: 改 mint 弹窗标签**

```html
        <NsAllowlistEditor :bound-ns="mintForm.boundSA_namespace" :cluster-id="mintForm.clusterId" v-model="mintExtraNs" />
```

- [ ] **Step 2: 改编辑弹窗标签**

```html
        <NsAllowlistEditor :bound-ns="editingKey.boundSA_namespace" :cluster-id="editingKey?.clusterId" v-model="editExtraNs" />
```

- [ ] **Step 3: 跑现有视图测试回归**

Run: `npx vitest run src/views/__tests__/ApiKeyManagement`
Expected: 全 PASS(弹窗默认关闭,编辑器不挂载,mock 无需改)。若有用例打开弹窗导致
`adminApi.clusters.namespaces` 未 mock 报错:在该用例的 `vi.mock('@/api/client')` 的
`clusters` 对象里补 `namespaces: vi.fn(async () => ({ namespaces: [] }))`。

- [ ] **Step 4: 提交**

```bash
git add src/views/admin/ApiKeyManagement.vue
git commit -m "feat(ui): mint/编辑弹窗 NsAllowlistEditor 接 clusterId(下拉候选跟随绑定集群)"
```

---

### Task 5: 全量门禁 + 合并 main

**Files:** 无新文件(验证与合并)

- [ ] **Step 1: 全量门禁**

Run: `npm test`(server + unit 全量)、`npm run typecheck`、`npm run i18n:check`
Expected: 三项全绿(i18n:check 会抓 zh/en 键不对齐)

- [ ] **Step 2: 合并 main**

```bash
cd /home/liang/MyProgram/AiProject/aliangboard
git branch --show-current   # 须 main 且干净;否则停,按 multi-session 防撞流程处理
git merge --no-ff feat-ns-allowlist-dropdown -m "Merge branch 'feat-ns-allowlist-dropdown': ns allowlist 下拉选择(按绑定集群拉真实 ns+手输兜底)"
```

- [ ] **Step 3: 汇报**

向用户汇报:改动摘要、测试结果、需手测项(mint 选集群后下拉联动/切换集群重拉、编辑弹窗下拉、
拉取失败落手输、真实集群端到端加 ns)。

---

## Self-Review 记录

- Spec 覆盖:端点(§1→Task 1)、API+composable(§2/§3→Task 2)、编辑器双态(§4→Task 3)、
  调用点(§5→Task 4)、测试(§6→各 Task+Task 5 门禁)、错误处理表(§表→Task 3
  fallbackReason 分支)——全覆盖;「重开弹窗才重拉」由组件 unmount/mount 天然满足。
- 占位符:无 TBD/「适当处理」;全部代码块完整可抄。
- 类型/命名一致性:`useClusterNamespaces(fetchNs)` 与 `adminApi.clusters.namespaces(id)`、
  data-testid 三处(`ns-select`/`ns-manual-input`/`ns-mode-toggle`)在 Task 2/3/测试间一致;
  i18n 键 8 个 zh/en 对齐。
