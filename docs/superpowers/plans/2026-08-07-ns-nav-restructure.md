# ns 导航栏优化:Workload Overview / Workloads 定位梳理 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重新定位+命名 ns 作用域导航,让"分层拓扑"(ns 默认首页)和"工作负载列表"区别一目了然,Events 退到底部不起眼处。

**Architecture:** `SideNavBar.vue` 移除「概览」组、Workloads 改名「工作负载列表」、Events 移到底部 actions 区、顶部 ns 名可点击回首页(与切 ns 下拉分离);`NamespaceOverview.vue` h1 加"· 分层拓扑";i18n zh/en 同步新增 key。路由结构不变。

**Tech Stack:** Vue 3 `<script setup>` + vue-i18n;验证用 `npm run i18n:check` + `npm run build` + `vitest`(关键交互)+ grep + 手测。

## Global Constraints

- **不改** `src/router/index.js`(路由结构、name、path 全部保持)。
- **不改** `nsRouteMap` 的 routeKey 语义(只调导航显示,不动路由映射)。
- i18n zh/en 必须对齐:`npm run i18n:check` 全绿。
- 其余分组(网络/存储配置/安全/策略;工作负载组的 Pods/HPA)不动。
- 集群级导航(`clusterPrimaryNav` 等)与平台管理区不动。

---

### Task 1: 新增 i18n 命名 key(zh/en)

**Files:**
- Modify: `src/locales/zh.json`(nav 段 ~217-254;ns.namespaceOverview 段)
- Modify: `src/locales/en.json`(同位 key)

**Produces:** `nav.workloadsList`、`nav.events`、`ns.namespaceOverview.topology`(后续任务消费)。

- [ ] **Step 1: zh.json nav 段加 `workloadsList` + `events`**

在 `"workloads": "工作负载",`(zh.json:234)后加两行:
```json
    "workloads": "工作负载",
    "workloadsList": "工作负载列表",
    "events": "事件",
```

- [ ] **Step 2: zh.json ns.namespaceOverview 段加 `topology`**

在 ns.namespaceOverview 段(紧邻 `"relatedIngress": "Ingress",` 之后)加:
```json
      "topology": "分层拓扑",
```

- [ ] **Step 3: en.json 同步三个 key**

en.json nav 段 `"workloads": "Workloads",`(en.json:234)后加:
```json
    "workloads": "Workloads",
    "workloadsList": "Workloads",
    "events": "Events",
```
ns.namespaceOverview 段 `"relatedIngress": "Ingress",` 后加:
```json
      "topology": "Topology",
```

- [ ] **Step 4: 验证 i18n:check**

Run: `npm run i18n:check`
Expected: 残存中文 0 / 键对齐 ✓ / 引用键缺失 0。

- [ ] **Step 5: commit**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "feat(i18n): 新增导航命名 key(workloadsList/events/topology)"
```

---

### Task 2: SideNavBar 移除「概览」组 + Workloads 改名

**Files:**
- Modify: `src/components/layout/SideNavBar.vue:52-69`(nsNavGroups 的概览组 + 工作负载组)

**Consumes:** `nav.workloadsList`(Task 1)。

- [ ] **Step 1: 删除「概览」组**

删除 `nsNavGroups` 数组里的整个概览组对象(SideNavBar.vue:53-60):
```js
  {
    labelKey: 'nav.overview',
    icon: 'grid_view',
    items: [
      { icon: 'dashboard', label: 'Namespace Overview', routeKey: 'overview' },
      { icon: 'notifications_active', label: 'Events', routeKey: 'events' },
    ]
  },
```
(Events 将在 Task 3 移到底部;Namespace Overview 变首页不占导航。)

- [ ] **Step 2: Workloads item 改用 i18n key**

工作负载组里(SideNavBar.vue:65):
```js
      { icon: 'apps', label: 'Workloads', routeKey: 'workloads' },
```
改为:
```js
      { icon: 'apps', labelKey: 'nav.workloadsList', routeKey: 'workloads' },
