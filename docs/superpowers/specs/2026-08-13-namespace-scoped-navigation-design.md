# 侧边栏上下文分级:命名空间态隐藏集群管理 + 集群头返回上层

> 状态:已与用户确认方向与两处关键决策(① 返回入口形态=「集群头可点击返回」;② 命名空间态全局/管理类全留,只隐藏集群导航组)。待写实现计划。
> 日期:2026-08-13。分支:`worktree-feat-ns-scoped-nav`。

## 1. 背景与动机

平台的导航心智应是**两级上下文**:

- **集群态(上层)**:默认进入,看集群整体状态(概览/节点/命名空间列表/存储/监控/CRDs…)。
- **命名空间态(下层)**:选定某个 namespace 后进入,聚焦该 ns 内的工作负载/网络/配置/安全/策略。

现状(`src/components/layout/SideNavBar.vue`)用 `currentNamespace` 一个布尔来切两组菜单:命名空间资源组 `v-if="currentNs"`;集群管理组 `v-show="clusterNavOpen || !currentNs"`——**选了 ns 只是折叠,集群管理仍留在侧栏**。用户反馈:命名空间态下左侧菜单应是"纯 ns 相关",集群管理**不应出现**;从 ns "返回集群管理"应有明确的**回到上层**的感觉,而不是在一堆 ns 菜单项里翻折叠的集群组。

此外,模式跟随"上次选的 ns"(persist 的 `currentNamespace`)而非"当前所在路由",语义错位:站在 `/cluster` 但 ns 还在时,侧栏仍显示命名空间态。

## 2. 目标 / 非目标

**目标**
- 模式判定改为**路由驱动**(`route.meta.scope`),单一真相源 = 当前路由。
- 命名空间态下,**集群导航组整组消失**(不再是折叠)。
- 顶部 Cluster Header 在命名空间态变为**可点击的「返回集群管理」入口** → 回到 `/cluster`(集群态)。
- 命名空间态下保留:ns 资源分组、ns 操作(部署/事件)、**全局/管理类**(设置 / 活动记录 / 平台管理含 `/admin/clusters`)。
- 与既有「ns 名→回 ns 拓扑首页、箭头→切 ns」机制(2026-08-07 spec)并存,不冲突。

**非目标**
- 不改路由表结构、不改各资源页面本身。
- 不重做集群态侧栏的整体视觉(仅 Cluster Header 增加点击语义)。
- 不引入新外部依赖。
- 不做权限驱动的菜单项增删(平台管理仍按 `authStore.isAdmin`,不变)。

## 3. 现状(关键文件 + 行号)

- `src/router/index.js`:每条路由已带 `meta.scope: 'global' | 'namespace'`(如 37 / 237 行);路由守卫已在 `ns/:namespace` 路由同步 `store.setNamespace`(542-546)。**`scope` meta 已就绪,可直接用作模式真相源。**
- `src/components/layout/SideNavBar.vue`:
  - **Cluster Header**(190-198):集群图标 + `store.cluster.name` + `store.cluster.version`,**静态、不可点击**。
  - **Namespace Selector**(203-259):`ns-home` 按钮(点 ns 名→`NamespaceOverview` 拓扑首页)+ 箭头(切 ns 下拉)。已落地 2026-08-07 spec。
  - **命名空间资源组**(264-284):`v-if="currentNs"`。
  - **集群管理组**(287-315):折叠头 + `v-show="clusterNavOpen || !currentNs"`,含 `clusterPrimaryNav`/`clusterResourcesNav`/`clusterOtherNav`。
  - **平台管理**(318-326):`v-if="authStore.isAdmin"`。
  - **底部区**(330-361):部署 `v-if="currentNs"`、事件 `v-if="currentNs"`、活动记录、设置。
- `src/stores/cluster.js`:`currentNamespace`(localStorage 持久化)、`cluster`/`currentCluster`(连接集群信息)。

## 4. 设计

### 4.1 模式判定(新增 `useNavMode` composable)

