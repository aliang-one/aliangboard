# 自定义列 Overhaul — Phase 1 设计（底座升级）

- 日期：2026-08-09
- 状态：待评审
- 范围：**Phase 1（底座）**。覆盖扩张（把 ~30 个硬编码表迁入）为 **Phase 2**，另立 cycle，本文仅给出衔接说明。

## 1. 背景与问题

「自定义列」当前实现于 `src/composables/useTableColumns.js`：`TABLE_CATALOG` 是列定义单一事实源，配置以「隐藏覆盖」形式存 localStorage，Settings 页与各 DataTable 视图共享同一份响应式状态。架构本身干净，但核实出四个真实短板：

1. **覆盖面仅 5/~35**：catalog 只有 `nodes / workloads / namespaces / services / ingress`。其余视图用硬编码 `<table>` 或用 DataTable 但不接 catalog，完全绕过本体系。
2. **标签未 i18n**：`TABLE_CATALOG` 列写死英文字符串（`'Name'`、`'Status'`…），视图 `tableColumns('nodes')` 直传 DataTable 渲染 `header.label`，全程无 `t()`。**结果：这 5 张表的列头在中文环境下也是英文**，且 Settings 自定义列页同样显示英文。与项目严格 `i18n:check` 门禁相悖。
3. **能力仅显隐**：不能调列顺序、不能调列宽、全局唯一（无按集群/命名空间分作用域）。
4. **入口单一**：只能在 Settings 页改，表格现场无法就地勾选。

## 2. 目标与非目标

**Phase 1 目标（本 spec）：**
- 数据模型从「隐藏覆盖」升级为「有序 + 列宽」覆盖式布局，带 v1→v2 无损迁移与对账（新增/删除列不致旧配置失效）。
- catalog 全量 i18n 化，**同时修掉表格列头与 Settings 页两处英文**。
- DataTable 内嵌就地列管理：表头角 `☰` 图标 → 单栏弹层（勾选 + 拖拽排序）+ 表头边缘拖拽调列宽。
- 复用同一 `<ColumnManager>` 组件于 Settings 页与 DataTable 弹层。
- 不破坏非 catalog 的 DataTable 视图（~7 个）与硬编码表视图（~30 个）。

**非目标（Phase 1 不做）：**
- 把其余视图迁入 catalog（→ Phase 2）。
- 按集群/命名空间分作用域（保持全局）。
- 像素级精准列宽（需 `table-layout: fixed`，回归风险高，见 §7 取舍）。

## 3. 数据模型 v2

### 3.1 存储结构

```
// localStorage 'aliangboard.tableColumns.v2'
{
  nodes: {
    order:  ['status','name','cpu', ...],  // 显式顺序;未列出的 catalog 列按默认序追加
    hidden: { system: true },               // 隐藏的列(缺省=显示)
    width:  { name: 240, cpu: 120 },        // 列宽 px(缺省=catalog 默认/自动)
  }
}
```

覆盖式哲学不变：catalog 仍是「哪些列存在」的事实源，用户配置只记**偏离默认**的部分（order/hidden/width 任一可缺省）。

### 3.2 读取对账（核心纯函数）

读取时以 **catalog 为准**对账：
- `order` 中已被 catalog 移除的 key → 丢弃。
- catalog 中存在但不在 `order` 的列 → 按默认序追加到末尾。
- `hidden` / `width` 中引用了已不存在的列 → 忽略。

⇒ **新增列自动出现（默认可见、默认序末尾），删除列静默生效，老配置永不失效。**

### 3.3 v1 → v2 迁移

首启：读 v2；不存在则读 v1，转换 `{ [k]: false }` → `{ hidden: { [k]: true } }`，写回 v2。JSON 解析失败 → 回退 `{}`（与现状一致）。一次性、无损。

## 4. catalog i18n 化

- 列定义从 `label: 'Name'` 改为 `labelKey: 'cols.nodes.name'`，保留英文 `label` 作兜底。
- composable 内部用 `useI18n()` 解析，**对外仍返回带已翻译 `label` 的列对象**——视图侧 `columns('nodes')` 调用契约不变，仅 `label` 变成本地化文本。
- en / zh 两份 locale 补齐 `cols.<tableKey>.<colKey>` 及弹层 UI 文案键，过 `i18n:check`。
- 为保持纯函数可测，对账函数返回 `{ ...col, labelKey, label(fallback) }`；`t()` 仅在最外层 `columns()`/`allColumns()` 包装时应用。

## 5. 组件结构

### 5.1 新增 `src/components/common/ColumnManager.vue`（共享）

职责：单栏列管理——勾选显隐 + 拖拽排序 + 单表重置。props: `tableKey`。内部从 composable 取 `allColumns(tableKey)`、调 `toggle / setOrder / resetTable`。**Settings 页内联使用，DataTable 弹层也内嵌使用，一套实现。**

排序用原生 `draggable`（dragstart/dragover/drop 重排 key 数组 → `setOrder`），**零新依赖**，符合仓库政策。含可见键盘可达性（上/下移动作为拖拽的兜底，复用 setOrder）。

### 5.2 `src/components/common/DataTable.vue` 增量改造