```

- [ ] **Step 3: 模板渲染兼容 labelKey**

SideNavBar.vue:277 的 item label 渲染当前是 `{{ item.label }}`。改为:
```vue
<span class="text-body-sm">{{ item.labelKey ? $t(item.labelKey) : item.label }}</span>
```
(与组标题 265 行的 labelKey/label 双模式一致。)

- [ ] **Step 4: 验证 build**

Run: `npm run build`
Expected: 编译成功(无 i18n key 缺失报错)。

- [ ] **Step 5: commit**

```bash
git add src/components/layout/SideNavBar.vue
git commit -m "feat(nav): 移除概览组,Workloads 改名工作负载列表"
```

---

### Task 3: Events 移到底部 actions 区

**Files:**
- Modify: `src/components/layout/SideNavBar.vue:326-339`(底部 actions 区)

**Consumes:** `nav.events`(Task 1)、`nsRouteMap.events`(已有,→ NsEvents)、`goNsRoute`(已有)。

- [ ] **Step 1: 底部 actions 区加 Events 链接**

在底部 actions 区(SideNavBar.vue:333 的 Deploy 按钮 `</button>` 之后、Settings `<a>` 之前)插入:
```vue
        <button v-if="currentNs" @click="goNsRoute('events')"
          class="w-full flex items-center justify-center gap-sm py-xs px-md text-body-sm text-on-surface-variant hover:bg-surface-container rounded-lg transition-colors">
          <span class="material-symbols-outlined text-lg">notifications_active</span>
          {{ $t('nav.events') }}
        </button>
```
(与 Deploy 同列、Settings 之上;仅选中 ns 时显示;不起眼但可访问。)

- [ ] **Step 2: 验证 build + grep**

Run: `npm run build`
Expected: 编译成功。
Run: `grep -n "goNsRoute('events')" src/components/layout/SideNavBar.vue`
Expected: 命中底部 actions 区那一行。

- [ ] **Step 3: commit**

```bash
git add src/components/layout/SideNavBar.vue
git commit -m "feat(nav): Events 移到底部 actions 区(不起眼)"
```

---

### Task 4: ns 名点击回首页(与切 ns 下拉分离)

**Files:**
- Modify: `src/components/layout/SideNavBar.vue:213-223`(namespace 选择器按钮)
- Test: `src/components/layout/__tests__/SideNavBar.home.test.js`(新建)

**Consumes:** `currentNs`、`router`(已有)。
**Produces:** 点击 ns 名 → `router.push({ name: 'NamespaceOverview', params: { namespace: currentNs } })`;下拉箭头单独 `showNsDropdown = !showNsDropdown`。

- [ ] **Step 1: 写失败测试**

新建 `src/components/layout/__tests__/SideNavBar.home.test.js`:
```js
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SideNavBar from '../SideNavBar.vue'

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ currentNamespace: 'default', namespaceList: [], cluster: { name: 'c', version: 'v' } }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false }) }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/ns/default/workloads', params: { namespace: 'default' }, name: 'NsWorkloads' }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

