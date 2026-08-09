# 顶栏去重：设置/通知下沉到侧边栏底部

- **日期**: 2026-08-09
- **类型**: UI 布局调整（去重 + 信息架构收敛）
- **状态**: 已通过 brainstorming，待写实现计划
- **涉及组件**: `src/components/layout/TopNavBar.vue`、`src/components/layout/SideNavBar.vue`、`src/locales/{en,zh}.json`

## 背景

顶栏右侧三个图标（刷新、通知、设置）中，「通知」与「设置」实际上与侧边栏已有的入口指向**同一页面**，属于重复入口：

| 顶栏图标 | 目标路由 | 侧边栏已有入口 |
|---|---|---|
| 🔔 通知（aria `nav.activityLog`，"活动记录"） | `/audit-logs` | ✅ 集群管理分组内的 "Audit Logs"（`history` 图标，`nav.auditLogs`） |
| ⚙ 设置（aria `nav.settings`） | `/settings` | ✅ 侧边栏底部 "Settings"（`tune` 图标） |
| 🔄 刷新 | 页面重取+重挂载（`refreshPage`） | ❌ 唯一行为，正确保留在顶栏 |

用户判断：这三者带有「设置/工具」属性，与侧边栏底部的设置是同一类业务感觉，应收敛到侧边栏底部，腾出顶栏空间。

## 目标

1. 删除顶栏「通知」「设置」两个重复图标，仅保留刷新。
2. 把「活动记录」（审计日志）入口并入侧边栏底部，与 Settings 并列。
3. 审计日志最终**只在一处**出现：移除集群管理分组里的 Audit Logs。
4. 腾出的顶栏宽度由左侧 `flex-1` 控件（搜索/集群/命名空间）自然吸收，无需新增内容。

## 非目标

- 不新增「真正的通知中心」功能（铃铛目前仅是审计日志快捷入口，本次不改变其语义）。
- 不调整刷新、用户/登出、集群切换、命名空间选择器的行为。

## 设计

### 改动 1 — 顶栏 `TopNavBar.vue`（右侧按钮区，行 267–284）

删除两个图标按钮：

- 🔔 通知：`@click="router.push('/audit-logs')"`，aria `nav.activityLog`（行 271–273）
- ⚙ 设置：`@click="router.push('/settings')"`，aria `nav.settings`（行 274–276）

保留：

- 🔄 刷新（行 268–270）—— 页面上下文动作，不动。
- 分隔线（行 277）+ 用户/登出按钮（行 278–283）—— 不动。

顶栏右侧结果：`[🔄 刷新] | [用户/登出]`。

> 删除后 `nav.activityLog` 在顶栏不再被引用，但会被改动 2 的底部入口复用，故不致孤立。`nav.settings` 仍在底部 Settings 项使用。

### 改动 2 — 侧边栏底部 `SideNavBar.vue`（`<!-- Bottom Actions -->` 块，约行 331–350）

在 Settings 之上新增「活动记录」入口，沿用现有底部链接样式（与 Settings 一致的 `<a>` 扁平链接）：

```
🚀 Deploy          (v-if currentNs，不变)
🔔 Events          (v-if currentNs，不变)
📋 活动记录 ← 新增  (notifications 图标 → /audit-logs)
⚙  设置           (不变)
```

- **图标**：`notifications`（铃铛）—— 保留用户「通知/活动」心智。
- **标签**：复用 `nav.activityLog`（en "Activity Log" / zh "活动记录"），无需新 i18n 键。
- **路由**：`router.push('/audit-logs')`。
- **active 高亮（新增，含改进）**：当前底部三项（Deploy/Events/Settings）均无 active 态。为底部 Activity 与 Settings 两个导航项加上 active 高亮——命中当前路由时应用 `bg-primary-container text-on-primary-container font-semibold`，判定逻辑复用现有 `isGlobalActive('/audit-logs')` / `isGlobalActive('/settings')`。

### 改动 3 — 侧边栏主导航 `SideNavBar.vue`（行 40–43 数据定义、行 309–311 模板）

从 `clusterOtherNav` 移除 Audit Logs（行 41），仅剩 Clusters：

```js
const clusterOtherNav = [
  { icon: 'hub', labelKey: 'nav.clusters', route: '/clusters' },
]
```

分组小标题 `nav.auditAndMultiCluster`（en "Audit / Multi-Cluster" / zh "审计 / 多集群"）随之名不副实。

### i18n 清理

- **重命名键** `auditAndMultiCluster → multiCluster`：
  - `src/locales/en.json`：`"multiCluster": "Multi-Cluster"`
  - `src/locales/zh.json`：`"multiCluster": "多集群"`
  - 更新唯一引用（`SideNavBar.vue` 行 309 的 `$t('nav.auditAndMultiCluster')` → `$t('nav.multiCluster')`）。
  - 键改名在两个 locale 间一致、引用同步更新，`npm run i18n:check` 保持绿色。
- **`nav.auditLogs` 将变孤立（已核实）**：该键仅被 `SideNavBar.vue:41` 的侧边栏项引用，AuditLogs 视图标题未使用它。移除该项后键无引用。建议从 `en.json`/`zh.json` 一并删除该键（其语义与保留的 `activityLog` 重复）；若倾向最小改动亦可保留（`i18n:check` 门禁不报未用键）。**推荐删除。**

## 验证

- `npm run typecheck`（`node --check` 全 .js/.mjs；.vue 由 build 覆盖）
- `npm run build`（覆盖 .vue 编译）
- `npm run i18n:check`（残存中文 + 键对齐 + 引用键缺失三合一门禁）
- `npm run test:unit`（若存在布局相关单测）
- 手测清单：
  1. 顶栏右侧只剩刷新 + 用户/登出，宽度被左侧控件吸收。
  2. 侧边栏底部出现「活动记录」+「设置」，点击分别进入 `/audit-logs`、`/settings`。
  3. 处于 `/audit-logs` 时底部活动记录项高亮；处于 `/settings` 时底部设置项高亮。
  4. 集群管理分组内不再有 Audit Logs，分组标题显示「多集群/Multi-Cluster」，Clusters 仍可进入。
  5. 审计日志全局只有一个入口（底部）。

## 风险

- 低。纯展示层调整，无数据/路由逻辑变更。唯一行为保留的刷新动作不动。
- 注意 i18n 键改名需同步引用与双 locale，否则 `i18n:check` 报引用键缺失。
