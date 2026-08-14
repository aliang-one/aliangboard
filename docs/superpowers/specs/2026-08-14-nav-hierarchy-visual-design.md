# 命名空间态层级可视化(底部入口 · 钻入动效)

> 状态:已与用户确认全部视觉决策(A+C 方向 / 克制力度 / 返回入口走底部安静链接)。待写实现计划。
> 日期:2026-08-14。分支:`worktree-feat-ns-scoped-nav`(已快进到 main `944eb64`)。
> 前置:本特性叠加在 `2026-08-13-namespace-scoped-navigation-design.md`(已合 main)之上,纯视觉增量,不改路由/逻辑。

## 1. 背景与动机

nav-scoped 特性落地后,命名空间态侧栏顶部的「返回集群管理」入口是一个**醒目的返回按钮**:粗 `‹` 箭头 + primary 填充的 kubernetes 图标方块 + 集群名 + 「返回集群管理」副标题。用户反馈:

- 这个返回按钮**比 ns 资源内容还显眼**,违背「命名空间内容才是主角、不喧宾夺主」。
- 但**仍要保留「集群是上层、命名空间是下层」的层级概念**。

因此要「去强调」:层级感不再靠一个响亮的返回按钮,而是靠**切换时的钻入动效**表达;返回入口降级为底部一条安静的链接。

## 2. 目标 / 非目标

**目标**
- 命名空间态**移除顶部集群头/返回按钮**,顶部全给 ns(NAMESPACE 选择器 + ns 资源组)。
- 返回上层入口 = **底部一条安静链接** `← 集群概览`(dashboard 图标),muted、hover→primary,点击 → `/cluster`。仅 ns 态出现。
- 层级由**模式切换时的钻入/钻出动效**(240ms)表达:集群组向上收、ns 组从下钻入。
- ns 资源组保持**扁平**(不加凹陷面板/连接线)——最安静。
- 尊重 `prefers-reduced-motion`。
- **不破坏** nav-scoped 特性已有的契约与测试(`cluster-home` testid 与点击行为保留,只是位置从顶部移到底部)。

**非目标**
- 不改路由、store、`useNavMode`、各资源页。
- 不加凹陷面板/连接线(A 的静态部分放弃,只保留 C 动效)。
- 不新增文件、不加依赖、无 i18n 改动(链接文案复用已有 `nav.clusterOverview`)。
- 不改集群态侧栏(集群态顶部静态集群头保留不变)。

## 3. 现状(`SideNavBar.vue`,同步到 main `944eb64` 后)

- **Cluster Header 块**(模板顶部):
  - ns 态:`<button v-if="isNsMode" data-test="cluster-home" @click="router.push('/cluster')">` —— `chevron_left` + primary 蓝块 kubernetes 图标 + 集群名 + 「返回集群管理」副标题。**这就是过响的返回按钮。**
  - 集群态:`<div v-else>` —— 静态展示集群名 + 版本。
- **`<nav>` 内**:ns 资源组 `v-if="isNsMode"`(data-test `ns-nav-section`);集群导航组 `v-if="isClusterMode"`(data-test `cluster-nav-section`)。两者互斥,目前**无切换动效**(直接 v-if 切换)。
- **底部 Bottom Actions**:部署按钮(`v-if="isNsMode"`)+ 图标行 [事件(`v-if="isNsMode"`)][活动记录][设置]。
- **测试**:`SideNavBar.test.js` 已有「ns 态存在 `cluster-home` + 点击 → `/cluster`;集群态无 `cluster-home`」「ns/cluster 态分组互斥」等用例。

## 4. 设计

### 4.1 返回入口移到底部安静链接(仅 ns 态)
- 删除顶部 ns 态的 `cluster-home` 返回按钮(4.2)。
- 在底部 Bottom Actions 区**最下方**加一条细的、muted 的全宽链接行:
  - 内容:`←` + `dashboard` 图标(Material `dashboard`,与集群概览菜单项一致)+ 文案 `$t('nav.clusterOverview')`。
  - `data-test="cluster-home"`(**保留,迁移到此**)、`@click="router.push('/cluster')"`、`:title/:aria-label="$t('nav.clusterOverview')"`。
  - 样式:`text-on-surface-variant`、`hover:text-primary hover:bg-surface-container`、左对齐、`text-body-sm`。**无 primary 填充、无方框、无粗箭头。**
  - `v-if="isNsMode"`(集群态不需要——已在最上层)。
- 底部结构(ns 态)变为:
  ```
  [部署按钮]
  [事件][活动记录][设置]      ← 既有图标行
  ← ▦ 集群概览                 ← 新增安静返回链接
  ```

