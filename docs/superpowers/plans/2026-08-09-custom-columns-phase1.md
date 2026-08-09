# 自定义列 Phase 1(底座升级)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「自定义列」从仅显隐升级为「有序 + 列宽 + 全 i18n + 就地列管理」的底座,5 张已接入表自动受益,不破坏其余视图。

**Architecture:** 抽出纯逻辑核心 `tableColumnsCore.js`(无 vue/vue-i18n,可被零依赖运行器单测);`useTableColumns.js` 在其上加响应式 + useI18n + localStorage(v1→v2 迁移)。新增共享 `ColumnManager.vue`,被 Settings 内联、被 DataTable 弹层复用。DataTable 增量加可选 `columnKey` prop,不传时零行为变化。

**Tech Stack:** Vue 3 + vue-i18n(legacy:false)+ Pinia;测试用自研零依赖运行器(`scripts/test.mjs`)+ vitest/happy-dom/@vue/test-utils。

## 对 spec §6 的一处简化

spec §6 把「解析后的可见列」函数命名为 `columns(tableKey)`。为避免改动 4 个视图的调用名,本计划**保留现有函数名 `tableColumns(tableKey)`**(行为升级:返回带翻译 label + width 的可见列),新增 `allColumns / setOrder / setWidth`。行为与 spec 一致,仅函数名沿用旧名。

## Global Constraints

- **不新增外部依赖**:vue / vue-i18n / @vue/test-utils / vitest / happy-dom 已是 CLAUDE.md 登记例外;不得再引新依赖。
- **测试分工**:纯逻辑 → `scripts/test.mjs`(自研零依赖运行器,`node:assert`);组件交互 → vitest(happy-dom + @vue/test-utils,`globals:false` 故需 `import { test, expect, vi } from 'vitest'`)。
- **i18n**:en.json 与 zh.json 必须同步;`npm run i18n:check` 三项门禁(残留中文 0 / 键对齐 / 引用键缺失 0)全过。
- **类型/语法**:`npm run typecheck`(`node --check` 全 .js/.mjs)过;`.vue` 由 `npm run build` 覆盖。
- **DataTable 向后兼容**:不传 `columnKey` 时行为与今天**完全一致**(波及 12 个视图,必须零回归)。
- **分支**:全程在 `feat/custom-columns-phase1`(已建)。提交前 `git branch --show-current` 确认。

---

## 文件结构

| 文件 | 责任 | 类型 |
|------|------|------|
| `src/composables/tableColumnsCore.js` | 纯逻辑:`STORAGE_KEY*`、`TABLE_CATALOG`(labelKey+label)、`migrateV1toV2`、`reconcileColumns`。无 vue/vue-i18n。 | 新增 |
| `src/composables/useTableColumns.js` | 响应式 + useI18n + localStorage(v1→v2 迁移)包装层;对外 API。 | 重写 |
| `src/components/common/ColumnManager.vue` | 共享列管理 UI:勾选 + 拖拽排序 + 上/下兜底 + 重置。props:`tableKey`。 | 新增 |
| `src/components/common/DataTable.vue` | 加 `columnKey` prop → ☰ 弹层 + 列宽应用 + 边缘拖拽 + 空列守卫。不传则不变。 | 改 |
| `src/views/Settings.vue` | `customcols` tab 改为内联 `<ColumnManager>` 逐表渲染。 | 改(小) |
| `src/views/Nodes.vue` `Workloads.vue` `Namespaces.vue` `Network.vue` | 给现有 `<DataTable>` 补 `:column-key`。 | 改(极小) |
| `src/locales/en.json` `src/locales/zh.json` | 补 `cols.*` 与 `settings.columnManager/dragHint/moveUp/moveDown`。 | 改 |
| `scripts/test.mjs` | 追加 `migrateV1toV2` / `reconcileColumns` 纯逻辑用例。 | 改 |

---

### Task 1: 纯逻辑核心 `tableColumnsCore.js` + 零依赖单测

**Files:**
- Create: `src/composables/tableColumnsCore.js`
- Modify: `scripts/test.mjs`(顶部新增 import + 文件末尾结果打印前追加用例)

**Interfaces:**
- Produces: `STORAGE_KEY='aliangboard.tableColumns.v2'`、`STORAGE_KEY_V1='aliangboard.tableColumns.v1'`、`TABLE_CATALOG`(数组,每项 `{ key, labelKey, label, icon, columns: [{ key, labelKey, label, align? }] }`)、`migrateV1toV2(v1: object) => v2: object`、`reconcileColumns(catalogColumns: array, overrides?: { order?, hidden?, width? }) => { ordered: array, visible: array }`。ordered/visible 元素形如 `{ ...catalogCol, hidden: boolean, width?: number }`。

- [ ] **Step 1: 写失败测试(追加到 `scripts/test.mjs`)**

在 `scripts/test.mjs` 顶部 import 区追加:

```js
import { migrateV1toV2, reconcileColumns, STORAGE_KEY, STORAGE_KEY_V1 } from '../src/composables/tableColumnsCore.js'
```

在文件中已有用例之后(结果汇总打印之前)追加:

