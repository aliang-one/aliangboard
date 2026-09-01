# 手机适配 Wave 2 实施计划(应急闭环:日志/终端/Pod 动作/工作台审批+停靠收口)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 应急排障闭环在手机上全程可完成——看日志(工具栏不溢出+字号可调)、进终端(虚拟按键条)、止血动作(PodDetail 底部止血条)、AI 干活(审批大按钮)——并收编 Wave 1 停靠项。

**Architecture:** 全部结构性切换消费 `useIsPhone()`;组件级改造复用 Wave 1 既有配方(DropdownMenu bottom sheet 模式/useDropdownPanel/zScale);日志与终端是「工具密度」问题——手机档换行收纳+触控目标而非删功能;Modal 无 actions 槽的安全区下沉到 Modal.vue 一处(惠及所有全屏弹窗)。

**Tech Stack:** Vue 3 `<script setup>` + vitest(happy-dom) + tailwind `max-sm:` + 零新依赖。

**Spec:** `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md` §5(应急闭环)、§6(守卫)。

## Global Constraints

- 禁止新增 npm 依赖;提交作者恒 `aliangone <aliangone@gmail.com>`(**提交前 `git config user.name`+`user.email` 双核对,提交后 `git log -1 --format='%an %ae'` 自证**——repo 身份被并行回写是既有坑)、禁止 Co-Authored-By。
- 结构性切换用 `useIsPhone()`(`src/composables/useBreakpoint.js`,→`{ isPhone }`);纯样式用 `max-sm:`;浮层 z 一律 zScale(overflow-guard V3/V4 在 `npm test` 链内)。
- 触控目标 ≥40px 只调 padding/min 尺寸,不改字号体系;桌面/iPad 零回归,每个任务含桌面不变断言。
- i18n 新文案 zh/en 成对(`src/locales/zh.json`+`en.json`),改完跑 `npm run i18n:check`。
- 多会话并行期全量 unit 用 `npx vitest run --maxWorkers=2`(默认并发会因资源竞争挂起)。
- docs/superpowers 被 gitignore,git add 需 `-f`。工作分支 `worktree-feat-mobile-2`。

---

### Task 1: 测试基建 mockViewport 共享 helper + 卡片命中区 40px(停靠收口)

**Files:**
- Create: `src/__tests__/helpers/mobileViewport.js`
- Modify: `src/components/common/__tests__/DataTable.card.test.js`、`DropdownMenu.panel.test.js`、`FilterBar.test.js`、`SplitButton.test.js`、`ConfirmDialog.test.js`(迁移各自本地 mockBelowSm 到共享 helper)
- Modify: `src/components/common/DataTable.vue`(checkbox 命中区 p-2→p-2.5)
- Test: 上述测试文件自身

**Interfaces:**
- Produces: `mockViewport(belowSm)` → 返回 `vi.spyOn` 结果(可 `mockRestore`);语义=仅 `(max-width: 639.98px)` 查询按入参匹配、其余 false。后续新测试一律用它,不再本地拷贝。

- [ ] **Step 1: 写 helper**(无测试——纯测试脚手架,由迁移后的既有用例守护)

```js
// 手机档视口 mock 共享 helper(2026-09-01 手机适配 Wave 2):收敛 1b 期间 5 份本地拷贝。
// 用法:const spy = mockViewport(true) … spy.mockRestore()(或文件级 afterEach(vi.restoreAllMocks))。
import { vi } from 'vitest'

export function mockViewport(belowSm) {
  return vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)' ? belowSm : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}
```

- [ ] **Step 2: 迁移 5 个测试文件**——每个文件删本地 `mockBelowSm`/等价函数,改 `import { mockViewport } from '@/__tests__/helpers/mobileViewport'`(相对路径按文件位置调),调用点逐字替换。**断言零改动**;每迁一个跑该文件测试绿。

Run: `npx vitest run src/components/common/__tests__/DataTable.card.test.js src/components/common/__tests__/DropdownMenu.panel.test.js src/components/common/__tests__/FilterBar.test.js src/components/common/__tests__/SplitButton.test.js src/components/common/__tests__/ConfirmDialog.test.js`
Expected: PASS(全部,迁移前后行为一致)

