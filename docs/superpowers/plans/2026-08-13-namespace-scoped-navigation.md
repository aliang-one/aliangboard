# 命名空间态侧栏分级 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧边栏按路由 scope 分两级上下文——命名空间态隐藏集群导航组、Cluster Header 变为「返回集群管理」入口;集群态/全局管理类保留。

**Architecture:** 新增 `useNavMode` composable 用 `route.meta.scope` 判定模式(单一真相源=路由);`SideNavBar.vue` 用 `isNsMode`/`isClusterMode` 门控分组(取代 `currentNs`),并把静态 Cluster Header 在命名空间态改成可点击返回按钮。无新依赖、无路由表改动。

**Tech Stack:** Vue 3 + Pinia + vue-router(纯 JS);vitest + @vue/test-utils + happy-dom(组件/composable 测试);`npm run typecheck` / `npm run i18n:check` 门禁。

## Global Constraints

(每个任务的隐含前置约束,值逐字取自 spec / CLAUDE.md)

- **不新增外部依赖**(CLAUDE.md 依赖政策;本特性不引入任何依赖)。
- **测试栈**:含 Vue/vue-router 的 composable 与组件测试用 **vitest + @vue/test-utils + happy-dom**,命令 `npm run test:unit`;纯服务端逻辑才用自研零依赖运行器。本特性的 `useNavMode` 依赖 vue-router,故走 vitest。
- **门禁**:每个任务结束前跑相关门禁——`npm run typecheck`(`node --check` 全 .js/.mjs;.vue 由 `npm run build` 覆盖)、`npm run i18n:check`(残留中文 + zh/en 键对齐 + 引用键缺失三合一)。涉及测试的任务跑 `npm run test:unit`。
- **testid 约定**:用 `data-test="..."` 锚定(参考既有 `ns-home` / `bottom-events` / `bottom-settings`)。
- **i18n 文案**:本特性文案不含 `@` 或 HTML,无需转义/`v-html`(参见 memory i18n-at-sign-escaping / i18n-html-voml-rendering)。
- **分支**:已开 worktree `worktree-feat-ns-scoped-nav`(基线=本地 main HEAD `efd9fa5`),所有提交落此分支;commit message 末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。

## File Structure

| 文件 | 责任 | 任务 |
|------|------|------|
| `src/composables/useNavMode.js` | **新增**:route scope → `{navMode,isNsMode,isClusterMode}` | Task 1 |
| `src/composables/__tests__/useNavMode.test.js` | **新增**:vitest + vue-router mock,测三种 scope | Task 1 |
| `src/locales/zh.json` / `en.json` | 改:`nav` 对象加 `backToCluster`、`enterNamespace` | Task 2 |
| `src/components/layout/SideNavBar.vue` | 改:引入 useNavMode;分组门控改 isNsMode/isClusterMode(Task 3);Cluster Header 命名空间态变返回按钮(Task 4) | Task 3、4 |
| `src/components/__tests__/SideNavBar.test.js` | **新增**:vitest,mount SideNavBar(全 store/router mock),测两种模式分组 + Header 返回 | Task 3、4 |
| `src/views/Namespaces.vue` | 改:行 actions 插槽加「进入命名空间」按钮 → `/ns/:name` | Task 5 |

---

## Task 1: `useNavMode` composable

**Files:**
- Create: `src/composables/useNavMode.js`
- Create: `src/composables/__tests__/useNavMode.test.js`

**Interfaces:**
- Produces: `useNavMode()` → `{ navMode: ComputedRef<'cluster'|'namespace'>, isNsMode: ComputedRef<boolean>, isClusterMode: ComputedRef<boolean> }`。模式判定:`route.meta?.scope === 'namespace'` → `'namespace'`,否则 `'cluster'`(缺 meta 也算集群态)。

- [ ] **Step 1: Write the failing test**

Create `src/composables/__tests__/useNavMode.test.js`:
```js
import { test, expect, vi } from 'vitest'
import { reactive } from 'vue'

// 用 reactive 对象模拟 vue-router 的 useRoute() 返回值(真实 route 也是 reactive),
// 这样 computed 能在跨用例改 meta 时重新求值。
const { routeRef } = vi.hoisted(() => ({
  routeRef: reactive({ meta: { scope: 'global' }, path: '/cluster', params: {} }),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: () => {} }),
}))

import { useNavMode } from '../useNavMode'

test('scope=global → cluster mode', () => {
  routeRef.meta.scope = 'global'
  const { navMode, isNsMode, isClusterMode } = useNavMode()
  expect(navMode.value).toBe('cluster')
  expect(isClusterMode.value).toBe(true)
  expect(isNsMode.value).toBe(false)
})

test('scope=namespace → namespace mode', () => {
  routeRef.meta.scope = 'namespace'
  const { navMode, isNsMode, isClusterMode } = useNavMode()
  expect(navMode.value).toBe('namespace')
  expect(isNsMode.value).toBe(true)
  expect(isClusterMode.value).toBe(false)
})

test('missing scope meta → cluster mode (default)', () => {
  routeRef.meta = {}
  const { navMode, isClusterMode } = useNavMode()
  expect(navMode.value).toBe('cluster')
  expect(isClusterMode.value).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/composables/__tests__/useNavMode.test.js`