```js
// --- 自定义列核心:迁移 v1→v2 ---
test('migrateV1toV2: false 标记转 hidden,其它丢弃', () => {
  const v1 = { nodes: { system: false, pods: false, name: true }, workloads: { namespace: false } }
  const v2 = migrateV1toV2(v1)
  assert.deepStrictEqual(v2, {
    nodes: { hidden: { system: true, pods: true } },     // name:true 非 false → 不计入
    workloads: { hidden: { namespace: true } },
  })
})
test('migrateV1toV2: 非对象/空 → {}', () => {
  assert.deepStrictEqual(migrateV1toV2(null), {})
  assert.deepStrictEqual(migrateV1toV2({}), {})
  assert.deepStrictEqual(migrateV1toV2('x'), {})
})
test('migrateV1toV2: 全显示的表不产出空 hidden', () => {
  assert.deepStrictEqual(migrateV1toV2({ nodes: { name: true } }), {})
})

// --- 自定义列核心:reconcile 对账 ---
const CAT = [
  { key: 'a', labelKey: 'x.a', label: 'A' },
  { key: 'b', labelKey: 'x.b', label: 'B' },
  { key: 'c', labelKey: 'x.c', label: 'C' },
]
test('reconcile: 无 overrides → 默认序全可见', () => {
  const r = reconcileColumns(CAT)
  assert.deepStrictEqual(r.ordered.map(x => x.key), ['a', 'b', 'c'])
  assert.deepStrictEqual(r.visible.map(x => x.key), ['a', 'b', 'c'])
  assert.equal(r.ordered[0].hidden, false)
})
test('reconcile: order 重排,未列入的按默认序追加到末尾', () => {
  const r = reconcileColumns(CAT, { order: ['c', 'a'] })  // b 未列入
  assert.deepStrictEqual(r.ordered.map(x => x.key), ['c', 'a', 'b'])
})
test('reconcile: order 含已删除的 key 被忽略,不报错', () => {
  const r = reconcileColumns(CAT, { order: ['b', 'ghost', 'a'] })
  assert.deepStrictEqual(r.ordered.map(x => x.key), ['b', 'a', 'c'])
})
test('reconcile: hidden 过滤 visible,ordered 仍含全部并带标记', () => {
  const r = reconcileColumns(CAT, { hidden: { b: true } })
  assert.deepStrictEqual(r.visible.map(x => x.key), ['a', 'c'])
  assert.equal(r.ordered.find(x => x.key === 'b').hidden, true)
  assert.equal(r.ordered.find(x => x.key === 'a').hidden, false)
})
test('reconcile: width 合并到列上', () => {
  const r = reconcileColumns(CAT, { width: { a: 200 } })
  assert.equal(r.ordered.find(x => x.key === 'a').width, 200)
  assert.equal(r.ordered.find(x => x.key === 'b').width, undefined)
})
test('reconcile: catalog 新增列自动出现在末尾(老配置前向兼容)', () => {
  const r = reconcileColumns(CAT, { order: ['a', 'b'], hidden: { a: true } })
  // 新列 c 不在老 order → 末尾;且默认可见
  assert.deepStrictEqual(r.visible.map(x => x.key), ['b', 'c'])
})
test('reconcile: 容错非法 overrides', () => {
  const r = reconcileColumns(CAT, { order: 'nope', hidden: null, width: 3 })
  assert.deepStrictEqual(r.ordered.map(x => x.key), ['a', 'b', 'c'])
})

test('STORAGE_KEY 为 v2', () => {
  assert.equal(STORAGE_KEY, 'aliangboard.tableColumns.v2')
  assert.equal(STORAGE_KEY_V1, 'aliangboard.tableColumns.v1')
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test.mjs`
Expected: 新增用例 FAIL(`Cannot find module ... tableColumnsCore.js`)。

- [ ] **Step 3: 实现 `src/composables/tableColumnsCore.js`**

```js
// 表格自定义列 —— 纯逻辑核心(无 vue / 无 vue-i18n,可被 node 零依赖运行器单测)。
// TABLE_CATALOG 是各 DataTable 视图列定义的「单一事实源」;labelKey 指向 i18n 键,
// label 为英文兜底。useTableColumns.js 在此之上加响应式 + i18n + localStorage。

export const STORAGE_KEY_V1 = 'aliangboard.tableColumns.v1'
export const STORAGE_KEY = 'aliangboard.tableColumns.v2'

export const TABLE_CATALOG = [
  {
    key: 'nodes', labelKey: 'cols.nodes._t', label: 'Nodes', icon: 'dns',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'roles', labelKey: 'cols.nodes.roles', label: 'Role' },
      { key: 'system', labelKey: 'cols.nodes.system', label: 'System' },
      { key: 'cpu', labelKey: 'cols.nodes.cpu', label: 'CPU' },
      { key: 'memory', labelKey: 'cols.nodes.memory', label: 'Memory' },
      { key: 'pods', labelKey: 'cols._c.pods', label: 'Pods' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'workloads', labelKey: 'cols.workloads._t', label: 'Workloads', icon: 'workspaces',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'type', labelKey: 'cols._c.type', label: 'Type' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'replicas', labelKey: 'cols.workloads.replicas', label: 'Replicas' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'namespaces', labelKey: 'cols.namespaces._t', label: 'Namespaces', icon: 'folder',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'status', labelKey: 'cols._c.status', label: 'Status' },
      { key: 'pods', labelKey: 'cols._c.pods', label: 'Pods' },
      { key: 'services', labelKey: 'cols._c.services', label: 'Services' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
      { key: 'actions', labelKey: 'cols._c.actions', label: 'Actions', align: 'right' },
    ],
  },
  {
    key: 'services', labelKey: 'cols.services._t', label: 'Services', icon: 'share',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'type', labelKey: 'cols._c.type', label: 'Type' },
      { key: 'clusterIP', labelKey: 'cols.services.clusterIP', label: 'Cluster IP' },
      { key: 'externalIP', labelKey: 'cols.services.externalIP', label: 'External IP' },
      { key: 'ports', labelKey: 'cols.services.ports', label: 'Ports' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
    ],
  },
  {
    key: 'ingress', labelKey: 'cols.ingress._t', label: 'Ingress', icon: 'router',
    columns: [
      { key: 'name', labelKey: 'cols._c.name', label: 'Name' },
      { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
      { key: 'hosts', labelKey: 'cols.ingress.hosts', label: 'Hosts' },
      { key: 'path', labelKey: 'cols.ingress.path', label: 'Path' },
      { key: 'backend', labelKey: 'cols.ingress.backend', label: 'Backend' },
      { key: 'tls', labelKey: 'cols.ingress.tls', label: 'TLS' },
      { key: 'age', labelKey: 'cols._c.age', label: 'Age' },
    ],
  },
]

// v1: { [tableKey]: { [colKey]: false } } (false = 隐藏)
// v2: { [tableKey]: { order?: string[], hidden?: { [k]: true }, width?: { [k]: number } } }
export function migrateV1toV2(v1) {
  if (!v1 || typeof v1 !== 'object') return {}
  const v2 = {}
  for (const [tableKey, cols] of Object.entries(v1)) {
    if (!cols || typeof cols !== 'object') continue
    const hidden = {}
    for (const [colKey, val] of Object.entries(cols)) {
      if (val === false) hidden[colKey] = true
    }
    if (Object.keys(hidden).length) v2[tableKey] = { hidden }
  }
  return v2
}

// 对账:catalog 为准。order 重排(未列入的 catalog 列按默认序追加到末尾;order 中
// 不存在的 key 忽略);hidden/width 合并。返回 ordered(全量,带标记)+ visible(过滤)。
export function reconcileColumns(catalogColumns, overrides) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {}
  const order = Array.isArray(ov.order) ? ov.order : []
  const hidden = ov.hidden && typeof ov.hidden === 'object' ? ov.hidden : {}
  const width = ov.width && typeof ov.width === 'object' ? ov.width : {}

  const ordered = [...catalogColumns]
  if (order.length) {
    ordered.sort((a, b) => {
      const ia = order.indexOf(a.key)
      const ib = order.indexOf(b.key)
      if (ia === -1 && ib === -1) return 0
      if (ia === -1) return 1   // a 不在 order → 排到后面
      if (ib === -1) return -1  // b 不在 order → 排到后面
      return ia - ib
    })
  }

  const tagged = ordered.map(c => ({
    ...c,
    hidden: hidden[c.key] === true,
    width: typeof width[c.key] === 'number' ? width[c.key] : undefined,
  }))
  return { ordered: tagged, visible: tagged.filter(c => !c.hidden) }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test.mjs`