### 4.2 ns 态移除顶部集群头
- Cluster Header 块改为**仅集群态渲染**:`<div v-if="isClusterMode">…静态集群头…</div>`(把原 `<button v-if="isNsMode">` 删除,原 `<div v-else>` 改为 `v-if="isClusterMode"`)。
- ns 态顶部直接是 Divider + NAMESPACE 选择器 + ns 资源组(无集群头/品牌块)。
- 集群态顶部静态集群头(集群名 + 版本)**不变**。

### 4.3 钻入/钻出动效(C,模式切换时一次性)
- 用 Vue `<Transition name="nav-drill">` 包裹 `<nav>` 内 ns-nav-section ↔ cluster-nav-section 的切换(按 `navMode` 切单一 key 子节点,默认 mode=同时)。
- CSS(组件 `<style scoped>`):
  - `.nav-drill-enter-from` / `.nav-drill-leave-to`:`opacity:0; transform:translateY(8px)`(进场从下、离场向上;离场元素 `position:absolute` 以短暂重叠,避免高度跳动)。
  - `.nav-drill-enter-active` / `.nav-drill-leave-active`:`transition:opacity .24s cubic-bezier(.2,.7,.3,1), transform .24s cubic-bezier(.2,.7,.3,1)`。
  - 离场方向:进 ns 时集群组 `translateY(-8px)` 离场、ns 组 `translateY(8px→0)` 进场;反之亦然(用统一 enter/leave 类即可表达「垂直运动 = 下一层」)。
- 仅模式切换触发;ns 内部点菜单/折叠不触发(这些不在该 Transition 内)。

### 4.4 reduced-motion
- 组件 `<style>` 加:`@media (prefers-reduced-motion: reduce){ .nav-drill-enter-active,.nav-drill-leave-active{transition:none} }`——瞬切,布局不变。

### 4.5 ns 资源组保持扁平
- 不加 `.ns-nested-panel` 凹陷、不加连接线。ns-nav-section 维持现有样式(仅被 Transition 包裹)。

### 4.6 实现落点
全部在 `src/components/layout/SideNavBar.vue`(模板 + `<style scoped>`):
1. Header 块:删 ns 态按钮,集群态 div 改 `v-if="isClusterMode"`。
2. `<nav>` 内:用 `<Transition name="nav-drill">` 包裹按 `navMode` 切换的分组(keyed 单子节点)。
3. 底部:新增 `cluster-home` 安静链接行(`v-if="isNsMode"`)。
4. `<style scoped>`:加 `.nav-drill-*` 与 reduced-motion 规则。

## 5. 影响文件

| 文件 | 改动 |
|------|------|
| `src/components/layout/SideNavBar.vue` | Header 重构(ns 态去头)、底部加返回链接、`<Transition name="nav-drill">`、`<style scoped>` 动效 + reduced-motion |
| `src/components/__tests__/SideNavBar.test.js` | 现有 `cluster-home` 用例自动通过(testid + 点击行为不变);新增 1 断言:ns 态**顶部无**集群头品牌块(如断言 kubernetes 图标方块不在 ns 态) |

不动:路由、store、`useNavMode`、TopNavBar、各资源视图、i18n。

## 6. 测试

- **组件(vitest + @vue/test-utils,复用 `mountSideNavBar` helper)**:
  - 现有用例继续通过:`cluster-home` 在 ns 态存在、点击 → `router.push('/cluster')`;集群态无 `cluster-home`;ns/cluster 分组互斥。
  - **新增**:ns 态下顶部集群头品牌块**不存在**(断言 ns 态渲染结果中无「静态集群头」标识,可用一个新 `data-test="cluster-brand"` 标在集群态头部,断言 ns 态无它);集群态存在。
  - 可选:ns 态 `cluster-home` 位于底部区(断言其在 Bottom Actions 容器内)。
- **门禁**:`npm run typecheck`、`npm run test:unit`、`npm run build`(.vue 编译)。
- **手测**(动效是视觉感受):
  1. 集群态→选 ns:集群组向上收、ns 组从下钻入,~240ms 顺滑。
  2. ns 态→点底部「← 集群概览」:回 `/cluster`,反向动效。
  3. 系统设 reduced-motion:瞬切,无位移。
  4. ns 态顶部无集群头/返回按钮;底部有安静链接;ns 资源项(选中)仍最亮。

## 7. 风险与回退

- **风险**:Transition 包裹分组切换时,离场元素 `position:absolute` 可能在过渡瞬间影响滚动区高度/跳动。**缓解**:过渡容器给 `position:relative`,离场绝对定位仅在 active 期;手测确认无跳动;必要时改 `mode="out-in"`(串行,无重叠,牺牲一点连贯性换稳定)。
- **风险**:`cluster-home` 从顶部移到底部,若有其它代码/测试依赖其位于顶部 → 无(仅 testid + 点击,与位置无关)。
- **回退**:改动集中在 `SideNavBar.vue` + 测试;回退即还原 Header、移除底部链接与 Transition/CSS。低风险。