- [ ] **Step 3: 卡片命中区补差到 40px**——`DataTable.vue` 手机卡片 checkbox 命中区 `p-2`(36px)改 `p-2.5`(20px checkbox+2×10px=40px):

```html
<span v-if="selectable" data-card-select-hit class="shrink-0 -m-1 p-2.5 inline-flex items-center justify-center" @click.stop>
```

跑 `npx vitest run src/components/common/__tests__/DataTable.card.test.js`(既有 p-2 断言若存在则同步改 p-2.5——断言跟实现走,契约「≥40px 命中区+点击不误触 row-click」不变)。
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/helpers/mobileViewport.js src/components/common/__tests__/ src/components/common/DataTable.vue
git commit -m "feat(mobile): mockViewport 共享测试 helper(收编 5 份拷贝)+卡片命中区补差 40px"
```

---

### Task 2: SplitButton Teleport + 手机 bottom sheet(停靠)

**Files:**
- Modify: `src/components/common/SplitButton.vue`(45 行:菜单 Teleport body;桌面用 `useDropdownPanel` 锚定;手机固定底板;消灭裸 z-30/z-40)
- Test: `src/components/common/__tests__/SplitButton.test.js`(追加)

**Interfaces:**
- Consumes: `useIsPhone()`、`useDropdownPanel(triggerRef, open, { align: 'right' })`(`src/composables/useDropdownPanel.js`,→`{ panelRef, panelStyle }`)、`Z.popover`。
- Produces: SplitButton 菜单手机档 bottom sheet(与 DropdownMenu 同款体验);桌面锚定浮层(裁切链根治);无裸 z 魔数。

- [ ] **Step 1: 写失败测试**(追加;mockViewport 用 Task 1 helper)

```js
import { Z } from '@/styles/zScale'