Expected: 全部用例 PASS(含新增 11 条)。

- [ ] **Step 5: 提交**

```bash
git add src/composables/tableColumnsCore.js scripts/test.mjs
git commit -m "feat(custom-columns): 纯逻辑核心 tableColumnsCore(迁移+对账)+ 零依赖单测

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: i18n 键(en + zh)

**Files:**
- Modify: `src/locales/en.json`
- Modify: `src/locales/zh.json`

**Interfaces:**
- Produces: locales 中新增 `cols` 顶层对象与 `settings.columnManager / dragHint / moveUp / moveDown` 四键,供 Task 3 的 `t(c.labelKey)` 与 Task 4 的 ColumnManager 文案解析。

- [ ] **Step 1: 在 `src/locales/en.json` 顶层对象内新增 `cols` 键,并在 `settings` 段补 4 键**

在 `settings` 段内紧挨 `"reset"` 之后加入:

```json
"columnManager": "Column Manager",
"dragHint": "Drag to reorder",
"moveUp": "Move up",
"moveDown": "Move down",
```

在顶层(与 `common`、`settings` 同级)新增 `cols` 对象:

```json
"cols": {
  "_c": {
    "name": "Name",
    "status": "Status",
    "age": "Age",
    "actions": "Actions",
    "namespace": "Namespace",
    "type": "Type",
    "pods": "Pods",
    "services": "Services"
  },
  "nodes": { "_t": "Nodes", "roles": "Role", "system": "System", "cpu": "CPU", "memory": "Memory" },
  "workloads": { "_t": "Workloads", "replicas": "Replicas" },
  "namespaces": { "_t": "Namespaces" },
  "services": { "_t": "Services", "clusterIP": "Cluster IP", "externalIP": "External IP", "ports": "Ports" },
  "ingress": { "_t": "Ingress", "hosts": "Hosts", "path": "Path", "backend": "Backend", "tls": "TLS" }
}
```

- [ ] **Step 2: 在 `src/locales/zh.json` 做完全对应的中文新增**

`settings` 段内紧挨 `"reset"` 之后:

```json
"columnManager": "列管理",
"dragHint": "拖拽排序",
"moveUp": "上移",
"moveDown": "下移",
```

顶层新增 `cols`:

```json
"cols": {
  "_c": {
    "name": "名称",
    "status": "状态",
    "age": "年龄",
    "actions": "操作",
    "namespace": "命名空间",
    "type": "类型",
    "pods": "Pod 数",
    "services": "服务数"
  },
  "nodes": { "_t": "节点", "roles": "角色", "system": "系统", "cpu": "CPU", "memory": "内存" },
  "workloads": { "_t": "工作负载", "replicas": "副本数" },
  "namespaces": { "_t": "命名空间" },
  "services": { "_t": "服务", "clusterIP": "集群 IP", "externalIP": "外部 IP", "ports": "端口" },
  "ingress": { "_t": "路由", "hosts": "主机", "path": "路径", "backend": "后端", "tls": "TLS" }
}
```

- [ ] **Step 3: 校验 i18n 三项门禁**

Run: `npm run i18n:check`
Expected: 通过(残留中文 0 / en-zh 键对齐 / 引用键缺失 0)。若报某键缺失,核对 Task 1 的 `labelKey` 与此处拼写一致。

- [ ] **Step 4: 提交**

```bash
git add src/locales/en.json src/locales/zh.json
git commit -m "i18n(custom-columns): 补 cols.* 列标签与列管理 UI 文案(en+zh)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 重写 `useTableColumns.js`(响应式 + i18n + v2 迁移)

**Files:**
- Modify(整体重写): `src/composables/useTableColumns.js`
- Test: `src/composables/__tests__/useTableColumns.test.js`(新增,vitest)

**Interfaces:**
- Consumes: Task 1 的 `STORAGE_KEY`、`STORAGE_KEY_V1`、`TABLE_CATALOG`、`migrateV1toV2`、`reconcileColumns`;Task 2 的 i18n 键。
- Produces: `useTableColumns()` 返回 `{ catalog, config, isHidden, tableColumns, allColumns, toggle, setOrder, setWidth, resetTable, resetAll }`。`tableColumns(tableKey)` → 可见列数组(已翻译 label + width);`allColumns(tableKey)` → 全量列(含 `hidden:boolean`、`width?`,已翻译 label)。

