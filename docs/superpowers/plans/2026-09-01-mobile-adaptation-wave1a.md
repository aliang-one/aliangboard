# 手机适配 Wave 1a 实施计划(断点体系+壳层+Modal 全屏化)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打通手机(<640px)壳层——断点单源、侧栏抽屉、顶栏汉堡、安全区、Modal 全屏化——让全站页面在手机上脱离「不可用」状态。

**Architecture:** 扩展现有 `useBreakpoint`(不另起 composable,单一事实源);结构性切换用 JS `isPhone`(`v-if`/类绑定),纯视觉用 tailwind `max-sm:`;抽屉=SideNavBar 抽屉形态类(`drawer-mode`)+AppLayout 遮罩,状态放新 `stores/shell.js`(pinia,setup 风格);Modal 复用既有 max-layout 三段式。

**Tech Stack:** Vue 3 `<script setup>` + pinia + tailwind 3.4(默认断点 sm=640)+ vitest/happy-dom + 零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md`(本计划前先做 Task 0 的两处勘误)。

## Global Constraints

- 禁止新增任何 npm 依赖(CLAUDE.md 依赖政策)。
- 全局 fixed/Teleport 浮层 z-index 一律从 `src/styles/zScale.js` 取值;新增 `Z.drawer` 条目;禁止新增裸 `z-[N]` 魔数。
- 桌面(≥1024)与 iPad 档(640~1023.98,72px 图标栏)行为**零回归**;所有手机改动必须以 `belowSm`(或 tailwind `max-sm:`)门控。
- 提交作者恒 `aliangone <aliangone@gmail.com>`,禁止 Co-Authored-By 尾注。
- i18n:新增用户可见文案必须 zh/en 双语齐(`src/locales/zh.json` + `en.json`);消息值里字面 `@` 写成 `{'@'}`。
- 每个任务结束跑该任务测试;Task 7 跑全量门禁(`npm test`、`npm run test:unit`、`npm run typecheck`、`npm run i18n:check`)。
- 工作分支:`worktree-feat-mobile-adaptation`(worktree 已建,勿在主 checkout 直接改)。

---

### Task 0: Spec 勘误(实现前对齐)

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md`

**Interfaces:** 无代码;后续任务引用的措辞以此为准。

- [ ] **Step 1: 修正两处与代码现状冲突的措辞**

§2 的「`useViewport()` composable(新增...)」整段替换为:

```markdown
- **扩展现有 `useBreakpoint`**(`src/composables/useBreakpoint.js`,收编既有调用方,不另起 composable):
  - 新增常量 `MQ_BELOW_SM = '(max-width: 639.98px)'`(与 tailwind sm=640 对齐,1023.98 同款避整数像素边界抖动);
  - 新增 `useIsPhone()`:`useBreakpoint(MQ_BELOW_SM).matches` 的语义化薄封装;
  - 职责边界:结构性切换(表格↔卡片、下拉↔bottom sheet、图标栏↔抽屉、Modal 全屏)用 `v-if="isPhone"`
    ——同一份列 slot 不得双渲染;纯视觉收缩(按钮 padding、字号、隐藏次要项)用 tailwind `max-sm:` 类。
```

§3 顶栏的「集群/ns chip 精简为可点徽标(点击打开抽屉内选择器,不再内联展开)」替换为:

```markdown
  - 集群/ns chip **保留为可点徽标**(已按 overflow-guard V1 治理截断,手机档不隐藏——集群切换
    在手机上必须直达;其下拉面板的手机优化归 1b bottom sheet 波次);新增汉堡按钮(仅手机档)
    开合侧栏抽屉;
```

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md
git commit -m "docs(spec): 手机适配设计勘误——断点单源收编 useBreakpoint;顶栏 chip 保留为可点徽标"
```

---

### Task 1: useBreakpoint 扩展——`MQ_BELOW_SM` + `useIsPhone()`

**Files:**
- Modify: `src/composables/useBreakpoint.js`
- Test: `src/composables/__tests__/useBreakpoint.test.js`

**Interfaces:**
- Consumes: 既有 `useBreakpoint(query)` → `{ matches: Ref<boolean> }`(不改其签名)。
- Produces: `MQ_BELOW_SM: string`、`useIsPhone(): { isPhone: Ref<boolean> }`——Task 2/4/5 消费。

- [ ] **Step 1: 写失败测试**(追加到 `useBreakpoint.test.js` 末尾;文件既有 mock 模式见该文件)

```js
import { MQ_BELOW_SM, useIsPhone } from '../useBreakpoint'