Expected: FAIL — `Cannot find module '../useNavMode'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/composables/useNavMode.js`:
```js
import { computed } from 'vue'
import { useRoute } from 'vue-router'

// 模式 = 当前路由的 scope。'namespace' = 下层(ns 内);否则 = 上层(集群态)。
// 单一真相源 = 路由,不依赖 currentNamespace(避免 persist ns 造成模式错位)。
export function useNavMode() {
  const route = useRoute()
  const navMode = computed(() => route.meta?.scope === 'namespace' ? 'namespace' : 'cluster')
  return {
    navMode,
    isNsMode: computed(() => navMode.value === 'namespace'),
    isClusterMode: computed(() => navMode.value === 'cluster'),
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/composables/__tests__/useNavMode.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`(应仍通过;新文件是 .js,`node --check` 覆盖)。
```bash
git add src/composables/useNavMode.js src/composables/__tests__/useNavMode.test.js
git commit -m "feat(nav): useNavMode composable(路由 scope 驱动模式判定)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: i18n 键(`nav.backToCluster` / `nav.enterNamespace`)

**Files:**
- Modify: `src/locales/zh.json`(`nav` 对象,`"logout"` 之后)
- Modify: `src/locales/en.json`(`nav` 对象,`"logout"` 之后)

**Interfaces:**
- Produces: `nav.backToCluster`(zh `返回集群管理` / en `Back to cluster`)、`nav.enterNamespace`(zh `进入命名空间` / en `Enter namespace`)。Task 3/4/5 引用 `$t('nav.backToCluster')`、Task 5 引用 `$t('nav.enterNamespace')`。

- [ ] **Step 1: zh.json 增键**

在 `src/locales/zh.json` 的 `"nav"` 对象内,`"logout": "退出登录"` 这一行之后新增两行(注意逗号):
```json
  "logout": "退出登录",
  "backToCluster": "返回集群管理",
  "enterNamespace": "进入命名空间"
```
(若 `"logout"` 原本是 `nav` 对象的最后一个键、无尾逗号,则把 `"logout"` 行末加逗号再追加两键,最后一键无尾逗号。)

- [ ] **Step 2: en.json 增键**

在 `src/locales/en.json` 的 `"nav"` 对象内,`"logout"` 之后同样追加(英文值):
```json
  "logout": "Logout",
  "backToCluster": "Back to cluster",
  "enterNamespace": "Enter namespace"
```

- [ ] **Step 3: 跑 i18n 门禁**

Run: `npm run i18n:check`
Expected: PASS(0 残留中文、zh/en 键对齐、0 引用键缺失)。若报对齐缺失,补齐另一文件的同名键。

- [ ] **Step 4: typecheck + commit**

Run: `npm run typecheck`。
```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "i18n(nav): +backToCluster +enterNamespace

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: SideNavBar 分组门控(命名空间态隐藏集群组)

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(script 引入 useNavMode;模板分组 v-if 改模式;行号见 Steps)
- Create: `src/components/__tests__/SideNavBar.test.js`

**Interfaces:**
- Consumes: Task 1 `useNavMode()`;Task 2 `nav.*` 键。
- Produces: `SideNavBar` 在 `route.meta.scope='namespace'` 下不渲染集群导航组(整组 `v-if="isClusterMode"` 消失)、渲染 ns 资源组;`scope='global'` 反之。新增 testid:`data-test="ns-nav-section"`、`data-test="cluster-nav-section"`。

- [ ] **Step 1: Write the failing test**