test('手机档:菜单 Teleport 到 body 的底部面板(zIndex=Z.popover);桌面锚定', async () => {
  mockViewport(true)
  const w = await mountSplit()
  await w.findAll('button')[1].trigger('click')   // 展开箭头钮
  await nextTick()
  const panel = document.querySelector('[data-split-menu]')
  expect(panel).toBeTruthy()
  expect(panel.style.bottom).toBe('0px')
  expect(panel.style.zIndex).toBe(String(Z.popover))
  w.unmount(); document.body.innerHTML = ''

  mockViewport(false)
  const d = await mountSplit()
  await d.findAll('button')[1].trigger('click')
  await nextTick()
  const dp = document.querySelector('[data-split-menu]')
  expect(dp).toBeTruthy()
  expect(dp.style.bottom).toBe('')
  d.unmount(); document.body.innerHTML = ''
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/SplitButton.test.js`
Expected: FAIL(菜单未 Teleport/无 bottom)

- [ ] **Step 3: 实现**(SplitButton.vue;参照 `DropdownMenu.vue` 的双分支结构逐段仿写——它就是本仓 bottom sheet 配方的参照实现)

script:`import { useIsPhone } from '@/composables/useBreakpoint'`、`import { useDropdownPanel } from '@/composables/useDropdownPanel'`、`import { Z } from '@/styles/zScale'`;`const { isPhone } = useIsPhone()`;菜单 open ref 旁加 `triggerRef`;`const { panelRef, panelStyle } = useDropdownPanel(triggerRef, open, { align: 'right' })`;手机底板 `const phonePanelStyle = computed(() => ({ position: 'fixed', left: '0px', right: '0px', bottom: '0px', zIndex: Z.popover }))`。

template:菜单容器从就地 absolute 改 Teleport+双分支(原有菜单项渲染与 action 分发原样搬入):

```html
    <Teleport to="body">
      <div v-if="open" ref="panelRef" data-split-menu
        :style="isPhone ? phonePanelStyle : panelStyle"
        :class="isPhone ? 'w-full rounded-t-2xl rounded-b-none py-sm shadow-dropdown max-h-[70vh] overflow-y-auto' : 'min-w-[160px] rounded-lg py-xs'"
        class="bg-surface-container-lowest border border-outline-variant overflow-hidden"
        @click.stop>
        <!-- 既有菜单项按钮原样搬入,类追加 max-sm:min-h-[40px](若 Task 4 前置已加则保留) -->
      </div>
    </Teleport>
    <div v-if="open" class="fixed inset-0" :style="{ zIndex: Z.popover - 1 }" @click="open = false"></div>
```

删除原就地菜单与 `fixed inset-0 z-30` 旧遮罩;触发按钮组加 `ref="triggerRef"`(外层容器);`onBeforeUnmount` 收 `open=false`(若未有)。桌面菜单项既有触控类保留。

- [ ] **Step 4: 跑测试确认通过**(含既有用例;菜单项点击分发/禁用态断言若受 DOM 迁移影响,按新结构适配查询路径——document.querySelector)

Run: `npx vitest run src/components/common/__tests__/SplitButton.test.js`
Expected: PASS(全部)

- [ ] **Step 5: Commit**

```bash
git add src/components/common/SplitButton.vue src/components/common/__tests__/SplitButton.test.js
git commit -m "feat(mobile): SplitButton 菜单 Teleport+手机 bottom sheet——消灭裸 z 魔数(停靠收口)"
```

---

### Task 3: LogViewerBody 手机化(工具栏收纳+字号调节)

**Files:**
- Modify: `src/components/common/LogViewerBody.vue`(两行工具栏 `max-sm:flex-wrap`;selects 触控目标;字号 A-/A+)
- Test: `src/components/common/__tests__/LogViewerBody.test.js`(找到既有测试文件就追加;无则新建——组件 props/依赖以源码为准,`useLogViewer` 需按既有消费方(如 LogPopup/PodDetail)的 mount 方式 mock)

**Interfaces:**
- Consumes: 无新增(组件内自有状态)。
- Produces: 手机档工具栏换行收纳不横向溢出;字号调节按钮(10~18px 钳制,默认不变);selects/按钮触控目标 ≥40px。
- 裁决注:容器/行数/since 保留原生 `<select>`——手机上原生 select 即 OS 级底部选择器(bottom sheet 的平台正解),不做自定义面板;日志「全屏化」由挂载形态(LogPopup/Modal)经 Wave 1a 自动全屏覆盖,本任务不重复实现。

- [ ] **Step 1: 写失败测试**(断言类名契约;组件依赖按源码最小 mock——`useLogViewer` 返回形状照 `src/composables/useLogViewer.js` 真实签名 stub)

```js
test('手机档:工具栏换行收纳+字号调节按钮进退钳制', async () => {
  mockViewport(true)
  const w = await mountLogViewer()   // 照既有/新建 mount;无流式数据也要可渲染
  expect(w.find('[data-testid="log-toolbar-row-1"]').classes()).toContain('max-sm:flex-wrap')
  expect(w.find('[data-testid="log-toolbar-row-2"]').classes()).toContain('max-sm:flex-wrap')
  // 字号:默认不变,A- 减 1,连点到 10 钳制,A+ 加回
  const before = w.find('[data-testid="log-scroll"]').attributes('style') || ''
  await w.find('[data-testid="log-font-down"]').trigger('click')
  await w.find('[data-testid="log-font-down"]').trigger('click')
  const after = w.find('[data-testid="log-scroll"]').attributes('style') || ''
  expect(after).not.toBe(before)
  for (let i = 0; i < 20; i++) await w.find('[data-testid="log-font-down"]').trigger('click')
  await w.find('[data-testid="log-font-up"]').trigger('click')
  expect(w.find('[data-testid="log-font-down"]').exists()).toBe(true)
  w.unmount()
})

test('桌面档:无字号调节钮,工具栏无换行类', async () => {
  mockViewport(false)
  const w = await mountLogViewer()
  expect(w.find('[data-testid="log-font-down"]').exists()).toBe(false)
  expect(w.find('[data-testid="log-toolbar-row-1"]').classes()).not.toContain('max-sm:flex-wrap')
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/LogViewerBody.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**(LogViewerBody.vue)

script:

```js
const fontSize = ref(12)                      // px;日志区字号(默认=现状 text-code-sm 观感)
function adjustFont(delta) { fontSize.value = Math.min(18, Math.max(10, fontSize.value + delta)) }
```

template:
① 两行工具栏容器类各追加 `max-sm:flex-wrap max-sm:gap-sm max-sm:py-1`;行内 `<select>` 类追加 `max-sm:min-h-[40px]`;`log-previous/log-follow` 两个 label 追加 `max-sm:py-1`(点控 ≥40px);行 2 的刷新/下载/复制按钮类追加 `max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center`。
② 行 2 的操作区(`ml-auto` 那组)前面插入字号对(仅手机):

```html
      <template v-if="isPhone">
        <span class="w-px h-5 bg-outline-variant/60 shrink-0"></span>
        <button data-testid="log-font-down" @click="adjustFont(-1)" :aria-label="t('component.logViewer.fontHint')" :title="t('component.logViewer.fontHint')"
          class="px-sm min-h-[32px] rounded-lg hover:bg-surface-container-low text-body-sm font-mono">A-</button>
        <button data-testid="log-font-up" @click="adjustFont(1)" :aria-label="t('component.logViewer.fontHint')" :title="t('component.logViewer.fontHint')"
          class="px-sm min-h-[32px] rounded-lg hover:bg-surface-container-low text-body-base font-mono">A+</button>
      </template>
```

③ 渲染区(`data-testid="log-scroll"`)加 `:style="{ fontSize: fontSize + 'px' }"`。
④ script 引 `useIsPhone`。

i18n:`component.logViewer.fontHint` zh=`字号` / en=`Font size`。

- [ ] **Step 4: 跑测试确认通过 + i18n 门禁**

Run: `npx vitest run src/components/common/__tests__/LogViewerBody.test.js && npm run i18n:check`
Expected: PASS / 0

- [ ] **Step 5: Commit**

```bash
git add src/components/common/LogViewerBody.vue src/components/common/__tests__/LogViewerBody.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(mobile): 日志查看器手机化——工具栏换行收纳+字号调节+触控目标"
```

---

### Task 4: PodDetail 手机动作区 + 底部止血条

**Files:**
- Modify: `src/views/PodDetail.vue`(头部按钮换行+触控目标;手机档 fixed 底部止血条:重启/删除)
- Test: PodDetail 既有测试文件追加(先 `grep -rln "PodDetail" src/views/__tests__/ src/**/__tests__ 2>/dev/null` 定位;无则新建最小 mount——组件依赖多时允许浅挂载+子组件 stub,断言只看目标元素)

**Interfaces:**
- Consumes: `useIsPhone()`;既有 `askRestart`/`askDelete` 处理函数(止血条按钮直接调用,ConfirmDialog 二次确认不变——误触防线不放松)。

- [ ] **Step 1: 写失败测试**

```js
test('手机档:头部按钮换行+40px;底部止血条(重启/删除)在场且复用既有处理器', async () => {
  mockViewport(true)
  const w = await mountPodDetail()   // 照既有 mount(子组件 stub)
  const btn = w.find('button')       // 头部既有按钮(如 跳转负载/导出)
  expect(btn.classes().join(' ')).toContain('max-sm:min-h-[40px]')
  expect(w.find('[data-testid="pod-action-bar"]').exists()).toBe(true)
  const barBtns = w.findAll('[data-testid="pod-action-bar"] button')
  expect(barBtns.length).toBe(2)
  // 重启钮点击走既有 askRestart(弹确认)——断言确认弹窗/函数被触发,而非直接删
  await barBtns[0].trigger('click')
  expect(w.find('[data-testid="pod-action-bar"]').exists()).toBe(true) // 冒烟:点击不抛
  w.unmount()
})

test('桌面档:无底部止血条', async () => {
  mockViewport(false)
  const w = await mountPodDetail()
  expect(w.find('[data-testid="pod-action-bar"]').exists()).toBe(false)
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run <PodDetail 测试文件>`
Expected: FAIL

- [ ] **Step 3: 实现**(PodDetail.vue)

① 头部按钮区容器类追加 `max-sm:flex-wrap max-sm:gap-sm`;每个头部按钮类追加 `max-sm:min-h-[40px]`。
② script 引 `useIsPhone`;模板根内追加(appLayout main 是滚动容器,fixed 相对视口):

```html
  <!-- 手机底部止血条(spec §5):重启/删除一键可达;复用既有处理器,二次确认不放松 -->
  <div v-if="isPhone" data-testid="pod-action-bar"
    class="fixed bottom-0 inset-x-0 flex gap-sm px-md pt-sm bg-surface-container-lowest border-t border-outline-variant"
    :style="{ zIndex: Z.drawer - 1, paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 8px)' }">
    <button @click="askRestart" class="flex-1 min-h-[44px] flex items-center justify-center gap-sm bg-primary text-on-primary rounded-lg font-semibold active:scale-95 transition-all">
      <span class="material-symbols-outlined text-base">restart_alt</span>{{ $t('podDetail.restart') }}
    </button>
    <button @click="askDelete" class="flex-1 min-h-[44px] flex items-center justify-center gap-sm border border-error/50 text-error rounded-lg active:scale-95 transition-all">
      <span class="material-symbols-outlined text-base">delete</span>{{ $t('podDetail.delete') }}
    </button>
  </div>
```

> `$t('podDetail.restart')/delete` 若实际键名不同,以源码既有头部按钮的文案键为准替换;script `import { Z } from '@/styles/zScale'`。主内容底部补 `max-sm:pb-20`(防止止血条遮住末尾内容,数字以条高约 60px+安全区估)。

- [ ] **Step 4: 跑测试确认通过**(该文件全部)

Run: `npx vitest run <PodDetail 测试文件>`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/views/PodDetail.vue <PodDetail 测试文件>
git commit -m "feat(mobile): PodDetail 手机动作区换行+底部止血条(重启/删除,复用二次确认)"
```

---

### Task 5: 终端虚拟按键条 + TerminalTaskbar 关闭钮触控目标

**Files:**
- Modify: `src/components/common/InteractiveTerminal.vue`(手机档按键条;`sendInput` 注入函数)
- Modify: `src/components/terminal/TerminalTaskbar.vue`(chip 关闭 × 触控目标)
- Test: `src/components/common/__tests__/InteractiveTerminal` 相关(先定位:`grep -rln "InteractiveTerminal" src --include=*.test.js`;xterm 依赖重——测试策略:把按键条的**字节映射**抽成纯函数放同文件 export 并直测,组件挂载仅断言手机档按键条在场/桌面不在)

**Interfaces:**
- Consumes: 既有 `stream?.send(d)` 数据通路(`term.onData` 同款);`useIsPhone()`。
- Produces: `KEY_BYTES` 纯映射(导出,可测);`sendInput(d)`(组件内,工具条调用);手机档按键条(Esc/Tab/↑/↓/←/→/Ctrl+C)。

- [ ] **Step 1: 写失败测试**(新建 `InteractiveTerminal.keys.test.js`;不 mount xterm,只测纯函数与模板分支)

```js
import { KEY_BYTES } from '@/components/common/InteractiveTerminal.vue'

test('虚拟按键字节映射:与 VT100/xterm 标准转义一致', () => {
  expect(KEY_BYTES['Esc']).toBe('\x1b')
  expect(KEY_BYTES['Tab']).toBe('\t')
  expect(KEY_BYTES['↑']).toBe('\x1b[A')
  expect(KEY_BYTES['↓']).toBe('\x1b[B')
  expect(KEY_BYTES['←']).toBe('\x1b[D')
  expect(KEY_BYTES['→']).toBe('\x1b[C')
  expect(KEY_BYTES['Ctrl+C']).toBe('\x03')
})
```

模板分支断言并入既有 InteractiveTerminal 测试(若 mount 成本过高,允许新开轻量测试文件对 SFC 编译后模板做静态断言——参照 `shell-width-guard.test.js` 的 readFileSync 模式):手机档模板含 `data-test="term-keybar"` 与全部 7 个键位;桌面档不渲染(运行时分支,以实现内 `v-if="isPhone"` 源码断言兜底)。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run <定位到的测试文件>`
Expected: FAIL(KEY_BYTES 未导出)

- [ ] **Step 3: 实现**(InteractiveTerminal.vue)

script:

```js
// 手机虚拟按键字节表(VT100/xterm 标准):无物理键盘时的 exec 刚需(spec §5)
export const KEY_BYTES = { 'Esc': '\x1b', 'Tab': '\t', '↑': '\x1b[A', '↓': '\x1b[B', '←': '\x1b[D', '→': '\x1b[C', 'Ctrl+C': '\x03' }
const { isPhone } = useIsPhone()
function sendInput(d) { stream?.send(d) }
```

template:xterm 根容器之下追加(手机档):

```html
  <div v-if="isPhone" data-test="term-keybar" class="flex items-center gap-1 px-sm py-1 border-t border-outline-variant bg-surface-container-low overflow-x-auto">
    <button v-for="(bytes, key) in KEY_BYTES" :key="key" @click="sendInput(bytes)"
      class="shrink-0 min-h-[40px] min-w-[40px] px-sm rounded-lg border border-outline-variant bg-surface-container-lowest text-body-sm font-mono active:bg-primary-container/20 transition-colors">
      {{ key }}
    </button>
  </div>
```

TerminalTaskbar.vue:4 处 chip 关闭 ×(`opacity-0 group-hover:opacity-100 max-sm:opacity-100` 的 span)类追加 `max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run <定位到的测试文件>`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/common/InteractiveTerminal.vue src/components/terminal/TerminalTaskbar.vue <测试文件>
git commit -m "feat(mobile): 终端虚拟按键条(VT100 字节表)+任务栏关闭钮触控目标"
```

---

### Task 6: Modal 无 actions 槽底缘安全区 + ChatModal 手机满高(停靠)

**Files:**
- Modify: `src/components/common/Modal.vue`(max-layout 内容区手机档底部安全区 padding——惠及所有无 actions 的全屏弹窗)
- Modify: `src/components/workbench/ChatModal.vue`(`h-[72vh]` 手机档改满高)
- Test: `Modal.test.js`、ChatModal 既有测试(定位 `grep -rln "ChatModal" src --include=*.test.js`)追加

**Interfaces:**
- Produces: 无 actions 槽的全屏 Modal(ToolCallModal/ChatModal 等)内容底缘不再贴死、带安全区;ChatModal 手机档内容满高(修复 72vh 硬编码在全屏 Modal 里下方留空)。

- [ ] **Step 1: 写失败测试**

Modal.test.js 追加:

```js
test('手机档全屏 Modal:无 actions 时内容区带底部安全区 padding', async () => {
  mockViewport(true)
  const wrapper = mount(Modal, { props: { modelValue: true, title: 't' }, global: { plugins: [i18n] } })
  await nextTick()
  const content = document.querySelector('body .flex-1')
  expect(content).toBeTruthy()
  expect(content.className).toContain('max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+16px)]')
  wrapper.unmount(); document.body.innerHTML = ''
})
```

ChatModal 测试追加:

```js
test('手机档:ChatModal 内层满高(72vh 硬编码不适用全屏 Modal)', async () => {
  mockViewport(true)
  const w = await mountChatModal()   // 照既有 mount
  const inner = w.find('.h-\\[72vh\\], [class*="h-full"]')  // 以实现断言:手机类在桌面档类之上
  expect(w.html()).toContain('max-sm:h-full')
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/Modal.test.js <ChatModal 测试文件>`
Expected: FAIL

- [ ] **Step 3: 实现**

Modal.vue 内容区(`isMaxLayout ? 'flex-1 overflow-y-auto p-lg' : ''` 处):

```html
<div :class="isMaxLayout ? ['flex-1 overflow-y-auto p-lg', 'max-sm:pb-[calc(env(safe-area-inset-bottom,0px)+16px)]'] : ''"><slot :maximized="maximized" /></div>
```

ChatModal.vue 内层:

```html
<div v-if="conversation" class="h-[72vh] max-sm:h-full flex flex-col min-h-0">
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/Modal.test.js <ChatModal 测试文件>`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/common/Modal.vue src/components/workbench/ChatModal.vue <测试文件>
git commit -m "feat(mobile): 全屏 Modal 无 actions 底缘安全区+ChatModal 手机满高(停靠收口)"
```

---

### Task 7: 工作台审批按钮手机大按钮

**Files:**
- Modify: `src/components/workbench/WorkbenchChat.vue`(审批 Modal 的 #actions 两按钮手机档拉伸放大)
- Test: `src/components/workbench/__tests__/WorkbenchChat.approval.test.js`(已存在,追加)

**Interfaces:**
- Consumes: 既有审批 Modal(priority,手机档经 1a 已全屏+动作条安全区);`decideApproval(true/false)`。

- [ ] **Step 1: 写失败测试**(照该文件既有 mock/approval 触发方式把 pendingApproval 置位)

```js
test('手机档:审批按钮全宽大目标(拒绝/批准各 flex-1 ≥44px)', async () => {
  mockViewport(true)
  const w = await mountWithPendingApproval()   // 该文件既有的审批置位路径
  const btns = w.findAll('[data-testid="approval-approve"], [data-testid="approval-deny"]')
  // 若既有用例无 testid,按按钮文本查询(拒绝/批准 i18n 文案);断言类契约:
  expect(w.find('button.bg-primary').classes()).toContain('max-sm:min-h-[44px]')
  expect(w.find('button.bg-primary').classes()).toContain('max-sm:flex-1')
  w.unmount()
})
```

> 给两按钮补 `data-testid`(approval-deny/approval-approve)便于稳定查询。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.approval.test.js`
Expected: FAIL

- [ ] **Step 3: 实现**(WorkbenchChat.vue 审批 Modal #actions)

```html
      <template #actions>
        <button data-testid="approval-deny" @click="decideApproval(false)" :disabled="sending"
          class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container max-sm:flex-1 max-sm:min-h-[44px] max-sm:text-body-md">{{ t('workbench.chat.reject') }}</button>
        <button data-testid="approval-approve" @click="decideApproval(true)" :disabled="sending"
          class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold disabled:opacity-40 max-sm:flex-1 max-sm:min-h-[44px] max-sm:text-body-md">{{ t('workbench.chat.approve') }}</button>
      </template>
```

- [ ] **Step 4: 跑测试确认通过**(该文件全部——注意既有审批 CAS 用例有 1/3 隔离 flaky 的既有记录,红灯先分辨是否既有 flaky)

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.approval.test.js`
Expected: PASS(新用例绿;既有 flaky 按既有判定口径)

- [ ] **Step 5: Commit**

```bash
git add src/components/workbench/WorkbenchChat.vue src/components/workbench/__tests__/WorkbenchChat.approval.test.js
git commit -m "feat(mobile): 工作台审批按钮手机全宽大目标(44px)——单手可批"
```

---

### Task 8: 全量门禁 + 手测清单

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md`(追加 §11 Wave 2 手测)

- [ ] **Step 1: 全量门禁**

```bash
npm run typecheck && node --test server/*.test.mjs 2>&1 | grep -E "^ℹ (pass|fail)" && npx vitest run --maxWorkers=2 2>&1 | grep -E "Test Files|Tests " && npm run i18n:check
```
Expected: 四项全绿(基线 1806 只增不减)

- [ ] **Step 2: spec 追加**(逐字)

```markdown

## 11. Wave 2 真机手测清单

1. 日志(PodDetail→日志):工具栏两行换行不横向溢出;A-/A+ 字号即时生效;follow/previous 可点
2. 终端:虚拟按键条在场;Esc/Tab/Ctrl+C 在 shell 里行为正确;方向键翻历史;按键条随软键盘不遮挡(终端在下、条在上)
3. PodDetail:底部止血条重启/删除——均弹二次确认;头部按钮换行可点
4. SplitButton(任一列表页「创建」):手机底部弹出、选项可点、点遮罩关
5. 工作台:触发审批→全屏弹窗、批准/拒绝全宽大按钮;ChatModal 满高不空底
6. 桌面/iPad:日志工具栏平铺、无字号钮;PodDetail 无止血条;SplitButton 锚定浮层;审批按钮原尺寸——零回归
```

- [ ] **Step 3: Commit**

```bash
git add -f docs/superpowers/specs/2026-09-01-mobile-adaptation-design.md
git commit -m "docs(spec): Wave 2 真机手测清单"
```

---

## Wave 2 完成定义

- Task 1-7 全部 commit 在 `worktree-feat-mobile-2`;Task 8 四门禁绿;
- 真机手测(§11)通过后 `--no-ff` 合 main;
- Wave 3 停靠:①workload 详情页(NsWorkloadDetail)sticky 动作条(scale/rollback/restart)——该页是组件拆分 backlog 大户,待拆分波同做;②xterm 字号热调(term 实例句柄重构);③视图级触控目标细扫(存储/网络/管理域)、既有浮层组件巡检。