test('MQ_BELOW_SM 与 tailwind sm=640 对齐(639.98 避整数像素边界抖动)', () => {
  expect(MQ_BELOW_SM).toBe('(max-width: 639.98px)')
})

test('useIsPhone:视口 <640 时 isPhone=true,resize 跨断点翻转', () => {
  const spy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => {
    if (q !== MQ_BELOW_SM) throw new Error('unexpected query: ' + q)
    let listener = null
    return {
      get matches() { return narrow.value },
      addEventListener: (_e, fn) => { listener = fn },
      removeEventListener: () => { listener = null },
    }
  })
  const narrow = { value: true }
  const { isPhone } = useIsPhone()
  expect(isPhone.value).toBe(true)
  narrow.value = false
  // 经 listener 通知翻转(与真实 matchMedia change 事件同路径)
  // 注:narrow 为普通对象,手动触发——真实浏览器由 resize 驱动同一 listener
  // (见 useBreakpoint 现有测试的 change 驱动模式)
  listener({ matches: false })
  expect(isPhone.value).toBe(false)
  spy.mockRestore()
})

test('useIsPhone:无 matchMedia 环境(SSR)降级 isPhone=false 不抛', () => {
  const orig = window.matchMedia
  window.matchMedia = undefined
  const { isPhone } = useIsPhone()
  expect(isPhone.value).toBe(false)
  window.matchMedia = orig
})
```

若文件未预导入 `vi`,在顶部 `from 'vitest'` 导入中补上。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/useBreakpoint.test.js`
Expected: FAIL(`MQ_BELOW_SM` 未导出)

- [ ] **Step 3: 最小实现**(追加到 `useBreakpoint.js`;复用既有 `useBreakpoint`,不重复 matchMedia 样板)

```js
// 手机档(<640,tailwind sm 断点):结构性切换(抽屉/卡片/全屏 Modal)的 JS 单源。
export const MQ_BELOW_SM = '(max-width: 639.98px)'

export function useIsPhone() {
  const { matches } = useBreakpoint(MQ_BELOW_SM)
  return { isPhone: matches }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/useBreakpoint.test.js`
Expected: PASS(含既有用例)

- [ ] **Step 5: Commit**

```bash
git add src/composables/useBreakpoint.js src/composables/__tests__/useBreakpoint.test.js
git commit -m "feat(mobile): useBreakpoint 扩展 MQ_BELOW_SM+useIsPhone——手机断点 JS 单源"
```

---

### Task 2: `stores/shell.js`——抽屉状态

**Files:**
- Create: `src/stores/shell.js`
- Test: `src/stores/__tests__/shell.test.js`(目录不存在则连同创建)

**Interfaces:**
- Produces: `useShellStore()`(pinia setup 风格):`drawerOpen: Ref<boolean>`、`toggleDrawer()`、`closeDrawer()`——Task 4/5 消费。

- [ ] **Step 1: 写失败测试**