- [ ] **Step 1: 写失败测试 `src/composables/__tests__/useTableColumns.test.js`**

```js
import { describe, it, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import { i18n } from '@/i18n'
import { useTableColumns } from '../useTableColumns.js'

// composable 内部用 useI18n,需挂载并提供 i18n 插件;config 为模块单例,每用例前重置。
function withComposable(fn) {
  let captured
  const Test = defineComponent({
    setup() { captured = useTableColumns(); return () => h('div') },
  })
  mount(Test, { global: { plugins: [i18n] } })
  return captured
}

describe('useTableColumns', () => {
  beforeEach(() => {
    localStorage.clear()
    withComposable(c => c.resetAll())
  })

  it('tableColumns: 默认全部可见且 label 已翻译(zh)', () => {
    const c = withComposable()
    const keys = c.tableColumns('nodes').map(x => x.key)
    expect(keys).toEqual(['name', 'status', 'roles', 'system', 'cpu', 'memory', 'pods', 'age', 'actions'])
    expect(c.tableColumns('nodes')[0].label).toBe('名称') // cols._c.name → zh
  })

  it('toggle: 隐藏后再显示,tableColumns 即时反映', async () => {
    const c = withComposable()
    c.toggle('nodes', 'cpu')
    expect(c.tableColumns('nodes').map(x => x.key)).not.toContain('cpu')
    expect(c.allColumns('nodes').find(x => x.key === 'cpu').hidden).toBe(true)
    c.toggle('nodes', 'cpu')
    expect(c.tableColumns('nodes').map(x => x.key)).toContain('cpu')
  })

  it('setOrder: 重排后 tableColumns 顺序变化', () => {
    const c = withComposable()
    c.setOrder('nodes', ['actions', 'name'])
    const keys = c.tableColumns('nodes').map(x => x.key)
    expect(keys.slice(0, 2)).toEqual(['actions', 'name'])
  })

  it('setWidth: 限幅 60–600 并合并到列上,且持久化', () => {
    const c = withComposable()
    c.setWidth('nodes', 'name', 9999)
    expect(c.tableColumns('nodes').find(x => x.key === 'name').width).toBe(600)
    expect(JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2')).nodes.width.name).toBe(600)
  })

  it('resetTable / resetAll: 清回默认', () => {
    const c = withComposable()
    c.toggle('nodes', 'cpu'); c.toggle('workloads', 'type')
    c.resetTable('nodes')
    expect(c.tableColumns('nodes').map(x => x.key)).toContain('cpu')
    expect(c.isHidden('workloads', 'type')).toBe(true)
    c.resetAll()
    expect(c.isHidden('workloads', 'type')).toBe(false)
  })

  it('v1→v2 迁移: 旧 v1 隐藏标记被读为 v2 hidden', () => {
    localStorage.setItem('aliangboard.tableColumns.v1', JSON.stringify({ nodes: { cpu: false } }))
    localStorage.removeItem('aliangboard.tableColumns.v2')
    const c = withComposable()
    expect(c.tableColumns('nodes').map(x => x.key)).not.toContain('cpu')
    expect(JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2')).nodes.hidden.cpu).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/composables/__tests__/useTableColumns.test.js`
Expected: FAIL(`tableColumns is not a function` 或迁移逻辑缺失)。

- [ ] **Step 3: 整体重写 `src/composables/useTableColumns.js`**

```js
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  STORAGE_KEY, STORAGE_KEY_V1, TABLE_CATALOG,
  migrateV1toV2, reconcileColumns,
} from './tableColumnsCore.js'

// 表格「自定义列」:可勾选显隐 / 拖拽排序 / 调列宽,配置持久化到 localStorage(v2),
// 所有视图与 Settings 页共享同一份响应式状态(即时生效)。
//
// 纯逻辑(迁移/对账/列定义)见 tableColumnsCore.js;本文件只做响应式 + i18n + 存取包装。

// 模块级单例:跨组件共享。
const config = ref(loadAndMigrate())

function loadAndMigrate() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) || {}
    const v1raw = localStorage.getItem(STORAGE_KEY_V1)
    if (v1raw) {
      const v2 = migrateV1toV2(JSON.parse(v1raw) || {})
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(v2)) } catch { /* 隐私模式 */ }
      return v2
    }
  } catch { /* 损坏 JSON */ }
  return {}
}
function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(config.value)) } catch { /* 隐私模式 */ }
}

function entryOf(tableKey) {
  return TABLE_CATALOG.find(t => t.key === tableKey)
}

export function useTableColumns() {
  const { t } = useI18n()
  const withLabel = (c) => ({ ...c, label: t(c.labelKey) || c.label })

  function isHidden(tableKey, colKey) {
    return config.value[tableKey]?.hidden?.[colKey] === true
  }
  // 视图用:可见列(有序 + width 合并 + label 已翻译)。
  function tableColumns(tableKey) {
    const entry = entryOf(tableKey)
    if (!entry) return []
    return reconcileColumns(entry.columns, config.value[tableKey]).visible.map(withLabel)
  }
  // ColumnManager 用:全量列(含 hidden 标记 + width + 翻译 label,有序)。
  function allColumns(tableKey) {
    const entry = entryOf(tableKey)
    if (!entry) return []
    return reconcileColumns(entry.columns, config.value[tableKey]).ordered.map(withLabel)
  }
  function toggle(tableKey, colKey) {
    const cur = config.value[tableKey] || {}
    const hidden = { ...(cur.hidden || {}) }
    if (hidden[colKey]) delete hidden[colKey]
    else hidden[colKey] = true
    config.value = { ...config.value, [tableKey]: { ...cur, hidden } }
    persist()
  }
  function setOrder(tableKey, keyArray) {
    const cur = config.value[tableKey] || {}
    config.value = { ...config.value, [tableKey]: { ...cur, order: [...keyArray] } }
    persist()
  }
  function setWidth(tableKey, colKey, px) {
    const cur = config.value[tableKey] || {}
    const width = { ...(cur.width || {}) }
    width[colKey] = Math.max(60, Math.min(600, Math.round(px)))
    config.value = { ...config.value, [tableKey]: { ...cur, width } }
    persist()
  }
  function resetTable(tableKey) {
    const next = { ...config.value }
    delete next[tableKey]
    config.value = next
    persist()
  }
  function resetAll() {
    config.value = {}
    persist()
  }

  return { catalog: TABLE_CATALOG, config, isHidden, tableColumns, allColumns, toggle, setOrder, setWidth, resetTable, resetAll }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/composables/__tests__/useTableColumns.test.js`
