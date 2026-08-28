# 工作台入口 · 顶栏品牌胶囊升级(方案 C3)

- 日期:2026-08-28
- 状态:已与用户经可视化 brainstorm 交互定稿(位置方案 C + 胶囊质感 C3)
- 影响文件:`src/components/layout/TopNavBar.vue`、`src/components/layout/__tests__/`(新增 1 个测试文件)

## 1. 背景与目标

工作台(`/workbench`,WorkbenchShell 全屏 tab:项目/配置/全局/台账,项目内带 AI 对话)是本产品的一级功能,但其唯一入口是 `TopNavBar.vue` 右侧区一个**纯图标灰色小按钮**(`workspaces` 图标,`text-on-surface-variant`,与旁边的刷新按钮视觉权重完全相同),无文字、无边框、夹在「刷新」与「分隔线+用户区」之间。用户反馈:入口太小、不显眼,团队成员发现不了工作台功能。

目标:**可发现性**——入口一眼可见、有文字标签;同时保持改动最小,不动导航结构。

## 2. 现状与约束

现状(顶栏右侧区顺序):`[刷新] [工作台图标] | 分隔线 | [用户名+登出]`。侧边栏(集群态/命名空间态)与底部 dock 均无工作台入口。

**硬约束**:

1. 顶栏溢出回归(issue #3):收缩链为「搜索框优先缩(`flex-1 min-w-0`)、集群/ns 包裹层 `shrink-0`」;右侧区新增固定宽胶囊后,压力必须仍由搜索框吸收,现有回归测试 `TopNavBar.test.js` 必须保持绿。
2. 顶栏去重原则(`TopNavBar.dedup.test.js`):顶栏不重复侧边栏已有的图标(通知/设置已因此移除)。本设计不往侧边栏加工作台入口,顶栏保留唯一入口,与该原则自洽。
3. 动效政策:所有动效必须带 `prefers-reduced-motion: reduce` 禁用分支。本设计**不新增任何动画**(仅沿用 Tailwind `transition-colors` 的 hover 反馈,同现有按钮),政策天然满足。
4. 样式走 Material token(TopNavBar 现有按钮全部 token 化:`bg-surface-container-low`/`border-outline-variant`/`bg-primary/5` 等),不硬编码色值,避免破坏主题一致性。
5. i18n:复用现有 `nav.workbench` 键(zh「工作台」zh.json:460 / en「Workbench」均已存在),**零文案改动**;`npm run i18n:check` 门禁不受影响。
6. 图标延续 `workspaces`(路由 meta.icon 已是 `workspaces`,router/index.js:454)。

## 3. 设计总览(方案 C3:描边浅底胶囊)

现有灰色小图标按钮升级为带文字的品牌胶囊按钮,位置从「刷新之后」移到「刷新**之前**」(右侧区第一位)——导航级入口排在工具按钮前面。用户已在 mockup 对比中先后选定:

- 位置形态:**C · 顶栏升级**(备选 A 侧边栏一级入口 / B 底部坞卡被否,理由:改动最小、不动导航结构;且与去重原则自洽)
- 胶囊质感:**C3 · 描边浅底**(与顶栏现有集群/ns 选择器同款描边语言,用品牌绿区分;备选 C1 静态渐变 / C2 呼吸光晕被否,理由:用户偏好克制、与顶栏语言统一)

### 状态表

| 状态 | 视觉 | Tailwind 类 |
|------|------|-------------|
| 默认 | 浅绿底 + 中绿描边 + 绿字绿图标 | `border border-primary/40 bg-primary/5 text-primary` |
| hover | 描边加深 + 底色加深 | `hover:border-primary hover:bg-primary/10` |
| 激活(路由 `/workbench*`) | 浅绿填充 + 实描边 | `bg-primary-container text-on-primary-container border-primary` |

共同:`rounded-full px-md py-1.5` + `flex items-center gap-sm shrink-0`(胶囊自身不参与收缩,溢出压力全部由左侧搜索链吸收)+ `workspaces` 图标(`text-lg`)+ `$t('nav.workbench')` 文字(`text-body-sm font-semibold`)+ `transition-colors`。

激活判定:`route.path.startsWith('/workbench')`——覆盖 Workbench(`/workbench`)、WorkbenchLedger(`/workbench/ledger`)、WorkbenchProject(`/workbench/:id`)。

### 无障碍

保留 `:aria-label="$t('nav.workbench')"` 与 `:title`(沿用现按钮的可及性属性),文字标签本身进一步降低图标语义歧义。

## 4. 代码改动(单文件)

仅 `src/components/layout/TopNavBar.vue`:

1. script:`useRoute` 补充引入(现只引 `useRouter`),新增 `const isWorkbenchActive = computed(() => route.path.startsWith('/workbench'))`。
2. template:右侧区(`div.flex.items-center.gap-md`)内,删除现有工作台图标按钮(:273-275),在刷新按钮(:270)**之前**插入胶囊按钮:

```html
<button
  @click="router.push('/workbench')"
  :aria-label="$t('nav.workbench')"
  :title="$t('nav.workbench')"
  class="flex items-center gap-sm rounded-full px-md py-1.5 border transition-colors text-body-sm font-semibold shrink-0"
  :class="isWorkbenchActive
    ? 'border-primary bg-primary-container text-on-primary-container'
    : 'border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10'"
>
  <span class="material-symbols-outlined text-lg">workspaces</span>
  {{ $t('nav.workbench') }}
</button>
```

3. i18n / 路由 / 其它组件:**零改动**。

## 5. 测试计划(TDD 先行)

新增 `src/components/layout/__tests__/TopNavBar.workbench-entry.test.js`(mock 风格仿 `TopNavBar.dedup.test.js`,通过 mock `vue-router` 的 `useRoute` 控制激活态):

1. 胶囊按钮存在,`aria-label="nav.workbench"`,且**含文字标签**(非 icon-only,断言 `text()` 含 `nav.workbench`)。
2. DOM 顺序:胶囊位于刷新按钮(`aria-label="nav.refreshPage"`)**之前**。
3. 点击触发 `router.push('/workbench')`。
4. 路由为 `/workbench/p1` 时按钮含 `bg-primary-container`(激活态);路由为 `/cluster` 时不含。
5. 不再存在旧版 icon-only 形态(可由 1 的文字断言覆盖)。

回归门槛:`npm run test:unit` 全绿(含现有 `TopNavBar.test.js` 溢出收缩链、`TopNavBar.dedup.test.js`)+ `npm run build`(覆盖 .vue)。

## 6. 范围外(明确不做)

- 侧边栏(集群态/命名空间态)与底部 dock **不加**工作台入口——单入口原则,避免双入口漂移。
- `ChatPresence` 悬浮 AI 对话入口不动(独立功能)。
- WorkbenchShell 内部布局不动。
- 移动端/窄屏响应式不做(全顶栏本就桌面优先,无任何响应式断点)。

## 7. 决策记录

| 决策 | 选择 | 否决的备选与理由 |
|------|------|------------------|
| 位置形态 | C 顶栏升级 | A 侧边栏一级项(占黄金首屏位、动导航结构)、B 底部坞卡(扫视顺序靠后、集群态底部需重排) |
| 胶囊质感 | C3 描边浅底 | C1 静态渐变、C2 呼吸光晕(用户偏好克制;C3 与顶栏现有选择器语言统一) |
| 激活判定 | `path.startsWith('/workbench')` | 按路由名枚举(需维护名单,新增工作台子路由会漏) |
| 位置 | 右侧区第一位 | 原位(刷新之后):导航级入口应排在工具按钮前,mockup 即按此评审通过 |

## 8. 实施备注

- 实施在 git worktree 隔离分支进行(用户指定);按 TDD 先写测试再改组件。
- 动效为零新增,reduced-motion 政策无需新分支。
