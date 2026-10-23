# 顶栏退役 · 导航单源收敛 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 TopNavBar,顶栏 8 项能力全部安置到侧栏/footer/设置页,导航声明收敛到 `src/logic/navConfig.js` 单源。

**Architecture:** 先建新家(navConfig 数据源 → globalSearch 派生 → UserMenu 头像行 / WorkbenchNavItem / SideNavSearch 三个独立组件 → SideNavBar 装配),最后一次性翻转 AppLayout(footer 接管刷新/汉堡/手机告警)并删除 TopNavBar 与 WorkbenchEntryPill。每步全仓测试保持绿。

**Tech Stack:** Vue 3 + Pinia + vue-query + vue-i18n + Tailwind(M3 token);测试 vitest + @vue/test-utils + happy-dom(组件)/ node --test(纯逻辑)。

**Spec:** `docs/superpowers/specs/2026-10-23-topbar-retirement-nav-consolidation-design.md`(执行者须同读)

## Global Constraints

- 依赖政策:零新增外部依赖(CLAUDE.md 依赖表外的依赖一律不引)。
- 提交作者恒为 `aliang-one <aliangdone@gmail.com>`;**禁止** `Co-Authored-By: Claude` 尾注;禁改写已推送历史。
- 开发一律在 worktree 隔离(用户硬约束);Edit 用 worktree 绝对路径。
- i18n:src 禁中文字面量(残留门禁);zh.json / en.json 同步新增;新 HTML 消息必须 v-html 规则不涉及本计划。
- 浮层一律 Teleport body + fixed + `Z.*` 阶梯取值,禁止 absolute z-* 就地面板(会被 overflow 祖先裁切)与裸 `z-[N]`。
- 列向容器里 truncate 元素必须自带 `w-full`(overflow-guard 静态扫全仓 .vue)。
- AppLayout **不做挂载测试**(happy-dom 拖全站,项目惯例=静态源断言);新 AppLayout 测试用 readFileSync 断言源码。
- `npm test` 两条链都必须绿:`npm run test:server`(自研 runner + node --test)与 `npm run test:unit`(vitest)。

## Review Focus

1. **手机抽屉打开时双 AlertBell 双轮询**——footer 铃铛 `v-if="belowSm"` 与侧栏底部行铃铛 `v-if="!belowSm"` 必须互斥;期望:任何时刻全app至多一个 AlertBell 实例。Pinned: Task 7 静态断言 + Task 8 静态断言。
2. **无集群态登出/个人中心不可达**——头像行不得挂在 `noCluster` 门控内;期望:未连集群也能登出。Pinned: Task 7 测试。
3. **⌘K 在 YAML 编辑器/工作台输入框内被抢**——editable target 守卫必须随迁;期望:焦点在 input/textarea/contentEditable 时 ⌘K 不打开搜索。Pinned: Task 6 测试。
4. **搜索关框后仍发请求**——20 类惰性查询 `enabled` 必须随开框/弹层翻转;期望:不开框零请求。Pinned: Task 6 测试。
5. **rail 触屏(iPad 640-1023, hover:none)恒折叠态下搜索/工作台/头像不可达**——三个新段在 rail 折叠态必须保留图标形态入口。Pinned: Task 6 rail 弹层测试 + Task 7 rail 静态断言。

---

### Task 1: navConfig 单源 + i18n 键 + 单测

**Files:**
- Create: `src/logic/navConfig.js`
- Create: `src/logic/navConfig.test.mjs`
- Modify: `package.json`(test:server 链追加 navConfig.test.mjs)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(nav.crossNamespace)

**Interfaces:**
- Consumes: 无(纯数据叶子模块)。
- Produces(Task 2/7 依赖,名字逐字):`CLUSTER_PRIMARY_NAV`、`CLUSTER_CROSS_NS_NAV`、`CLUSTER_RESOURCES_NAV`、`CLUSTER_OTHER_NAV`、`PLATFORM_ADMIN_NAV`、`NS_NAV_GROUPS`、`NS_ROUTE_MAP`、`WORKBENCH_NAV`。导航项形状 `{ icon, labelKey?, label?, route }`;NS_NAV_GROUPS/NS_ROUTE_MAP 形状与 SideNavBar 现内联定义逐字一致。

- [ ] **Step 1: 写失败测试**

```js
// src/logic/navConfig.test.mjs
// 导航单源自卫:①每条 route 尾段必须真实存在于 router/index.js(防手滑路径);
// ②NS_ROUTE_MAP 每个目标路由名存在;③跨 ns 组四条齐全(spec §6 补入口)。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CLUSTER_PRIMARY_NAV, CLUSTER_CROSS_NS_NAV, CLUSTER_RESOURCES_NAV, CLUSTER_OTHER_NAV,
  PLATFORM_ADMIN_NAV, NS_NAV_GROUPS, NS_ROUTE_MAP, WORKBENCH_NAV,
} from './navConfig.js'

const routerSrc = readFileSync(new URL('../router/index.js', import.meta.url), 'utf8')
const ALL_NAV = [
  ...CLUSTER_PRIMARY_NAV, ...CLUSTER_CROSS_NS_NAV, ...CLUSTER_RESOURCES_NAV,
  ...CLUSTER_OTHER_NAV, ...PLATFORM_ADMIN_NAV, WORKBENCH_NAV,
]

test('navConfig:每条 route 尾段在 router 中有 path 声明', () => {
  for (const it of ALL_NAV) {
    const seg = it.route.split('/').filter(Boolean).pop()
    assert.match(routerSrc, new RegExp(`path: '${seg}'`), `route 不存在: ${it.route}`)
  }
})

test('navConfig:NS_ROUTE_MAP 目标路由名全部存在', () => {
  for (const name of Object.values(NS_ROUTE_MAP)) {
    assert.match(routerSrc, new RegExp(`name: '${name}'`), `路由名不存在: ${name}`)
  }
})

test('navConfig:跨 ns 组补齐 4 条无入口页面(spec §6)', () => {
  assert.deepEqual(
    CLUSTER_CROSS_NS_NAV.map(x => x.route).sort(),
    ['/configuration', '/network', '/rbac', '/workloads'],
  )
})

test('navConfig:形状契约(icon+labelKey 或 label+route;ns 组有 items)', () => {
  for (const it of ALL_NAV) {
    assert.ok(it.icon, `缺 icon: ${JSON.stringify(it)}`)
    assert.ok(it.route, `缺 route: ${JSON.stringify(it)}`)
    assert.ok(it.labelKey || it.label, `缺文案键: ${JSON.stringify(it)}`)
  }
  for (const g of NS_NAV_GROUPS) {
    assert.ok(g.labelKey || g.label)
    assert.ok(Array.isArray(g.items) && g.items.length > 0)
  }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/logic/navConfig.test.mjs`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 写 navConfig.js**

内容 = SideNavBar.vue 现内联五组(`clusterPrimaryNav` L87-93、`clusterResourcesNav` L94-105、`clusterOtherNav` L106-108、`platformAdminNav` L110-118、`nsNavGroups` L122-166、`nsRouteMap` L176-193)**逐字迁入**改名,再加跨 ns 组与工作台入口。文件头注释注明 spec 与「纯数据:禁 import Vue/store/i18n,labelKey 渲染期解析」。