Expected: 6 条全 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useTableColumns.js src/composables/__tests__/useTableColumns.test.js
git commit -m "feat(custom-columns): useTableColumns 升级 v2(有序+列宽+i18n+迁移)+ vitest 单测

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 共享组件 `ColumnManager.vue` + 组件测试

**Files:**
- Create: `src/components/common/ColumnManager.vue`
- Test: `src/components/common/__tests__/ColumnManager.test.js`(新增)

**Interfaces:**
- Consumes: Task 3 的 `useTableColumns`(`allColumns / toggle / setOrder / resetTable`)+ Task 2 的 `settings.columnManager / dragHint / moveUp / moveDown / reset`。
- Produces: `<ColumnManager :table-key="...">`,渲染勾选列表(拖拽 + 上/下按钮排序 + 重置)。被 Settings 内联、被 Task 5 的 DataTable 弹层内嵌。

- [ ] **Step 1: 写失败测试 `src/components/common/__tests__/ColumnManager.test.js`**

```js
import { test, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import { useTableColumns } from '@/composables/useTableColumns'
import ColumnManager from '@/components/common/ColumnManager.vue'

beforeEach(() => {
  localStorage.clear()
  const c = useTableColumns() // 仅用于 reset;不挂载,无 i18n 依赖副作用
  // useTableColumns 内部 useI18n 仅在 setup 调用时执行,这里跳过;直接清 localStorage 已足够
  localStorage.removeItem('aliangboard.tableColumns.v2')
})

test('ColumnManager: 勾掉 CPU → 调 toggle,列表反映隐藏', async () => {
  const wrapper = mount(ColumnManager, { props: { tableKey: 'nodes' }, global: { plugins: [i18n] } })
  const cpuLabel = wrapper.findAll('label').find(l => l.text().includes('CPU'))
  expect(cpuLabel).toBeTruthy()
  await cpuLabel.find('input[type=checkbox]').setValue(false)
  // 重新读取 allColumns:CPU 应标记隐藏
  const { allColumns } = useTableColumns()
  // 注意:useTableColumns 在测试上下文直接调用会缺 i18n;改为校验 localStorage 落库
  const persisted = JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2'))
  expect(persisted.nodes.hidden.cpu).toBe(true)
})

test('ColumnManager: 点击下移 → setOrder 改变顺序并落库', async () => {
  const wrapper = mount(ColumnManager, { props: { tableKey: 'nodes' }, global: { plugins: [i18n] } })
  // 第一项的下移按钮(title="下移")
  const moveDownBtn = wrapper.findAll('button').find(b => b.attributes('title') === '下移')
  expect(moveDownBtn).toBeTruthy()
  await moveDownBtn.trigger('click')
  const persisted = JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2'))
  expect(Array.isArray(persisted.nodes.order)).toBe(true)
  expect(persisted.nodes.order[0]).toBe('status') // 原 name 下移 → status 升到首位
})

test('ColumnManager: 点击重置 → 清空该表 overrides', async () => {
  // 先写入一条 override
  localStorage.setItem('aliangboard.tableColumns.v2', JSON.stringify({ nodes: { hidden: { cpu: true } } }))
  const wrapper = mount(ColumnManager, { props: { tableKey: 'nodes' }, global: { plugins: [i18n] } })
  await wrapper.find('button.border-outline-variant').trigger('click') // 重置按钮
  const persisted = JSON.parse(localStorage.getItem('aliangboard.tableColumns.v2') || '{}')
  expect(persisted.nodes).toBeUndefined()
})
```

> 说明:`useTableColumns` 在测试里直接调用会因缺 setup 上下文报 useI18n 错,因此断言走 **localStorage 落库** 这条客观事实,绕开 i18n 上下文依赖。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/common/__tests__/ColumnManager.test.js`
Expected: FAIL(组件不存在)。

- [ ] **Step 3: 实现 `src/components/common/ColumnManager.vue`**

```vue
<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTableColumns } from '@/composables/useTableColumns'

const props = defineProps({
  tableKey: { type: String, required: true },
})

const { t } = useI18n()
const { allColumns, toggle, setOrder, resetTable } = useTableColumns()

const cols = computed(() => allColumns(props.tableKey))
const dragOverKey = ref(null)
let dragFromKey = null

function onDragStart(e, key) {
  dragFromKey = key
  e.dataTransfer.effectAllowed = 'move'
}
function onDragOver(e, key) {
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  dragOverKey.value = key
}
function onDrop(e, key) {
  e.preventDefault()
  dragOverKey.value = null
  if (dragFromKey && dragFromKey !== key) {
    const keys = cols.value.map(c => c.key)
    const from = keys.indexOf(dragFromKey)
    const to = keys.indexOf(key)
    if (from !== -1 && to !== -1) {
      keys.splice(to, 0, keys.splice(from, 1)[0])
      setOrder(props.tableKey, keys)
    }
  }
  dragFromKey = null
}
function move(key, dir) {
  const keys = cols.value.map(c => c.key)
  const i = keys.indexOf(key)
  const j = i + dir
  if (i !== -1 && j >= 0 && j < keys.length) {
    keys.splice(j, 0, keys.splice(i, 1)[0])
    setOrder(props.tableKey, keys)
  }
}
</script>