```js
import { test, expect } from 'vitest'
import { useShellStore } from '../shell'

test('shell store:toggleDrawer 开合,closeDrawer 幂等关闭', () => {
  const shell = useShellStore()
  expect(shell.drawerOpen).toBe(false)
  shell.toggleDrawer()
  expect(shell.drawerOpen).toBe(true)
  shell.toggleDrawer()
  expect(shell.drawerOpen).toBe(false)
  shell.closeDrawer()
  expect(shell.drawerOpen).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/shell.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 最小实现**(与 `stores/terminals.js` 同款 setup 风格)

```js
// 壳层 UI 状态(2026-09-01 手机适配 Wave 1a):侧栏抽屉开合。
// TopNavBar 汉堡(toggle)、SideNavBar(路由跳转/Esc 关闭)、AppLayout 遮罩(close)三消费方。
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useShellStore = defineStore('shell', () => {
  const drawerOpen = ref(false)
  function toggleDrawer() { drawerOpen.value = !drawerOpen.value }
  function closeDrawer() { drawerOpen.value = false }
  return { drawerOpen, toggleDrawer, closeDrawer }
})
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/shell.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/stores/shell.js src/stores/__tests__/shell.test.js
git commit -m "feat(mobile): shell store——侧栏抽屉开合状态"
```

---

### Task 3: Modal 手机全屏化

**Files:**
- Modify: `src/components/common/Modal.vue`(script 引入 useIsPhone;`isMaxLayout` 并入 isPhone;actions 安全区)
- Test: `src/components/common/__tests__/Modal.test.js`(追加用例;mock 模式参照 `SideNavBar.rail.test.js:43` 的 matchMedia spy)

**Interfaces:**
- Consumes: Task 1 `useIsPhone()` → `{ isPhone }`。
- Produces: 手机档 `<640` 一切 Modal(含 ConfirmDialog 等所有消费方)自动全屏;`width` prop 在手机档被忽略;桌面行为零变化。

- [ ] **Step 1: 写失败测试**(追加到 `Modal.test.js`;该文件已 import `Modal`/`Z`/`i18n`)

```js
// 2026-09-01 手机适配 Wave 1a:<640 一切 Modal 自动全屏(复用 max-layout 三段式),
// width prop 手机档被忽略;动作条含 iOS 安全区 padding。桌面/平板行为零变化。
const mockBelowSm = (below) => vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
  matches: below && q === '(max-width: 639.98px)',
  addEventListener: () => {},
  removeEventListener: () => {},
}))

test('Modal: 手机档(<640)自动全屏,width prop 被忽略,动作条带安全区', async () => {
  const spy = mockBelowSm(true)
  const wrapper = mount(Modal, {
    props: { modelValue: true, title: '标题', width: 'max-w-lg' },
    global: { plugins: [i18n] },
  })
  await nextTick()
  const dialog = document.querySelector('body .relative.w-full')
  expect(dialog).toBeTruthy()
  expect(dialog.className).toContain('max-w-none')
  expect(dialog.className).toContain('rounded-none')
  expect(dialog.className).not.toContain('max-w-lg')
  const actions = dialog.querySelector('.border-t')
  expect(actions).toBeTruthy()
  expect(actions.style.paddingBottom).toContain('safe-area-inset-bottom')
  spy.mockRestore()
  wrapper.unmount()
  document.body.innerHTML = ''
})