新增 `src/composables/useNavMode.js`:
```js
import { computed } from 'vue'
import { useRoute } from 'vue-router'
// 模式 = 当前路由的 scope。'namespace' = 下层(ns 内);否则 = 上层(集群态)。
export function useNavMode() {
  const route = useRoute()
  const navMode = computed(() => route.meta.scope === 'namespace' ? 'namespace' : 'cluster')
  const isNsMode = computed(() => navMode.value === 'namespace')
  const isClusterMode = computed(() => navMode.value === 'cluster')
  return { navMode, isNsMode, isClusterMode }
}
```
`currentNamespace` **保留**(ns 切换器、持久化仍用它),但**不再决定模式**。

### 4.2 Cluster Header = 返回上层入口(改 190-198)

把静态 Header 改为条件可点击:

| 模式 | 集群行表现 | 点击行为 |
|------|-----------|----------|
| **集群态** | `⬢ {集群名}`(+ 版本/健康),**静态展示、不可点击**(此时就在上层,无需返回) | 无 |
| **命名空间态** | `‹ ⬢ {集群名}`,前置返回箭头,整行 hover 高亮、tooltip「返回集群管理」 | → `router.push('/cluster')`,回到集群态 |

- 复用现有 Header 的图标/样式,仅在外层包 `:class` 与 `@click`(`isNsMode` 时生效)。
- 集群名数据源:优先 `store.cluster.name`;实现期**核实连接态下其是否可靠填充**,不可靠则 fallback `currentCluster.apiServer` 主机名或 `'Cluster'`(写进实现计划 Task 0 核实项)。
- i18n 新增 `nav.backToCluster`(「返回集群管理」/「Back to cluster」),走 tooltip + `aria-label`。

命名空间态视觉(与用户确认的 mockup 一致):
```
┌──────────────────────────┐
│ ‹ ⬢ prod-cluster          │  ← 点集群名回上层(/cluster)
├──────────────────────────┤
│ NAMESPACE                │
│ [ folder_open default ▾ ]│  ← 既有 ns 选择器(切 ns / 回拓扑首页)
├──────────────────────────┤
│ 工作负载 / 网络 / 存储…    │  ← ns 资源组
│ (集群管理组此处不出现)     │
├──────────────────────────┤
│ 部署 | 事件 | 活动 | 设置  │
└──────────────────────────┘
```

### 4.3 分组门控改造(改 262-360)

用 `isNsMode`/`isClusterMode` 替换 `currentNs` 作为分组门控:

| 分组 | 现门控 | 改后门控 |
|------|--------|----------|
| 命名空间资源组(264) | `v-if="currentNs"` | `v-if="isNsMode"` |
| 集群管理组整块(287-315) | 折叠头 + `v-show="clusterNavOpen \|\| !currentNs"` | `v-if="isClusterMode"`(整组消失;折叠头保留在内部,`clusterNavOpen` 仅集群态用) |
| 底部·部署(332)、底部·事件(341) | `v-if="currentNs"` | `v-if="isNsMode"` |
| 平台管理(318) | `v-if="authStore.isAdmin"` | **不变**(两态都留) |
| 底部·活动记录、设置(348/354) | 常驻 | **不变**(两态都留) |

> 注:把命名空间组/部署/事件的 `currentNs` 一并换成 `isNsMode`,保证"模式=路由 scope"这一真相源一致(当前 `currentNs` 与"在 ns 路由上"实际等价,但用 scope 更直白、避免 persist ns 造成的边角错位)。

### 4.4 命名空间态的进入入口(从集群态→下层)

进入 ns 态的主入口**已存在**:顶部 Namespace Selector 下拉点任一 ns → `selectNamespace` → `router.push('/ns/:ns')`(127-132)。**无需新增主入口。**

