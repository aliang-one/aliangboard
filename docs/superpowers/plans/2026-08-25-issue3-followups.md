# issue #3 后续三项实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 issue #3 三项:① 顶栏整行横向溢出 ② TLS Secret 输入统一 PortSelect 下拉(可手输) ③ Pods 卡片批量删除。

**Architecture:** A 纯 CSS 类级收缩链修复;B 复用 PortSelect 平铺模式,IngressRulesEditor 加 `secrets` prop 由三父级按 `type === 'kubernetes.io/tls'` + 当前 ns 过滤传入;C NsPods 加批量模式(Set 选中集跨分页),PodCard 加 `selectable` checkbox 视觉,`Promise.allSettled` + 纯函数 `summarizeResults` 汇总。

**Tech Stack:** Vue 3 组合式 + Tailwind v3 + vitest/happy-dom + @vue/test-utils + vue-i18n(zh/en 双语)。

**Spec:** `docs/superpowers/specs/2026-08-25-issue3-followups-design.md`(b4d0978)

## Global Constraints

- **开工先 EnterWorktree**(分支名 `worktree-fix-issue3-followups`);每个 Task 结束 commit;commit 前必 `git branch --show-current` 复核
- 不新增任何外部依赖(CLAUDE.md 依赖政策)
- 所有新用户可见文案:zh/en 双语同步加键(`src/locales/zh.json` + `en.json`),过 `npm run i18n:check`;i18n 值含 `@` 须转义 `{'@'}`(本次键均无 @)
- 测试命令:`npx vitest run <file>`;组件测试需 `global: { plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]] }`(先例 DeployIngressControllerDialog.test.js:48-51)
- docs/ 下文件提交须 `git add -f`(目录被 ignore)

---

### Task 1: 顶栏整行溢出修复(TopNavBar)

**Files:**
- Modify: `src/components/layout/TopNavBar.vue`(:142-143 左组/搜索框、:166/:225 按钮包裹层、:177/:238 名字 span、:212 下拉行、:279 用户名)
- Test: `src/components/layout/__tests__/TopNavBar.test.js`(新建;`src/components/layout/__tests__/` 目录不存在,随测试文件创建)

**Interfaces:**
- Consumes: 无
- Produces: 无(纯展示修复;类契约由测试锁定)

- [ ] **Step 1: 写失败测试**

```js
// src/components/layout/__tests__/TopNavBar.test.js
// issue #3 顶栏溢出回归:整行可收缩链(搜索框优先缩)+ 名字截断后 title 兜底。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

vi.mock('vue-router', () => ({ useRoute: () => ({}), useRouter: () => ({ push: vi.fn() }) }))

import TopNavBar from '@/components/layout/TopNavBar.vue'
import { useClusterStore } from '@/stores/cluster'

function mountNav() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(TopNavBar, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
}

test('收缩链:搜索框包裹层 min-w-0,集群/ns 按钮包裹层 shrink-0', () => {
  setActivePinia(createPinia())
  const w = mountNav()
  const searchWrap = w.find('header div.max-w-md')
  expect(searchWrap.classes()).toContain('min-w-0')
  const clusterWrap = searchWrap.element.nextElementSibling
  expect(clusterWrap.className).toContain('shrink-0')
  const nsWrap = clusterWrap.nextElementSibling
  expect(nsWrap.className).toContain('shrink-0')
})

test('集群名截断后 title 可见全名;用户名 span truncate+max-w', () => {
  setActivePinia(createPinia())
  const store = useClusterStore()
  const longName = 'a-very-long-cluster-name-that-exceeds-180px-for-sure'
  store.clusterList = [{ name: longName, apiServer: 'https://k8s.example', version: 'v1.31', distribution: 'k3s' }]
  store.currentCluster = longName
  const w = mountNav()
  const clusterBtn = w.findAll('header button').find(b => b.text().includes('CLUSTER'))
  const nameSpan = clusterBtn.findAll('span').find(s => s.classes().includes('truncate'))
  expect(nameSpan.attributes('title')).toBe(longName)
  const logoutBtn = w.findAll('header button').at(-1)
  const userSpan = logoutBtn.findAll('span').find(s => s.classes().includes('truncate'))
  expect(userSpan.classes()).toContain('max-w-[120px]')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js`