新增可选 prop `columnKey: String`：
- **传入**：渲染表头栏（含 `☰` 按钮，点击弹层内嵌 `ColumnManager`）；按 `header.width` 应用列宽；表头右边缘渲染拖拽手柄，拖动 → `setWidth(columnKey, key, px)`。
- **不传**：行为与今天完全一致（其余 ~7 个非 catalog DataTable 视图零改动）。

视图侧：从「传已过滤 headers」升级为「传 catalog key + 由 composable 解析出有序/过滤/带宽的 headers」。例：

```vue
<DataTable :headers="columns('nodes')" :column-key="'nodes'" :rows="paginated" ...>
```

`columns(tableKey)` 返回值随 config 响应式更新，弹层改动即时反映到表头与表体。

### 5.3 `src/views/Settings.vue`

`customcols` tab 改为按 catalog 逐表内联渲染 `<ColumnManager :table-key="tbl.key">`，保留「全部重置」。Settings 不放列宽控件（列宽就地调更自然）。

### 5.4 视图改动（最小）

`Nodes.vue` / `Workloads.vue` / `Namespaces.vue` / `Network.vue`（services + ingress 两表）：仅给现有 `<DataTable>` 补 `:column-key` prop；`headers` 仍取自 composable。改动量极小。

## 6. composable API（新）

纯函数（可测，无 vue/localStorage）：
- `migrateV1toV2(v1)` → v2 overrides
- `reconcileColumns(catalogColumns, overrides)` → `{ ordered: [...全量, 含 hidden/width 标记], visible: [...过滤] }`

有状态包装（thin）：
- `columns(tableKey)` → 解析后的可见列（有序 / width 合并 / label 已翻译）— 视图传给 DataTable
- `allColumns(tableKey)` → 全量列（含 hidden 标记 + width + 翻译 label）— ColumnManager 用
- `isHidden / toggle / setOrder / setWidth / resetTable / resetAll`、`catalog`

## 7. 取舍：列宽 ↔ table-layout

DataTable 现为 `table-layout: auto`。**像素级精准列宽**需切 `fixed + colgroup`，但会改变全部 12 个 DataTable 视图的列宽行为（高回归风险）。

**决定**：Phase 1 保持 `auto` + `th { width; min-width }` 提示。列宽拖拽「偏软」（浏览器视 width 为提示，可能再分配），但**零破坏**。若未来某表需精准控宽，再按表 opt-in `fixed`。实现阶段以实物验证手感。

## 8. 边界与错误处理

- localStorage 不可用（隐私模式）：`try/catch` 静默，与现状一致。
- 某表所有列被隐藏：DataTable 增加守卫——可见列数为 0 时复用空状态（避免渲染空表）。
- 迁移损坏 JSON：回退 `{}`。
- 重置：`resetTable` 清该表 overrides（回 catalog 默认）；`resetAll` 清空。

## 9. 测试

- **纯逻辑**（`migrateV1toV2`、`reconcileColumns` 的对账/合并/边界）→ 自研零依赖运行器（`scripts/test.mjs` / `node --test`），符合项目约定。
- **组件交互**（ColumnManager 拖拽排序、DataTable 列宽拖拽与守卫）→ vitest + @vue/test-utils + happy-dom（已登记 devDep 例外）。
- 回归：`npm run typecheck`、`npm run i18n:check`、`npm run build`、`npm test`、`npm run test:unit` 全绿。

## 10. 文件改动清单

| 文件 | 类型 | 说明 |
|------|------|------|
| `src/composables/useTableColumns.js` | 重写核心 | v2 模型 + 迁移 + 对账纯函数 + 新 API + useI18n + catalog→labelKey |
| `src/components/common/ColumnManager.vue` | 新增 | 共享列管理（勾选 + 拖拽排序 + 重置） |
| `src/components/common/DataTable.vue` | 增量 | `columnKey` prop + 表头栏/☰弹层 + 列宽应用 + 边缘拖拽 + 空列守卫 |
| `src/views/Settings.vue` | 改 | customcols tab 内联 ColumnManager |
| `src/views/Nodes.vue` `Workloads.vue` `Namespaces.vue` `Network.vue` | 改（极小） | DataTable 补 `:column-key` |
| `src/locales/en.json` `src/locales/zh.json` | 改 | 补 `cols.*` 与弹层文案键 |
| `scripts/`（零依赖测试） + `src/components/common/__tests__/`（vitest） | 新增 | 纯逻辑 + 组件交互 |

## 11. 与 Phase 2（覆盖扩张）的衔接

Phase 1 落地后，覆盖扩张降为「机械但量大」的工作：
- 已用 DataTable 但未接 catalog 的视图（WorkbenchList / AuditTrail / Configuration / NsRBAC / Storage / RBAC / ApiKeyManagement 等）→ 仅需加 catalog 条目 + `:column-key`。
- 硬编码 `<table>` 视图（NsPods / NsConfigMaps / …）→ 需先迁到 DataTable（含命名插槽），再接 catalog。
- **时机**：须与进行中的 Vue Query 数据层重构（P2-B pods/workloads，最高风险）错开文件，按资源族分批，避免回归叠加。Phase 2 另立 spec。

## 12. 风险

- `auto` 布局下列宽手感偏软（已接受，见 §7）。
- 原生 `draggable` 跨浏览器/触屏体验差异（内部工具，可接受；必要时补上/下按钮兜底）。
- DataTable 改造须严格保证「不传 columnKey 时零行为变化」，否则波及 12 个视图。