补充(次要 UX):集群态的 `/namespaces` 列表(`Namespaces.vue`)当前点行进入 `/namespaces/:name`(global scope 的 NamespaceDetail,**仍是集群态**)。补一个「进入命名空间」操作 → `router.push({name:'NamespaceOverview',params:{namespace:name}})`,让"集群态看 ns 列表 → 进入该 ns 工作"路径自洽。(实现期确认 `Namespaces.vue` 行操作位置;若该页已有等价入口则跳过。)

### 4.5 i18n(`src/locales/{zh,en}.json`)

新增:
- `nav.backToCluster`:zh `返回集群管理` / en `Back to cluster`
- (如 4.4 落地)`namespaces.enter`:zh `进入命名空间` / en `Enter namespace`

过门禁:`npm run i18n:check`(残留中文 + 键对齐 + 引用键缺失三合一)。

### 4.6 边界一致性

- 命名空间态下直接访问集群级 URL(如 `/nodes`):`scope=global` → `isClusterMode` → 侧栏自动切集群态 ✓
- 集群态点 ns 选择器选 ns → `/ns/:ns` → `isNsMode` ✓
- 点 Cluster Header(命名空间态)→ `/cluster` → 集群态;`currentNamespace` 仍 persist,可再进 ✓
- `SelectCluster` → `/cluster` → 集群态默认页(符合"默认看集群状态")✓
- TopNavBar 的 ns 快切保留,与侧栏 Cluster Header 并存不冲突。

## 5. 影响文件

| 文件 | 改动 |
|------|------|
| `src/composables/useNavMode.js` | **新增**:route scope → 模式 composable |
| `src/components/layout/SideNavBar.vue` | 引入 `useNavMode`;Cluster Header 条件可点击(返回);集群组 `v-if isClusterMode`;ns 组/部署/事件改 `v-if isNsMode` |
| `src/views/Namespaces.vue`(如 4.4 落地) | 行操作补「进入命名空间」→ `/ns/:name` |
| `src/locales/zh.json` / `en.json` | 新增 `nav.backToCluster`(及可选 `namespaces.enter`) |

不动:路由表、各资源视图、store、TopNavBar。

## 6. 测试

- **纯逻辑(自研零依赖运行器 / `scripts/test.mjs`)**:`useNavMode` 给定 mock route 的 `meta.scope` → 正确返回 `cluster`/`namespace`。
- **组件(vitest + @vue/test-utils + happy-dom)**:
  - `SideNavBar` 在 mock `scope='global'` 下渲染集群组、不渲染 ns 资源组;
  - mock `scope='namespace'` 下渲染 ns 资源组、**不渲染集群管理组**;
  - 命名空间态下 Cluster Header 可点击且触发 `router.push('/cluster')`(用 `data-test="cluster-home"` 锚定,参考既有 `ns-home`/`bottom-events` testid 约定)。
- **门禁**:`npm run typecheck`(`node --check` + .vue 经 `npm run build`)、`npm run i18n:check`。
- **手测清单**(实现后):
  1. 默认进 `/cluster` → 侧栏为集群态(集群组可见、无 ns 资源组)。
  2. ns 选择器选 ns → 进命名空间态,侧栏无集群管理组,顶部 Cluster Header 出现 `‹`。
  3. 点 Cluster Header → 回 `/cluster`,侧栏切集群态。
  4. 命名空间态下地址栏直输 `/nodes` → 侧栏自动切集群态。
  5. 管理员两态均见「平台管理」;两态均见 设置/活动记录。

## 7. 风险与回退

- **风险**:Cluster Header 数据源 `store.cluster.name` 在连接态可能为空/mock → 返回入口显示异常。**缓解**:Task 0 核实,fallback 链 `cluster.name → currentCluster.apiServer host → 'Cluster'`。
- **风险**:把 `currentNs` 门控换成 `isNsMode` 时遗漏某处(如底部按钮)→ 命名空间态多/少项。**缓解**:逐项对照 §4.3 表,组件测试覆盖两种模式快照。
- **回退**:改动集中在 `SideNavBar.vue` + 一个新 composable + 两条 i18n;回退即还原门控条件、移除 Header 点击。低风险。