Expected: FAIL(缺 `min-w-0`/`shrink-0`/`title`,断言不等)

- [ ] **Step 3: 最小实现(TopNavBar.vue 六处类/属性)**

```text
:142  <div class="flex items-center gap-lg flex-1">
   →  <div class="flex items-center gap-lg flex-1 min-w-0">
:143  <div class="relative max-w-md w-full">
   →  <div class="relative max-w-md w-full min-w-0">
:166  <div class="relative">(集群切换注释下)
   →  <div class="relative shrink-0">
:177  <span class="text-body-sm font-semibold truncate">{{ currentClusterObj?.name || '—' }}</span>
   →  <span class="text-body-sm font-semibold truncate" :title="currentClusterObj?.name">{{ currentClusterObj?.name || '—' }}</span>
:212  <p class="text-xs text-on-surface-variant">{{ c.version }} · {{ c.distribution }}</p>
   →  <p class="text-xs text-on-surface-variant truncate">{{ c.version }} · {{ c.distribution }}</p>
:225  <div class="relative">(ns 注释下)
   →  <div class="relative shrink-0">
:238  <span class="text-body-sm font-semibold truncate">{{ currentNs || $t('nav.notSelected') }}</span>
   →  <span class="text-body-sm font-semibold truncate" :title="currentNs">{{ currentNs || $t('nav.notSelected') }}</span>
:279  <span class="text-body-sm font-semibold">{{ authStore.user?.displayName || authStore.user?.username || 'User' }}</span>
   →  <span class="text-body-sm font-semibold max-w-[120px] truncate" :title="authStore.user?.displayName || authStore.user?.username">{{ authStore.user?.displayName || authStore.user?.username || 'User' }}</span>
```

注::166/:225 两处 `<div class="relative">` 外层还有搜索框的 `relative`(已改过,不受影响);用上下文注释行(`<!-- 集群切换 -->` / `<!-- 当前命名空间…`)区分定位。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js`
Expected: PASS 2/2

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/components/layout/TopNavBar.vue src/components/layout/__tests__/TopNavBar.test.js
git commit -m "fix(nav): 顶栏整行横向溢出——收缩链(搜索框优先缩 min-w-0/按钮 shrink-0)+名字 title 兜底+用户名 truncate(issue #3)"
```

---

### Task 2: IngressRulesEditor TLS Secret 行换 PortSelect

**Files:**
- Modify: `src/components/common/IngressRulesEditor.vue`(props :13-21 + :146-150 TLS 行)
- Test: `src/components/common/__tests__/IngressRulesEditor.test.js`(新建)

**Interfaces:**
- Consumes: `PortSelect`(已 import :11)props:`options/placeholder/empty-hint/input-class` + `v-model`
- Produces: IngressRulesEditor 新 prop `secrets: Array<string>`(TLS Secret 候选名,父级已过滤;Task 3 三父级依赖此名)

- [ ] **Step 1: 写失败测试**

```js
// src/components/common/__tests__/IngressRulesEditor.test.js
// issue #3 TLS Secret 下拉:纯手输 → PortSelect(可下拉可手输+空态提示)。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import IngressRulesEditor from '@/components/common/IngressRulesEditor.vue'
import PortSelect from '@/components/common/PortSelect.vue'

const HOSTS_ON = [{ host: 'a.example.com', tls: true, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' }] }]

function mountEd(props = {}) {
  return mount(IngressRulesEditor, {
    props: { modelValue: HOSTS_ON, services: [{ name: 'svc', ports: [80] }], withTls: true, secrets: ['tls-a', 'tls-b'], ...props },
    global: { plugins: [i18n] },
  })
}

test('TLS Secret 行 = PortSelect:options=secrets prop,空态提示可配', () => {
  const w = mountEd()
  const ps = w.findAllComponents(PortSelect)
    .find(c => c.props('placeholder') === i18n.global.t('ns.ingressDetail.tlsRowSecretPlaceholder'))
  expect(ps).toBeTruthy()
  expect(ps.props('options')).toEqual(['tls-a', 'tls-b'])
  expect(ps.props('emptyHint')).toBe(i18n.global.t('ns.ingressDetail.noTlsSecretsHint'))
})

test('secrets 为空数组也渲染 PortSelect(空态提示由组件呈现)', () => {
  const w = mountEd({ secrets: [] })
  const ps = w.findAllComponents(PortSelect)
    .find(c => c.props('placeholder') === i18n.global.t('ns.ingressDetail.tlsRowSecretPlaceholder'))
  expect(ps.exists()).toBe(true)
  expect(ps.props('options')).toEqual([])
})

test('tls 勾选关闭时无 TLS PortSelect(仅 serviceName/servicePort 两个)', () => {
  const w = mountEd({ modelValue: [{ host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'svc', servicePort: '80' }] }] })
  expect(w.findAllComponents(PortSelect).length).toBe(2)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/IngressRulesEditor.test.js`