```js
// 导航单一事实源(2026-10-23 顶栏退役·导航单源收敛,spec §3:
// docs/superpowers/specs/2026-10-23-topbar-retirement-nav-consolidation-design.md)。
// 侧栏全部导航声明为数据,SideNavBar 只渲染;globalSearch.PAGE_ENTRIES 由此派生。
// 纯数据模块:禁止 import Vue/store/i18n——labelKey 由消费方渲染期经 $t/t 解析。
export const CLUSTER_PRIMARY_NAV = [
  { icon: 'dashboard', labelKey: 'nav.clusterOverview', route: '/cluster' },
  { icon: 'dns', labelKey: 'nav.nodes', route: '/nodes' },
  { icon: 'folder_open', labelKey: 'nav.namespaces', route: '/namespaces' },
  { icon: 'storage', labelKey: 'nav.storage', route: '/storage' },
  { icon: 'monitoring', labelKey: 'nav.monitoring', route: '/monitoring' },
]
// 跨命名空间视图(2026-10-23 补入口:此前仅全局搜索可达,spec §6)
export const CLUSTER_CROSS_NS_NAV = [
  { icon: 'work', labelKey: 'nav.workloads', route: '/workloads' },
  { icon: 'share', labelKey: 'nav.network', route: '/network' },
  { icon: 'tune', labelKey: 'route.configuration', route: '/configuration' },
  { icon: 'security', labelKey: 'route.rbac', route: '/rbac' },
]
export const CLUSTER_RESOURCES_NAV = [
  // …与 SideNavBar 现 clusterResourcesNav 逐字一致(route 改键名):
  { icon: 'extension', labelKey: 'nav.crds', route: '/crds' },
  { icon: 'flag', label: 'PriorityClasses', route: '/priorityclasses' },
  { icon: 'language', label: 'IngressClasses', route: '/ingressclasses' },
  { icon: 'memory', label: 'RuntimeClasses', route: '/runtimeclasses' },
  { icon: 'api', label: 'APIServices', route: '/admin/apiservices' },
  { icon: 'webhook', label: 'Mutating Webhooks', route: '/admin/webhooks-mutating' },
  { icon: 'rule', label: 'Validating Webhooks', route: '/admin/webhooks-validating' },
  { icon: 'dynamic_feed', label: 'ReplicaSets', route: '/admin/replicasets' },
  { icon: 'hard_drive', label: 'CSINodes', route: '/admin/csinodes' },
  { icon: 'verified', labelKey: 'nav.certs', route: '/cluster/certs' },
]
export const CLUSTER_OTHER_NAV = [
  { icon: 'hub', labelKey: 'nav.clusters', route: '/clusters' },
]
export const PLATFORM_ADMIN_NAV = [
  { icon: 'group', labelKey: 'nav.userManagement', route: '/admin/users' },
  { icon: 'admin_panel_settings', labelKey: 'nav.groupsGrants', route: '/admin/groups' },
  { icon: 'cloud', labelKey: 'nav.clusterManagement', route: '/admin/clusters' },
  { icon: 'vpn_key', labelKey: 'nav.apiKeys', route: '/admin/apikeys' },
  { icon: 'tune', labelKey: 'nav.aiBehavior', route: '/admin/ai-behavior' },
  { icon: 'neurology', labelKey: 'nav.llmConfig', route: '/admin/llm-config' },
  { icon: 'shield', labelKey: 'nav.auditTrail', route: '/admin/audit-trail' },
]
// Namespace 作用域导航——与 SideNavBar 现 nsNavGroups 逐字一致(五组:工作负载/网络/
// 存储配置/安全/策略,items 形状 {icon,labelKey?,label?,routeKey})
export const NS_NAV_GROUPS = [ /* ← 逐字迁入,勿改任何 labelKey/label/icon/routeKey */ ]
export const NS_ROUTE_MAP = { /* ← 逐字迁入 16 个映射 */ }
// 工作台模块入口(W 轨,免集群;spec §4.3)
export const WORKBENCH_NAV = { icon: 'workspaces', labelKey: 'nav.workbench', route: '/workbench' }
```

注意:`NS_NAV_GROUPS`/`NS_ROUTE_MAP` 必须从 SideNavBar.vue L122-193 复制实际内容,上面未展开。

- [ ] **Step 4: 加 i18n 键(双语)**

zh.json `nav` 段(字母序放 clusterResources 附近):`"crossNamespace": "跨命名空间"`;
en.json 同位置:`"crossNamespace": "Cross-Namespace"`。
(其余 labelKey 全部已存在;实施时用 `npm run i18n:check` 验证。)

- [ ] **Step 5: 挂进 test:server 链**

package.json `test:server` 中 `node --test src/logic/resourceNavigation.test.mjs src/logic/globalSearch.test.mjs` 追加为 `node --test src/logic/resourceNavigation.test.mjs src/logic/globalSearch.test.mjs src/logic/navConfig.test.mjs`。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test src/logic/navConfig.test.mjs && npm run i18n:check`
Expected: 全 PASS。若 route 尾段断言失败,核对 router/index.js 真实路径(如 `/admin/apiservices` 的声明段),以 router 为准修 navConfig。

- [ ] **Step 7: Commit**

```bash
git add src/logic/navConfig.js src/logic/navConfig.test.mjs package.json src/locales/zh.json src/locales/en.json
git commit -m "feat(nav): navConfig 导航单源数据层——侧栏五组+跨ns补入口+工作台入口,单测钉路由存在性"
```

---

### Task 2: globalSearch.PAGE_ENTRIES 派生化 + admin 门控

**Files:**
- Modify: `src/logic/globalSearch.js:1-44`
- Modify: `src/logic/globalSearch.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `CLUSTER_*_NAV`、`PLATFORM_ADMIN_NAV`、`WORKBENCH_NAV`。
- Produces(Task 6 依赖):`searchAll(rawQuery, items, opts)` 新增 `opts.showAdmin`(默认 false,admin 页面条目仅 showAdmin 时可命中);`PAGE_ENTRIES` 条目新增可选 `admin: true` 标记。`matchPages` 第三参 `opts = { showAdmin = false }`。

- [ ] **Step 1: 写失败测试(globalSearch.test.mjs 追加)**

```js
test('PAGE_ENTRIES 派生:含平台管理 7 页且带 admin 标记', () => {
  const admin = PAGE_ENTRIES.filter(p => p.admin)
  assert.equal(admin.length, 7)
  assert.ok(admin.some(p => p.path === '/admin/llm-config'))
})

test('admin 页面:默认不命中,showAdmin:true 才命中', () => {
  assert.ok(!matchPages('llm').some(p => p.path === '/admin/llm-config'))
  assert.ok(matchPages('llm', {}, { showAdmin: true }).some(p => p.path === '/admin/llm-config'))
})

test('searchAll 透传 showAdmin', () => {
  const { pages } = searchAll('apikeys', [], { showAdmin: true })
  assert.ok(pages.some(p => p.path === '/admin/apikeys'))
})
```

注意:'llm' 是否前缀/包含命中取决于 KEYWORDS——admin 页默认 keywords 空,靠 KEYWORDS 表补 `'llm-config': ['llm', 'llm-config']`;测试以此为准。若实施时用其它关键词,同步改断言(断言的语义=「admin 门控开/关」,关键词可调)。

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/logic/globalSearch.test.mjs`
Expected: 新 3 例 FAIL

- [ ] **Step 3: 改 globalSearch.js 头部(L1-44)**

```js
// 全局搜索纯函数(2026-09-04 自 TopNavBar 抽出;2026-10-23 页面表改由 navConfig 派生,spec §3):
// 页面 path/labelKey/icon 单源自导航,关键词与中文同义词(经参数传入)留本模块。
import {
  CLUSTER_PRIMARY_NAV, CLUSTER_CROSS_NS_NAV, CLUSTER_RESOURCES_NAV, CLUSTER_OTHER_NAV,
  PLATFORM_ADMIN_NAV, WORKBENCH_NAV,
} from './navConfig.js'

// 英文 slug 关键词(承 2026-09-04 旧表逐字);未列出的条目靠 i18n 同义词表命中
const KEYWORDS = {
  '/cluster': ['cluster', 'overview'],
  '/nodes': ['node', 'nodes'],
  '/namespaces': ['namespace', 'namespaces'],
  '/storage': ['storage'],
  '/monitoring': ['monitor', 'monitoring'],
  '/crds': ['crd', 'crds'],
  '/cluster/certs': ['cert', 'certificate', 'tls', 'x509', 'ca'],
  '/clusters': ['clusters', 'multi-cluster'],
  '/workloads': ['workload', 'workloads'],
  '/network': ['network'],
  '/configuration': ['config', 'configuration'],
  '/rbac': ['rbac'],
  '/rbac/can-i': ['can-i', 'cani'],
  '/deploy': ['deploy'],
  '/audit-logs': ['audit', 'activity', 'events'],
  '/settings': ['settings'],
  '/workbench': ['workbench', 'ai'],
  '/admin/users': ['users', 'user-management'],
  '/admin/groups': ['groups', 'grants'],
  '/admin/clusters': ['cluster-management'],
  '/admin/apikeys': ['apikeys', 'api-key'],
  '/admin/ai-behavior': ['ai-behavior'],
  '/admin/llm-config': ['llm', 'llm-config'],
  '/admin/audit-trail': ['audit-trail'],
}

const toPageEntry = it => ({
  path: it.route,
  labelKey: it.labelKey,
  icon: it.icon,
  keywords: KEYWORDS[it.route] || [],
})

