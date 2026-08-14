# 钻入入口图标化(集群入口 icon 行 + 命名空间进入箭头)

> 状态:已与用户确认方向与图标选择。待写实现计划。
> 日期:2026-08-14。分支:`worktree-feat-ns-nav-icons`(基线 main `8d874de`)。
> 前置:叠加在 `2026-08-14-nav-hierarchy-visual-design.md`(已合 main)之上,纯 UI 微调,不改路由/逻辑。

## 1. 背景与动机

上一轮把「返回上层」做成底部文字链 `← 集群概览`。用户进一步要求:

- 集群概览入口**不要做成文字链/返回按钮**,而是收成**普通集群图标**,与底部「事件/活动/设置」**平级,排成一行 4 个 icon**;图标用集群概览的 `dashboard`(非箭头)。
- 在**集群视角下**,命名空间选择器的图标旁加一个**「进入下一层」图标**(`arrow_forward`),让"选 ns → 钻入下层"可感。

两条呼应:集群态有「→ 进入下层」,ns 态有「▦ 回到上层」——层级双向可感,且都是普通图标、不喧宾夺主。

## 2. 目标 / 非目标

**目标**
- ns 态底部图标行由 3 个变为 **4 个**:最左新增 `dashboard`(集群概览入口 → `/cluster`),icon-only;删除原「← 集群概览」文字链。
- 集群态命名空间选择器 `folder_open` 旁新增 `arrow_forward`(muted),**仅集群态**(`v-if="isClusterMode"`),示意进入下层。
- 保留 `cluster-home` testid + 点击 → `/cluster` 契约(仅位置/形态从文字链变图标)。

**非目标**
- 不改路由、store、`useNavMode`、各资源页、动效。
- 不改集群态顶部静态集群头(`cluster-brand`)。
- 不加依赖、无 i18n 改动(复用 `nav.clusterOverview`)。

## 3. 现状(`SideNavBar.vue`,main `8d874de`)

- **ns 态底部 Bottom Actions**(`data-test="bottom-actions"`):部署按钮 + 图标行 `[事件(data-test bottom-events, ns 态)][活动记录(bottom-activity)][设置(bottom-settings)]` + 文字链 `cluster-home`(`arrow_back` + `$t('nav.clusterOverview')`,`v-if="isNsMode"`)。
- **命名空间选择器**(`data-test="ns-home"`):`folder_open` 图标 + ns 名 + 下拉 `expand_more`;两态都显示。
- **测试**:`SideNavBar.test.js` 已断言「ns 态 `[bottom-actions] [cluster-home]` 存在 + 无 cluster-brand」「集群态有 cluster-brand + 无 cluster-home」等。

## 4. 设计

### 4.1 ns 态底部:4 图标行(集群入口图标化)
- **删除**原 `cluster-home` 文字链(`<a>` 含 `arrow_back` + 文本)。
- 在图标行**最左**新增一个 icon-only `<button>`:
  - `data-test="cluster-home"`、`@click="router.push('/cluster')"`、`:title/:aria-label="$t('nav.clusterOverview')"`、`v-if="isNsMode"`。
  - 图标 `<span class="material-symbols-outlined">dashboard</span>`(集群概览图标,非箭头)。
  - 样式与相邻 3 个图标按钮一致(`flex-1`、`text-on-surface-variant`、`hover:text-primary hover:bg-surface-container`)。
- 图标行变为 4 个:`[dashboard 集群概览][事件][活动记录][设置]`(ns 态);集群态仍是 `[活动记录][设置]`(集群概览/事件均 ns 态专属)。

### 4.2 集群态:命名空间选择器加「→ 进入」
- 在命名空间选择器 `ns-home` 按钮内、`folder_open` 图标**紧后**插入一个 `arrow_forward` 图标:
  - `data-test="ns-enter"`、`v-if="isClusterMode"`、`class="material-symbols-outlined ... text-on-surface-variant"`(muted)。
  - 仅展示性(不绑点击;点击仍走原 `ns-home` → 选 ns 进入),表达「进入下一层」。
- ns 态隐藏(已在下层,无需提示)。

## 5. 影响文件

| 文件 | 改动 |
|------|------|
| `src/components/layout/SideNavBar.vue` | 删 cluster-home 文字链;图标行最左加 dashboard 图标按钮;ns-home 内 folder_open 后加 arrow_forward(v-if isClusterMode) |
| `src/components/__tests__/SideNavBar.test.js` | 现有 cluster-home 用例自动通过(位置/形态变,testid+点击不变);新增断言:ns 态 cluster-home 为 dashboard 图标(无「集群概览」可见文本,icon-only);集群态有 `ns-enter`、ns 态无 |

不动:路由、store、useNavMode、TopNavBar、各资源视图、i18n、动效 CSS。

## 6. 测试

- **组件(vitest,复用 `mountSideNavBar`)**:
  - 现有用例继续通过:`[bottom-actions] [cluster-home]` ns 态存在 + 点击 → `/cluster`;集群态无 cluster-home;ns/cluster 分组互斥。
  - 新增 A:ns 态 `cluster-home` 内含 `dashboard` 图标、且**无可见「集群概览」文本**(icon-only)。
  - 新增 B:集群态存在 `ns-enter`(arrow_forward);ns 态**不存在** `ns-enter`。
- **门禁**:`npm run typecheck`、`npm run test:unit`、`npm run build`。
- **手测**:ns 态底部 4 图标平级、最左 dashboard 点回 /cluster;集群态选择器旁有 →、选 ns 后消失。

## 7. 风险与回退

- **风险**:4 图标在小宽度下挤;**缓解**:图标行已用 `flex-1` 等分,260px 侧栏容纳 4 个 icon-only 无压力。
- **风险**:`arrow_forward` 紧跟 `folder_open` 可能在选择器内显得密;**缓解**:muted 色 + 小号(`text-base`),手测确认;必要时改到 ns 名右侧。
- **回退**:改动集中在 `SideNavBar.vue` + 测试;还原即恢复文字链 + 移除两图标。低风险。