Expected: FAIL(TLS 行还是 input,找不到 placeholder 对应的 PortSelect)

- [ ] **Step 3: 最小实现**

props 块(:13-21)在 `services:` 之后加一行:

```js
  secrets: { type: Array, default: () => [] },  // TLS Secret 候选名(父级已按 kubernetes.io/tls + 当前 ns 过滤)
```

:149 的 input 整行替换为:

```vue
          <PortSelect v-if="h.tls" v-model="h.tlsSecret" :options="secrets" :placeholder="t('ns.ingressDetail.tlsRowSecretPlaceholder')" :empty-hint="t('ns.ingressDetail.noTlsSecretsHint')" input-class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" />
```

(v-model 直接绑行对象字段,守既有契约「字段编辑直接 v-model 行对象」。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/IngressRulesEditor.test.js`
Expected: PASS 3/3

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/components/common/IngressRulesEditor.vue src/components/common/__tests__/IngressRulesEditor.test.js
git commit -m "feat(ingress): IngressRulesEditor TLS Secret 行换 PortSelect——可下拉可手输+空态提示(issue #3)"
```

---

### Task 3: 三父级接线 + i18n 键

**Files:**
- Modify: `src/locales/zh.json` / `src/locales/en.json`(`ns.ingressDetail` 对象内加 `noTlsSecretsHint`)
- Modify: `src/views/NsIngress.vue`(:40 svcQ 后加 secQ + computed;:275 传 prop)
- Modify: `src/views/DeployApp.vue`(:282 _secQ 后加 computed;:1474 传 prop;PortSelect 已 import)
- Modify: `src/views/NsIngressDetail.vue`(:46 allSecrets 后加 computed;import PortSelect;:506-511 datalist 块换 PortSelect)

**Interfaces:**
- Consumes: Task 2 的 `secrets` prop;`store.fetchSecrets()`(useFetchers 既有)
- Produces: 无

- [ ] **Step 1: i18n 键(两文件 `ns.ingressDetail` 对象内,紧跟 `tlsRowSecretPlaceholder` 键之后)**

zh.json:
```json
"noTlsSecretsHint": "本命名空间暂无 TLS 类型 Secret,可手动输入名称",
```
en.json:
```json
"noTlsSecretsHint": "No TLS Secrets in this namespace; type the name manually",
```

- [ ] **Step 2: NsIngress.vue(③独立创建)**

:40(svcQ 行)之后加:

```js
const secQ = useResourceList({ key: ['cluster', cid, 'secrets'], fetcher: () => store.fetchSecrets(), options: { refetchInterval: 30000 } })
// TLS Secret 候选:当前 ns + kubernetes.io/tls 类型(fetchSecrets 拉的是全 ns 列表,须过滤)
const tlsSecretNames = computed(() => (secQ.data.value || []).filter(s => s.namespace === route.params.namespace && s.type === 'kubernetes.io/tls').map(s => s.name))
```

(确认 `computed` 已在 vue import 中,缺则补。)

:275 改为:

```vue
      <IngressRulesEditor v-model="hosts" :services="svcOptions" :secrets="tlsSecretNames" :with-tls="true" @validation="v => rulesErrors = v" />
```

- [ ] **Step 3: DeployApp.vue(①向导;_secQ :282 已有,PortSelect :19 已 import)**

:283(availableConfigMaps 行)之后加:

```js
// TLS Secret 候选:当前 ns + kubernetes.io/tls 类型
const tlsSecretNames = computed(() => (_secQ.data.value || []).filter(s => s.namespace === store.currentNamespace && s.type === 'kubernetes.io/tls').map(s => s.name))
```

:1474 改为:

```vue
            <IngressRulesEditor v-model="form.ingressRules" :services="ingressServiceOptions" :secrets="tlsSecretNames" :with-tls="true" :default-service-name="virtualServiceName || undefined" />
```

- [ ] **Step 4: NsIngressDetail.vue(②TLS 编辑弹窗;allSecrets :46 已有)**

script:import 区加 `import PortSelect from '@/components/common/PortSelect.vue'`;:46(allSecrets 行)之后加:

```js
// TLS Secret 候选:当前 ns + kubernetes.io/tls 类型
const tlsSecretNames = computed(() => allSecrets.value.filter(s => s.namespace === route.params.namespace && s.type === 'kubernetes.io/tls').map(s => s.name))
```

template:506-511 的 input+datalist 两块(input 带 `list="ing-tls-secrets"` 与整个 `<datalist id="ing-tls-secrets">…</datalist>`)整体替换为:

```vue
      <PortSelect v-model="editTlsSecret" :options="tlsSecretNames" :placeholder="$t('ns.ingressDetail.tlsSecretPlaceholder')" :empty-hint="$t('ns.ingressDetail.noTlsSecretsHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" />
```

- [ ] **Step 5: 验证(接线无独立单测,以门禁代行)**

Run: `npm run i18n:check && npx vitest run src/components/common/__tests__/IngressRulesEditor.test.js && npm run build 2>&1 | tail -3`
Expected: i18n 三项全过;测试 PASS;build 成功

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add src/locales/zh.json src/locales/en.json src/views/NsIngress.vue src/views/DeployApp.vue src/views/NsIngressDetail.vue
git commit -m "feat(ingress): TLS Secret 候选接线三入口——ns+tls 类型过滤,datalist 假图标根治(issue #3)"
```

---

### Task 4: 批量结果汇总纯函数

**Files:**
- Create: `src/utils/batchDelete.js`
- Test: `src/utils/__tests__/batchDelete.test.js`(目录不存在则随文件创建)

**Interfaces:**
- Consumes: 无
- Produces: `summarizeResults(results, items, nameOf = it => it?.name ?? '')` → `{ okNames: string[], failedNames: string[] }`(results 为 `Promise.allSettled` 输出,与 items 按索引对齐;Task 6 依赖)

- [ ] **Step 1: 写失败测试**

```js
// src/utils/__tests__/batchDelete.test.js
import { test, expect } from 'vitest'
import { summarizeResults } from '@/utils/batchDelete'

const items = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]