Create `src/components/__tests__/SideNavBar.test.js`:
```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'

const { routeRef, pushMock } = vi.hoisted(() => ({
  routeRef: reactive({ meta: { scope: 'global' }, path: '/cluster', params: {} }),
  pushMock: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    cluster: { name: 'prod-cluster', version: 'v1.28.2' },
    currentNamespace: 'default',
    setNamespace: vi.fn(),
    namespaceList: [],
    fetchNamespaces: vi.fn(),
    currentCluster: 'prod-cluster',
  }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isAdmin: false, init: vi.fn(), user: null }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] }, isFetching: { value: false }, refetch: vi.fn() }),
}))

import SideNavBar from '../layout/SideNavBar.vue'

function mountSideNavBar() {
  return mount(SideNavBar, { global: { plugins: [i18n] } })
}

test('ns mode: 集群导航组隐藏、ns 资源组显示', () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-nav-section"]').exists()).toBe(false)
  expect(w.find('[data-test="ns-nav-section"]').exists()).toBe(true)
})

test('cluster mode: 集群导航组显示、ns 资源组隐藏', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-nav-section"]').exists()).toBe(true)
  expect(w.find('[data-test="ns-nav-section"]').exists()).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: FAIL — 两个 testid 选择器都找不到(模板还没加 `data-test`,且分组仍按 `currentNs` 门控)。

- [ ] **Step 3: 改 SideNavBar script——引入 useNavMode**

`src/components/layout/SideNavBar.vue` script 顶部 import 区(第 1-6 行附近)加:
```js
import { useNavMode } from '@/composables/useNavMode'
```
在 `const authStore = useAuthStore()`(第 11 行)之后加:
```js
const { isNsMode, isClusterMode } = useNavMode()
```

- [ ] **Step 4: 改 ns 资源组门控(第 264 行)**

把:
```html
      <div v-if="currentNs" class="animate-fade-in mb-md">
```
改为:
```html
      <div v-if="isNsMode" data-test="ns-nav-section" class="animate-fade-in mb-md">
```

- [ ] **Step 5: 改集群导航组门控(第 287-293 行)+ 折叠默认展开**

把外层 div(第 287 行):
```html
      <div class="flex flex-col gap-xs">
```
改为:
```html
      <div v-if="isClusterMode" data-test="cluster-nav-section" class="flex flex-col gap-xs">
```
把内层 `v-show`(第 293 行):
```html
        <div v-show="clusterNavOpen || !currentNs" class="flex flex-col gap-xs">
```
改为:
```html
        <div v-show="clusterNavOpen" class="flex flex-col gap-xs">
```
并把 `const clusterNavOpen = ref(false)`(第 51 行)改为 `const clusterNavOpen = ref(true)`(集群态默认展开,保留可折叠)。

- [ ] **Step 6: 改底部 部署/事件 门控(第 332、341 行)**

部署按钮(第 332 行)与事件按钮(第 341 行)的 `v-if="currentNs"` 都改为 `v-if="isNsMode"`。

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 8: typecheck + commit**

Run: `npm run typecheck`。
```bash
git add src/components/layout/SideNavBar.vue src/components/__tests__/SideNavBar.test.js
git commit -m "feat(nav): 命名空间态隐藏集群导航组(路由 scope 门控)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: Cluster Header 命名空间态变「返回集群管理」按钮

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(Cluster Header 块,第 190-198 行)
- Modify: `src/components/__tests__/SideNavBar.test.js`(追加 2 个用例)

**Interfaces:**
- Consumes: Task 3 的 `isNsMode`;Task 2 `nav.backToCluster`。
- Produces: 命名空间态下 Cluster Header 为 `<button data-test="cluster-home">`,点击 → `router.push('/cluster')`;集群态保持静态 `<div>`(无 `cluster-home`)。

- [ ] **Step 1: 追加 failing test**

在 `src/components/__tests__/SideNavBar.test.js` 末尾追加:
```js
test('ns mode: 点 Cluster Header → push /cluster', async () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  pushMock.mockClear()
  const w = mountSideNavBar()
  const home = w.find('[data-test="cluster-home"]')
  expect(home.exists()).toBe(true)
  await home.trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/cluster')
})

test('cluster mode: Header 为静态、无 cluster-home', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-home"]').exists()).toBe(false)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: 新增 2 用例 FAIL(`cluster-home` 找不到)。

- [ ] **Step 3: 改 Cluster Header(第 189-198 行)**

把原静态 Header:
```html
    <!-- Cluster Header -->
    <div class="flex items-center gap-md p-md px-lg shrink-0">
      <div class="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-on-primary">
        <span class="material-symbols-outlined text-lg filled">kubernetes</span>
      </div>
      <div class="min-w-0">
        <h2 class="text-body-md font-bold text-primary leading-tight truncate">{{ store.cluster.name }}</h2>
        <p class="text-body-sm text-on-surface-variant">{{ store.cluster.version }}</p>
      </div>
    </div>