describe('SideNavBar ns 名回首页', () => {
  it('点击 ns 名区域 → push NamespaceOverview', async () => {
    const push = vi.fn()
    vi.doMock('vue-router', () => ({ useRoute: () => ({ path: '/ns/default/workloads', params: { namespace: 'default' }, name: 'NsWorkloads' }), useRouter: () => ({ push }) }))
    const { default: SideNavBarFresh } = await import('../SideNavBar.vue')
    const w = mount(SideNavBarFresh, { global: { stubs: { routerLink: true } } })
    // data-test="ns-home" 是 ns 名区域(Step 3 加)
    await w.find('[data-test="ns-home"]').trigger('click')
    expect(push).toHaveBeenCalledWith({ name: 'NamespaceOverview', params: { namespace: 'default' } })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node_modules/.bin/vitest run src/components/layout/__tests__/SideNavBar.home.test.js`
Expected: FAIL(`[data-test="ns-home"]` 不存在)。

- [ ] **Step 3: 改 SideNavBar 按钮为"名+箭头"分离**

SideNavBar.vue:213-223 的 `<button @click="showNsDropdown = !showNsDropdown" ...>` 拆为两部分:ns 名区域(回首页)+ 箭头(开下拉)。
```vue
<div class="flex items-stretch rounded-lg border overflow-hidden transition-all"
  :class="currentNs ? 'border-primary bg-primary/5' : 'border-outline-variant bg-surface-container-low'">
  <button data-test="ns-home" @click="currentNs && router.push({ name: 'NamespaceOverview', params: { namespace: currentNs } })"
    class="flex-1 flex items-center gap-sm min-w-0 px-md py-sm"
    :class="currentNs ? 'text-primary' : 'text-on-surface-variant'">
    <span class="material-symbols-outlined text-lg">folder_open</span>
    <span class="text-body-md font-medium truncate">{{ currentNs || 'Select Namespace' }}</span>
  </button>
  <button @click="showNsDropdown = !showNsDropdown"
    class="px-md py-sm shrink-0 border-l border-current/10"
    :class="currentNs ? 'text-primary' : 'text-on-surface-variant'">
    <span class="material-symbols-outlined text-lg transition-transform" :class="showNsDropdown ? 'rotate-180' : ''">expand_more</span>
  </button>
</div>
```
(原整体 button 的 class 分摊到外层 div + 两个 button;`isGlobalActive` 等不受影响。)

- [ ] **Step 4: 运行测试确认通过**

Run: `node_modules/.bin/vitest run src/components/layout/__tests__/SideNavBar.home.test.js`
Expected: PASS。

- [ ] **Step 5: 验证 build**

Run: `npm run build`
Expected: 编译成功。

- [ ] **Step 6: commit**

```bash
git add src/components/layout/SideNavBar.vue src/components/layout/__tests__/SideNavBar.home.test.js
git commit -m "feat(nav): ns 名点击回拓扑首页,箭头切 ns(分离)"
```

---

### Task 5: NamespaceOverview h1 加"· 分层拓扑"

**Files:**
- Modify: `src/views/NamespaceOverview.vue:185`(h1)

**Consumes:** `ns.namespaceOverview.topology`(Task 1)。

- [ ] **Step 1: 改 h1**

NamespaceOverview.vue:185:
```vue
<h1 class="text-headline-lg font-bold text-on-surface">{{ route.params.namespace }}</h1>
```
改为:
```vue
<h1 class="text-headline-lg font-bold text-on-surface">{{ route.params.namespace }} <span class="text-on-surface-variant font-normal">· {{ t('ns.namespaceOverview.topology') }}</span></h1>
```
(确认 setup 已 `const { t } = useI18n()` 或用 `$t`;若该文件未导入 useI18n,用 `$t('ns.namespaceOverview.topology')` 免改 script。)

- [ ] **Step 2: 验证 build + grep**

Run: `npm run build`
Expected: 编译成功。
Run: `grep -n "namespaceOverview.topology" src/views/NamespaceOverview.vue`
Expected: 命中。

- [ ] **Step 3: commit**

```bash
git add src/views/NamespaceOverview.vue
git commit -m "feat(nav): NamespaceOverview h1 加「分层拓扑」定位"
```

---

### Task 6: 全量验证 + 手测清单

**Files:** 无(仅验证)。

- [ ] **Step 1: i18n:check + build + test:unit 全绿**

Run: `npm run i18n:check && npm run build && npm run test:unit`
Expected: 全部通过。

- [ ] **Step 2: 手测清单(开发者本地 `npm run dev`)**

- [ ] 进入某 ns → 默认显示分层拓扑(NamespaceOverview),h1 为 `{ns} · 分层拓扑`
- [ ] 导航无「概览」组;工作负载组首项显示「工作负载列表」
- [ ] 点侧边栏顶部 ns 名 → 回到分层拓扑首页
- [ ] 点 ns 名右侧箭头 → 展开 namespace 切换下拉(切 ns 正常)
- [ ] 底部 actions 区有「事件」按钮(不起眼),点击 → NsEvents
- [ ] 原有各 ns 子页面(workloads/services/ingress/...)跳转不受影响

- [ ] **Step 3: 收尾 commit(若有手测发现的微调)**

```bash
git add -A
git commit -m "fix(nav): 手测微调"
```

---

## Self-Review 已完成

- **Spec 覆盖**:spec 4 节(导航结构/拓扑首页/回首页/命名)→ Task 2+3 / Task 5 / Task 4 / Task 1,全覆盖。
- **类型/命名一致**:`nav.workloadsList`、`nav.events`、`ns.namespaceOverview.topology` 三个 key 在 Task 1 定义、后续任务引用一致。
- **无占位符**:每个 step 有具体代码/命令。
