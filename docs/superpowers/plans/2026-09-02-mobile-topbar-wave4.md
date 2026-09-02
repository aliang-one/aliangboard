# 手机顶栏 Wave 4 实施计划(单颗上下文胶囊+工作台图标钮+抽屉集群切换)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手机(<640)顶栏从 538px 结构性溢出收敛为一行：汉堡+单颗上下文胶囊(ns主/集群副)+工作台图标钮+搜索+刷新+头像；集群切换进抽屉；选择器 bottom sheet 化。

**Architecture:** TopNavBar 手机分支(v-if="belowSm")渲染单颗上下文胶囊替代双 chip;cluster/ns 两面板手机档绕过 `placeDropdown` 锚定、统一 fixed 底部面板(复用 DropdownMenu bottom sheet 配方);工作台 pill 组件内 isPhone 分支收成图标钮;抽屉集群切换经 shell store 新通道(`requestClusterSelect`)由 TopNavBar 承接弹面板。

**Tech Stack:** Vue 3 `<script setup>` + pinia + vitest(happy-dom) + tailwind `max-sm:` + 零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md` §13/§14。

## Global Constraints

- 禁止新增 npm 依赖;提交作者恒 `aliangone <aliangone@gmail.com>`(提交前 `git config user.name`+`user.email` 双核,提交后 `%an %ae` 自证)、禁止 Co-Authored-By。
- 桌面/iPad(≥640)零回归:双 chip/完整胶囊/锚定下拉全部现状;手机分支一律 `v-if="belowSm"`/`isPhone` 门控。
- 浮层 z 一律 zScale;溢出治理配方(CLAUDE.md)适用于胶囊文本 truncate;触控目标 ≥40px。
- 测试 mock 用共享 helper `import { mockViewport } from '@/__tests__/helpers/mobileViewport'`;多会话期全量 unit `npx vitest run --maxWorkers=2`。
- i18n 新键 zh/en 成对(`src/locales/zh.json`+`en.json`),改完 `npm run i18n:check`。
- docs/superpowers gitignore 需 `-f`。工作分支 `worktree-feat-mobile-topbar`。

---

### Task 1: TopNavBar 单颗上下文胶囊 + 面板手机 bottom sheet

**Files:**
- Modify: `src/components/layout/TopNavBar.vue`(模板:集群/ns 双 chip 包 `v-if="!belowSm"`;其后插手机胶囊;`placeDropdown` 调用处手机分支换底部面板样式;两 Teleport 面板手机档类;遮罩已有)
- Test: `src/components/layout/__tests__/TopNavBar.test.js`(追加)

**Interfaces:**
- Consumes: 既有 `belowSm`、`showClusterDropdown/showNsDropdown`、`currentNs`、`currentClusterObj`、`selectNs`(选后关面板)。
- Produces: `data-test="context-capsule"`(手机档唯一上下文入口);两面板手机档 `data-bottom-sheet` 在场。

- [ ] **Step 1: 写失败测试**(追加;mount 照该文件既有用例——store/session 置备抄现用例)

```js
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

test('手机档:双 chip 不渲染,单颗上下文胶囊在场(ns 主/集群副);面板为底部面板', async () => {
  const spy = mockViewport(true)
  const w = await mountTopNav()                     // 既有帮助函数;须有 currentNs='default' 与集群名
  expect(w.find('[data-test="cluster-trigger"]').exists()).toBe(false)
  expect(w.find('[data-test="ns-trigger"]').exists()).toBe(false)
  const cap = w.find('[data-test="context-capsule"]')
  expect(cap.exists()).toBe(true)
  expect(cap.text()).toContain('default')            // ns 主文本
  await cap.trigger('click')
  expect(w.vm.showNsDropdown).toBe(true)
  await nextTick()
  const panel = document.querySelector('[data-testid="ns-dropdown-panel"]')
  expect(panel.getAttribute('data-bottom-sheet')).toBe('true')
  expect(panel.style.bottom).toBe('0px')
  w.unmount(); spy.mockRestore()
})