test('全成功', () => {
  const r = summarizeResults([
    { status: 'fulfilled', value: null },
    { status: 'fulfilled', value: null },
    { status: 'fulfilled', value: null },
  ], items)
  expect(r).toEqual({ okNames: ['a', 'b', 'c'], failedNames: [] })
})

test('部分失败按索引对齐,全败为空 ok', () => {
  const r = summarizeResults([
    { status: 'fulfilled', value: null },
    { status: 'rejected', reason: new Error('404') },
    { status: 'rejected', reason: new Error('403') },
  ], items)
  expect(r).toEqual({ okNames: ['a'], failedNames: ['b', 'c'] })
})

test('nameOf 可定制(如取 pod.name)', () => {
  const r = summarizeResults([{ status: 'rejected', reason: new Error('x') }], [{ pod: { name: 'p1' } }], it => it.pod.name)
  expect(r).toEqual({ okNames: [], failedNames: ['p1'] })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/batchDelete.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**

```js
// src/utils/batchDelete.js
// 批量操作结果汇总:Promise.allSettled 输出与输入数组按索引对齐。
// 返回 { okNames, failedNames } 供调用方拼 notify 文案与保留失败项选中。
export function summarizeResults(results, items, nameOf = it => it?.name ?? '') {
  const okNames = [], failedNames = []
  results.forEach((r, i) => {
    const name = nameOf(items[i])
    if (r.status === 'fulfilled') okNames.push(name)
    else failedNames.push(name)
  })
  return { okNames, failedNames }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/utils/__tests__/batchDelete.test.js`
Expected: PASS 3/3

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/utils/batchDelete.js src/utils/__tests__/batchDelete.test.js
git commit -m "feat(utils): summarizeResults——Promise.allSettled 批量结果按索引对齐汇总"
```

---

### Task 5: PodCard selectable checkbox

**Files:**
- Modify: `src/components/common/PodCard.vue`(props :15-31 + 行1 :78-79)
- Test: `src/components/common/__tests__/PodCard.test.js`(文件已有,追加用例)

**Interfaces:**
- Consumes: 既有 `selected` prop(:19)
- Produces: PodCard 新 prop `selectable: Boolean`——为 true 时行1渲染 checkbox 视觉(`pointer-events-none`,点击由卡片 `@click` 统一触发;Task 6 依赖)

- [ ] **Step 1: 追加失败测试(PodCard.test.js 末尾)**

```js
test('批量模式:selectable 渲染 checkbox 视觉,selected 切换图标,点击卡片仍 emit click', async () => {
  const w1 = mountCard({ selectable: true, selected: false })
  const cb1 = w1.find('[data-test="batch-checkbox"]')
  expect(cb1.exists()).toBe(true)
  expect(cb1.text()).toBe('check_box_outline_blank')
  await cb1.trigger('click')
  expect(w1.emitted('click')).toBeTruthy()  // checkbox 不拦截,冒泡到卡片

  const w2 = mountCard({ selectable: true, selected: true })
  expect(w2.find('[data-test="batch-checkbox"]').text()).toBe('check_box')

  const w3 = mountCard({ selectable: false })
  expect(w3.find('[data-test="batch-checkbox"]').exists()).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/PodCard.test.js`
Expected: FAIL(找不到 `[data-test="batch-checkbox"]`)

- [ ] **Step 3: 最小实现**

props(:23 `showDelete` 行前)加:

```js
  // 批量选择模式:行1 渲染 checkbox 视觉(pointer-events-none,点击统一走卡片 @click)
  selectable: { type: Boolean, default: false },
```

行1(:79 健康点 span 之前)插入:

```vue
      <span v-if="selectable" data-test="batch-checkbox" class="material-symbols-outlined text-base text-primary select-none pointer-events-none shrink-0">{{ selected ? 'check_box' : 'check_box_outline_blank' }}</span>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/PodCard.test.js`
Expected: PASS(既有用例 + 新用例)

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/components/common/PodCard.vue src/components/common/__tests__/PodCard.test.js
git commit -m "feat(pod): PodCard selectable——批量模式 checkbox 视觉(pointer-events-none 由卡片统一点击)"
```

---

### Task 6: NsPods 批量删除模式

**Files:**
- Modify: `src/views/NsPods.vue`(script :29-85 区域 + template 工具栏 :128-141 / 筛选行 :148-160 / 卡片 :165-175 + 新 Modal)
- Modify: `src/locales/zh.json` / `en.json`(`ns.pods` 对象内加 11 键)

**Interfaces:**
- Consumes: Task 4 `summarizeResults`;Task 5 `selectable`/`selected` props;既有 `store.deletePod(name, ns)`、Modal(Z.modal)、notify
- Produces: 无

- [ ] **Step 1: i18n 键(ns.pods 对象内,紧跟 `deletedPod` 键之后;两文件同步)**

zh.json:
```json
"batchEnter": "批量删除",
"batchExit": "退出批量",
"batchSelected": "已选 {n}",
"batchSelectAll": "全选",
"batchClear": "清空",
"batchDeleteAction": "删除所选",
"batchDeleteTitle": "批量删除 Pod",
"batchDeleteConfirm": "将删除以下 {n} 个 Pod:{names}",
"batchDeleteWarning": "由 Deployment/StatefulSet 等控制器管理的 Pod,删除后会被自动重建",
"batchDeleted": "已删除 {n} 个 Pod",
"batchPartial": "成功 {ok} 个,失败 {fail} 个:{names}",
```
en.json:
```json
"batchEnter": "Batch Delete",
"batchExit": "Exit Batch",
"batchSelected": "{n} selected",
"batchSelectAll": "Select All",
"batchClear": "Clear",
"batchDeleteAction": "Delete Selected",
"batchDeleteTitle": "Batch Delete Pods",
"batchDeleteConfirm": "The following {n} pods will be deleted: {names}",
"batchDeleteWarning": "Pods managed by controllers (Deployment/StatefulSet, etc.) will be recreated automatically after deletion",
"batchDeleted": "Deleted {n} pods",
"batchPartial": "{ok} succeeded, {fail} failed: {names}",
```

- [ ] **Step 2: script 批量逻辑(单删块 :66-85 之后插入)**

```js
// === 批量删除(卡片选择模式;选中集跨分页/筛选保留) ===
const batchMode = ref(false)
const selectedNames = ref(new Set())
const showBatchModal = ref(false)
function toggleSelect(name) {
  const s = selectedNames.value
  if (s.has(name)) s.delete(name)
  else s.add(name)
}
function enterBatch() { batchMode.value = true }
function exitBatch() { batchMode.value = false; selectedNames.value = new Set() }
function selectAllFiltered() {
  selectedNames.value = new Set(filtered.value.map(p => p.name))
}
function clearSelection() { selectedNames.value = new Set() }
// 删除目标 = 当前列表中仍存在的选中项(选中后列表刷新/被删的自动失效)
const batchTargets = computed(() => nsPods.value.filter(p => selectedNames.value.has(p.name)))
const batchNamesPreview = computed(() => {
  const names = batchTargets.value.map(p => p.name)
  const head = names.slice(0, 10).join(', ')
  return names.length > 10 ? `${head} …` : head
})
function onCardClick(p) {
  if (batchMode.value) { toggleSelect(p.name); return }
  router.push({ name: 'NsPodDetail', params: { namespace: route.params.namespace, name: p.name } })
}
async function handleBatchDelete() {
  const targets = batchTargets.value
  if (!targets.length) return
  const results = await Promise.allSettled(targets.map(p => store.deletePod(p.name, route.params.namespace)))
  const { okNames, failedNames } = summarizeResults(results, targets)
  if (!failedNames.length) {
    notify('success', t('ns.pods.batchDeleted', { n: okNames.length }))
    showBatchModal.value = false
    exitBatch()
  } else {
    // 部分失败:保留失败项选中便于重试;不退出批量模式
    notify('error', t('ns.pods.batchPartial', { ok: okNames.length, fail: failedNames.length, names: failedNames.join(', ') }))
    selectedNames.value = new Set(failedNames)
    showBatchModal.value = false
  }
}
```

import 行补:`import { summarizeResults } from '@/utils/batchDelete'`(放 :7 api/client import 之后)。

- [ ] **Step 3: template 三处改动**

① 工具栏(:129 LIVE 按钮之前)插入批量开关:

```vue
        <button v-if="!batchMode" @click="enterBatch"
          class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-medium rounded-lg border bg-surface-container-highest text-on-surface border-outline-variant hover:bg-surface-container transition-colors"
          :title="t('ns.pods.batchEnter')">
          <span class="material-symbols-outlined">delete_sweep</span> {{ t('ns.pods.batchEnter') }}
        </button>
        <button v-else @click="exitBatch"
          class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-medium rounded-lg border bg-primary-container/20 text-primary border-primary transition-colors"
          :title="t('ns.pods.batchExit')">
          <span class="material-symbols-outlined">close</span> {{ t('ns.pods.batchExit') }}
        </button>
```

② 筛选行(:159 `results` span 之后)追加批量操作条:

```vue
      <template v-if="batchMode">
        <span class="text-body-sm font-semibold text-primary">{{ t('ns.pods.batchSelected', { n: batchTargets.length }) }}</span>
        <button @click="selectAllFiltered" class="px-sm py-xs text-body-sm border border-outline-variant rounded-lg hover:bg-surface-container-low">{{ t('ns.pods.batchSelectAll') }}</button>
        <button @click="clearSelection" class="px-sm py-xs text-body-sm border border-outline-variant rounded-lg hover:bg-surface-container-low">{{ t('ns.pods.batchClear') }}</button>
        <button @click="showBatchModal = true" :disabled="!batchTargets.length"
          class="flex items-center gap-xs px-sm py-xs text-body-sm font-semibold bg-error text-on-error rounded-lg hover:opacity-90 disabled:opacity-40">
          <span class="material-symbols-outlined text-base">delete</span>{{ t('ns.pods.batchDeleteAction') }}
        </button>
      </template>
```

③ PodCard(:165-169)改为:

```vue
        <PodCard
          v-for="p in paginated" :key="p.name" :pod="p" show-delete
          :selectable="batchMode" :selected="batchMode && selectedNames.has(p.name)"
          @click="onCardClick"
          @delete="confirmDelete"
        >
```

④ 文件末尾(创建 Modal 之后)追加批量确认 Modal:

```vue
  <!-- 批量删除确认 -->
  <Modal v-model="showBatchModal" :title="t('ns.pods.batchDeleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface">{{ t('ns.pods.batchDeleteConfirm', { n: batchTargets.length, names: batchNamesPreview }) }}</p>
    <p class="text-body-sm text-error mt-sm">{{ t('ns.pods.batchDeleteWarning') }}</p>
    <template #actions>
      <button @click="showBatchModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('common.cancel') }}</button>
      <button @click="handleBatchDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('common.delete') }}</button>
    </template>
  </Modal>
```

- [ ] **Step 4: 验证(无独立挂载测试,以门禁代行)**

Run: `npm run i18n:check && npx vitest run && npm run build 2>&1 | tail -3`
Expected: i18n 过;全量单测 PASS;build 成功

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add src/views/NsPods.vue src/locales/zh.json src/locales/en.json
git commit -m "feat(pods): Pods 卡片批量删除——选择模式(跨分页 Set)/全选/确认弹窗/allSettled 汇总+失败保留重试(issue #3)"
```

---

### Task 7: 门禁四连 + 合 main + 推 origin

**Files:** 无新增(验证与合并)

- [ ] **Step 1: 全量门禁**

```bash
npm run test:unit && npm test && npm run typecheck && npm run build
```
Expected: 四连全绿(test:unit 全量、server 测试、312+ 文件语法、构建成功)

- [ ] **Step 2: 合 main(在主 checkout,ff-only 惯例)**

```bash
git -C /home/liang/MyProgram/AiProject/aliangboard status --short   # 须干净
git -C /home/liang/MyProgram/AiProject/aliangboard branch --show-current  # 须 main
git -C /home/liang/MyProgram/AiProject/aliangboard merge --ff-only worktree-fix-issue3-followups
git -C /home/liang/MyProgram/AiProject/aliangboard push origin main
```

- [ ] **Step 3: 手测清单交付(需集群,汇报给用户)**

1. 长名集群(>30 字符)+ 窄窗口:顶栏无横向滚动,搜索框先缩,悬停名字见全名
2. 部署向导/Ingress 创建勾 TLS:下拉出 TLS Secret;空 ns 显示空态提示;手输仍可
3. Ingress 详情 TLS 编辑:PortSelect 可选(datalist 假图标消失)
4. Pods 批量:进批量→点卡多选(翻页保留)→全选/清空→确认名单→删除→toast 汇总;无权限场景部分失败提示+失败项保持选中

## Self-Review 记录

- 覆盖:spec A/B/C 三节 → Task 1/2+3/4+5+6;spec「验证」→ Task 7 ✓
- 占位:无 TBD/「适当处理」;所有代码块完整 ✓
- 类型一致:`secrets: Array<string>`(Task 2 产出 = Task 3 消费)、`summarizeResults(results, items, nameOf)`(Task 4 产出 = Task 6 消费)、`selectable/selected`(Task 5 产出 = Task 6 消费)✓
