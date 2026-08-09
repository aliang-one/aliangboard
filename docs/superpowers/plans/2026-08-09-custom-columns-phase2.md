# 自定义列 Phase 2(覆盖扩张)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** 把 Phase 1 的自定义列(显隐/排序/列宽/就地 ☰)推广到所有列表视图,重点是用户实际使用的命名空间(Ns*)列表。

**Architecture:** 复用 Phase 1 已落地的 `tableColumnsCore` + `useTableColumns` + `ColumnManager` + `DataTable(columnKey)`。Phase 2 只做「接线」:把硬编码 `<table>` 视图迁到 `<DataTable>`,把已用 DataTable 的视图接 catalog。**不新增任何运行时机制。**

## 现状(基点 main 5a09d23)

- Phase 1 已覆盖 5 张集群表(nodes/workloads/namespaces/services/ingress)。
- 待覆盖(列表视图):
  - **Ns* 硬编码列表(13)**:NsWorkloads, NsConfigMaps, NsSecrets, NsServices, NsIngress, NsEndpoints, NsNetworkPolicies, NsPDBs, NsHPA, NsLimitRanges, NsResourceQuotas, NsStorage, NsEvents
  - **已用 DataTable 但未接 catalog(资源类 4)**:RBAC, NsRBAC, Storage, Configuration
  - **集群硬编码列表(5)**:CrdList, IngressClasses, PriorityClasses, RuntimeClasses, AuditLogs
- Vue Query 迁移已完成(Ns* 均已上 useResourceList)→ 无数据层冲突,只剩 main 移动(rebase 即可)。
- **暂不覆盖**:detail 页子表(container/event/condition)、非资源列表(WorkbenchList/AuditTrail/ApiKeyManagement)——不同 UX,延后。

## 迁移模板(每个硬编码 `<table>` 视图通用)

1. **catalog 加一项**(在 `tableColumnsCore.js` 的 `TABLE_CATALOG`):列定义复用该视图**已有的** `ns.xxx.thYyy` i18n 键作 `labelKey`(不新增 i18n)。例:
   ```js
   { key: 'nsWorkloads', labelKey: 'ns.workloads.title', label: 'Workloads', icon: 'workspaces', columns: [
     { key: 'name', labelKey: 'ns.workloads.thName', label: 'Name' },
     { key: 'type', labelKey: 'ns.workloads.thType', label: 'Type' },
     { key: 'status', labelKey: 'ns.workloads.thStatus', label: 'Status' },
     { key: 'replicas', labelKey: 'ns.workloads.thReplicas', label: 'Replicas' },
     { key: 'image', labelKey: 'ns.workloads.thImage', label: 'Image' },
     { key: 'age', labelKey: 'ns.workloads.thAge', label: 'Age' },
     { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
   ] }
   ```
2. **视图 setup**:加 `import { useTableColumns } from '@/composables/useTableColumns'` + `const { tableColumns } = useTableColumns()` + `const headers = computed(() => tableColumns('<key>'))`。
3. **模板**:把整段 `<table>...</table>` 替换为
   ```vue
   <DataTable :headers="headers" :rows="<paginated>" column-key="<key>" @row-click="<goDetail>">
     <template #name="{ row }"> …原 name 单元格内容… </template>
     <template #status="{ row }"><StatusChip :status="row.status" size="sm" /></template>
     …每个有自定义渲染的列一个具名 slot(纯文本列可不写 slot,DataTable 默认渲染 row[key])…
     <template v-if="<filtered>.length" #pagination><Pagination … /></template>
   </DataTable>
   ```
   保留外层 `rounded-xl` 卡片 div(或交给 DataTable 自带卡片——DataTable 已含卡片样式,可去掉外层 div 避免双层)。
4. **空状态**:DataTable 自带 `!rows.length` 空状态;原视图的「无匹配」文案若不同,可保留为 slot 或接受 DataTable 统一文案。
5. **已用 DataTable 的视图(RBAC/Storage…)**:跳过模板 3,只做 1+2 + 给 `<DataTable>` 加 `column-key` + 把硬编码 `headers` 换成 `tableColumns(key)`(单元格 slot 已是现成的,不动)。

## 测试策略(轻量,复用现成安全网)

- `_allViewsMount.test.js`(main 已有,挂载全部 73 视图)→ 迁移后每个视图必须仍能挂载。这是主回归网。
- `npm run typecheck` + `npm run build`(.vue 编译)+ `npm run i18n:check`(labelKey 复用现有键,应 0 新增缺失)。
- `npm run test:unit`(含 catalog 纯逻辑测试 + 挂载套件)全绿。
- 不为每个视图写专属 vitest(挂载依赖重,smoke 套件已覆盖「能否挂载」;列显隐逻辑由 Phase 1 的 catalog/composable 测试覆盖)。

## 批次(SDD 任务)

- **Task 1**:NsWorkloads 迁移(用户痛点 + 模板样板)+ catalog 项 `nsWorkloads`。
- **Task 2**:Ns 配置类组 — NsConfigMaps, NsSecrets, NsEndpoints。
- **Task 3**:Ns 网络类组 — NsServices, NsIngress, NsNetworkPolicies。
- **Task 4**:Ns 调度/策略类组 — NsPDBs, NsHPA, NsLimitRanges, NsResourceQuotas。
- **Task 5**:Ns 其余 — NsStorage, NsEvents。
- **Task 6**:已用 DataTable 组 — RBAC, NsRBAC, Storage, Configuration(加 catalog + column-key + 换 headers)。
- **Task 7**:集群硬编码列表 — CrdList, IngressClasses, PriorityClasses, RuntimeClasses, AuditLogs。
- **Task 8**:全量门禁(typecheck/i18n:check/test/test:unit/build)+ 手测清单 + 收尾。

每任务:catalog 项 + 视图迁移 + 跑 `_allViewsMount`/typecheck/build → 提交。

## Global Constraints

- 不新增外部依赖;复用 Phase 1 机制。
- labelKey **复用视图已有的 `ns.xxx.thYyy` 键**,原则上不新增 i18n(若某列无现成键,补 en+zh)。
- 迁移**只改呈现层**(`<table>`→DataTable + slot),不动数据链路(Vue Query/store)。
- 分支 `feat/custom-columns-phase2`,worktree `.claude/worktrees/custom-columns-p2`。落地时 rebase 到最新 main。
- DataTable 不传 columnKey 时零行为变化(Phase 1 已保证);本 phase 都会传 columnKey。