test('桌面档:双 chip 现状,胶囊不渲染,面板非底部面板', async () => {
  const spy = mockViewport(false)
  const w = await mountTopNav()
  expect(w.find('[data-test="cluster-trigger"]').exists()).toBe(true)
  expect(w.find('[data-test="ns-trigger"]').exists()).toBe(true)
  expect(w.find('[data-test="context-capsule"]').exists()).toBe(false)
  await w.find('[data-test="ns-trigger"]').trigger('click')
  await nextTick()
  expect(document.querySelector('[data-testid="ns-dropdown-panel"]').getAttribute('data-bottom-sheet')).toBe('false')
  w.unmount(); spy.mockRestore()
})
```

> `mountTopNav` 置备里给 `store.currentCluster`/当前 ns 赋值方式照既有用例;若 ns 状态在 pinia 之外(如 route),按实际适配,断言不减。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js`
Expected: 新用例 FAIL;既有 PASS

- [ ] **Step 3: 实现**(TopNavBar.vue 三处)

① 模板:集群 chip 外层 div 与 ns chip 外层 div 各包 `v-if="!belowSm"`(与 search-trigger 的 `v-if="belowLg"` 同层);其后插:

```html
      <!-- 手机单颗上下文胶囊(spec §13.1):ns 主/集群副,点击弹 ns 底部选择器;集群切换进抽屉 -->
      <button v-if="belowSm" data-test="context-capsule" @click="showNsDropdown = !showNsDropdown"
        class="flex items-center gap-xs min-w-0 flex-1 max-w-[240px] px-md py-1.5 rounded-lg border transition-all"
        :class="showNsDropdown
          ? 'border-primary bg-primary/5 text-primary'
          : (currentNs
            ? 'border-primary/40 bg-primary/5 text-primary'
            : 'border-outline-variant bg-surface-container-low text-on-surface-variant')"
        :aria-label="$t('nav.switchNamespace')">
        <span class="material-symbols-outlined text-lg shrink-0">folder_open</span>
        <div class="flex flex-col items-start leading-tight min-w-0 flex-1">
          <span class="w-full text-body-sm font-semibold truncate">{{ currentNs || $t('nav.notSelected') }}</span>
          <span class="w-full text-[10px] text-on-surface-variant truncate">{{ currentClusterObj?.name || '—' }}</span>
        </div>
        <span class="material-symbols-outlined text-base shrink-0 transition-transform" :class="showNsDropdown ? 'rotate-180' : ''">expand_more</span>
      </button>
```

② `placeDropdown` 两处赋值(:165-166)加手机分支:

```js
  if (showClusterDropdown.value && clusterPanelRef.value) clusterPanelStyle.value = belowSm.value ? bottomSheetStyle() : placeDropdown(clusterBtnRef.value, clusterPanelRef.value, 320)
  if (showNsDropdown.value && nsPanelRef.value) nsPanelStyle.value = belowSm.value ? bottomSheetStyle() : placeDropdown(nsBtnRef.value, nsPanelRef.value, 288)
```

script 加(与 `hiddenStyle()` 同处):

```js
const bottomSheetStyle = () => ({ position: 'fixed', left: '0px', right: '0px', bottom: '0px', zIndex: Z.popover })
```

③ 两 Teleport 面板根元素加 `:data-bottom-sheet="String(belowSm)"` 与手机类:

```html
    <div v-if="showClusterDropdown" ref="clusterPanelRef" data-testid="cluster-dropdown-panel"
      :data-bottom-sheet="String(belowSm)"
      class="bg-surface-container-lowest border border-outline-variant shadow-dropdown overflow-hidden"
      :class="belowSm ? 'fixed bottom-0 left-0 right-0 rounded-t-2xl max-h-[70vh] overflow-y-auto max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+12px)]' : 'rounded-lg'"
      :style="clusterPanelStyle">
```

ns 同款(ns 面板内搜索输入加 `autofocus` 仅手机档—用 `:attrs` 简化为始终 autofocus 可接受,注明)。i18n 核对 `nav.switchNamespace` 存在,无则 zh=`切换命名空间`/en=`Switch namespace`。

- [ ] **Step 4: 跑测试确认通过 + i18n**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js && npm run i18n:check`
Expected: PASS / 0

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/TopNavBar.vue src/components/layout/__tests__/TopNavBar.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(mobile): 顶栏单颗上下文胶囊+选择器 bottom sheet——双 chip 结构性溢出根治"
```

---

### Task 2: WorkbenchEntryPill 手机图标钮

**Files:**
- Modify: `src/components/layout/WorkbenchEntryPill.vue`(组件内 isPhone 分支:图标钮形态)
- Test: `src/components/layout/__tests__/WorkbenchEntryPill.test.js`(追加)