<template>
  <div class="w-full">
    <div class="flex items-center justify-between mb-sm">
      <span class="text-body-sm font-semibold">{{ t('settings.columnManager') }}</span>
      <button
        @click="resetTable(props.tableKey)"
        class="px-2 py-1 border border-outline-variant rounded-md text-xs text-on-surface-variant hover:bg-surface-container"
      >{{ t('settings.reset') }}</button>
    </div>
    <ul class="space-y-xs">
      <li
        v-for="c in cols"
        :key="c.key"
        draggable="true"
        @dragstart="onDragStart($event, c.key)"
        @dragover="onDragOver($event, c.key)"
        @drop="onDrop($event, c.key)"
        class="flex items-center gap-sm px-sm py-xs rounded-md border cursor-grab active:cursor-grabbing transition-colors"
        :class="dragOverKey === c.key ? 'border-primary bg-primary-container/10' : (c.hidden ? 'border-outline-variant bg-surface-container-low' : 'border-outline-variant/60 bg-surface-container-lowest')"
      >
        <span class="material-symbols-outlined text-sm text-on-surface-variant select-none" :title="t('settings.dragHint')">drag_indicator</span>
        <label class="flex items-center gap-xs flex-1 cursor-pointer">
          <input
            type="checkbox"
            :checked="!c.hidden"
            @change="toggle(props.tableKey, c.key)"
            class="accent-[var(--md-sys-color-primary)]"
          />
          <span class="text-xs" :class="c.hidden ? 'text-on-surface-variant line-through' : 'text-on-surface'">{{ c.label }}</span>
        </label>
        <button @click="move(c.key, -1)" :title="t('settings.moveUp')" class="p-xs text-on-surface-variant hover:text-primary rounded">▲</button>
        <button @click="move(c.key, 1)" :title="t('settings.moveDown')" class="p-xs text-on-surface-variant hover:text-primary rounded">▼</button>
      </li>
    </ul>
  </div>
