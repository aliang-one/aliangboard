# 手机适配 Wave 1b 实施计划(DataTable 卡片/下拉 bottom sheet/hover 常显/触控目标/navTo 收编)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 通用组件层手机原生习语化——表格变卡片、下拉变 bottom sheet、hover 动作常显、触控目标 ≥40px——32 个 DataTable 消费方与全部下拉/列表动作在手机上真正可用。

**Architecture:** 全部结构性切换消费 Wave 1a 的 `useIsPhone()`(`v-if` 分支,slot 单渲染);DataTable 卡片模式实现在组件内部(复用既有列 slot,消费方零改动);DropdownMenu 手机档呈现为 bottom sheet(锚定样式换固定底板,层级仍 Z.popover);hover 常显=6 文件加 `max-sm:opacity-100` + overflow-guard V4 静态守卫防新增;navTo 收编 SideNavBar 全部裸 router.push 点击入口。

**Tech Stack:** Vue 3 `<script setup>` + vitest(happy-dom) + tailwind `max-sm:` + 零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md` §4(组件触屏化/§4.1 卡片模式)、§6(测试守卫)。

## Global Constraints

- 禁止新增任何 npm 依赖;提交作者恒 `aliangone <aliangone@gmail.com>`、禁止 Co-Authored-By 尾注。
- 结构性切换用 `useIsPhone()` 的 `v-if`;同一份列 slot **不得双渲染**(spec §4.1 拒绝 CSS 双渲染)。
- 浮层 z 一律 zScale 取值(overflow-guard V3 已强制 `z-[N]` 魔数禁令);触控目标 ≥40px 只调 padding/min 尺寸,**不改字号体系**。
- 桌面/iPad 档行为零回归:每个组件任务的测试必须含桌面分支不变断言。
- truncate 一律按 CLAUDE.md「组件文本溢出治理」配方(列向 w-full/max-w、行向 min-w-0)。
- docs/superpowers 被 gitignore,git add 需 `-f`。
- 每任务 TDD(失败测试→最小实现→跑绿→commit);工作分支 `worktree-feat-mobile-1b`。

---

### Task 1: DataTable 卡片模式(核心)

**Files:**
- Modify: `src/components/common/DataTable.vue`(script 引 isPhone + titleKey/kvHeaders;template 拆桌面/手机双分支)
- Test: `src/components/common/__tests__/DataTable.card.test.js`(新建)

**Interfaces:**
- Consumes: `useIsPhone()` → `{ isPhone }`(Wave 1a)。
- Produces: 手机档 `<640` 一切 DataTable 消费方(32 视图)自动卡片化,列 slot 原样复用;桌面分支 DOM 与现状完全一致。

- [ ] **Step 1: 写失败测试**(新建文件;mount 前置 mock 参照 `SideNavBar.drawer.test.js` 的 matchMedia spy 模式)

```js
import { test, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DataTable from '@/components/common/DataTable.vue'

afterEach(() => { vi.restoreAllMocks() })
function mockViewport(belowSm) {
  return vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)' ? belowSm : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}
const headers = [
  { key: 'name', label: '名称' },
  { key: 'status', label: '状态' },
  { key: 'age', label: '年龄', align: 'right' },
]
const rows = [{ name: 'web-0', status: 'Running', age: '2d' }]

async function mountTable(props = {}, slots = {}) {
  const w = mount(DataTable, { props: { headers, rows, ...props }, slots, global: {} })
  await nextTick()
  return w
}

test('手机档:渲染卡片不渲染 table;首列 slot 作标题,其余列键值行复用同一 slot', async () => {
  mockViewport(true)
  const w = await mountTable({}, {
    name: '<b class="slot-name">{{ params.row.name }}</b>',
    status: '<i class="slot-status">{{ params.row.status }}</i>',
  })
  expect(w.find('table').exists()).toBe(false)
  expect(w.findAll('[data-card-row]')).toHaveLength(1)
  expect(w.find('.slot-name').text()).toBe('web-0')
  expect(w.find('.slot-status').text()).toBe('Running')
  // 键值行:非首列渲染「列名+slot 值」;首列不得重复出现在键值区
  const labels = w.findAll('[data-kv-label]').map(x => x.text())
  expect(labels).toEqual(['状态', '年龄'])
  w.unmount()
})

test('手机档:无自定义 slot 的列走 fallback 文本;fallback 缺失时首列仍在标题', async () => {
  mockViewport(true)
  const w = await mountTable()
  expect(w.find('[data-card-title]').text()).toBe('web-0')
  const kv = w.findAll('[data-kv-row]').map(x => x.text())
  expect(kv[0]).toContain('状态')
  expect(kv[0]).toContain('Running')
  w.unmount()
})

test('手机档:row-click 点卡片主体触发;checkbox/expand 点击 .stop 不触发 row-click', async () => {
  mockViewport(true)
  const w = await mountTable({ selectable: true, expandable: true, rowKey: 'name' }, {
    expanded: '<div class="expanded-body">详情</div>',
  })
  await w.find('[data-card-row]').trigger('click')
  expect(w.emitted('row-click')).toHaveLength(1)
  await w.find('input[data-card-select]').trigger('click')
  expect(w.emitted('row-click')).toHaveLength(1)
  expect(w.emitted('update:selection')[0][0]).toEqual([rows[0]])
  await w.find('[data-card-expand]').trigger('click')
  expect(w.emitted('row-click')).toHaveLength(1)
  expect(w.find('.expanded-body').exists()).toBe(true)
  w.unmount()
})

test('手机档:分页 slot 与空状态照常;桌面档无任何卡片 DOM', async () => {
  mockViewport(true)
  const w = await mountTable({}, { pagination: '<div class="pager">1 / 1</div>' })
  expect(w.find('.pager').exists()).toBe(true)
  w.unmount()
  const empty = await mountTable({ rows: [] })
  expect(empty.text()).toContain('暂无数据')
  empty.unmount()

  mockViewport(false)
  const d = await mountTable({ selectable: true }, {
    name: '<b class="slot-name">x</b>',
    pagination: '<div class="pager">1 / 1</div>',
  })
  expect(d.find('table').exists()).toBe(true)
  expect(d.find('[data-card-row]').exists()).toBe(false)
  expect(d.find('.pager').exists()).toBe(true)
  d.unmount()
})
```

> 若 `暂无数据` 与 i18n 实际文案不符,先读 DataTable 既有空态实现照实断言;`update:selection` 载荷形状以组件既有 `toggleRow` 实现为准。mount 须挂 i18n 插件(组件模板用 `$t`)——照抄 `DataTable.columnKey.test.js` 既有 mount 的 global 配置,把本文件 `mountTable` 的 `global: {}` 对齐成它的写法。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/DataTable.card.test.js`
Expected: FAIL(无 data-card-row)

- [ ] **Step 3: 实现**(DataTable.vue)

script 追加:

```js
import { useIsPhone } from '@/composables/useBreakpoint'
// ...(既有 props/computed 区)
const { isPhone } = useIsPhone()
// 卡片模式(spec §4.1):首个数据列=标题,其余列=键值行;同一份列 slot 双分支复用,单渲染
const titleKey = computed(() => props.headers[0]?.key)
const kvHeaders = computed(() => props.headers.slice(1))
```

template:根容器内、既有 `<div class="overflow-x-auto">` 改为 `v-if="!isPhone"`,其后插入手机分支(键值行 label 固定宽避免长列名挤压;truncate 按 V2 配方):

```html
    <!-- 手机卡片模式(spec §4.1):slot 与桌面同源单渲染;checkbox/expand .stop 防误触 row-click -->
    <div v-else class="divide-y divide-outline-variant/30">
      <div v-for="(row, idx) in rows" :key="rowId(row) ?? idx" data-card-row
        class="relative px-md py-md active:bg-surface-container-low/60 transition-colors"
        @click="$emit('row-click', row)">
        <div class="flex items-start gap-sm">
          <div class="flex-1 min-w-0" data-card-title>
            <slot :name="titleKey" :row="row" :value="row[titleKey]">
              <span class="block truncate font-semibold text-body-md">{{ row[titleKey] }}</span>
            </slot>
          </div>
          <input v-if="selectable" type="checkbox" data-card-select :checked="isSelected(row)"
            @click.stop @change="toggleRow(row)"
            class="shrink-0 mt-0.5 accent-[rgb(var(--md-sys-color-primary))] cursor-pointer" />
          <button v-if="expandable" data-card-expand @click.stop="toggleExpand(row)"
            class="shrink-0 p-xs text-on-surface-variant hover:text-primary rounded">
            <span class="material-symbols-outlined text-base">{{ isExpanded(row) ? 'expand_more' : 'chevron_right' }}</span>
          </button>
        </div>
        <div class="mt-sm grid gap-xs">
          <div v-for="header in kvHeaders" :key="header.key" data-kv-row class="flex items-baseline gap-sm min-w-0">
            <span data-kv-label class="text-label-caps text-on-surface-variant shrink-0 w-20">{{ header.label }}</span>
            <span class="min-w-0 text-body-sm"><slot :name="header.key" :row="row" :value="row[header.key]">{{ row[header.key] }}</slot></span>
          </div>
        </div>
        <div v-if="expandable && isExpanded(row)" class="mt-sm pt-sm border-t border-outline-variant/30">
          <slot name="expanded" :row="row" />
        </div>
      </div>
      <div v-if="!rows.length" class="px-md py-xl text-center">
        <span class="material-symbols-outlined text-4xl text-surface-container-high block mb-sm">inbox</span>
        <p class="text-on-surface-variant">{{ $t('common.noData') }}</p>
      </div>
    </div>
```

- [ ] **Step 4: 跑测试确认通过 + 既有 DataTable 测试零回归**

Run: `npx vitest run src/components/common/__tests__/DataTable.card.test.js src/components/common/__tests__/DataTable.columnKey.test.js src/components/common/__tests__/DataTable.selection-expandable.test.js`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/common/DataTable.vue src/components/common/__tests__/DataTable.card.test.js
git commit -m "feat(mobile): DataTable 手机卡片模式——列 slot 同源复用,32 消费方零改动生效"
```

---

### Task 2: DropdownMenu 手机 bottom sheet + 触控目标

**Files:**
- Modify: `src/components/common/DropdownMenu.vue`
- Test: `src/components/common/__tests__/` 下既有 DropdownMenu 测试文件追加(先 `ls` 找到;无则新建 `DropdownMenu.test.js`)

**Interfaces:**
- Consumes: `useIsPhone()`;`Z.popover`(既有)。
- Produces: 手机档菜单=fixed 底部面板(`data-testid` 不变,测试选择器沿用);菜单项触控目标 ≥40px;桌面锚定行为不变。

- [ ] **Step 1: 写失败测试**(追加到该文件的测试区;mount 方式照该文件既有用例)

```js
test('手机档:菜单呈现为底部面板(贴合底缘,zIndex 仍 Z.popover);菜单项触控目标 ≥40px', async () => {
  mockBelowSm(true) // 该文件既有 matchMedia spy 帮助函数;无则按 SideNavBar.drawer.test.js 模式建
  const w = await mountMenu()   // 既有 mount 帮助函数;items 两条
  await w.find('button').trigger('click')
  await nextTick()
  const panel = document.querySelector('[data-testid="dropdown-menu-panel"]')
  expect(panel).toBeTruthy()
  expect(panel.style.bottom).toBe('0px')
  expect(panel.style.left).toBe('0px')
  expect(panel.style.right).toBe('0px')
  expect(panel.style.zIndex).toBe(String(Z.popover))
  const item = panel.querySelector('button')
  expect(item.className).toContain('min-h-[40px]')
  w.unmount(); document.body.innerHTML = ''
})

test('桌面档:菜单锚定触发钮(非贴底),无 min-h 触控类', async () => {
  mockBelowSm(false)
  const w = await mountMenu()
  await w.find('button').trigger('click')
  await nextTick()
  const panel = document.querySelector('[data-testid="dropdown-menu-panel"]')
  expect(panel.style.bottom).toBe('')
  expect(panel.querySelector('button').className).not.toContain('min-h-[40px]')
  w.unmount(); document.body.innerHTML = ''
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/DropdownMenu.test.js`
Expected: 新增 2 用例 FAIL;既有 PASS

- [ ] **Step 3: 实现**(DropdownMenu.vue)

script:

```js
import { useIsPhone } from '@/composables/useBreakpoint'
const { isPhone } = useIsPhone()
const phonePanelStyle = computed(() => ({ position: 'fixed', left: '0px', right: '0px', bottom: '0px', zIndex: Z.popover }))
```

template:panel 的 `:style` 与类改双分支(锚定样式来自既有 useDropdownPanel 的 panelStyle,手机档整体换固定底板):

```html
      <div v-if="open" ref="panelRef" data-testid="dropdown-menu-panel"
        :style="isPhone ? phonePanelStyle : panelStyle"
        :class="isPhone
          ? 'w-full rounded-t-2xl rounded-b-none py-sm shadow-dropdown'
          : 'min-w-[160px] rounded-lg py-xs'"
        class="bg-surface-container-lowest border border-outline-variant overflow-hidden"
        @click.stop>
```

菜单项按钮类追加触控目标(两态通用 `max-sm:` 前缀,桌面不受影响):

```html
          class="w-full flex items-center gap-sm px-md py-sm text-left text-body-sm transition-colors disabled:opacity-40 disabled:cursor-not-allowed max-sm:min-h-[40px]"
```

触发按钮类追加 `max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:flex max-sm:items-center max-sm:justify-center`。

- [ ] **Step 4: 跑测试确认通过**(含既有用例)

Run: `npx vitest run src/components/common/__tests__/DropdownMenu.test.js`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/common/DropdownMenu.vue src/components/common/__tests__/DropdownMenu.test.js
git commit -m "feat(mobile): DropdownMenu 手机 bottom sheet 呈现+触控目标 40px——桌面锚定不变"
```

---

### Task 3: FilterBar 手机折叠面板

**Files:**
- Modify: `src/components/common/FilterBar.vue`
- Test: `src/components/common/__tests__/FilterBar.test.js`(无则新建;有则追加)

**Interfaces:**
- Consumes: `useIsPhone()`。
- Produces: 手机档筛选条件默认收起,点「筛选」钮展开(结果计数与重置钮恒可见);桌面档恒展开。

- [ ] **Step 1: 写失败测试**(mount 方式:该组件 props `filters: [{key,label,value?}]`,先读组件源码对齐 props/事件)

```js
test('手机档:筛选条件默认收起,点筛选钮展开;结果计数恒可见', async () => {
  mockBelowSm(true)
  const w = await mountFilterBar()
  expect(w.find('[data-filter-fields]').isVisible()).toBe(false)
  expect(w.text()).toContain('0')            // resultCount 恒可见(按组件真实渲染断言)
  await w.find('[data-test="filter-toggle"]').trigger('click')
  expect(w.find('[data-filter-fields]').isVisible()).toBe(true)
  w.unmount()
})

test('桌面档:筛选条件恒展开,无筛选钮', async () => {
  mockBelowSm(false)
  const w = await mountFilterBar()
  expect(w.find('[data-filter-fields]').isVisible()).toBe(true)
  expect(w.find('[data-test="filter-toggle"]').exists()).toBe(false)
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/FilterBar.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**(FilterBar.vue)

script:

```js
import { useIsPhone } from '@/composables/useBreakpoint'
const { isPhone } = useIsPhone()
const filterOpen = ref(false)   // 手机档折叠态;桌面恒视为展开
```

template:筛选字段区(既有 `v-for="filter in filters"` 的字段集合)外包一层并加门控;头部行加手机筛选钮:

```html
  <!-- 手机档:条件收进可展开面板(spec §4);桌面恒展开 -->
  <div v-show="!isPhone || filterOpen" data-filter-fields class="contents">
    <!-- 既有 v-for filter 字段组原样置于其内 -->
  </div>
  <div class="ml-auto flex items-center gap-sm self-end pb-1">
    <button v-if="isPhone" data-test="filter-toggle" @click="filterOpen = !filterOpen"
      class="p-xs text-on-surface-variant hover:text-primary rounded-md transition-colors"
      :aria-label="$t('component.filterBar.toggle')">
      <span class="material-symbols-outlined text-lg">{{ filterOpen ? 'filter_alt_off' : 'filter_alt' }}</span>
    </button>
    <!-- 既有结果计数 + 重置钮原样保留于此 -->
  </div>
```

i18n `component.filterBar.toggle`:zh `筛选` / en `Filters`(zh.json+en.json 成对加;跑 `npm run i18n:check` 验证)。

- [ ] **Step 4: 跑测试确认通过 + i18n 门禁**

Run: `npx vitest run src/components/common/__tests__/FilterBar.test.js && npm run i18n:check`
Expected: PASS / 0 问题

- [ ] **Step 5: Commit**

```bash
git add src/components/common/FilterBar.vue src/components/common/__tests__/FilterBar.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(mobile): FilterBar 手机折叠面板——条件收进可展开面板,计数/重置恒可见"
```

---

### Task 4: SplitButton 触控目标 + ConfirmDialog 手机全屏回归锁

**Files:**
- Modify: `src/components/common/SplitButton.vue`
- Test: `src/components/common/__tests__/ConfirmDialog.test.js`(追加 1 用例)、SplitButton 既有测试文件追加(先 `ls src/components/common/__tests__/ | grep -i split` 定位;无则新建 `SplitButton.test.js`)

**Interfaces:**
- Consumes: ConfirmDialog 基于 Modal(Wave 1a 已自动全屏)——本任务只补行为回归锁,不改其代码。

- [ ] **Step 1: 写失败测试**

ConfirmDialog.test.js 追加(mockBelowSm 模式同前):

```js
test('手机档:ConfirmDialog 随 Modal 自动全屏(width prop 被忽略)', async () => {
  mockBelowSm(true)
  const w = mount(ConfirmDialog, { props: { modelValue: true, title: '确认', message: '删?' }, global: { plugins: [i18n] } })
  await nextTick()
  const dialog = document.querySelector('body .relative.w-full')
  expect(dialog).toBeTruthy()
  expect(dialog.className).toContain('max-w-none')
  expect(dialog.className).not.toContain('max-w-md')
  w.unmount(); document.body.innerHTML = ''
})
```

SplitButton 测试追加:

```js
test('手机档:主动作/展开钮/菜单项触控目标 ≥40px', async () => {
  mockBelowSm(true)
  const w = await mountSplit()   // 照该文件既有 mount;props 含至少一条 action
  expect(w.find('button.bg-primary').classes()).toContain('max-sm:min-h-[40px]')
  await w.findAll('button')[1].trigger('click')   // 展开箭头钮
  const item = w.find('[data-split-menu] button')
  expect(item.classes()).toContain('max-sm:min-h-[40px]')
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/ConfirmDialog.test.js src/components/common/__tests__/SplitButton.test.js`
Expected: 新增用例 FAIL(ConfirmDialog 用例可能已绿——若已绿则该用例转为回归锁,直接进 Step 3 只改 SplitButton)

- [ ] **Step 3: 实现**(SplitButton.vue)

主/副按钮类追加 `max-sm:min-h-[40px]`;菜单项按钮类追加 `max-sm:min-h-[40px]` 并给菜单容器加 `data-split-menu`(若无)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/ConfirmDialog.test.js src/components/common/__tests__/SplitButton.test.js`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/common/SplitButton.vue src/components/common/__tests__/ConfirmDialog.test.js src/components/common/__tests__/SplitButton.test.js
git commit -m "feat(mobile): SplitButton 触控目标 40px+ConfirmDialog 手机全屏回归锁"
```

---

### Task 5: hover 动作常显(6 文件)+ overflow-guard V4

**Files:**
- Modify: `src/views/NsIngressDetail.vue`、`src/views/NsConfigMapDetail.vue`、`src/views/WorkbenchProjects.vue`、`src/views/WorkbenchDetail.vue`、`src/components/terminal/TerminalTaskbar.vue`、`src/components/common/DataKeysEditor.vue`
- Modify: `scripts/overflow-guard.test.mjs`(追加 V4)
- Test: 即 overflow-guard V4 本身(先红后绿=TDD)

**Interfaces:**
- Produces: 全仓静态守卫——`opacity-0` + `group-hover:opacity-100` 同元素必须配对 `max-sm:opacity-100`(手机常显);6 文件存量修齐。

- [ ] **Step 1: 写失败守卫**(overflow-guard.test.mjs 末尾追加;V3 的 `Z_ARBITRARY_ALLOWLIST`/`walk(SRC)` 复用既有)

```js
// ── V4:hover 动作常显守卫(2026-09-01 手机适配 Wave 1b,spec §4)──
// 触屏无 hover:`opacity-0` + `group-hover:opacity-100` 的动作在手机上永不可见。
// 规则:同元素 class 同时含两者时,必须配对 `max-sm:opacity-100`(手机档常显)。
test('V4: hover 显隐动作必须配 max-sm:opacity-100(手机常显)', () => {
  const offenders = []
  for (const f of walk(SRC)) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/class="([^"]*)"/g)) {
      const cls = m[1]
      if (cls.includes('opacity-0') && cls.includes('group-hover:opacity-100') && !cls.includes('max-sm:opacity-100')) {
        offenders.push(`${f}: ${cls.slice(0, 80)}`)
      }
    }
  }
  assert.deepEqual(offenders, [])
})
```

- [ ] **Step 2: 跑守卫确认失败**

Run: `node --test scripts/overflow-guard.test.mjs`
Expected: V4 FAIL,offenders 列出 6 文件的存量点

- [ ] **Step 3: 修齐存量**(每处只改 class 串,在其 `group-hover:opacity-100` 后追加 `max-sm:opacity-100`)

对 Step 2 输出的**每个**命中元素,例如:

```
- class="opacity-0 group-hover:opacity-100 text-on-surface-variant hover:text-error transition-opacity"
+ class="opacity-0 group-hover:opacity-100 max-sm:opacity-100 text-on-surface-variant hover:text-error transition-opacity"
```

逐文件修到 V4 绿;`:class` 动态绑定里的同名模式(若 Step 2 输出无则不处理——守卫只扫静态 class,与既有 V1/V2 口径一致)。

- [ ] **Step 4: 跑守卫确认通过 + 全量 overflow 回归**

Run: `node --test scripts/overflow-guard.test.mjs`
Expected: PASS(V1-V4 全绿)

- [ ] **Step 5: Commit**

```bash
git add scripts/overflow-guard.test.mjs src/views/NsIngressDetail.vue src/views/NsConfigMapDetail.vue src/views/WorkbenchProjects.vue src/views/WorkbenchDetail.vue src/components/terminal/TerminalTaskbar.vue src/components/common/DataKeysEditor.vue
git commit -m "feat(mobile): hover 动作手机常显(6 文件)+overflow-guard V4 守卫防新增"
```

---

### Task 6: SideNavBar navTo 收编(Wave 1a 停靠项)

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`
- Test: `src/components/layout/__tests__/SideNavBar.drawer.test.js`(追加)

**Interfaces:**
- Consumes: 既有 `navTo(target)`(push + belowSm 时 closeDrawer,Wave 1a 落地)。

- [ ] **Step 1: 盘点+写失败测试**

盘点(实现时以实际文件为准,以下是 Wave 1a 终审记录的 8 处):
`:243` cluster-anchor(`/cluster`)、`:401` cluster-slab(`/cluster`)、`:417` bottom-settings(`/settings`)、`:451` bottom-settings(`/settings`)、`:427` bottom-activity(`/audit-logs`)、`:445` bottom-activity(`/audit-logs`)、`:432` deploy-card(`{ name:'NsDeploy' }`)、`:164` selectNamespace 内 `router.push({ name:'NamespaceOverview' })`、`:174` onNsHomeClick 内 `router.push({ name:'NamespaceOverview' })`。

SideNavBar.drawer.test.js 追加:

```js
test('手机档:8 处裸 router.push 入口收编 navTo——点已激活路由也收抽屉', async () => {
  mockViewport(true, true)
  const wrapper = await mountNav()      // 该文件既有帮助函数
  const shell = useShellStore()
  shell.toggleDrawer()
  await Promise.resolve()
  // cluster-anchor 推 '/cluster':mock router 下 fullPath 不变的场景由 push stub 吸收,
  // 断言收口在 navTo 内的 closeDrawer(点击后 drawerOpen=false 即为契约)
  await wrapper.find('[data-test="cluster-anchor"]').trigger('click')
  expect(shell.drawerOpen).toBe(false)
  wrapper.unmount()
})
```

> 该文件已有「点激活项收抽屉」用例(navTo 主链路);本用例锁的是**此批收编入口**。若 mock router 结构不支持某入口触发,以既有用例的真实做法为准适配,断言(drawerOpen===false)不减。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.drawer.test.js`
Expected: FAIL(cluster-anchor 点击后抽屉未收)

- [ ] **Step 3: 实现**

把盘点出的每处 `@click="router.push(X)"` 改为 `@click="navTo(X)"`;`selectNamespace`/`onNsHomeClick` 函数体内的 `router.push({ name: 'NamespaceOverview', ... })` 改 `navTo({ name: 'NamespaceOverview', ... })`。注意两处例外**不得**改:
- `:170` `if (belowLg.value) { router.push('/namespaces'); return }`——rail 态降级跳转,桌面/iPad 语义,保持;
- 任何非用户点击路径的程序化跳转(如有)保持 router.push。

- [ ] **Step 4: 跑测试确认通过 + layout 全家回归**

Run: `npx vitest run src/components/layout/__tests__/`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/SideNavBar.vue src/components/layout/__tests__/SideNavBar.drawer.test.js
git commit -m "feat(mobile): SideNavBar 裸 router.push 点击入口收编 navTo(9 处)——同路由点击也收抽屉"
```

---

### Task 7: 全量门禁 + 手测清单更新

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md`(§9 追加 Wave 1b 手测项)

- [ ] **Step 1: 全量门禁**

```bash
npm run typecheck && node --test server/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)" && npm run test:unit 2>&1 | grep -E "Test Files|Tests " && npm run i18n:check
```
Expected: 四项全绿(基线 1759+ 只增不减)

- [ ] **Step 2: spec §9 追加 Wave 1b 手测项**(逐字)

```markdown

## 10. Wave 1b 真机手测清单

1. 任一列表页(NsPods 等):卡片呈现——首列标题加粗、键值行对齐、状态 chip 正常;点卡片进详情
2. 卡片 checkbox 勾选不误触进详情;批量删除按钮可达
3. 表格行 DropdownMenu:底部弹出面板、菜单项 ≥40px、点遮罩关闭、危险项红色
4. 筛选钮展开/收起;结果计数与重置恒可见
5. SplitButton/确认弹窗:全屏、按钮好按;终端任务栏 chip 的关闭 × 手机可见可点
6. 桌面/iPad:列表仍表格、下拉仍锚定浮层、筛选仍平铺——零回归
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md
git commit -m "docs(spec): Wave 1b 真机手测清单"
```

---

## Wave 1b 完成定义

- Task 1-6 全部 commit 在 `worktree-feat-mobile-1b`;Task 7 四门禁绿;
- 真机手测(§10)通过后 `--no-ff` 合 main(用户裁决时机);
- 停靠到 Wave 2:视图级触控目标细扫、无 #actions 槽全屏 Modal 底缘安全区(ChatModal/ToolCallModal)。