**Interfaces:**
- Consumes: `useIsPhone()`;既有 `isWorkbenchActive`/`pendingCount`/`router.push('/workbench')`。
- Produces: 手机档 `data-test="wb-pill"` 呈 40px 图标钮(icon-only,活跃高亮,待审批红点角标);桌面完整胶囊零变化。

- [ ] **Step 1: 写失败测试**(追加;mount 照既有)

```js
test('手机档:pill 收成 40px 图标钮(文本不在场,待审批红点保留),点击仍进工作台', async () => {
  const spy = mockViewport(true)
  const w = await mountPill()          // 既有帮助函数(带 summary 数据 stub)
  const btn = w.find('[data-test="wb-pill"] button')
  expect(btn.text()).not.toContain(w.vm.$t?.('nav.workbench') ?? '工作台')
  expect(btn.classes().join(' ')).toContain('max-sm:min-h-[40px]')
  expect(btn.find('span.material-symbols-outlined').exists()).toBe(true)
  await btn.trigger('click')
  expect(w.vm.router.push).toHaveBeenCalledWith('/workbench')  // 照既有断言路径适配
  w.unmount(); spy.mockRestore()
})

test('桌面档:完整胶囊(文本在场)', async () => {
  const spy = mockViewport(false)
  const w = await mountPill()
  expect(w.find('[data-test="wb-pill"] button').text()).toContain('工作台')
  w.unmount(); spy.mockRestore()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/WorkbenchEntryPill.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**(WorkbenchEntryPill.vue)

script:`import { useIsPhone } from '@/composables/useBreakpoint'` + `const { isPhone } = useIsPhone()`。
模板按钮改双分支(悬停面板/统计条桌面逻辑全保留):

```html
    <button
      @click="router.push('/workbench')"
      :aria-label="$t('nav.workbench')"
      :title="isPhone ? $t('nav.workbench') : summaryText"
      class="flex items-center gap-sm rounded-full px-md py-1.5 border transition-colors text-body-sm font-semibold shrink-0"
      :class="[
        isWorkbenchActive
          ? 'border-primary bg-primary-container text-on-primary-container'
          : 'border-primary/40 bg-primary/5 text-primary hover:border-primary hover:bg-primary/10',
        isPhone ? 'max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:justify-center max-sm:px-0' : '',
      ]"
    >
      <span class="relative inline-flex">
        <span class="material-symbols-outlined text-lg">workspaces</span>
        <!-- 手机档待审批红点(数字角标让位空间;桌面数字角标保留) -->
        <span v-if="isPhone && pendingCount > 0" data-test="pill-pending-dot"
          class="absolute -top-0.5 -right-1 w-2 h-2 rounded-full bg-error"></span>
      </span>
      <template v-if="!isPhone">{{ $t('nav.workbench') }}</template>
      <!-- 既有 pill-stats(≥xl)与状态徽章(<xl 非 phone)原样保留在下,仅 v-if 加 !isPhone -->
    </button>