// 平台管理页 admin 专属:默认不进匹配(非 admin 使用者搜索不漏 admin 路由),showAdmin 放行
export const PAGE_ENTRIES = [
  ...[...CLUSTER_PRIMARY_NAV, ...CLUSTER_CROSS_NS_NAV, ...CLUSTER_RESOURCES_NAV,
    ...CLUSTER_OTHER_NAV, WORKBENCH_NAV].map(toPageEntry),
  ...PLATFORM_ADMIN_NAV.map(it => ({ ...toPageEntry(it), admin: true })),
  // 固定补充:不走侧栏数据组的功能页(全局工具)
  { path: '/rbac/can-i', labelKey: 'route.canI', icon: 'rule', keywords: KEYWORDS['/rbac/can-i'] },
  { path: '/deploy', labelKey: 'nav.deploy', icon: 'rocket_launch', keywords: KEYWORDS['/deploy'] },
  { path: '/audit-logs', labelKey: 'nav.activityLog', icon: 'history', keywords: KEYWORDS['/audit-logs'] },
  { path: '/settings', labelKey: 'nav.settings', icon: 'settings', keywords: KEYWORDS['/settings'] },
]

export function matchPages(rawQuery, synonyms = {}, opts = {}) {
  const showAdmin = opts.showAdmin === true
  const q = String(rawQuery || '').trim().toLowerCase()
  if (!q) return []
  const scored = []
  for (const p of PAGE_ENTRIES) {
    if (p.admin && !showAdmin) continue
    // ↓ 以下与原实现逐字一致(同义词键兼容/前缀优先排序)
    const pk = pathKey(p.path)
    const zhText = synonyms[pk] ?? synonyms[pk.split('/').pop()] ?? ''
    const pool = [...p.keywords, ...String(zhText).split(',').filter(Boolean)]
    const prefix = pool.some(k => k.toLowerCase().startsWith(q))
    const includes = pool.some(k => k.toLowerCase().includes(q))
    if (prefix || includes) scored.push({ p, prefix })
  }
  return scored.sort((a, b) => Number(b.prefix) - Number(a.prefix)).map(x => p => x.p) // ← 注意:此处保持原实现 `.map(x => x.p)`,勿照抄本行注释上方的笔误
}
```

⚠️ 实施注意:`matchPages` 返回行保持原样 `.map(x => x.p)`;`pathKey` 保留原定义。`searchAll` 改一行:`const pages = matchPages(rawQuery, synonyms, { showAdmin: opts.showAdmin === true }).slice(0, 4)`。

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/logic/globalSearch.test.mjs src/logic/navConfig.test.mjs`
Expected: 全 PASS(旧例不变绿:matchPages 两参调用兼容)。

- [ ] **Step 5: Commit**

```bash
git add src/logic/globalSearch.js src/logic/globalSearch.test.mjs
git commit -m "feat(search): 搜索页面表改 navConfig 派生——补平台管理 7 页,admin 条目 showAdmin 门控"
```

---

### Task 3: SearchResults 加 docked 形态(Teleport 宿主用)

**Files:**
- Modify: `src/components/layout/SearchResults.vue`
- Test: `src/components/layout/__tests__/SearchResults.test.js`(追加 1 例)

**Interfaces:**
- Consumes: 无。
- Produces(Task 5/6 依赖):`<SearchResults :results="..." :docked="true" @select="...">` — docked=true 时根节点为**文档流内**面板(`w-full` 起头,无 absolute/top-full/mt-1/z-50),供 Teleport 面板内嵌;默认 false 行为逐字不变(TopNavBar 退役前仍用默认形态)。

- [ ] **Step 1: 写失败测试(在现有 SearchResults.test.js 追加)**

```js
test('docked 形态:根节点为文档流面板,无 absolute/z-50 定位类', () => {
  const w = mount(SearchResults, { props: { results: [{ page: true, path: '/x', labelKey: 'nav.settings', icon: 'settings' }], docked: true } })
  const cls = w.find('[data-test="search-row"]').element.parentElement.className
  expect(cls).not.toContain('absolute')
  expect(cls).not.toContain('z-50')
  expect(cls).toContain('w-full')
})
```

(以现有测试文件的 mount 方式与既有 mock 为准;若该文件已有 results 工厂函数则复用。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/SearchResults.test.js`
Expected: 新例 FAIL(现根类含 absolute)

- [ ] **Step 3: 改 SearchResults.vue**

props 加 `docked: { type: Boolean, default: false }`;根节点 class 改三元:

```
:class="docked
  ? 'w-full bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-y-auto max-h-96'
  : 'absolute top-full left-0 mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown z-50 overflow-y-auto max-h-96'"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/SearchResults.test.js`
Expected: PASS(旧例零变化)

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/SearchResults.vue src/components/layout/__tests__/SearchResults.test.js
git commit -m "feat(search): SearchResults 加 docked 文档流形态——供侧栏 Teleport 面板内嵌,默认形态不变"
```

---

### Task 4: UserMenu 重写为侧栏头像行

**Files:**
- Modify: `src/components/layout/UserMenu.vue`(整文件重写)
- Modify: `src/components/layout/__tests__/UserMenu.test.js`

**Interfaces:**
- Consumes: `useDropdownPanel(triggerRef, open, { matchTriggerWidth: true })`(已有向上翻转);`useAvatar` 单例;ConfirmDialog。
- Produces(Task 7 依赖):默认导出 UserMenu;data-testid 保留 `user-menu-trigger` / `user-menu-dropdown` / `user-menu-profile` / `user-menu-logout` / `user-menu-role` / `user-avatar-img` / `user-avatar-fallback`(触发钮头像);菜单头头像用新 testid `user-menu-avatar` / `user-menu-avatar-fallback`。**主题/语言快捷切换删除**(data-testid user-menu-theme-* / user-menu-lang-* 消失)。

- [ ] **Step 1: 改写测试(先改测试=失败态)**

保留用例(断言改 Teleport 查询):开合切换、profile push /profile、登出 ConfirmDialog 确认流、取消流、角色三态、头像 img/fallback。删除:主题三态、语言两态、主题点击、语言点击 4 例。新增:

```js
test('菜单经 Teleport 渲染在 body(侧栏 overflow-hidden 裁切防线)', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(false) // 组件树内不可见
  expect(document.body.querySelector('[data-testid="user-menu-dropdown"]')).toBeTruthy()
  w.unmount()
})

test('主题/语言快捷切换已退役(归设置页)', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(document.body.querySelector('[data-testid="user-menu-theme-dark"]')).toBeNull()
  expect(document.body.querySelector('[data-testid="user-menu-lang-en"]')).toBeNull()
  w.unmount()
})
```

`mountMenu` 中 dropdown 相关断言全部从 `w.find(...)` 换成 `document.body.querySelector(...)`;`mount` 仍需 `attachTo: document.body`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/UserMenu.test.js`
Expected: FAIL(现实现无 Teleport、有主题语言)

- [ ] **Step 3: 重写 UserMenu.vue**

script:去掉 `usePreferencesStore`/themeOptions/langOptions/activeTheme/activeLang;加 `useDropdownPanel`;`rowRef` 替代 rootEl(触发钮 ref,菜单锚定);`onDocClick` 外点关闭保留(判 `!e.target.closest?.('[data-testid="user-menu-trigger"], [data-testid="user-menu-dropdown"]')`);登出流(doLogout 停双 watch + authStore.logout + push /login)逐字保留;`roleLabel` 逐字保留。菜单定位:

```js
const rowRef = ref(null)
const { panelRef, panelStyle } = useDropdownPanel(rowRef, open, { matchTriggerWidth: true })
```

template 骨架:

```html
<template>
  <div class="shrink-0">
    <button ref="rowRef" data-testid="user-menu-trigger" @click="toggle"
      class="w-full flex items-center gap-sm px-md py-sm text-left transition-colors"
      :class="open ? 'bg-surface-container' : 'hover:bg-surface-container'"
      :aria-label="$t('nav.userCenter')" :aria-expanded="open ? 'true' : 'false'" aria-haspopup="true">
      <img v-if="avatarDataUrl" :src="avatarDataUrl" data-testid="user-avatar-img" alt="avatar" class="w-7 h-7 rounded-full object-cover shrink-0" />
      <div v-else data-testid="user-avatar-fallback" class="w-7 h-7 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-body-sm font-bold shrink-0">{{ initial }}</div>
      <div class="min-w-0 flex-1 sb-user-txt">
        <span class="block w-full text-body-sm font-semibold truncate">{{ displayName }}</span>
        <span v-if="roleLabel" data-testid="user-menu-role" class="block w-full text-[10px] text-on-surface-variant truncate">{{ roleLabel }}</span>
      </div>
      <span class="material-symbols-outlined text-on-surface-variant text-body-sm transition-transform sb-user-txt" :class="open ? 'rotate-180' : ''">expand_more</span>
    </button>

    <Teleport to="body">
      <div v-if="open" ref="panelRef" data-testid="user-menu-dropdown"
        class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-hidden" :style="panelStyle">
        <!-- 用户信息头(头像用独立 testid,与触发钮区分) -->
        <div class="flex items-center gap-sm px-md py-md border-b border-outline-variant">
          <img v-if="avatarDataUrl" :src="avatarDataUrl" data-testid="user-menu-avatar" alt="avatar" class="w-10 h-10 rounded-full object-cover shrink-0" />
          <div v-else data-testid="user-menu-avatar-fallback" class="w-10 h-10 rounded-full bg-primary-container flex items-center justify-center text-on-primary-container text-headline-sm font-bold shrink-0">{{ initial }}</div>
          <div class="min-w-0">
            <p class="text-body-md font-semibold truncate">{{ displayName }}</p>
            <p class="text-body-xs text-on-surface-variant truncate font-mono">{{ authStore.user?.username }}</p>
          </div>
        </div>
        <button data-testid="user-menu-profile" class="flex items-center gap-sm w-full px-md py-sm text-left hover:bg-surface-container transition-colors" @click="goProfile">
          <span class="material-symbols-outlined text-lg text-on-surface-variant">person</span>
          <span class="text-body-md">{{ $t('nav.userCenter') }}</span>
        </button>
        <div class="border-t border-outline-variant"></div>
        <button data-testid="user-menu-logout" class="flex items-center gap-sm w-full px-md py-sm text-left text-error hover:bg-error/10 transition-colors" @click="askLogout">
          <span class="material-symbols-outlined text-lg">logout</span>
          <span class="text-body-md">{{ $t('nav.logout') }}</span>
        </button>
      </div>
    </Teleport>

    <ConfirmDialog v-model="showLogoutConfirm" :title="$t('userCenter.logoutConfirmTitle')"
      :message="$t('userCenter.logoutConfirmMessage')" :confirm-text="$t('nav.logout')" danger @confirm="doLogout" />
  </div>
</template>
```

外点关闭:`onDocClick` 挂 document(沿用旧实现,closest 判定更新为上述两个 testid)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/UserMenu.test.js`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/UserMenu.vue src/components/layout/__tests__/UserMenu.test.js
git commit -m "feat(nav): UserMenu 重写为侧栏头像行——Teleport 向上菜单,主题/语言快捷切换退役归设置页"
```

---

### Task 5: WorkbenchNavItem(承 WorkbenchEntryPill 逻辑)

**Files:**
- Create: `src/components/layout/WorkbenchNavItem.vue`
- Create: `src/components/layout/__tests__/WorkbenchNavItem.test.js`
- (WorkbenchEntryPill.vue 本任务不删——TopNavBar 仍引用;Task 8 删)

**Interfaces:**
- Consumes: `workbenchApi.summary` / `getPlatformToken`(原 pill 数据链逐字);`useDropdownPanel(rowRef, panelOpen)`(面板定位,替代原手写 placePanel——原 placePanel 的右缘钳制该 composable 已含,行为等价)。
- Produces(Task 7 依赖):默认导出 WorkbenchNavItem;data-test `wb-nav-item`(行)/ `wb-panel`(悬停面板)/ `panel-project`;行根 class 含 `nav-item`(继承 rail 折叠样式)与 `nav-item__label`。

- [ ] **Step 1: 写失败测试**

以 `WorkbenchEntryPill.test.js` 为底本复制改 3 处:① import 换 WorkbenchNavItem;② 挂载后选择器 `data-test="wb-nav-item"`;③ 契约断言改为行形态:

```js
test('行契约:nav-item 类 + 激活态 primary-container + 瓷砖 workspaces', async () => {
  mocks.summary.mockReturnValue(new Promise(() => {}))
  const w = mountItem(); await flushPromises()
  const row = w.find('[data-test="wb-nav-item"]')
  expect(row.attributes('aria-label')).toBe('工作台')
  expect(row.classes()).toContain('nav-item')
  expect(row.classes()).not.toContain('bg-primary-container')   // 非激活
  expect(row.find('.material-symbols-outlined').text()).toBe('workspaces')
  mocks.path = '/workbench'
  const w2 = mountItem(); await flushPromises()
  expect(w2.find('[data-test="wb-nav-item"]').classes()).toContain('bg-primary-container')
  w.unmount(); w2.unmount()
})

test('待审批红数角标:pendingApprovals>0 显示数字', async () => {
  mocks.summary.mockResolvedValue(SUMMARY({ totals: { projects: 1, runningConvs: 0, pendingApprovals: 3, sshSessions: 0 } }))
  const w = mountItem(); await flushPromises()
  expect(w.find('[data-test="wb-nav-pending"]').text()).toBe('3')
  w.unmount()
})

test('悬停面板:项目行点击跳 /workbench/p1(≥lg)', async () => {
  vi.useFakeTimers()
  mocks.summary.mockResolvedValue(SUMMARY())
  const w = mountItem(); await flushPromises()
  await w.find('[data-test="wb-nav-item"]').trigger('mouseenter')
  vi.advanceTimersByTime(200)
  const panel = document.body.querySelector('[data-test="wb-panel"]')
  expect(panel).toBeTruthy()
  panel.querySelector('[data-test="panel-project"]').click()
  await vi.runOnlyPendingTimersAsync()
  expect(mocks.push).toHaveBeenCalledWith('/workbench/p1')
  vi.useRealTimers()
  w.unmount()
})
```