```
替换为(命名空间态=可点击返回按钮;集群态=原静态展示):
```html
    <!-- Cluster Header:命名空间态=返回集群管理入口;集群态=静态展示 -->
    <button
      v-if="isNsMode"
      data-test="cluster-home"
      @click="router.push('/cluster')"
      :title="$t('nav.backToCluster')"
      :aria-label="$t('nav.backToCluster')"
      class="w-full flex items-center gap-sm p-md px-lg shrink-0 hover:bg-surface-container transition-colors text-left"
    >
      <span class="material-symbols-outlined text-on-surface-variant">chevron_left</span>
      <div class="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-on-primary">
        <span class="material-symbols-outlined text-lg filled">kubernetes</span>
      </div>
      <div class="min-w-0">
        <h2 class="text-body-md font-bold text-primary leading-tight truncate">{{ store.cluster.name || 'Cluster' }}</h2>
        <p class="text-body-sm text-on-surface-variant">{{ $t('nav.backToCluster') }}</p>
      </div>
    </button>
    <div v-else class="flex items-center gap-md p-md px-lg shrink-0">
      <div class="w-9 h-9 rounded-lg bg-primary flex items-center justify-center text-on-primary">
        <span class="material-symbols-outlined text-lg filled">kubernetes</span>
      </div>
      <div class="min-w-0">
        <h2 class="text-body-md font-bold text-primary leading-tight truncate">{{ store.cluster.name || 'Cluster' }}</h2>
        <p class="text-body-sm text-on-surface-variant">{{ store.cluster.version }}</p>
      </div>
    </div>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/__tests__/SideNavBar.test.js`
Expected: PASS(4 tests)。

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck`。
```bash
git add src/components/layout/SideNavBar.vue src/components/__tests__/SideNavBar.test.js
git commit -m "feat(nav): Cluster Header 命名空间态变返回集群管理入口

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 5: `/namespaces` 列表「进入命名空间」入口(次要 UX)

> 说明:`Namespaces.vue` 依赖 Vue Query + 分页 + 表格列,mount 整页做单测既重又脆;本任务改动是「一行 `router.push('/ns/:name')` 按钮」,故用 typecheck + 手测验证(push 语义与 Task 4 同源,已被 Task 4 覆盖路由路径正确性)。

**Files:**
- Modify: `src/views/Namespaces.vue`(actions 插槽,第 168-169 行 View 按钮之前)

**Interfaces:**
- Consumes: Task 2 `nav.enterNamespace`。

- [ ] **Step 1: 加「进入命名空间」按钮**

在 `src/views/Namespaces.vue` 的 `<template #actions="{ row }">` 内,现有 View 按钮(`<button @click.stop="router.push(\`/namespaces/${row.name}\`)">`,第 168 行)**之前**插入:
```html
      <button
        @click.stop="router.push(`/ns/${row.name}`)"
        :title="t('nav.enterNamespace')"
        :aria-label="t('nav.enterNamespace')"
        class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-all"
      >
        <span class="material-symbols-outlined text-lg">login</span>
      </button>
```

- [ ] **Step 2: typecheck + i18n 门禁**

Run: `npm run typecheck` && `npm run i18n:check`
Expected: 均 PASS(`nav.enterNamespace` 已由 Task 2 加入,引用键不缺失)。

- [ ] **Step 3: 手测验证**

`npm run dev` 后,集群态进 `/namespaces`,每行 actions 区应多一个 `login` 图标按钮;点击 → 地址栏变 `/ns/<name>` → 侧栏切命名空间态、集群导航组消失、Cluster Header 变返回入口。

- [ ] **Step 4: commit**

```bash
git add src/views/Namespaces.vue
git commit -m "feat(nav): /namespaces 列表加「进入命名空间」入口(→ /ns/:name)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 收尾:全量门禁

全部任务完成后,在 worktree 跑一遍全量门禁确认无回归:
- [ ] `npm run test:unit`(含 Task 1/3/4 新单测,全绿)
- [ ] `npm test`(服务端 + 单测,确保未碰服务端)
- [ ] `npm run typecheck`
- [ ] `npm run i18n:check`
- [ ] `npm run build`(覆盖 .vue 编译)
- [ ] 手测清单(spec §6):① 默认 `/cluster` 集群态;② 选 ns→命名空间态、无集群组、Header 出现 ‹;③ 点 Header→回 `/cluster`;④ ns 态直输 `/nodes`→侧栏切集群态;⑤ 管理员两态均见平台管理、设置/活动记录两态均在。