```

既有「状态徽章(<xl)」span 的 `v-if="pendingCount > 0"` 改 `v-if="!isPhone && pendingCount > 0"`(手机由红点接管)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/WorkbenchEntryPill.test.js`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/WorkbenchEntryPill.vue src/components/layout/__tests__/WorkbenchEntryPill.test.js
git commit -m "feat(mobile): 工作台 pill 手机档收成 40px 图标钮(待审批红点)——桌面胶囊零变化"
```

---

### Task 3: 抽屉集群切换通道(shell store + SideNavBar + TopNavBar 承接)

**Files:**
- Modify: `src/stores/shell.js`(+`clusterSelectTick`/`requestClusterSelect()`)
- Modify: `src/components/layout/SideNavBar.vue`(drawer-mode 的 `cluster-anchor` 点击改发通道)
- Modify: `src/components/layout/TopNavBar.vue`(watch 通道→`showClusterDropdown=true`)
- Test: `src/stores/__tests__/shell.test.js`、`src/components/layout/__tests__/SideNavBar.drawer.test.js`、`TopNavBar.test.js`(各追加)

**Interfaces:**
- Consumes: 既有 drawer-mode `cluster-anchor`(:243,当前 navTo('/cluster'))、TopNavBar `showClusterDropdown`。
- Produces: `shell.clusterSelectTick: number` + `shell.requestClusterSelect()`(自增);TopNavBar watch 之。桌面/iPad 无 drawer → 通道不触发,零影响。

- [ ] **Step 1: 写失败测试**

shell.test.js 追加:

```js
test('requestClusterSelect:tick 自增(跨组件打开集群选择器的通道)', () => {
  const shell = useShellStore()
  const before = shell.clusterSelectTick
  shell.requestClusterSelect()
  expect(shell.clusterSelectTick).toBe(before + 1)
})
```

SideNavBar.drawer.test.js 追加:

```js
test('手机抽屉:cluster-anchor 点击发集群选择通道(不再导航)', async () => {
  mockViewport(true, true)
  const wrapper = await mountNav()
  const shell = useShellStore()
  const before = shell.clusterSelectTick
  await wrapper.find('[data-test="cluster-anchor"]').trigger('click')
  expect(shell.clusterSelectTick).toBe(before + 1)
  // drawer-mode 下不再导航去 /cluster(navTo 仅非 drawer 语义)——断言 shell 通道而非路由
  wrapper.unmount()
})
```

TopNavBar.test.js 追加:

```js
test('手机档:shell 通道请求 → 集群面板打开(bottom sheet)', async () => {
  const spy = mockViewport(true)
  const w = await mountTopNav()
  useShellStore().requestClusterSelect()
  await nextTick()
  expect(w.vm.showClusterDropdown).toBe(true)
  await nextTick()
  expect(document.querySelector('[data-testid="cluster-dropdown-panel"]').getAttribute('data-bottom-sheet')).toBe('true')
  w.unmount(); spy.mockRestore()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/shell.test.js src/components/layout/__tests__/SideNavBar.drawer.test.js src/components/layout/__tests__/TopNavBar.test.js`
Expected: 新用例 FAIL;既有 PASS

- [ ] **Step 3: 实现**

shell.js state 加 `const clusterSelectTick = ref(0)`;action `function requestClusterSelect() { clusterSelectTick.value++ }`(return 区补两者)。

SideNavBar.vue drawer-mode 的 `cluster-anchor`(:243)点击改:`@click="belowSm ? shell.requestClusterSelect() : navTo('/cluster')"`(模板内三元允许;drawer-mode 只在 belowSm 存在,桌面 anchor 保持导航)。若 drawer-mode 下模板无法用 belowSm(常量恒真),直接 `@click="shell.requestClusterSelect()"`——以渲染分支事实为准,报告注明。

TopNavBar.vue script 加:

```js
// 抽屉集群切换通道(spec §13.1):SideNavBar drawer-mode 的 cluster-anchor 经 shell tick
// 请求打开集群选择器(面板锚点 clusterBtnRef 手机档不存在,placeDropdown 手机分支本就绕过)
watch(() => shell.clusterSelectTick, () => { if (belowSm.value) { showNsDropdown.value = false; showClusterDropdown.value = true } })
```

(开集群面板时收 ns 面板,防双开;`watch` 从 vue import 已有。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/shell.test.js src/components/layout/__tests__/`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/stores/shell.js src/stores/__tests__/shell.test.js src/components/layout/SideNavBar.vue src/components/layout/TopNavBar.vue src/components/layout/__tests__/
git commit -m "feat(mobile): 抽屉集群切换通道——cluster-anchor 经 shell tick 弹集群 bottom sheet"
```

---

### Task 4: 全量门禁 + 手测清单

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md`(§14 已有——追加执行记录节即可;无新清单)

- [ ] **Step 1: 全量门禁**

```bash
npm run typecheck && node --test server/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)" && npx vitest run --maxWorkers=2 2>&1 | grep -E "Test Files|Tests " && npm run i18n:check
```
Expected: 四项全绿(基线 1854 只增不减)

- [ ] **Step 2: spec §14 后追加执行记录**

```markdown

### 14.1 Wave 4 执行记录(2026-09-02)

- 顶栏新布局已落地:单颗上下文胶囊/工作台图标钮/抽屉集群切换通道/面板 bottom sheet
- 溢出算术:汉堡36+胶囊(弹性≤240)+工作台40+搜索36+刷新36+头像40+gaps≈460→375px 由胶囊 truncate 吸收(主文本弹性收缩)
- 真机手测按 §14 执行(375/390/430 明暗)
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md
git commit -m "docs(spec): Wave 4 执行记录"
```

---

## Wave 4 完成定义

- Task 1-3 全部 commit 在 `worktree-feat-mobile-topbar`;Task 4 四门禁绿;
- 真机手测(§14)通过后 `--no-ff` 合 main;
- 溢出算术残留:极端长集群名(URL 形)副行 truncate 兜底;若真机仍溢出,后续波次降胶囊主文本最小宽。