(手机档禁开面板一例沿用底本 mockViewport 写法:`mockViewport(true)` 后 mouseenter 不出面板。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/WorkbenchNavItem.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 3: 写 WorkbenchNavItem.vue**

复制 WorkbenchEntryPill.vue 全量,做以下**精确手术**(其余逐字保留:summary 查询 30s/keepPreviousData/retry、relTime、openPanel/scheduleClose/holdPanel/closeNow/onDocClick/onKey、面板模板汇总 chips/项目行/快捷动作/stale 细字):

1. 头注释改:「工作台侧栏入口行(2026-10-23 自顶栏 WorkbenchEntryPill 迁入,spec §4.3):行形态入侧栏滚动导航,悬停面板原样保留(≥lg、非触屏)。」
2. 行模板替换(替换原 `<button @click="router.push('/workbench')" ...>...</button>` 整块):

```html
<a data-test="wb-nav-item" role="button" tabindex="0"
  @click="router.push('/workbench')" @keydown.enter.prevent="router.push('/workbench')"
  @mouseenter="openPanel" @mouseleave="scheduleClose"
  :aria-label="$t('nav.workbench')" :title="isPhone ? $t('nav.workbench') : summaryText"
  class="nav-item flex items-center gap-md px-md py-sm rounded-lg cursor-pointer transition-all duration-200"
  :class="isWorkbenchActive
    ? 'bg-primary-container text-on-primary-container font-semibold'
    : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
  <span class="relative inline-flex shrink-0">
    <span data-test="wb-nav-tile"
      class="relative inline-flex h-[26px] w-[26px] items-center justify-center overflow-hidden rounded-lg bg-gradient-to-br from-primary to-primary-container shadow-[0_1px_3px_rgb(0_0_0/0.25),inset_0_1px_0_rgb(255_255_255/0.35)] transition-transform duration-300 motion-reduce:transition-none"
      :class="isWorkbenchActive ? 'scale-105' : ''">
      <span class="material-symbols-outlined text-base text-on-primary">workspaces</span>
      <span v-if="isWorkbenchActive" data-test="wb-nav-sheen" aria-hidden="true"
        class="absolute inset-0 rounded-lg bg-no-repeat bg-gradient-to-r from-transparent via-white/45 to-transparent bg-[length:200%_100%] animate-sheen motion-reduce:hidden"></span>
    </span>
  </span>
  <span class="text-body-sm nav-item__label flex-1 min-w-0 truncate">{{ $t('nav.workbench') }}</span>
  <span v-if="pendingCount > 0" data-test="wb-nav-pending"
    class="min-w-[18px] h-[18px] px-1 inline-flex items-center justify-center rounded-full bg-error text-on-error text-body-xs font-bold leading-none shrink-0">{{ pendingCount }}</span>
</a>
```

3. `btnRef` 改名 `rowRef` 并锚到行元素;`placePanel` 整函数删除,改 `const { panelRef, panelStyle } = useDropdownPanel(rowRef, panelOpen)`(panelOpen 即原 panelOpen;PANEL_W 常量删除);Teleport 面板宽度类改 `w-[340px] max-w-[calc(100vw-16px)]`(原来内联 width 由 placePanel 给,现由类给)。
4. 删除:stats 条(`pill-stats`)、状态徽章三枚(`pill-pending/running/projects`)、手机红点(`pill-pending-dot`,角标已全断点通用)、`pill-hoverfill`、`isPhone` 的 min-h 命中区补丁——`isPhone` 仅保留「禁开面板」守卫。
5. onDocClick 的 closest 选择器 `[data-test="wb-pill"]` 改 `[data-test="wb-nav-item"]`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/WorkbenchNavItem.test.js`
Expected: 全 PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/WorkbenchNavItem.vue src/components/layout/__tests__/WorkbenchNavItem.test.js
git commit -m "feat(nav): WorkbenchNavItem 工作台侧栏入口行——承胶囊 summary/悬停面板,行形态+激活态"
```

---

### Task 6: SideNavSearch(搜索宿主,三态自适应)

**Files:**
- Create: `src/components/layout/SideNavSearch.vue`
- Create: `src/components/layout/__tests__/SideNavSearch.test.js`

**Interfaces:**
- Consumes: Task 2 `searchAll(…, { showAdmin })`;Task 3 `SearchResults :docked`;`useDropdownPanel`;`useResourceList`;`searchPageSynonyms` 提取逻辑(自 TopNavBar L23-38 逐字迁)。
- Produces(Task 7 依赖):默认导出 SideNavSearch;外层 `data-test="sidenav-search"`;桌面内联输入 `data-test="search-input"`;rail 图标钮 `data-test="search-trigger"`;rail 弹层 `data-test="search-modal"`;⌘K 行为=桌面聚焦内联框、rail 开弹层、手机 no-op。

- [ ] **Step 1: 写失败测试**

```js
// SideNavSearch.test.js(关键用例;mount 需要 pinia + i18n + VueQueryPlugin,mock 集群 store)
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { readFileSync } from 'node:fs'

const mocks = vi.hoisted(() => ({ push: vi.fn(), useResourceList: vi.fn() }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: mocks.push }), useRoute: () => ({ path: '/cluster', fullPath: '/cluster' }) }))
vi.mock('@/composables/useK8sQuery', () => ({ useResourceList: mocks.useResourceList }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo', cluster: { name: 't', version: 'v1' },
    nodeList: [], namespaceList: [], fetchNamespaces: vi.fn(),
    fetchPods: vi.fn(), fetchWorkloads: vi.fn(), fetchServices: vi.fn(), fetchIngresses: vi.fn(),
    fetchConfigMaps: vi.fn(), fetchSecrets: vi.fn(), fetchPVCs: vi.fn(), fetchHPAs: vi.fn(),
    fetchRoles: vi.fn(), fetchRoleBindings: vi.fn(), fetchClusterRoleBindings: vi.fn(),
    fetchServiceAccounts: vi.fn(), fetchNetworkPolicies: vi.fn(), fetchResourceQuotas: vi.fn(),
    fetchLimitRanges: vi.fn(), fetchPDBs: vi.fn(), fetchStorageClasses: vi.fn(),
    fetchPVs: vi.fn(), fetchCRDs: vi.fn(), fetchEvents: vi.fn(),
  }),
}))
vi.mock('@/api/client', async (importOriginal) => {
  const orig = await importOriginal()
  return { ...orig, getSession: () => 'sess' }
})

import SideNavSearch from '../SideNavSearch.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: JSON.parse(readFileSync('./src/locales/zh.json', 'utf8')) } })
// 双断点 mock(rail=belowLg && !belowSm;desktop=两者皆 false)
const mockBp = (belowLg, belowSm) => vi.spyOn(window, 'matchMedia').mockImplementation(q => ({
  matches: q === '(max-width: 1023.98px)' ? belowLg : q === '(max-width: 639.98px)' ? belowSm : false,
  addEventListener: () => {}, removeEventListener: () => {},
}))

beforeEach(() => {
  setActivePinia(createPinia())
  document.body.innerHTML = ''
  mocks.push.mockReset()
  // enabled 以 ref 形态被消费,记录每次调用
  mocks.useResourceList.mockImplementation(({ options }) => {
    return { data: { value: [] }, __enabled: options?.enabled }
  })
})

test('桌面:开框才 enabled,关框零请求(Review Focus 4)', async () => {
  mockBp(false, false)
  const w = mount(SideNavSearch, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient() }]] } })
  const enabledOf = () => mocks.useResourceList.mock.calls.map(c => c[0].options?.enabled).filter(Boolean)
  expect(enabledOf().every(e => e === false || e.value === false)).toBe(true) // namespaces 常驻除外
  await w.find('[data-test="search-input"]').trigger('focus')
  // 惰性组 enabled 全部翻转 true(实现细节:同一 computed 引用)
  const lazy = mocks.useResourceList.mock.calls.filter(c => c[0].key?.[2] !== 'namespaces')
  expect(lazy.length).toBeGreaterThanOrEqual(20)
  w.unmount()
})
```

(断言写法以实现后 `enabled` 的真实形态微调:关键是「focus 前惰性组 enabled 为 false」。namespaces 常驻组 `enabled: nsEnabled` 恒 true,断言时排除。)

再写 3 例:

```js
test('⌘K 桌面:聚焦内联输入框', async () => {
  mockBp(false, false)
  const w = mount(...)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  expect(document.activeElement).toBe(w.find('[data-test="search-input"]').element)
  w.unmount()
})

test('⌘K rail:打开弹层', async () => {
  mockBp(true, false)
  const w = mount(...)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
  expect(document.body.querySelector('[data-test="search-modal"]')).toBeTruthy()
  w.unmount()
})

test('⌘K 焦点在 textarea 内不抢(Review Focus 3)', async () => {
  mockBp(false, false)
  const w = mount(...)
  const ta = document.createElement('textarea')
  document.body.appendChild(ta)
  ta.focus()
  ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
  expect(document.activeElement).toBe(ta)   // 焦点未被夺走
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/SideNavSearch.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 3: 写 SideNavSearch.vue**

自 TopNavBar.vue **逐字迁入**以下段(保持函数名):`asText`/`pageSynonyms`(L23-38)、`cid`/`searchEnabled`(L46-55)、⌘K `onGlobalKeydown`(L61-74,焦点目标改 `inputRef.value?.focus()`)、`LAZY_KINDS`/`lazyQ`(L76-88)、`nsQ`/`allNamespaces`(L89-93)、`buildItems`/`searchResults`/`goResult`/`onSearchKeydown`(L130-178);新增:

```js
import { useAuthStore } from '@/stores/auth'
import { useDropdownPanel } from '@/composables/useDropdownPanel'
const auth = useAuthStore()
const { matches: belowLg } = useBreakpoint(MQ_BELOW_LG)
const { matches: belowSm } = useBreakpoint(MQ_BELOW_SM)
// 模式:desktop=内联+Teleport 下拉;rail=图标+弹层;drawer=抽屉内联+贴底 sheet
const mode = computed(() => belowSm.value ? 'drawer' : (belowLg.value ? 'rail' : 'desktop'))
const isDesktop = computed(() => mode.value === 'desktop')
const inputRef = ref(null)
const { panelRef, panelStyle } = useDropdownPanel(inputRef, resultsOpen, { matchTriggerWidth: true })
// resultsOpen:有结果才开面板(TopNavBar 语义:面板随结果显隐,blur 不清查询)
const resultsOpen = computed(() => isDesktop.value && searchResults.value.length > 0)
// admin 页面条目仅 admin 可搜(Task 2 门控)
const filtered = computed(() => searchAll(q, items, { synonyms: pageSynonyms.value, showAdmin: auth.isAdmin }))
// 路由切换收起残留结果(TopNavBar 无此守卫,迁入侧栏后补)
watch(() => route.fullPath, () => { searchQuery.value = ''; searchModalOpen.value = false })
```

`searchAll` 调用处把 `showAdmin: auth.isAdmin` 并入 opts(searchResults 内部改)。模板骨架:

```html
<template>
  <div data-test="sidenav-search" class="px-md pt-md pb-sm shrink-0">
    <!-- desktop / drawer:内联框 -->
    <div v-if="mode !== 'rail'" class="relative">
      <span class="material-symbols-outlined absolute left-2.5 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm pointer-events-none z-10">search</span>
      <input ref="inputRef" data-test="search-input" v-model="searchQuery"
        @keydown="onSearchKeydown" @focus="searchOpen = true" @blur="searchOpen = false"
        class="w-full bg-surface-container-low border border-outline-variant rounded-full py-1.5 pl-8 pr-md text-body-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
        :placeholder="$t('nav.searchPlaceholder')" :aria-label="$t('common.search')" type="text" />
      <kbd v-if="isDesktop" data-test="search-kbd" aria-hidden="true" class="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] leading-none text-on-surface-variant border border-outline-variant rounded px-1.5 py-1 pointer-events-none">⌘K</kbd>
    </div>
    <!-- rail:图标钮开弹层 -->
    <button v-else data-test="search-trigger" @click="openSearchModal"
      class="w-full flex items-center justify-center p-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-colors"
      :aria-label="$t('common.search')">
      <span class="material-symbols-outlined">search</span>
    </button>

    <!-- desktop 结果:Teleport 锚定下拉(docked 列表内嵌) -->
    <Teleport to="body">
      <div v-if="resultsOpen" ref="panelRef" data-test="search-dropdown"
        class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-hidden" :style="panelStyle">
        <SearchResults :results="searchResults" :docked="true" @select="goResult" />
      </div>
    </Teleport>

    <!-- rail 弹层(承 TopNavBar search-modal 逐字:遮罩+顶部居中+autofocus) -->
    <Teleport to="body">
      <div v-if="searchModalOpen" data-test="search-modal" class="fixed inset-0" :style="{ zIndex: Z.popover }">
        <div class="absolute inset-0 bg-black/30" @click="closeSearchModal"></div>
        <div class="absolute left-1/2 -translate-x-1/2 top-16 w-[min(92vw,480px)]">
          <div class="relative">
            <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none z-10">search</span>
            <input ref="searchModalInput" data-test="search-modal-input" v-model="searchQuery" @keydown="onSearchKeydown"
              class="w-full bg-surface-container-low border border-outline-variant rounded-full py-2.5 pl-10 pr-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary shadow-dropdown"
              :placeholder="$t('nav.searchPlaceholder')" :aria-label="$t('common.search')" type="text" />
            <SearchResults :results="searchResults" :docked="true" @select="goResult" />
          </div>
        </div>
      </div>
    </Teleport>

    <!-- drawer 贴底 sheet(手机;承 TopNavBar ns bottom sheet 配方) -->
    <Teleport to="body">
      <div v-if="mode === 'drawer' && searchResults.length" data-test="search-sheet"
        class="fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[70vh] overflow-y-auto bg-surface-container-lowest border border-outline-variant max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+12px)]"
        :style="{ zIndex: Z.popover }">
        <SearchResults :results="searchResults" :docked="true" @select="goResult" />
      </div>
      <div v-if="mode === 'drawer' && searchResults.length" class="fixed inset-0"
        :style="{ zIndex: String(Z.popover - 1) }" @click="searchQuery = ''"></div>
    </Teleport>
  </div>
</template>
```

`openSearchModal`/`closeSearchModal`/`searchModalInput` autofocus(nextTick focus)自 TopNavBar L56-60 逐字。**删除不迁**:refresh/身份舱/ns 下拉/汉堡/胶囊(顶栏独有,随顶栏退役)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/SideNavSearch.test.js`
Expected: 全 PASS(断言与实现的 enabled/面板形态细节互相校准后全绿)

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/SideNavSearch.vue src/components/layout/__tests__/SideNavSearch.test.js
git commit -m "feat(search): SideNavSearch 搜索宿主——桌面Teleport下拉/rail弹层/抽屉贴底sheet三态,⌘K+惰性查询+admin门控随迁"
```

---

### Task 7: SideNavBar 装配(消费 navConfig + 四新段 + AlertBell tile 形态)

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(script 数据源替换 + template 四段插入 + rail CSS 两块扩展)
- Modify: `src/components/layout/AlertBell.vue`(加 `tile` prop)
- Modify: `src/components/layout/__tests__/AlertBell.test.js`(tile 1 例)
- Test: `src/components/layout/__tests__/SideNavBar.shell-extensions.test.js`(新)

**Interfaces:**
- Consumes: Task 1 navConfig 全部导出;Task 4 UserMenu;Task 5 WorkbenchNavItem;Task 6 SideNavSearch。
- Produces: data-test `sidenav-user-row`(头像行区)/ `wb-nav-seg`(工作台段容器);dock 告警颗 `data-test="bottom-alerts"`;集群态底部行告警 `data-test="bottom-alerts-row"` 且 `v-if="!belowSm"`(Review Focus 1)。

- [ ] **Step 1: 写失败测试(SideNavBar.shell-extensions.test.js)**

以 `SideNavBar.bottom-row.test.js` 的 mock 骨架为底本(集群 store/auth/useK8sQuery/vue-router mock + sessionStorage 会话),文件头补 `import { readFileSync } from 'node:fs'`;补 `useResourceList` mock 兼容 SideNavSearch 的 `{ key, fetcher, options }` 入参(现 mock `() => ({ data: { value: [] } })` 已兼容)。

```js
// 无集群态:头像行恒显(登出可达,Review Focus 2);工作台段恒显
test('无集群态:头像行+工作台段仍在,集群域控件隐藏', () => {
  sessionStorage.removeItem('aliangboard.session')
  currentNs = ''
  const w = mountIt()
  expect(w.find('[data-testid="user-menu-trigger"]').exists()).toBe(true)
  expect(w.find('[data-test="wb-nav-item"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-settings"]').exists()).toBe(false) // 底部行仍门控
  w.unmount()
})

test('工作台段:点击跳 /workbench', async () => {
  currentNs = ''
  const w = mountIt()
  await w.find('[data-test="wb-nav-item"]').trigger('click')
  expect(pushSpy).toHaveBeenCalledWith('/workbench')
  w.unmount()
})

test('集群态底部行:活动/告警/设置三颗在场;告警颗源码级 belowSm 互斥(RF1)', () => {
  currentNs = ''
  const w = mountIt()
  expect(w.find('[data-test="bottom-activity"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-alerts-row"]').exists()).toBe(true)
  // 互斥钉在源码:侧栏告警颗 !belowSm(手机抽屉内不渲染),footer 侧 v-if="belowSm"(Task 8)
  const src = readFileSync('./src/components/layout/SideNavBar.vue', 'utf8')
  expect(src).toMatch(/v-if="!belowSm"[\s\S]{0,120}<AlertBell/)
  w.unmount()
})

test('ns 态 dock:告警瓦片在场(bottom-alerts,tile 形态)', () => {
  currentNs = 'default'
  const w = mountIt()
  expect(w.find('[data-test="bottom-alerts"]').exists()).toBe(true)
  expect(w.find('[data-test="bottom-alerts"]').classes()).toContain('dock-ig')
  w.unmount()
})

test('搜索段/头像行/工作台段的 rail 折叠可达性(RF5,静态类断言)', () => {
  currentNs = ''
  const w = mountIt()
  expect(w.find('[data-test="sidenav-search"]').exists()).toBe(true)
  // 头像行文本容器挂 sb-user-txt(rail 折叠隐藏,头像图标保留)
  expect(w.find('.sb-user-txt').exists()).toBe(true)
  w.unmount()
})
```

(`max-sm:hidden` 即 `!belowSm` 的纯 CSS 等价——手机档 Tailwind 断点类实现互斥,**不需要 JS breakpoint**,比 v-if 更稳:SSR/测试环境无 matchMedia 依赖。告警颗实现须用 `class="max-sm:hidden"` 而非 v-if;footer 侧用 `max-lg:hidden` 反向?——footer 汉堡/铃铛是 `belowSm` v-if(AppLayout 已持有 belowSm),两处语义一致:任何视口下两侧至多渲染一个。此测试钉侧栏侧。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.shell-extensions.test.js`
Expected: FAIL(段未装配)

- [ ] **Step 3: AlertBell 加 tile prop**

```js
const props = defineProps({
  tile: { type: Boolean, default: false },  // true=图标包进 dock-ig__sq 瓦片(dock 网格用)
})
```

模板图标 `<span class="material-symbols-outlined">notifications</span>` 包一层(红点 span 留在 button 根,绝对定位不受影响):

```html
<span v-if="tile" class="dock-ig__sq">
  <span class="material-symbols-outlined">notifications</span>
</span>
<span v-else class="material-symbols-outlined">notifications</span>
```

(根 button 一律不加 dock-ig——由消费方外层 div 承载,避免 data-test 双根合并歧义。)AlertBell.test.js 追加:

```js
test('tile 形态:图标包 dock-ig__sq;默认形态不变', () => {
  const w = mount(AlertBell, { props: { tile: true }, /* 沿用该文件现有 global 插件 */ })
  expect(w.find('[data-test="alert-bell"] .dock-ig__sq').exists()).toBe(true)
  const w2 = mount(AlertBell, /* 同插件 */)
  expect(w2.find('[data-test="alert-bell"] .dock-ig__sq').exists()).toBe(false)
})
```

- [ ] **Step 4: SideNavBar 装配**

script:
1. 删六个内联数组与 nsRouteMap,改 import:`import { CLUSTER_PRIMARY_NAV, CLUSTER_CROSS_NS_NAV, CLUSTER_RESOURCES_NAV, CLUSTER_OTHER_NAV, PLATFORM_ADMIN_NAV, NS_NAV_GROUPS, NS_ROUTE_MAP, WORKBENCH_NAV } from '@/logic/navConfig.js'`;模板中引用名同步(`clusterPrimaryNav`→`CLUSTER_PRIMARY_NAV` 等;`nsRouteMap[routeKey]`→`NS_ROUTE_MAP[routeKey]`)。
2. import 三组件:SideNavSearch / WorkbenchNavItem / UserMenu / AlertBell。

template(按现文件锚点插入):
1. **搜索段**:集群头部 `</div>` 与 Divider 之后、无集群 CTA/ns 坍之前 → `<SideNavSearch />`(noCluster 也渲染)。
2. **工作台段**:`<nav>` 内 Transition `</div>` 之后、平台管理 div 之前:

```html
<!-- 工作台段(2026-10-23 spec §4.3):W 舷板入 K 壳,三态恒显(免集群) -->
<div data-test="wb-nav-seg" class="px-md pt-sm">
  <WorkbenchNavItem />
</div>
```

3. **集群管理组**:跨 ns 子组插在主组之后:

```html
<p class="text-xs text-on-surface-variant opacity-50 px-md pt-sm pb-xs group-head">{{ $t('nav.crossNamespace') }}</p>
<a v-for="item in CLUSTER_CROSS_NS_NAV" :key="item.route" @click="navTo(item.route)"
  class="nav-item flex items-center gap-md px-md py-sm rounded-lg cursor-pointer transition-all duration-200"
  :class="isGlobalActive(item.route) ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'">
  <span class="material-symbols-outlined text-lg">{{ item.icon }}</span>
  <span class="text-body-sm nav-item__label">{{ item.labelKey ? $t(item.labelKey) : item.label }}</span>
</a>
```

4. **底部行**:集群态行(现 L512-525 `v-else-if="!noCluster"` 块)在活动与设置之间插告警(wrapper div 承载 v-if 与 data-test,避免 AlertBell 根 data-test="alert-bell" 的透传合并歧义):

```html
<div v-if="!belowSm" data-test="bottom-alerts-row" class="flex-1 flex items-center justify-center">
  <AlertBell class="!rounded-none" />
</div>
```

ns 态 dock 图标网格:`grid grid-cols-3` → `grid grid-cols-4`,在活动瓦片后加(外层 div 承载 dock-ig 与 data-test,tile 形态图标入 `dock-ig__sq`;button 自身样式用 `!` 前缀压掉默认 p-sm/圆角/底色):

```html
<div v-if="!belowSm" data-test="bottom-alerts" class="dock-ig cursor-pointer">
  <AlertBell tile class="!p-0 !bg-transparent !shadow-none !border-0 !rounded-none" />
</div>
```

(`v-if="!belowSm"` 与集群态行同门控——手机抽屉内 dock 不带告警,统一由 footer 承担,RF1。)

5. **头像行**:底部行 div 之后(Bottom Actions 区末尾):

```html
<!-- 头像行(2026-10-23 spec §4.5):三态恒显——登出/个人中心无集群必须可达 -->
<div data-test="sidenav-user-row" class="shrink-0 border-t border-outline-variant/50">
  <UserMenu />
</div>
```

6. **rail CSS 两块**(hover:hover 与 hover:none 两块声明列表同步):隐藏列表各加 `.sb-user-txt`、`.sb-user-txt` 行为与 `.ns-txt` 同;(SideNavSearch/WorkbenchNavItem 的 rail 形态由组件自身与 nav-item 规则承担,无需新增。)

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.shell-extensions.test.js src/components/layout/__tests__/SideNavBar.bottom-row.test.js src/components/layout/__tests__/SideNavBar.home.test.js src/components/layout/__tests__/SideNavBar.nocluster.test.js src/components/layout/__tests__/AlertBell.test.js`
Expected: 全 PASS(既有 SideNavBar 用例零回归;若 noCluster 用例因头像行新增需更新计数,逐条核对语义后改)

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/SideNavBar.vue src/components/layout/AlertBell.vue src/components/layout/__tests__/AlertBell.test.js src/components/layout/__tests__/SideNavBar.shell-extensions.test.js
git commit -m "feat(nav): 侧栏装配——navConfig消费+搜索/工作台/头像行三新段+告警入底部行与dock(断点互斥)"
```

---

### Task 8: AppLayout footer 接管 + 顶栏退役

**Files:**
- Modify: `src/components/layout/AppLayout.vue`
- Delete: `src/components/layout/TopNavBar.vue`
- Delete: `src/components/layout/WorkbenchEntryPill.vue`
- Delete: `src/components/layout/__tests__/TopNavBar.test.js`、`TopNavBar.dedup.test.js`、`TopNavBar.workbench-entry.test.js`、`WorkbenchEntryPill.test.js`
- Modify: `src/components/layout/__tests__/shell-width-guard.test.js`(文件清单去 TopNavBar.vue)
- Create: `src/components/layout/__tests__/AppLayout.footer.test.js`(静态源断言)
- Modify(纯注释):`src/composables/usePageRefresh.js`、`src/styles/zScale.js`(Z.nav 注释改「nav 层级预留,原顶栏 sticky 参照」)、`src/stores/shell.js`(汉堡消费方改 footer)、`src/composables/useClusterHealth.js`、`src/api/client.js`、`src/logic/resourceNavigation.js`、`src/components/common/FloatingWindow.vue`、`src/components/terminal/TerminalTaskbar.vue`(WorkbenchEntryPill 字样改 WorkbenchNavItem)——逐文件 `grep -n "TopNavBar\|顶栏\|WorkbenchEntryPill"` 后按语义改写,不动逻辑。

**Interfaces:**
- Consumes: Task 4-7 全部新组件(已在 SideNavBar 装配);`usePageRefresh().bump`;`shell.toggleDrawer`;AlertBell。
- Produces: 无下游消费方(TopNavBar 退役)。

- [ ] **Step 1: 写失败测试(AppLayout.footer.test.js,静态源断言)**

```js
// AppLayout 过重不挂载(项目惯例,见 AppLayout.atmosphere.test.js 头注):静态源断言。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const layoutSrc = readFileSync('./src/components/layout/AppLayout.vue', 'utf8')

test('顶栏已退役:不再 import/挂载 TopNavBar', () => {
  expect(layoutSrc).not.toContain('TopNavBar')
})

test('footer 刷新:bumpRefresh + invalidateAllClusterQueries + 自旋窗', () => {
  expect(layoutSrc).toMatch(/function refreshPage\(\)/)
  expect(layoutSrc).toContain('bumpRefresh()')
  expect(layoutSrc).toContain('store.invalidateAllClusterQueries()')
  expect(layoutSrc).toContain('data-test="footer-refresh"')
})

test('footer 手机档:汉堡(toggleDrawer)与告警 AlertBell 均belowSm门控(RF1)', () => {
  expect(layoutSrc).toContain('data-test="footer-menu"')
  expect(layoutSrc).toMatch(/v-if="belowSm"[\s\S]{0,200}data-test="footer-menu"/)
  expect(layoutSrc).toMatch(/<AlertBell v-if="belowSm"/)
})

test('集群健康横幅/UpdateBanner 仍在(main 之前)', () => {
  expect(layoutSrc).toContain('clusterHealth')
  expect(layoutSrc).toContain('<UpdateBanner')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/AppLayout.footer.test.js`
Expected: FAIL(TopNavBar 仍在)

- [ ] **Step 3: AppLayout 手术**

script:
1. 删 `import TopNavBar from './TopNavBar.vue'`;加 `import AlertBell from './AlertBell.vue'`。
2. `const { tick: refreshTick, bump: bumpRefresh } = usePageRefresh()`(改现有解构)。
3. 加刷新逻辑(自 TopNavBar L96-105 逐字):

```js
// 刷新当前页(2026-10-23 自顶栏迁入 footer):重挂当前视图 + 后台重拉列表
const refreshing = ref(false)
let refreshTimer = null
function refreshPage() {
  if (refreshing.value) return
  refreshing.value = true
  bumpRefresh()
  store.invalidateAllClusterQueries()
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => { refreshing.value = false }, 700)
}
```

4. `onUnmounted` 追加 `if (refreshTimer) clearTimeout(refreshTimer)`。

template:
1. 删 `<TopNavBar />` 行。
2. footer 整块替换为:

```html
<footer class="shell-footer px-lg py-sm bg-surface border-t border-outline-variant flex items-center gap-sm shrink-0">
  <!-- 手机档:汉堡 + 告警(顶栏退役后手机全局工具归 footer;spec §5) -->
  <button v-if="belowSm" data-test="footer-menu" @click="shell.toggleDrawer()"
    class="p-sm -ml-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-colors"
    :aria-label="$t('nav.openMenu')">
    <span class="material-symbols-outlined">menu</span>
  </button>
  <AlertBell v-if="belowSm" class="max-sm:shrink-0" />
  <div class="flex items-center gap-sm min-w-0 flex-1">
    <span class="w-2 h-2 rounded-full shrink-0" :class="{ 'bg-primary': store.clusterHealth.severity === 'ok', 'bg-tertiary-container': store.clusterHealth.severity === 'warn', 'bg-error': store.clusterHealth.severity === 'crit', 'bg-on-surface-variant': store.clusterHealth.severity === 'none' }"></span>
    <span class="text-body-sm text-on-surface-variant min-w-0 truncate">{{ $t('layout.clusterStatusSummary', { status: store.clusterHealth.status, ready: store.clusterHealth.controlPlane.ready, total: store.clusterHealth.controlPlane.total, wready: store.clusterHealth.workers.ready, wtotal: store.clusterHealth.workers.total }) }}</span>
  </div>
  <!-- 刷新:全断点常驻(自顶栏迁入;数据新鲜度语义与「最后更新」同区) -->
  <button data-test="footer-refresh" @click="refreshPage" :disabled="refreshing"
    :aria-label="$t('nav.refreshPage')" :title="$t('nav.refreshPageData')"
    class="p-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary rounded-full transition-colors disabled:opacity-50 shrink-0">
    <span class="material-symbols-outlined" :class="refreshing ? 'animate-spin' : ''">refresh</span>
  </button>
  <div class="flex items-center gap-md text-on-surface-variant font-mono text-code-sm max-lg:hidden shrink-0">
    <span>{{ $t('layout.lastUpdated') }} {{ lastUpdated }}</span>
    <span class="px-sm py-xs bg-surface-container rounded-sm border border-outline-variant">{{ store.cluster.version }}</span>
  </div>
</footer>
```

- [ ] **Step 4: 删除四个文件 + 更新 shell-width-guard**

`git rm` TopNavBar.vue、WorkbenchEntryPill.vue、三个 TopNavBar 测试、WorkbenchEntryPill.test.js;`shell-width-guard.test.js` 文件清单 `['AppLayout.vue', 'TopNavBar.vue', 'SideNavBar.vue']` → `['AppLayout.vue', 'SideNavBar.vue']`。

- [ ] **Step 5: 注释清扫**

逐文件执行 `grep -n "TopNavBar\|顶栏\|WorkbenchEntryPill" <file>`(范围=Global Constraints 列出的 8 个文件 + `src/components/layout/SearchResults.vue` 头注释),按新现实改写措辞,**不改任何逻辑**。

- [ ] **Step 6: 跑全量前端测试确认通过**

Run: `npx vitest run && npm run typecheck`
Expected: 全 PASS(TopNavBar 系已删,其余零回归;如有守卫测试扫到 TopNavBar 字样,按 Step 5 同步清理)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(shell): 顶栏退役——footer接管刷新/手机汉堡/告警,AppLayout去TopNavBar,注释单源清扫"
```

---

### Task 9: Settings general 加主题行

**Files:**
- Modify: `src/views/Settings.vue`(general tab,L298 语言行后)
- Create: `src/views/__tests__/Settings.general-theme.test.js`

**Interfaces:**
- Consumes: `usePreferencesStore().setTheme`(单写路径,UserMenu 退役的快捷切换在此接续);i18n 键 `userCenter.theme` / `userCenter.themeLight` / `userCenter.themeDark` / `userCenter.themeAuto`(全部已存在,零新增键)。

- [ ] **Step 1: 写失败测试**

```js
// Settings 挂载用例:非 admin(auth.user=null)时 onMounted 不发任何请求,general tab 直接可测
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import Settings from '@/views/Settings.vue'
import { usePreferencesStore } from '@/stores/preferences'

test('general tab:主题三态行,点击深色即时生效,未设置时高亮 auto', async () => {
  setActivePinia(createPinia())
  const w = mount(Settings, { global: { plugins: [i18n] } })
  for (const v of ['light', 'dark', 'auto']) {
    expect(w.find(`[data-testid="settings-theme-${v}"]`).exists()).toBe(true)
  }
  expect(w.find('[data-testid="settings-theme-auto"]').classes()).toContain('bg-primary')
  await w.find('[data-testid="settings-theme-dark"]').trigger('click')
  expect(usePreferencesStore().theme).toBe('dark')
  expect(w.find('[data-testid="settings-theme-dark"]').classes()).toContain('bg-primary')
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/Settings.general-theme.test.js`
Expected: FAIL(无主题行)

- [ ] **Step 3: 实现**

script 加:

```js
// 主题三态(2026-10-23 spec §4.5:顶栏头像菜单快捷切换退役,归设置页;键复用 userCenter.*)
const themeOptions = [
  { v: 'light', key: 'userCenter.themeLight' },
  { v: 'dark', key: 'userCenter.themeDark' },
  { v: 'auto', key: 'userCenter.themeAuto' },
]
const activeTheme = computed(() => preferences.theme || 'auto')
```

template general tab 语言行(`settings.language` 行)之后插:

```html
<div class="flex justify-between items-center py-sm border-b border-outline-variant/50">
  <span class="text-body-sm text-on-surface-variant">{{ t('userCenter.theme') }}</span>
  <div class="flex items-center gap-xs">
    <button v-for="o in themeOptions" :key="o.v" :data-testid="`settings-theme-${o.v}`"
      @click="preferences.setTheme(o.v)"
      :class="activeTheme === o.v ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'"
      class="text-xs px-sm py-xs rounded-md transition-colors max-sm:min-h-[40px]">{{ t(o.key) }}</button>
  </div>
</div>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/Settings.general-theme.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/views/Settings.vue src/views/__tests__/Settings.general-theme.test.js
git commit -m "feat(settings): general tab 新增主题三态行——承接头像菜单退役的主题快捷切换"
```

---

### Task 10: 全量门禁 + 三断点实测

**Files:** 无新改动(验证任务;发现问题回对应任务修)

- [ ] **Step 1: 全量门禁**

```bash
npm test            # test:server(含 navConfig/globalSearch 链)+ test:unit
npm run typecheck
npm run build
npm run i18n:check
```
Expected: 四项全绿。

- [ ] **Step 2: 静态核对 Review Focus 五项 + spec §6 遗留核对**

```bash
grep -n "v-if=\"belowSm\"" src/components/layout/AppLayout.vue                    # footer 汉堡/铃铛
grep -n "v-if=\"!belowSm\"" src/components/layout/SideNavBar.vue                  # 侧栏告警互斥
grep -rn "TopNavBar\|WorkbenchEntryPill" src/ --include="*.vue" --include="*.js" # 应零命中
grep -n "can-i\|canI" src/views/RBAC.vue                                          # spec §6:/rbac 页内权限模拟器入口
```

RBAC.vue 若无 `/rbac/can-i` 链接,本任务内补一颗页内入口(样式沿页内现有链接/按钮惯例,文案键 `route.canI`),并补进本任务 commit。

- [ ] **Step 3: 本地实例三断点实测**(执行者自起实例,勿把凭据写入仓库)

```bash
mkdir -p /tmp/ab-verify && ADMIN_USERNAME=verify ADMIN_PASSWORD='verify-Ab12345678' \
  ALIANG_DB=/tmp/ab-verify/ab.db PORT=8899 node server/index.mjs &
ALIANGBOARD_API_URL=http://127.0.0.1:8899 npx vite --port 5199 --strictPort &
```

浏览器(Playwright MCP)按 spec §11 验收清单逐项:
- 桌面 1440×900:无顶栏;侧栏搜索(输入 pod 名出结果、回车跳转);⌘K;工作台段悬停面板;底部行 告警面板/活动/设置;头像行菜单(向上弹出)→个人中心/登出确认;footer 刷新自旋 + 「最后更新」滚动。
- iPad 768×1024(rail):搜索图标→弹层;工作台/头像图标可达。
- 手机 390×844:抽屉内搜索(贴底 sheet 结果);footer 汉堡开抽屉;footer 铃铛面板;footer 刷新;集群态与无集群态各过一遍(无集群态头像行登出可达)。
- 设置页:主题行三态切换生效。

- [ ] **Step 4: 收尾**

截图/临时文件不入库(`git status` 应只剩预期改动);浏览器 tab 关闭;后台 dev 进程 kill。

```bash
git status --short   # 核对无杂散文件
```