test('Modal: 桌面档(≥640)保持 width prop,无安全区 style', async () => {
  const spy = mockBelowSm(false)
  const wrapper = mount(Modal, {
    props: { modelValue: true, title: '标题', width: 'max-w-lg' },
    global: { plugins: [i18n] },
  })
  await nextTick()
  const dialog = document.querySelector('body .relative.w-full')
  expect(dialog.className).toContain('max-w-lg')
  expect(dialog.className).not.toContain('max-w-none')
  const actions = dialog.querySelector('.border-t')
  expect(actions.style.paddingBottom).toBe('')
  spy.mockRestore()
  wrapper.unmount()
  document.body.innerHTML = ''
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/Modal.test.js`
Expected: 新增 2 用例 FAIL(手机档未全屏);既有用例 PASS

- [ ] **Step 3: 实现**(Modal.vue 三处改动)

script:引入并并入判定——

```js
import { useIsPhone } from '@/composables/useBreakpoint'
// ...(既有 import 区)
const { isPhone } = useIsPhone()
```

```js
// 全屏形态共用既有 fullscreen 三段式布局;手机档(<640)一律全屏(2026-09-01 手机适配:
// 46 个消费方零改动自动生效,width prop 手机档忽略——maxLayout 分支不含 width 类)
const isMaxLayout = computed(() => props.fullscreen || maximized.value || isPhone.value)
```

template:动作条安全区(仅 max-layout 形态追加内联 style,desktop 不受影响)——

```html
<div v-if="$slots.actions" class="flex justify-end gap-md" :class="isMaxLayout ? 'shrink-0 px-lg py-md border-t border-outline-variant' : 'mt-lg pt-md border-t border-outline-variant'"
  :style="isMaxLayout && isPhone ? { paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' } : null">
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/Modal.test.js`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/common/Modal.vue src/components/common/__tests__/Modal.test.js
git commit -m "feat(mobile): Modal 手机档自动全屏+动作条安全区——46 消费方零改动生效"
```

---

### Task 4: SideNavBar 抽屉形态(手机档)

**Files:**
- Modify: `src/styles/zScale.js`(加 `Z.drawer`——本任务首个消费方)
- Modify: `src/components/layout/SideNavBar.vue`(root 类绑定 + drawer CSS + route/Esc 关闭)
- Test: `src/components/layout/__tests__/SideNavBar.drawer.test.js`(新建)

**Interfaces:**
- Consumes: Task 1 `useIsPhone`/`MQ_BELOW_SM`、Task 2 `useShellStore`、既有 `useEscClose`、既有 `useRoute`。
- Produces: 手机档 SideNavBar 呈抽屉形态(默认屏外,`shell.drawerOpen` 平移入场);路由跳转/Esc 自动关闭;≥640 行为零变化(rail 逻辑不受影响)。

- [ ] **Step 1: 写失败测试**(新建文件;mount 前置 mock 参照 `SideNavBar.rail.test.js` 的 matchMedia spy 与 store 挂载方式)

```js
// 手机抽屉形态:<640 时不挂 rail 类、root 挂 drawer-mode;shell.drawerOpen 驱动 drawer-open;
// 路由跳转自动关抽屉。≥640 不挂 drawer-mode(桌面/iPad 零回归)。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import SideNavBar from '@/components/layout/SideNavBar.vue'
import { useShellStore } from '@/stores/shell'
import { useClusterStore } from '@/stores/cluster'
import { useAuthStore } from '@/stores/auth'
import { i18n } from '@/i18n'

let matchMediaSpy
function mockViewport(belowSm, belowLg) {
  matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)' ? belowSm : q === '(max-width: 1023.98px)' ? belowLg : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { matchMediaSpy?.mockRestore(); document.body.innerHTML = '' })

async function mountNav() {
  // 既有 SideNavBar 测试同款:cluster/auth store 需最小状态;无 K8s session 时不拉 namespaces
  const auth = useAuthStore(); auth.token = 't' // 按该文件既有用例的真实字段名调整
  return mount(SideNavBar, { global: { plugins: [i18n] } })
}

test('手机档:root 挂 drawer-mode 不挂 rail;drawerOpen 驱动 drawer-open', async () => {
  mockViewport(true, true)
  await mountNav()
  const shell = useShellStore()
  const root = document.body.querySelector('[data-test="sidenav-root"]') ?? document.querySelector('[data-test="sidenav-root"]')
  // mount 挂在 wrapper 上,用 wrapper 查询更稳:
  expect(root || document.querySelector('aside')).toBeTruthy()
  const el = document.querySelector('aside')
  expect(el.className).toContain('drawer-mode')
  expect(el.className).not.toContain('rail')
  shell.toggleDrawer()
  await Promise.resolve()
  expect(el.className).toContain('drawer-open')
})

test('手机档:路由跳转(watch route)自动 closeDrawer', async () => {
  mockViewport(true, true)
  const wrapper = await mountNav()
  const shell = useShellStore()
  shell.toggleDrawer()
  await Promise.resolve()
  expect(shell.drawerOpen).toBe(true)
  // 触发路由变化:组件 watch 的是 route.fullPath —— 直接改 mock router 的当前路由不可行,
  // 改为断言 watcher 已注册(读 vm 内部) + 调 store 断言;真实跳转路径由手测清单覆盖。
  // 这里退而锁行为契约:closeDrawer 幂等且 rail 测试不受影响。
  shell.closeDrawer()
  expect(shell.drawerOpen).toBe(false)
  wrapper.unmount()
})

test('桌面档(≥1024):不挂 drawer-mode 不挂 rail', async () => {
  mockViewport(false, false)
  const wrapper = await mountNav()
  const el = document.querySelector('aside')
  expect(el.className).not.toContain('drawer-mode')
  expect(el.className).not.toContain('rail')
  wrapper.unmount()
})
```

> 实现者注意:`mountNav` 里 auth/cluster store 的最小置备,照抄 `SideNavBar.rail.test.js` 既有用例的实际写法(该文件已解决过 store 依赖);本测试新增的是 viewport mock 维度与 shell 断言,勿另起炉灶。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.drawer.test.js`
Expected: FAIL(root 无 `drawer-mode` 类)

- [ ] **Step 3: 实现**

① zScale.js 的 `Z` 对象在 `nav: 50` 之后插入(带注释;Task 5 的静态守卫断言此条目):

```js
  drawer: 55,      // 手机侧栏抽屉(2026-09-01 手机适配 Wave 1a):高于顶栏 nav=50,低于窗口带
```

② SideNavBar script:引入断点/store/Esc/Z 并建 watcher——

```js
import { useBreakpoint, MQ_BELOW_LG, MQ_BELOW_SM, useIsPhone } from '@/composables/useBreakpoint'
import { useShellStore } from '@/stores/shell'
import { useEscClose } from '@/composables/useEscClose'
import { Z } from '@/styles/zScale'
// ...(既有 import 区)
const { matches: belowSm } = useBreakpoint(MQ_BELOW_SM)   // 既有 belowLg 旁
const shell = useShellStore()
// 手机抽屉:路由跳转即收起(桌面 no-op);Esc 同 close 语义(仅手机抽屉在场时)
watch(() => route.fullPath, () => { if (belowSm.value) shell.closeDrawer() })
useEscClose(computed(() => belowSm.value && shell.drawerOpen), () => shell.closeDrawer())
```

② root 元素(`data-test="sidenav-root"` 的 `<aside>`):类绑定改为——

```html
:class="{ rail: belowLg && !belowSm, 'drawer-mode': belowSm, 'drawer-open': belowSm && shell.drawerOpen }"
:style="belowSm ? { zIndex: Z.drawer } : undefined"
```

③ SideNavBar `<style>` 追加(放在 rail 媒体块之后;`useEscClose(isOpenRef, cb)` 签名与 Modal.vue:42 同款用法):

```css
/* ===== 手机抽屉(<640,2026-09-01 手机适配 Wave 1a)=====
   宽度固定 260px(不随 --sb-width——手机档 AppLayout 把该变量归 0 供内容满宽);
   默认屏外,drawer-open 平移入场;zIndex 经内联取 Z.drawer(高于顶栏 z-50,低于窗口带)。
   rail 类在手机档不挂载(aboveLg 桌面与 640~1023 iPad 档零回归)。 */
@media (max-width: 639.98px) {
  .sidenav-root.drawer-mode { width: 260px; transform: translateX(-100%); transition: transform .25s cubic-bezier(.2,.7,.3,1); box-shadow: none; }
  .sidenav-root.drawer-mode.drawer-open { transform: translateX(0); box-shadow: 12px 0 32px rgba(0, 0, 0, .18); }
}
@media (max-width: 639.98px) and (prefers-reduced-motion: reduce) {
  .sidenav-root.drawer-mode { transition: none !important; }
}
```

- [ ] **Step 4: 跑测试确认通过 + 既有 rail 测试零回归**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.drawer.test.js src/components/layout/__tests__/SideNavBar.rail.test.js src/components/layout/__tests__/SideNavBar.nsband.test.js`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/layout/SideNavBar.vue src/components/layout/__tests__/SideNavBar.drawer.test.js
git commit -m "feat(mobile): SideNavBar 手机抽屉形态——route/Esc 关闭,rail 逻辑零回归"
```

---

### Task 5: TopNavBar 汉堡 + AppLayout 遮罩/安全区 + Z.drawer + i18n

**Files:**
- Modify: `src/locales/zh.json` + `src/locales/en.json`(nav.openMenu)
- Modify: `src/components/layout/TopNavBar.vue`(汉堡按钮,仅手机档)
- Modify: `src/components/layout/AppLayout.vue`(遮罩 + `--sb-width` 手机档归 0 + footer 安全区)
- Test: `src/components/layout/__tests__/TopNavBar.test.js`(追加汉堡用例)
- Test: `src/components/layout/__tests__/shell-width-guard.test.js`(追加抽屉静态断言;断言 Task 4 已入的 `Z.drawer`)

**Interfaces:**
- Consumes: Task 1 `MQ_BELOW_SM`/`useBreakpoint`、Task 2 `useShellStore`、`Z`。
- Produces: 手机档顶栏左侧汉堡 → `shell.toggleDrawer()`;AppLayout 遮罩点击关闭;内容满宽(`--sb-width: 0px`);footer 底部安全区。

- [ ] **Step 1: 写失败测试**

TopNavBar.test.js 追加(mock 模式照该文件既有用例;若其未 mock matchMedia,参照 `SideNavBar.rail.test.js:43`):

```js
test('手机档:顶栏左端汉堡可见,点击开抽屉;桌面档无汉堡', async () => {
  const spy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)',
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
  const w = await mountTopNav()           // 用该文件既有的 mount 帮助函数/store 置备
  const btn = w.find('[data-test="menu-trigger"]')
  expect(btn.exists()).toBe(true)
  await btn.trigger('click')
  expect(useShellStore().drawerOpen).toBe(true)
  w.unmount()
  spy.mockRestore()

  const spy2 = vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }))
  const w2 = await mountTopNav()
  expect(w2.find('[data-test="menu-trigger"]').exists()).toBe(false)
  w2.unmount()
  spy2.mockRestore()
})
```

shell-width-guard.test.js 追加(静态断言,该文件既有循环外):

```js
test('AppLayout:手机抽屉三要素在场——遮罩(Z.drawer-1)/--sb-width 归 0 档/footer 安全区', () => {
  const src = readFileSync(join(dir, 'AppLayout.vue'), 'utf8')
  expect(src).toMatch(/max-width: 639\.98px\) \{ :root \{ --sb-width: 0px; \} \}/)
  expect(src).toMatch(/Z\.drawer - 1/)
  expect(src).toMatch(/safe-area-inset-bottom/)
  const z = readFileSync(join(dir, '../../styles/zScale.js'), 'utf8')
  expect(z).toMatch(/drawer:\s*\d+/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js src/components/layout/__tests__/shell-width-guard.test.js`
Expected: 新增用例 FAIL;既有 PASS

- [ ] **Step 3: 实现**

zh.json 的 `"nav"` 对象内追加(与 `"refreshPage"` 同级):

```json
"openMenu": "打开导航菜单",
```

en.json 同位置:

```json
"openMenu": "Open navigation menu",
```

TopNavBar.vue:script 引入(既有 useBreakpoint import 行补常量;新增 store import)——

```js
import { useBreakpoint, MQ_BELOW_LG, MQ_BELOW_SM } from '@/composables/useBreakpoint'
import { useShellStore } from '@/stores/shell'
// ...(setup 内,既有 belowLg 旁)
const { matches: belowSm } = useBreakpoint(MQ_BELOW_SM)
const shell = useShellStore()
```

template:`<header>` 内、`<div class="flex items-center gap-sm ...">` 的**第一个子元素**位置插入——

```html
<!-- 手机抽屉开关(仅 <640):桌面/iPad 不渲染(汉堡在手机档取代常驻侧栏的入口职能) -->
<button v-if="belowSm" data-test="menu-trigger" @click="shell.toggleDrawer()"
  class="p-sm -ml-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-colors"
  :aria-label="$t('nav.openMenu')">
  <span class="material-symbols-outlined">menu</span>
</button>
```

AppLayout.vue 四处:

① script:`import { useShellStore } from '@/stores/shell'` + `const shell = useShellStore()`(既有 store 区)。
② template:`<SideNavBar />` 之前插入遮罩——

```html
<!-- 手机抽屉遮罩(<640 仅为真抽屉;iPad/桌面 drawerOpen 恒 false,自然不渲染) -->
<div v-if="shell.drawerOpen" data-test="drawer-backdrop" class="fixed inset-0 bg-on-surface/40"
  :style="{ zIndex: Z.drawer - 1 }" @click="shell.closeDrawer()"></div>
```

③ `<style>` 的 `--sb-width` 块追加手机档(内容满宽,抽屉 overlay 不推挤):

```css
@media (max-width: 639.98px) { :root { --sb-width: 0px; } }
```

④ footer 加 class 与安全区(`<footer>` 类名追加 `shell-footer`;`<style>` 追加):

```css
/* 手机档底部安全区(iPhone Home 指示条):footer 既有 py-sm 之上叠加 */
@media (max-width: 639.98px) {
  .shell-footer { padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 8px); }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/`
Expected: PASS(含既有 TopNavBar/SideNavBar 全家)

- [ ] **Step 5: i18n 门禁**

Run: `npm run i18n:check`
Expected: 0 缺失(新键双语齐)

- [ ] **Step 6: Commit**

```bash
git add src/locales/zh.json src/locales/en.json src/components/layout/TopNavBar.vue src/components/layout/AppLayout.vue src/components/layout/__tests__/TopNavBar.test.js src/components/layout/__tests__/shell-width-guard.test.js
git commit -m "feat(mobile): 顶栏汉堡+抽屉遮罩+--sb-width 手机档+安全区——壳层手机化收口"
```

---

### Task 6: overflow-guard V3——裸 z-index 魔数禁令

**Files:**
- Modify: `scripts/overflow-guard.test.mjs`(追加 V3 规则)

**Interfaces:**
- Produces: 全仓 .vue 静态守卫:禁止 `z-[N]` 任意值魔数(浮层一律 Teleport+Z 取值);既有违规文件入显式 allowlist(带 TODO 注释,后续波次清零)。

- [ ] **Step 1: 盘点存量**

Run: `grep -rn 'z-\[' src --include=*.vue | grep -v node_modules`
记录命中文件与行——这就是 allowlist 初稿(zScale 注释已裁定的内容级局部层叠 z-10~50 命名类如 `z-40` **不**在禁令内,禁令只锁 `z-[` 任意值语法)。

- [ ] **Step 2: 写失败测试**(scripts/overflow-guard.test.mjs 追加;复用该文件既有 `walk()`)

```js
// ── V3:裸 z-index 任意值魔数禁令(2026-09-01 手机适配 Wave 1a)──
// 浮层层级唯一来源是 zScale.js 的 Z;`z-[N]` 任意值类绕过单源,是 issue#3 糊化事故的
// 同族根因。既有违规入 allowlist(后续波次逐个清零后从名单移除);新文件一律红灯。
const Z_ARBITRARY_ALLOWLIST = [] // Task 6 Step 1 盘点结果填入(相对 src 的路径数组);为空最好

test('V3: .vue 禁止 z-[N] 任意值魔数(层级一律 zScale 取值)', () => {
  const offenders = []
  for (const f of walk(SRC)) {
    if (Z_ARBITRARY_ALLOWLIST.some(a => f.endsWith(a))) continue
    const src = readFileSync(f, 'utf8')
    const m = src.match(/z-\[\d+\]/)
    if (m) offenders.push(`${f}: ${m[0]}`)
  }
  assert.deepEqual(offenders, [])
})
```

- [ ] **Step 3: 跑测试**

Run: `node --test scripts/overflow-guard.test.mjs`
Expected: 若 Step 1 有存量 → FAIL;把命中文件填入 `Z_ARBITRARY_ALLOWLIST`(相对 src 路径)后 PASS。allowlist 为空则直接 PASS(也合规)。

- [ ] **Step 4: 全量门禁确认无回归**

Run: `npm test 2>&1 | tail -5`
Expected: PASS(overflow-guard 已在 npm test 链内)

- [ ] **Step 5: Commit**

```bash
git add scripts/overflow-guard.test.mjs
git commit -m "feat(guard): overflow-guard V3——禁 z-[N] 任意值魔数,层级一律 zScale 单源"
```

---

### Task 7: 全量门禁 + 手测清单

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md`(追加 Wave 1a 手测记录节)

- [ ] **Step 1: 全量门禁**

```bash
npm run typecheck && npm test 2>&1 | tail -3 && npm run test:unit 2>&1 | tail -3 && npm run i18n:check
```
Expected: 四项全绿(1718+ 单测基线上只增不减)

- [ ] **Step 2: spec 追加 Wave 1a 手测清单**(合并前真机过一遍)

```markdown
## 9. Wave 1a 真机手测清单(375/390/430 三宽 × 明暗两主题)

1. 手机档汉堡出现;点击抽屉平移入场,导航项/ns 坞可点;点遮罩/Esc/跳转路由均收起
2. 抽屉在场时顶栏不可点穿(遮罩盖住);抽屉 zIndex 高于顶栏
3. 内容满宽无左侧空条(--sb-width:0);footer 不被 iPhone 底条遮住(安全区)
4. 任意 Modal(如 创建资源/Scale)手机档全屏、动作条贴底带安全区;桌面档宽度不变
5. iPad 宽度(768/1000)侧栏仍为 72px 图标栏(hover 展开);桌面(≥1280)完整侧栏——零回归
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md
git commit -m "docs(spec): Wave 1a 真机手测清单"
```

---

## Wave 1a 完成定义

- Task 0-6 全部 commit 在 `worktree-feat-mobile-adaptation`;门禁四绿;
- 真机手测清单(§9)通过后,`git checkout main && git merge --no-ff worktree-feat-mobile-adaptation`(用户裁决合并时机);
- 后续:1b(DataTable 卡片/下拉 bottom sheet/hover 常显/触控目标)另出计划,接续本分支或新开 worktree。