</template>
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run src/components/common/__tests__/ColumnManager.test.js`
Expected: 3 条全 PASS。若「下移」断言顺序不符,核对 `cols` 默认序首项后调整断言中的预期 key(以实际 catalog 默认序为准:`name` 下移 → `status` 升首)。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/ColumnManager.vue src/components/common/__tests__/ColumnManager.test.js
git commit -m "feat(custom-columns): 共享 ColumnManager(勾选+拖拽/上下排序+重置)+ 组件测试

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: `DataTable.vue` 加 `columnKey`(☰ 弹层 + 列宽 + 空列守卫)

**Files:**
- Modify(整体替换内容): `src/components/common/DataTable.vue`
- Test: `src/components/common/__tests__/DataTable.columnKey.test.js`(新增)

**Interfaces:**
- Consumes: Task 3 的 `useTableColumns`(`setWidth`,供列宽拖拽回写);Task 4 的 `ColumnManager`(弹层内容)。
- Produces: `DataTable` 新增可选 prop `columnKey: String`。传入 → 渲染表头末尾 `☰` 单元格 + 弹层 + 列宽拖拽手柄 + 应用 `header.width`;不传 → 与今天行为完全一致。视图传 `:headers` 仍来自 `tableColumns()`(已带 width/翻译)。

- [ ] **Step 1: 写失败测试 `src/components/common/__tests__/DataTable.columnKey.test.js`**

```js
import { test, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'
import DataTable from '@/components/common/DataTable.vue'

beforeEach(() => { localStorage.clear(); localStorage.removeItem('aliangboard.tableColumns.v2') })

const HEADERS = [
  { key: 'name', label: '名称' },
  { key: 'status', label: '状态' },
]

test('DataTable: 不传 columnKey → 无列管理按钮(向后兼容)', () => {
  const wrapper = mount(DataTable, { props: { headers: HEADERS, rows: [{ name: 'a', status: 'ok' }] }, global: { plugins: [i18n] } })
  expect(wrapper.find('[data-col-manager]').exists()).toBe(false)
  expect(wrapper.findAll('th').length).toBe(2) // 仅两列,无额外 ☰ th
})

test('DataTable: 传 columnKey → 出现 ☰ 按钮,点击展开 ColumnManager 弹层', async () => {
  const wrapper = mount(DataTable, { props: { headers: HEADERS, rows: [{ name: 'a', status: 'ok' }], columnKey: 'nodes' }, global: { plugins: [i18n] } })
  expect(wrapper.find('[data-col-manager]').exists()).toBe(true)
  expect(wrapper.text()).not.toContain('列管理')
  await wrapper.find('[data-col-manager]').trigger('click')
  expect(wrapper.text()).toContain('列管理') // ColumnManager 标题
})

test('DataTable: header.width 被应用到 th style', () => {
  const wrapper = mount(DataTable, {
    props: { headers: [{ key: 'name', label: '名称', width: 200 }, { key: 'status', label: '状态' }], rows: [] },
    global: { plugins: [i18n] },
  })
  const ths = wrapper.findAll('th')
  expect(ths[0].attributes('style')).toContain('width: 200px')
  expect(ths[1].attributes('style') || '').not.toContain('width:')
})

test('DataTable: 可见列为 0 → 渲染空状态而非空表', () => {
  const wrapper = mount(DataTable, { props: { headers: [], rows: [{ name: 'a' }] }, global: { plugins: [i18n] } })
  expect(wrapper.text()).toContain('暂无数据') // common.noData 的 zh 文案
})
```

> 若 `common.noData` 的 zh 文案不是「暂无数据」,以 `src/locales/zh.json` 实际值为准调整断言(先读该键再写断言)。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run src/components/common/__tests__/DataTable.columnKey.test.js`
Expected: FAIL(无 `data-col-manager`、无 width 应用、无空列守卫)。

- [ ] **Step 3: 先读 `src/locales/zh.json` 的 `common.noData` 实际值,校准 Step 1 第 4 条断言**

Run: `node -e "console.log(require('./src/locales/zh.json').common.noData)"`
Expected: 打印实际文案;若与「暂无数据」不同,回到 Step 1 第 4 条测试改对。

- [ ] **Step 4: 整体替换 `src/components/common/DataTable.vue`**

```vue
<script setup>
import { ref, computed } from 'vue'
import { useTableColumns } from '@/composables/useTableColumns'
import ColumnManager from '@/components/common/ColumnManager.vue'

const props = defineProps({
  headers: { type: Array, required: true },
  rows: { type: Array, required: true },
  columnKey: { type: String, default: '' },
})

defineEmits(['row-click'])

const { setWidth } = useTableColumns()

// 列管理弹层
const mgrOpen = ref(false)
function toggleMgr() { mgrOpen.value = !mgrOpen.value }

// 列宽拖拽
let resizing = null // { key, startX, startW }
function startResize(e, key) {
  if (!props.columnKey) return
  const th = e.currentTarget.parentElement
  resizing = { key, startX: e.clientX, startW: th.getBoundingClientRect().width }
  e.preventDefault()
  e.stopPropagation()
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
function onMove(e) {
  if (!resizing) return
  const next = resizing.startW + (e.clientX - resizing.startX)
  setWidth(props.columnKey, resizing.key, next)
}
function onUp() {
  resizing = null
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerup', onUp)
}

const thStyle = (h) => h.width ? { width: h.width + 'px', minWidth: h.width + 'px' } : {}
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
    <div class="overflow-x-auto">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th
              v-for="header in headers"
              :key="header.key"
              class="relative px-lg py-md text-label-caps text-on-surface-variant whitespace-nowrap"
              :class="header.align === 'right' ? 'text-right' : ''"
              :style="thStyle(header)"
            >
              {{ header.label }}
              <span
                v-if="columnKey"
                @pointerdown="startResize($event, header.key)"
                class="absolute top-0 right-0 h-full w-1 cursor-col-resize hover:bg-primary/30"
                :title="$t('settings.dragHint')"
              ></span>
            </th>
            <!-- 列管理入口(仅 columnKey 时) -->
            <th v-if="columnKey" class="px-sm py-md w-10 text-right">
              <div class="relative inline-block">
                <button
                  data-col-manager
                  @click="toggleMgr"
                  class="material-symbols-outlined text-base text-on-surface-variant hover:text-primary p-xs rounded"
                  :title="$t('settings.columnManager')"
                >view_column</button>
                <div v-if="mgrOpen" class="absolute right-0 top-full mt-xs z-50 w-64 p-md bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card">
                  <button @click="toggleMgr" class="absolute top-xs right-xs material-symbols-outlined text-base text-on-surface-variant hover:text-primary">close</button>
                  <ColumnManager :table-key="columnKey" />
                </div>
              </div>
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <tr
            v-for="(row, idx) in rows"
            :key="idx"
            class="hover:bg-surface-container-low/50 transition-colors group cursor-pointer"
            @click="$emit('row-click', row)"
          >
            <td
              v-for="header in headers"
              :key="header.key"
              class="px-lg py-md text-body-md"
              :class="header.align === 'right' ? 'text-right' : ''"
            >
              <slot :name="header.key" :row="row" :value="row[header.key]">
                <span>{{ row[header.key] }}</span>
              </slot>
            </td>
            <td v-if="columnKey" class="px-sm"></td>
          </tr>
          <!-- 空状态:无行 或 无可见列 -->
          <tr v-if="!rows.length || !headers.length">
            <td :colspan="Math.max(headers.length, 1) + (columnKey ? 1 : 0)" class="px-lg py-xl text-center">
              <span class="material-symbols-outlined text-4xl text-surface-container-high block mb-sm">inbox</span>
              <p class="text-on-surface-variant">{{ $t('common.noData') }}</p>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="$slots.pagination" class="px-lg py-md bg-surface-container-low border-t border-outline-variant flex justify-between items-center">
      <slot name="pagination" />
    </div>
  </div>
</template>
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run src/components/common/__tests__/DataTable.columnKey.test.js`
Expected: 4 条全 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/components/common/DataTable.vue src/components/common/__tests__/DataTable.columnKey.test.js
git commit -m "feat(custom-columns): DataTable 加 columnKey(☰弹层+列宽拖拽+空列守卫),不传零变化

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 接线视图(4 视图补 column-key)+ Settings 改用 ColumnManager

**Files:**
- Modify: `src/views/Nodes.vue`(DataTable 加 `:column-key="'nodes'"`)
- Modify: `src/views/Workloads.vue`(同上,`'workloads'`)
- Modify: `src/views/Namespaces.vue`(同上,`'namespaces'`)
- Modify: `src/views/Network.vue`(两个 DataTable:services → `'services'`,ingress → `'ingress'`)
- Modify: `src/views/Settings.vue`(`customcols` tab 内容替换为逐表内联 `<ColumnManager>`)

**Interfaces:**
- Consumes: Task 3 的 `useTableColumns().catalog`、Task 4 的 `ColumnManager`。
- 说明:视图的 `headers` 仍由 `tableColumns(key)` 计算(契约不变,仅 label/width 升级)。本任务**不改函数名、不改数据流**,只给 `<DataTable>` 加一个 prop,并替换 Settings 的一段模板。

- [ ] **Step 1: 4 个视图各给 `<DataTable>` 加 `:column-key`**

对每个视图,找到现有 `<DataTable :headers="..." :rows="..." ...>`,新增属性:

- `src/views/Nodes.vue`(`<DataTable :headers="headers" ...>`,约第 83 行):加 `column-key="nodes"`
- `src/views/Workloads.vue`:加 `column-key="workloads"`
- `src/views/Namespaces.vue`:加 `column-key="namespaces"`
- `src/views/Network.vue`:services 表加 `column-key="services"`,ingress 表加 `column-key="ingress"`

示例(Nodes.vue):
```vue
<DataTable :headers="headers" :rows="paginated" column-key="nodes" @row-click="(row) => router.push(`/nodes/${row.name}`)">
```

- [ ] **Step 2: 改 `src/views/Settings.vue` 的 `customcols` tab**

先确认顶部已 import(现有):`const { catalog, isHidden, toggle, resetTable, resetAll } = useTableColumns()`。改为只取需要项并引入 ColumnManager:

把 `<script setup>` 中那行替换为:
```js
const { catalog, resetAll } = useTableColumns()
```

并在 Settings.vue 顶部 import 区加:
```js
import ColumnManager from '@/components/common/ColumnManager.vue'
```

把模板中 `<!-- Custom Columns -->` 整块(约第 248–277 行,从 `<div v-if="activeTab === 'customcols'" ...>` 到其闭合 `</div>`)替换为:

```vue
<!-- Custom Columns -->
<div v-if="activeTab === 'customcols'" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
  <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
    <div class="flex items-center gap-sm">
      <span class="material-symbols-outlined text-primary text-lg">view_column</span>
      <span class="text-body-sm font-semibold">{{ t('settings.customDisplay') }}</span>
    </div>
    <button @click="resetAll" class="px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium text-on-surface-variant hover:bg-surface-container">{{ t('settings.resetAll') }}</button>
  </div>
  <div class="p-md space-y-md">
    <p class="text-xs text-on-surface-variant">{{ t('settings.customDisplayDesc') }}</p>
    <div v-for="tbl in catalog" :key="tbl.key" class="border border-outline-variant/60 rounded-lg p-md">
      <div class="flex items-center gap-sm mb-sm">
        <span class="material-symbols-outlined text-primary text-sm">{{ tbl.icon }}</span>
        <span class="text-body-sm font-semibold">{{ t(tbl.labelKey) || tbl.label }}</span>
      </div>
      <ColumnManager :table-key="tbl.key" />
    </div>
  </div>
</div>
```

- [ ] **Step 3: 类型/语法 + i18n 门禁**

Run: `npm run typecheck && npm run i18n:check`
Expected: 两项均通过。若 typecheck 报某 `.vue`,通常是语法错,按提示修。

- [ ] **Step 4: 提交**

```bash
git add src/views/Nodes.vue src/views/Workloads.vue src/views/Namespaces.vue src/views/Network.vue src/views/Settings.vue
git commit -m "feat(custom-columns): 接线 4 视图 column-key + Settings 改用 ColumnManager

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: 全量验证 + 手测清单

**Files:**
- 无代码改动;仅运行门禁并记录手测要点。

- [ ] **Step 1: 全量自动化门禁**

Run(逐条,确认全绿):
```bash
npm run typecheck
npm run i18n:check
npm test            # server 零依赖 + node --test
npm run test:unit   # vitest 全量
npm run build       # 覆盖 .vue 编译
```
Expected: 五项全部成功。任一失败:定位到具体任务回退修复,不要放过。

- [ ] **Step 2: 手测清单(在 `npm run dev` 下,中文 locale)**

- [ ] Nodes 页:表头末尾出现 `☰`;点开弹层,勾掉「CPU」→ 列消失;再勾选 → 回来。刷新页面仍保持。
- [ ] 拖拽弹层里某列到新位置 → 表头顺序变化;用 ▲/▼ 按钮也能调序。
- [ ] 拖动某列表头右边缘 → 列宽变化,刷新保持(限幅 60–600)。
- [ ] Workloads / Namespaces / Network(services+ingress)同样可就地管理。
- [ ] Settings → 自定义列 tab:每张表内联列管理,「全部重置」清空所有;切换中/英文,列头与弹层文案随之变化(验证 i18n)。
- [ ] 其余未接 catalog 的 DataTable 视图(如 RBAC / Storage / ApiKeyManagement)与硬编码 `<table>` 视图:外观与操作**与改前一致**(向后兼容)。
- [ ] 隐私模式(禁 localStorage)下不报错(静默降级)。

- [ ] **Step 3: 收尾**

确认分支:`git branch --show-current` 应为 `feat/custom-columns-phase1`。汇总本 phase 已完成,提示可发起 PR 或继续 Phase 2(覆盖扩张,须与 Vue Query 重构错开)。

---

## Self-Review(写完后自查记录)

- **Spec 覆盖**:数据模型 v2 + 对账 + 迁移(Task 1、3)✓;catalog i18n(Task 1 labelKey + Task 2 键)✓;就地列管理 ☰ 单栏弹层(Task 4、5)✓;拖拽排序(Task 4)✓;列宽(Task 5)✓;Settings 适配(Task 6)✓;4 视图接线(Task 6)✓;table-layout auto 取舍(Task 5 width 用 th style,不切 fixed)✓;空列守卫(Task 5)✓;向后兼容(Task 5 不传 columnKey 分支 + Task 7 手测)✓;测试分工(零依赖 Task 1 + vitest Task 3/4/5)✓。
- **占位符扫描**:无 TBD/TODO;每步含可执行命令或完整代码。
- **类型/命名一致**:`tableColumns / allColumns / toggle / setOrder / setWidth / resetTable / resetAll` 在 Task 3 定义、Task 4/5/6 消费,签名一致;`STORAGE_KEY / STORAGE_KEY_V1` 在 Task 1 定义、Task 3 消费,一致;`labelKey` 命名 `cols._c.* / cols.<t>._t / cols.<t>.<col>` 在 Task 1 与 Task 2 逐键对齐。
- **已知取舍(不阻塞)**:① width 在 `table-layout:auto` 下偏软(spec §7 已接受)。② 原生 `draggable` 触屏体验一般(补 ▲/▼ 兜底)。③ ColumnManager 组件测试用 localStorage 落库断言以绕开 useI18n 上下文依赖,已在 Task 4 注明。
