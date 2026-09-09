# 手机适配 Wave 5(W1+W2)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地手机适配第五波的 W1(共享基建)+ W2(用户点名三处):FloatingWindow 手机铺满、Pagination/Breadcrumbs 响应式、WorkbenchDetail 侧栏抽屉化、WorkbenchServers 表格卡片化+弹窗响应式、NsWorkloadDetail 页头/tab/裸表/拓扑画布,共 26 条审计发现(含 5×P0)。

**Architecture:** 配方先行——W1 修共享组件(FloatingWindow/Pagination/Breadcrumbs),W2 按配方改三个页面文件;波内文件互不相交;模板类改动用「挂载断言 / 静态源码断言」双模式测试(仓库既有先例:`NsWorkloadDetail.action-bar.test.js` / `InteractiveTerminal.keys.test.js`);结构性改动(抽屉/浮窗)用 `useIsPhone` JS 分支,纯样式一律 `max-sm:` 类。

**Tech Stack:** Vue 3 `<script setup>` + Tailwind(断点单源 `useIsPhone` = max-width 639.98px)+ vitest/happy-dom + `mockViewport` helper;零新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-09-mobile-adaptation-wave5-design.md`(§4 配方 R1-R12、§5 波次、附录发现注册表;执行者须先读 spec §4 对应配方与本文件)

## Global Constraints

- 提交作者恒为 `aliang-one <aliangdone@gmail.com>`(repo git config 已配好,直接 `git commit` 即可);提交信息**英文**;**禁止** `Co-Authored-By` 尾注。
- 禁止改写已推送历史、禁止 force push;工作分支 `feat/mobile-wave5-w1w2`,波末 `--no-ff` 合 main。
- 零新增依赖;`max-sm:` 类优先,JS 分支(isPhone)仅用于结构切换。
- 触控命中区四件套完整形态:`relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']`(四件缺一不可)。
- z-index 一律取 `src/styles/zScale.js` 的 `Z`(V3 守卫禁止 `z-[N]` 字面量)。
- src 中禁止新增中文字面量(i18n 门禁),文案一律走 locales 键。
- 每任务完成跑:`npx vitest run <本任务测试文件>` + `npm run typecheck`;波末跑全量四道门禁。
- 测试挂载套路照 `src/views/__tests__/NsWorkloadDetail.action-bar.test.js`:真实 `@/i18n` + `VueQueryPlugin` + mock `@/api/client`/stores/router + `mockViewport(true/false)` + finally `spy.mockRestore()`。

---

### Task 0: 工作区准备(由 orchestrator 执行)

- [ ] 用 superpowers:using-git-worktrees 建分支 `feat/mobile-wave5-w1w2` 的隔离工作区;后续任务在其上执行。

---

### Task 1: FloatingWindow 手机铺满(R1,治 2×P0 + SshFileBrowserWindow P0)

**Files:**
- Modify: `src/components/common/FloatingWindow.vue:7,29-32,60-66`
- Test: `src/components/common/__tests__/FloatingWindow.phone.test.js`(新建)

**Interfaces:**
- Consumes: `useIsPhone()`(`@/composables/useBreakpoint`,返回 `{ isPhone }`)、`Z`(已在用)。
- Produces: FloatingWindow props 不变;手机档自动 inset 铺满,消费方(TerminalWindow/SshTerminalWindow/FileBrowserWindow/TransfersPanel)**零改动**;W2 Task 5 的 SshFileBrowserWindow P0 随本任务自动解决。

- [ ] **Step 1: 写失败测试**

```js
// src/components/common/__tests__/FloatingWindow.phone.test.js
// Wave5 W1 Task1(R1):浮窗手机铺满——390px 下不再出屏/不可控。
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FloatingWindow from '../FloatingWindow.vue'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

function styleOf(w) { return w.find('[data-test="window"]').attributes('style') || '' }

describe('FloatingWindow 手机铺满(R1)', () => {
  it('桌面档:常规定位/尺寸/最大化 left 消费 --sb-width(回归锚)', () => {
    const w = mount(FloatingWindow, { props: { width: '720px', height: '460px' } })
    expect(styleOf(w)).toContain('width: 720px')
    expect(styleOf(w)).toContain('left: 80px')
    w.unmount()
  })

  it('桌面档最大化:left 用 calc(var(--sb-width,260px)+8px) 取代硬编码 268px', async () => {
    const w = mount(FloatingWindow, { props: {} })
    await w.find('[data-test="btn-maximize"]').trigger('click')
    expect(styleOf(w)).toContain('calc(var(--sb-width, 260px) + 8px)')
    w.unmount()
  })

  it('手机档:忽略 width/pos,inset 8px 铺满;最大化同款', async () => {
    const spy = mockViewport(true)
    try {
      const w = mount(FloatingWindow, { props: { width: '720px' } })
      const s = styleOf(w)
      expect(s).toContain('left: 8px'); expect(s).toContain('right: 8px')
      expect(s).toContain('top: 8px'); expect(s).toContain('bottom: 44px')
      expect(s).not.toContain('width')
      await w.find('[data-test="btn-maximize"]').trigger('click')
      expect(styleOf(w)).toContain('left: 8px')   // 最大化不再锚 268px
      w.unmount(); document.body.innerHTML = ''
    } finally { spy.mockRestore() }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/FloatingWindow.phone.test.js`
Expected: FAIL —— 桌面最大化断言含 `268px` 而非 `calc(...)`;手机档 style 含 `width: 720px`/负 left。

- [ ] **Step 3: 实现**

`FloatingWindow.vue` script 改三处:

```js
// 1) import 区(第 7 行后)加:
import { useIsPhone } from '@/composables/useBreakpoint'
// props 定义之后加:
const { isPhone } = useIsPhone()

// 2) winStyle computed 整体替换(保留原注释块,尾部追加手机档说明):
// —— 手机档(R1/Wave5):390px 视口下固定宽(720/860px)+ 级联定位数学会把窗口推出屏外
// (x=Math.min(80, 390-740)=-350)且拖拽是 mouse 事件触屏不可用 → 浮窗一律 inset 铺满
// 内容区;最大化 left 消费 --sb-width(手机档该变量为 0,天然全宽),桌面行为不变。
const winStyle = computed(() => {
  if (isPhone.value) {
    return { left: '8px', top: '8px', right: '8px', bottom: '44px', zIndex: props.zIndex }
  }
  return isMax.value
    ? { left: 'calc(var(--sb-width, 260px) + 8px)', top: '72px', right: '8px', bottom: '44px', zIndex: props.zIndex }
    : { left: pos.value.x + 'px', top: pos.value.y + 'px', width: props.width, height: props.height, zIndex: props.zIndex }
})

// 3) pos 初始化两行的 -740/-480 基数不动(手机档 winStyle 已不走 pos);
//    拖拽逻辑不动(mouse-only,手机档无害)。
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/FloatingWindow.phone.test.js`
Expected: PASS ×3

- [ ] **Step 5: 提交**

```bash
git add src/components/common/FloatingWindow.vue src/components/common/__tests__/FloatingWindow.phone.test.js
git commit -m "fix(mobile): FloatingWindow phone full-bleed + maximize consumes --sb-width (Wave5 R1)"
```

---

### Task 2: Pagination 响应式(R2,治 8 条发现)

**Files:**
- Modify: `src/components/common/Pagination.vue:30,39-42,43-59`
- Test: `src/components/common/__tests__/Pagination.phone.test.js`(新建)

**Interfaces:**
- Produces: props/emits 不变;手机档根行可换行、摘要隐藏、翻页钮命中区扩展;全部 DataTable 页脚消费方零改动。

- [ ] **Step 1: 写失败测试**

```js
// src/components/common/__tests__/Pagination.phone.test.js
// Wave5 W1 Task2(R2):分页条手机档可换行、摘要降级、翻页钮命中区。
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import Pagination from '../Pagination.vue'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

vi.mock('vue-i18n', () => ({ useI18n: () => ({ t: (k) => k }) }))

describe('Pagination 手机档(R2)', () => {
  it('根行含 max-sm:flex-wrap;摘要 max-sm:hidden;前后钮带四件套', () => {
    const spy = mockViewport(true)
    try {
      const w = mount(Pagination, { props: { total: 55, pageSize: 10, currentPage: 2, showSizeSelector: true } })
      expect(w.find('div').classes().join(' ')).toContain('max-sm:flex-wrap')
      const summary = w.findAll('span').find(s => s.text().includes('rangeSummary'))
      expect(summary.classes()).toContain('max-sm:hidden')
      const prev = w.findAll('button').find(b => b.attributes('title') === 'component.pagination.prevPage')
      expect(prev.classes().join(' ')).toContain('max-sm:after:-inset-2')
      // 功能不回归:下一页仍可点并 emit
      const next = w.findAll('button').find(b => b.attributes('title') === 'component.pagination.nextPage')
      expect(next.attributes('disabled')).toBeUndefined()
      w.unmount(); document.body.innerHTML = ''
    } finally { spy.mockRestore() }
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/Pagination.phone.test.js`
Expected: FAIL(找不到 `max-sm:flex-wrap`)

- [ ] **Step 3: 实现**

`Pagination.vue` template 三处:

```html
<!-- 根行(30): -->
<div v-if="total > 0" class="flex flex-wrap items-center gap-x-md gap-y-xs max-sm:gap-x-xs">
  <!-- 摘要 span(39): -->
  <span class="text-body-sm text-on-surface-variant whitespace-nowrap max-sm:hidden">
  <!-- prev/next 两个 button 的 class 里追加(p-xs 前插 relative,尾接四件套后三件): -->
  class="relative p-xs text-on-surface-variant hover:bg-surface-container-highest rounded-md disabled:opacity-30 transition-colors max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/Pagination.phone.test.js`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/common/Pagination.vue src/components/common/__tests__/Pagination.phone.test.js
git commit -m "fix(mobile): Pagination wraps on phone, summary hidden, nav hit-areas (Wave5 R2)"
```

---

### Task 3: Breadcrumbs 收敛(W1 S2 关联)

**Files:**
- Modify: `src/components/common/Breadcrumbs.vue:8-17`
- Test: `src/components/common/__tests__/Breadcrumbs.phone.test.js`(新建)

**Interfaces:**
- Produces: props 不变;每段可 truncate(长 ns 名/资源名不再撑破头部),分隔箭头不收缩。

- [ ] **Step 1: 写失败测试**

```js
// src/components/common/__tests__/Breadcrumbs.phone.test.js
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import Breadcrumbs from '../Breadcrumbs.vue'

describe('Breadcrumbs truncate', () => {
  it('各段可 truncate,容器 min-w-0;末段高亮保留', () => {
    const w = mount(Breadcrumbs, { props: { items: [
      { label: 'my-team-production-with-a-very-long-name', route: '/ns/x' },
      { label: 'PersistentVolumeClaims', route: '/y' },
      { label: 'data-archive-pvc-2026-with-long-suffix' },
    ] } })
    const links = w.findAll('a')
    expect(links.length).toBe(2)
    for (const a of links) expect(a.classes()).toContain('truncate')
    const last = w.findAll('span').filter(s => s.text().includes('data-archive'))
    expect(last.length).toBeGreaterThan(0)
    w.unmount()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/Breadcrumbs.phone.test.js`
Expected: FAIL(链接无 truncate)

- [ ] **Step 3: 实现**

```html
<nav class="flex items-center gap-2 min-w-0 text-on-surface-variant text-body-sm mb-1">
  <template v-for="(item, idx) in items" :key="idx">
    <router-link
      v-if="item.route"
      :to="item.route"
      class="hover:text-primary transition-colors truncate"
      :title="item.label"
    >{{ item.label }}</router-link>
    <span v-else :class="[idx === items.length - 1 ? 'text-primary font-medium' : '', 'truncate']" :title="item.label">{{ item.label }}</span>
    <span v-if="idx < items.length - 1" class="material-symbols-outlined text-sm shrink-0">chevron_right</span>
  </template>
</nav>
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run src/components/common/__tests__/Breadcrumbs.phone.test.js` → PASS
Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.action-bar.test.js`(Breadcrumbs 被 stub,应不受影响)→ PASS

- [ ] **Step 5: 提交**

```bash
git add src/components/common/Breadcrumbs.vue src/components/common/__tests__/Breadcrumbs.phone.test.js
git commit -m "fix(mobile): Breadcrumbs items truncate with title fallback (Wave5 W1)"
```

---

### Task 4: WorkbenchDetail 侧栏手机抽屉(R6,治 2×P0 + 3×P2 触控)

**Files:**
- Modify: `src/views/WorkbenchDetail.vue`(script 头 import 区 + `selectConversation`/`newConversation`/`openFile` 附近 + template 318-359 工具条/383-421 侧栏/447-485 文件树/410-416/472-476 触控)
- Test: `src/views/__tests__/WorkbenchDetail.phone-drawer.test.js`(新建,静态源码断言模式)

**Interfaces:**
- Consumes: `useIsPhone`、`useEscClose(isOpenRef, onClose)`(`src/composables/useEscClose.js`,栈顶 ESC 语义)、`Z.drawer`/`Z.drawer-1`、`Teleport :disabled`。
- Produces: 手机档 DOM 锚点 `data-testid="open-conversations-btn"` / `open-files-btn` / `conversation-sidebar` / `file-tree-sidebar` / `wb-drawer-overlay`;W2 验证截图依赖这些锚点。桌面档结构与类名零变化。

- [ ] **Step 1: 写失败测试(静态源码断言,先例:InteractiveTerminal.keys.test.js)**

```js
// src/views/__tests__/WorkbenchDetail.phone-drawer.test.js
// Wave5 W2 Task4(R6):对话列表/Edit 文件树手机收抽屉。模板重(WorkbenchChat/YamlEditor/
// vue-query),用静态源码断言钉住结构契约;行为验证走波末 390px 截图(计划 Task 9)。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'

const src = readFileSync(fileURLToPath(new URL('../WorkbenchDetail.vue', import.meta.url)), 'utf8')

test('R6 抽屉:Teleport 手机启用/桌面禁用,双抽屉开关钮在工具条', () => {
  expect(src).toContain(':disabled="!isPhone"')                       // 侧栏 Teleport
  expect((src.match(/:disabled="!isPhone"/g) || []).length).toBeGreaterThanOrEqual(2)
  expect(src).toContain('data-testid="open-conversations-btn"')
  expect(src).toContain('data-testid="open-files-btn"')
  expect(src).toContain('v-if="isPhone && mode === \'agent\'"')
  expect(src).toContain('v-if="isPhone && mode === \'edit\'"')
})

test('R6 抽屉:遮罩/面板走 Z 阶梯,选中即收(watch 收口)', () => {
  expect(src).toContain('Z.drawer - 1')
  expect(src).toContain('Z.drawer')
  expect(src).toContain('listDrawerOpen.value = false')
  expect(src).toContain('treeDrawerOpen.value = false')
})

test('触控四件套:对话重命名/删除 + 文件树删除钮补齐(≥5 处 after 命中区)', () => {
  expect((src.match(/max-sm:after:-inset-2/g) || []).length).toBeGreaterThanOrEqual(5)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchDetail.phone-drawer.test.js`
Expected: FAIL(三例全红:无 Teleport/无开关钮/无四件套)

- [ ] **Step 3: 实现**

script 头(`import WbStage...` 之后)加:

```js
import { useIsPhone } from '@/composables/useBreakpoint'
import { useEscClose } from '@/composables/useEscClose'
import { Z } from '@/styles/zScale'

const { isPhone } = useIsPhone()
// 手机抽屉(Wave5 R6):Agent 对话列表 / Edit 文件树在 <640px 收进左侧滑入面板。
// 桌面档 Teleport disabled → 原 DOM 位置渲染,结构零变化。
const listDrawerOpen = ref(false)
const treeDrawerOpen = ref(false)
useEscClose(computed(() => isPhone.value && mode.value === 'agent' && listDrawerOpen.value), () => { listDrawerOpen.value = false })
useEscClose(computed(() => isPhone.value && mode.value === 'edit' && treeDrawerOpen.value), () => { treeDrawerOpen.value = false })
// 选中即收:切对话/开文件后自动关抽屉(newConversation 置 null 时若原值也是 null
// watch 不触发,由模板 New 钮显式收)。
watch(activeConversationId, () => { if (isPhone.value) listDrawerOpen.value = false })
watch(currentPath, () => { if (isPhone.value) treeDrawerOpen.value = false })
```

> 注意:`computed` 已在该文件 import 列表(第 4 行 `import { ref, computed, ... }`),`watch` 同行已有;不要重复 import。

template 三处:

(a) 工具条(318 行 div 内、返回钮之后)插入两个开关钮:

```html
<button v-if="isPhone && mode === 'agent'" data-testid="open-conversations-btn" @click="listDrawerOpen = true"
  class="p-1 rounded hover:bg-surface-container text-on-surface-variant relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"
  :title="t('workbench.detail.showConversations')"><span class="material-symbols-outlined">forum</span></button>
<button v-if="isPhone && mode === 'edit'" data-testid="open-files-btn" @click="treeDrawerOpen = true"
  class="p-1 rounded hover:bg-surface-container text-on-surface-variant relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']"
  :title="t('workbench.detail.showFiles')"><span class="material-symbols-outlined">folder_open</span></button>
```

(b) Agent 侧栏:把 383 行 `<div class="w-56 shrink-0 flex flex-col border-r border-outline-variant bg-surface-container-lowest">` 连同其闭合(421 行)整块包进 Teleport 并改根类:

```html
<Teleport to="body" :disabled="!isPhone">
  <div v-if="isPhone && listDrawerOpen" data-testid="wb-drawer-overlay" class="fixed inset-0 bg-on-surface/40" :style="{ zIndex: Z.drawer - 1 }" @click="listDrawerOpen = false"></div>
  <div data-testid="conversation-sidebar"
    class="flex flex-col bg-surface-container-lowest border-r border-outline-variant"
    :class="isPhone
      ? ['fixed inset-y-0 left-0 w-[85%] max-w-[280px] shadow-2xl transition-transform duration-200 motion-reduce:transition-none', listDrawerOpen ? 'translate-x-0' : '-translate-x-full']
      : 'w-56 shrink-0'"
    :style="isPhone ? { zIndex: Z.drawer } : undefined">
    <!-- ↓ 原侧栏内部(p-sm 头部 New 钮 + 列表)原样保留;仅两处小改: -->
    <!-- 1) New 钮 @click="newConversation" → @click="newConversation(); listDrawerOpen = false" -->
    <!-- 2) 411/414 行重命名/删除两钮 class 追加: relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-[''] -->
    ...原内容...
  </div>
</Teleport>
```

(c) Edit 文件树:447 行根 div 同款包裹(Teleport + overlay + 类三元),锚点 `data-testid="file-tree-sidebar"`,开合变量 `treeDrawerOpen`;472 行删除钮追加四件套;文件行点击 `openFile` 后由 `watch(currentPath)` 自动收。

locales 两文件补键(`workbench.detail` 段内):

```json
// zh.json: "showConversations": "对话列表", "showFiles": "文件列表"
// en.json: "showConversations": "Conversations", "showFiles": "Files"
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/views/__tests__/WorkbenchDetail.phone-drawer.test.js` → PASS ×3
Run: `npx vitest run src/components/workbench` → 既有套件零回归

- [ ] **Step 5: 提交**

```bash
git add src/views/WorkbenchDetail.vue src/views/__tests__/WorkbenchDetail.phone-drawer.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(mobile): workbench agent/edit sidebars collapse into phone drawers (Wave5 R6)"
```

---

### Task 5: WorkbenchServers 卡片化 + 弹窗响应式(R5/M2,治 1×P0 + 2 条)

**Files:**
- Modify: `src/views/WorkbenchServers.vue`(149-225 表格区、203-204 行钮、234/245 弹窗宽)
- Test: `src/views/__tests__/WorkbenchServers.cards.test.js`(新建)

**Interfaces:**
- Consumes: `DataTable`(props: headers/rows/row-key;列 slot `#<key>="{ row }"` 双分支同源;手机自动卡片,首列=标题);`useIsPhone`。
- Produces: 手机档行锚点沿用 `data-test="serverRow"` 放到每个 `data-card-row` 内(用 `#name` slot 根元素挂);操作钮 `data-test="btnTerm/btnFiles/btnTest/btnEdit/btnDelete"`(手机扁平组);桌面档 `btnMore` 下拉不变。

- [ ] **Step 1: 写失败测试**

```js
// src/views/__tests__/WorkbenchServers.cards.test.js
// Wave5 W2 Task5(R5):服务器清单迁 DataTable——手机卡片化、操作扁平化;桌面表格不变。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

vi.mock('@/api/client', () => ({
  sshApi: {
    list: vi.fn(async () => ({ servers: [
      { id: 's1', name: 'nas', host: '192.168.100.100', port: 22, username: 'root', authMethod: 'password', hasPassword: true, status: 'ok', exposeToAi: true, aiApprovalPolicy: 'always', osId: 'debian' },
      { id: 's2', name: 'mac-mini', host: '192.168.100.101', port: 22, username: 'liang', authMethod: 'key', hasPrivateKey: true, status: 'unknown', exposeToAi: false },
    ] })),
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: true }) }))
vi.mock('@/stores/sshTerminals', () => ({ useSshTerminalStore: () => ({ openOrFocus: vi.fn() }) }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))
vi.mock('@/components/ssh/SshServerForm.vue', () => ({ default: { name: 'SshServerForm', template: '<div/>' } }))
vi.mock('@/components/ssh/ServerLedgerPanel.vue', () => ({ default: { name: 'ServerLedgerPanel', template: '<div/>' } }))
vi.mock('@/components/ssh/SshFileBrowserWindow.vue', () => ({ default: { name: 'SshFileBrowserWindow', template: '<div/>' } }))

import WorkbenchServers from '../WorkbenchServers.vue'

async function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(WorkbenchServers, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
  await flushPromises()
  return w
}

test('手机档:DataTable 卡片模式,2 服务器 2 卡片,无裸 table;终端/文件/编辑/删除扁平可达', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountView()
    expect(w.findAll('[data-card-row]').length).toBe(2)
    expect(w.find('table').exists()).toBe(false)
    expect(w.find('[data-test="btnTerm"]').exists()).toBe(true)
    expect(w.find('[data-test="btnFiles"]').exists()).toBe(true)
    expect(w.find('[data-test="btnEdit"]').exists()).toBe(true)
    expect(w.find('[data-test="btnDelete"]').exists()).toBe(true)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('桌面档:表格分支在场,更多▾下拉保留', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountView()
    expect(w.find('table').exists()).toBe(true)
    expect(w.find('[data-test="btnMore"]').exists()).toBe(true)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('弹窗宽度响应式:w-[min(...)] 不再是裸 w-[720px]/w-[860px]', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountView()
    await w.find('[data-test="btnAdd"]').trigger('click')
    const html = document.body.innerHTML
    expect(html).toContain('w-[min(720px,calc(100vw-2rem))]')
    expect(html).not.toContain('w-[720px]')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchServers.cards.test.js`
Expected: FAIL(手机档仍有 table、无 data-card-row;弹窗含 w-[720px])

- [ ] **Step 3: 实现**

script 加:

```js
import DataTable from '@/components/common/DataTable.vue'
import { useIsPhone } from '@/composables/useBreakpoint'
const { isPhone } = useIsPhone()
const serverHeaders = computed(() => [
  { key: 'name', label: t('ssh.name') },
  { key: 'status', label: t('ssh.statusCol') },
  { key: 'host', label: t('ssh.host') },
  { key: 'username', label: t('ssh.username') },
  { key: 'cred', label: t('ssh.credState') },
  { key: 'expose', label: t('ssh.exposeToAi') },
  { key: 'actions', label: t('ssh.actions') },
])
const serverRows = computed(() => servers.value.map(s => ({ ...s, cred: credState(s) })))
```

template:149-225 的 `<table>...</table>` 整块替换为:

```html
<DataTable v-else :headers="serverHeaders" :rows="serverRows" row-key="id">
  <template #name="{ row }">
    <div data-test="serverRow" class="flex items-center gap-sm min-w-0">
      <OsIcon :os-id="row.osId" :os-name="row.osName || row.name" />
      <div class="min-w-0">
        <div class="font-mono truncate">{{ row.name }}</div>
        <div v-if="row.description || row.osName" class="text-on-surface-variant/60 text-body-xs truncate">{{ row.osName || row.description }}</div>
      </div>
    </div>
  </template>
  <template #status="{ row }">
    <span data-test="statusBadge" class="inline-flex items-center gap-xs px-sm py-0.5 rounded-full border text-body-xs" :class="statusBadge(row).cls">
      <span class="w-1.5 h-1.5 rounded-full" :class="statusBadge(row).dot"></span>{{ statusBadge(row).label }}
    </span>
  </template>
  <template #host="{ row }"><span class="font-mono text-body-xs break-all">{{ row.host }}:{{ row.port }}</span></template>
  <template #username="{ row }"><span class="font-mono text-body-xs truncate">{{ row.username }}</span></template>
  <template #cred="{ row }"><span class="text-body-xs">{{ row.cred }}</span></template>
  <template #expose="{ row }">
    <div class="flex items-center gap-xs flex-wrap" data-test="exposeCell">
      <!-- 原 180-198 行暴露单元格内容原样搬入,ToggleSwitch/快速策略 select/徽章不变 -->
      ...原 181-198 内容(row 替代 s)...
    </div>
  </template>
  <template #actions="{ row }">
    <!-- 手机:下拉在卡片 overflow 链里会被裁 → 扁平按钮组 -->
    <div v-if="isPhone" class="flex flex-wrap items-center gap-xs">
      <button data-test="btnTerm" @click="sshTerminals.openOrFocus(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg bg-primary-container/60 text-body-xs">{{ t('ssh.terminal') }}</button>
      <button data-test="btnFiles" @click="openFiles(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg bg-secondary-container/60 text-body-xs">{{ t('ssh.files') }}</button>
      <button data-test="btnTest" @click="onTest(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg border border-outline-variant text-body-xs">{{ t('ssh.testConnection') }}</button>
      <button data-test="btnEdit" @click="openEdit(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg border border-outline-variant text-body-xs">{{ t('common.edit') }}</button>
      <button data-test="btnDelete" @click="onDelete(row)" class="relative max-sm:min-h-[40px] px-sm rounded-lg border border-error/30 text-error text-body-xs">{{ t('common.delete') }}</button>
    </div>
    <!-- 桌面:原 202-221 终端/文件/更多▾ 下拉原样(row 替代 s),btnTerm/btnFiles 加四件套 -->
    <div v-else class="flex items-center gap-xs">
      ...原 203-220 内容...
    </div>
  </template>
</DataTable>
```

弹窗宽(234/245 行):

```html
<div class="bg-surface-container-low rounded-xl p-lg w-[min(720px,calc(100vw-2rem))] max-h-[90vh] overflow-y-auto">
<div class="bg-surface-container-low rounded-xl p-lg w-[min(860px,calc(100vw-2rem))] max-h-[90vh] overflow-y-auto flex flex-col gap-md">
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/views/__tests__/WorkbenchServers.cards.test.js` → PASS ×3
Run: `npm run typecheck` → 绿

- [ ] **Step 5: 提交**

```bash
git add src/views/WorkbenchServers.vue src/views/__tests__/WorkbenchServers.cards.test.js
git commit -m "feat(mobile): servers list to DataTable cards, flat phone actions, responsive modals (Wave5 R5)"
```

---

### Task 6: NsWorkloadDetail 页头配方 + tab 横滚 + i18n + 幽灵类(R4/R3/纯 bug)

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue:1220-1252,1255-1262`
- Modify: `src/locales/zh.json`、`src/locales/en.json`(`workload.tabs.*` 值补真翻译——键已存在,当前是恒等英文死值)
- Test: `src/views/__tests__/NsWorkloadDetail.mobile-header.test.js`(新建)

**Interfaces:**
- Produces: tab 条容器类契约 `overflow-x-auto` + 按钮钮 `shrink-0 whitespace-nowrap`(W3 全站复制本配方);tab 文案键 `workload.tabs.<key>`(zh:概览/拓扑/网络/Pod/版本/YAML/事件);`bg-primary/8` 全部清零(为 W5 删 V5 allowlist 铺路)。

- [ ] **Step 1: 写失败测试**

```js
// src/views/__tests__/NsWorkloadDetail.mobile-header.test.js
// Wave5 W2 Task6(R4/R3):页头可换行可截断 + tab 条横滚 + tab 名 i18n + 幽灵类清零。
// mock 策略照 NsWorkloadDetail.action-bar.test.js(真实 i18n + Vue Query)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
  cronJobApi: { get: vi.fn(async () => ({})) },
  execStream: vi.fn(),
  podFileApi: { get: vi.fn(async () => ({})) },
  registryApi: { get: vi.fn(async () => ({})) },
}))
const demoWorkload = {
  name: 'demo-deploy', namespace: 'default', type: 'Deployment', labels: { app: 'demo' },
  raw: { metadata: { name: 'demo-deploy', namespace: 'default' },
    spec: { replicas: 1, selector: { matchLabels: { app: 'demo' } },
      template: { metadata: { labels: { app: 'demo' } }, spec: { containers: [{ name: 'main', image: 'nginx' }] } } } },
}
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({
  watchStateOf: () => 'off', currentCluster: 'demo', setNamespace: () => {}, checkAccessServer: vi.fn(async () => true),
  fetchWorkloads: vi.fn(async () => [demoWorkload]), fetchPods: vi.fn(async () => []),
  fetchPVCs: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []),
  restartWorkload: vi.fn(), scaleWorkload: vi.fn(), invalidateAllClusterQueries: vi.fn(async () => {}),
}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { name: 'demo-deploy', namespace: 'default' }, query: {} }), useRouter: () => ({ push: () => {} }) }))

import NsWorkloadDetail from '../NsWorkloadDetail.vue'

async function mountDetail() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(NsWorkloadDetail, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Breadcrumbs: true, WorkloadTopologyTab: true } } })
  await flushPromises()
  return w
}

test('手机档页头(R4):外层 flex-wrap、h1 max-sm:truncate、按钮组去 shrink-0', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    const h1 = w.find('h1')
    expect(h1.classes().join(' ')).toContain('max-sm:truncate')
    const scaleBtn = w.findAll('button').find(b => b.text() === i18n.global.t('workload.scale'))
    const btnGroup = scaleBtn.element.parentElement
    expect(btnGroup.classList.contains('flex-wrap')).toBe(true)
    expect(btnGroup.classList.contains('shrink-0')).toBe(false)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('tab 条(R3):容器 overflow-x-auto,按钮 shrink-0+nowrap,文案走 i18n', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountDetail()
    const tabBar = w.findAll('div').find(d => d.classes().includes('border-b') && d.findAll('button').some(b => b.text() === i18n.global.t('workload.tabs.overview')))
    expect(tabBar).toBeTruthy()
    expect(tabBar.classes()).toContain('overflow-x-auto')
    const tabBtn = tabBar.findAll('button').find(b => b.text() === i18n.global.t('workload.tabs.overview'))
    expect(tabBtn.classes()).toContain('shrink-0')
    expect(tabBtn.classes()).toContain('whitespace-nowrap')
    // 纯 bug:tab 名不再是裸 key
    expect(tabBar.text()).not.toContain('overview')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('幽灵透明度类清零:渲染 HTML 不含 bg-primary/8', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountDetail()
    expect(w.html()).not.toContain('bg-primary/8')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.mobile-header.test.js`
Expected: FAIL ×3(无 wrap/truncate;tab 容器无 overflow-x-auto 且文本是裸 key;html 含 bg-primary/8)

- [ ] **Step 3: 实现**

`NsWorkloadDetail.vue` template 四处:

```html
<!-- 1220 页头外层: -->
<div class="flex flex-wrap items-start justify-between gap-x-sm gap-y-sm mt-sm mb-md">
  <!-- 1221 左块: -->
  <div class="flex items-start gap-md min-w-0">
    <!-- 1227 h1: -->
    <h1 class="text-headline-md text-on-surface font-bold min-w-0 max-sm:truncate" :title="meta.title || workload.name">{{ meta.title || workload.name }}</h1>
    <!-- 1228 副标题: -->
    <span v-if="meta.title" class="font-mono text-xs text-on-surface-variant truncate">{{ workload.name }}</span>
    <!-- 1232/1236/1237 三处 bg-primary/8 → bg-primary/10 -->
    <!-- 1241 按钮组: -->
    <div class="flex flex-wrap gap-xs">
  <!-- 1255 tab 容器: -->
  <div class="flex items-center gap-xs overflow-x-auto border-b border-outline-variant mb-md">
    <!-- 1257 tab 按钮 class 追加 shrink-0 whitespace-nowrap;1259 文案: -->
    {{ $t('workload.tabs.' + tab) }}
```

locales(键已存在,只改值):

```json
// zh.json workload.tabs:
"overview": "概览", "topology": "拓扑", "network": "网络", "pods": "Pod",
"revisions": "版本", "yaml": "YAML", "events": "事件"
// en.json workload.tabs:
"overview": "Overview", "topology": "Topology", "network": "Network", "pods": "Pods",
"revisions": "Revisions", "yaml": "YAML", "events": "Events"
```

> 注意:`workload.tabs` 之外若别处 `grep -rn "workload.tabs" src/` 有消费,值变更会影响它们——执行时先 grep 确认唯一消费点是本模板。

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.mobile-header.test.js` → PASS ×3
Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.action-bar.test.js` → 既有断言(`max-sm:flex-wrap` 查找逻辑改查容器 flex-wrap,若红:该测试找的是 `max-sm:flex-wrap` 字符串,按钮组现在是裸 `flex-wrap`——**更新该断言为 `flex-wrap`**,行为语义未变,属测试迁移而非放松)→ PASS
Run: `npm run test:unit -- --run src/views/__tests__ 2>/dev/null || npx vitest run src/views/__tests__` → 全绿

- [ ] **Step 5: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/locales/zh.json src/locales/en.json src/views/__tests__/NsWorkloadDetail.mobile-header.test.js src/views/__tests__/NsWorkloadDetail.action-bar.test.js
git commit -m "fix(mobile): workload detail header recipe, scrollable tabs, tab i18n, ghost alpha classes (Wave5 R3/R4)"
```

---

### Task 7: NsWorkloadDetail Revisions/Events 迁 DataTable(R5,治 2×P1)

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`(1732-1782 两个 tab;script 头加 import/headers)
- Test: `src/views/__tests__/NsWorkloadDetail.mobile-tables.test.js`(新建;mock 头与 Task 6 完全相同,复制)

**Interfaces:**
- Consumes: `DataTable`(同 Task 5)。
- Produces: 回滚钮四件套;Events 行键 `_idx`(slice 后无唯一键)。

- [ ] **Step 1: 写失败测试**

```js
// src/views/__tests__/NsWorkloadDetail.mobile-tables.test.js —— mock 头照抄 Task 6(同目录同款),
// 追加 revisions 数据:k8s mock 按调用参数分流,含 status.replicas 的 ReplicaSet items:
// api: { k8s: vi.fn(async (path) => String(path).includes('replicasets')
//   ? { items: [{ metadata: { name: 'demo-abc123', namespace: 'default',
//       annotations: { 'deployment.kubernetes.io/revision': '2' },
//       status: { replicas: 1, readyReplicas: 1 }, spec: { template: { spec: { containers: [{ image: 'nginx:1.27' }] } } } }] }
//   : { items: [] }) }
// (若真实 k8s() 调用形态不同,以让 revisions computed 非空为准调整 mock,断言不变。)

test('Revisions tab 手机档:DataTable 卡片渲染,回滚钮带四件套', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    const tabBar = w.findAll('div').find(d => d.findAll('button').some(b => b.text() === i18n.global.t('workload.tabs.revisions')))
    await tabBar.findAll('button').find(b => b.text() === i18n.global.t('workload.tabs.revisions')).trigger('click')
    expect(w.findAll('[data-card-row]').length).toBeGreaterThanOrEqual(1)
    expect(w.find('[data-testid="revisions-table"]').exists()).toBe(false)   // 旧裸表锚点退役
    const rollback = w.findAll('button').find(b => b.text() === i18n.global.t('workload.revisionsTab.rollback'))
    if (rollback) expect(rollback.classes().join(' ')).toContain('max-sm:after:-inset-2')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('Events tab:不再有裸 <table>(DataTable 双分支接管)', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    const tabBar = w.findAll('div').find(d => d.findAll('button').some(b => b.text() === i18n.global.t('workload.tabs.events')))
    await tabBar.findAll('button').find(b => b.text() === i18n.global.t('workload.tabs.events')).trigger('click')
    expect(w.find('table').exists()).toBe(false)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.mobile-tables.test.js`
Expected: FAIL(revisions tab 仍是裸 table)

- [ ] **Step 3: 实现**

script 头加 `import DataTable from '@/components/common/DataTable.vue'` 与:

```js
const revHeaders = [
  { key: 'rev', label: 'Rev' },
  { key: 'image', label: 'Image' },
  { key: 'replicas', label: 'Replicas' },
  { key: 'age', label: 'Age' },
  { key: 'actions', label: t('workload.revisionsTab.actions') },
]
const eventHeaders = [
  { key: 'object', label: t('workload.eventsTab.object') },
  { key: 'reason', label: 'Reason' },
  { key: 'type', label: 'Type' },
  { key: 'message', label: 'Message' },
  { key: 'age', label: 'Age' },
]
// Events slice 后无唯一键 → 注入 _idx 作 rowKey
const eventRows = computed(() => workloadEvents.value.slice(0, 100).map((e, i) => ({ ...e, _idx: i })))
```

> 若 script 中 `t` 未定义(模板用 `$t`),改用 `i18n.global.t` 或在 setup 里取 `const { t } = useI18n()`(该文件已用 `$t`,补 `useI18n` import 即可)。

Revisions tab(1733-1754)整块替换:

```html
<div v-if="activeTab === 'revisions'">
  <DataTable :headers="revHeaders" :rows="revisions" row-key="rev">
    <template #rev="{ row }">
      <span class="text-body-sm font-bold" :class="row.current ? 'text-primary' : ''">Rev {{ row.rev }}</span><span v-if="row.current" class="ml-xs text-xs text-primary">●</span>
    </template>
    <template #image="{ row }"><span class="font-mono text-xs block truncate max-w-[200px]" :title="row.image">{{ row.image }}</span></template>
    <template #replicas="{ row }"><span class="text-xs">{{ row.readyReplicas }}/{{ row.desiredReplicas }}</span></template>
    <template #age="{ row }"><span class="text-xs text-on-surface-variant">{{ row.age }}</span></template>
    <template #actions="{ row }">
      <button v-if="!row.current" @click="confirmRollback(row)"
        class="relative text-xs text-primary hover:underline max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
        {{ $t('workload.revisionsTab.rollback') }}</button>
    </template>
  </DataTable>
</div>
```

Events tab(1761-1782)整块替换(外层圆角卡壳去掉,DataTable 自带):

```html
<div v-if="activeTab === 'events'">
  <DataTable :headers="eventHeaders" :rows="eventRows" row-key="_idx">
    <template #object="{ row }">
      <span class="text-on-surface-variant/60">{{ row.relatedKind }}</span> <span class="font-mono break-all">{{ row.relatedName }}</span>
    </template>
    <template #reason="{ row }">
      <span class="text-xs font-medium" :class="row.type === 'warning' ? 'text-error' : 'text-on-surface'">{{ row.reason }}</span>
    </template>
    <template #type="{ row }">
      <span class="text-xs px-1.5 py-0.5 rounded" :class="row.type === 'warning' ? 'bg-error/10 text-error' : 'bg-primary/10 text-primary'">{{ row.type }}</span>
    </template>
    <template #message="{ row }"><span class="text-xs text-on-surface-variant block truncate" :title="row.message">{{ row.message }}</span></template>
    <template #age="{ row }"><span class="text-xs text-on-surface-variant">{{ row.age }}</span></template>
  </DataTable>
</div>
```

- [ ] **Step 4: 跑测试确认通过 + 回归**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.mobile-tables.test.js src/views/__tests__/NsWorkloadDetail.action-bar.test.js src/views/__tests__/NsWorkloadDetail.mobile-header.test.js` → 全 PASS

- [ ] **Step 5: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/views/__tests__/NsWorkloadDetail.mobile-tables.test.js
git commit -m "feat(mobile): workload revisions/events tabs to DataTable cards (Wave5 R5)"
```

---

### Task 8: NsWorkloadDetail overview 杂项 + 拓扑画布(R10/R11 + 触控长尾)

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`(1290/1293、1451-1453、1513-1515、1517、1564-1568、1614/1621/1638、1758、1889/2047/2060 区、2257)
- Modify: `src/components/common/WorkloadTopologyTab.vue`(96-98)
- Test: `src/views/__tests__/NsWorkloadDetail.mobile-misc.test.js`(静态源码断言,先例同 Task 4)

**Interfaces:**
- Produces: `:min-zoom="isPhone ? 0.15 : 0.5"`(WorkloadTopologyTab,W3 无涉);NsWorkloadDetail 文件内全部其余 W2 发现闭环。

- [ ] **Step 1: 写失败测试(静态断言)**

```js
// src/views/__tests__/NsWorkloadDetail.mobile-misc.test.js
// Wave5 W2 Task8:overview 杂项配方落地(静态源码断言,先例 InteractiveTerminal.keys.test.js)。
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test, expect } from 'vitest'

const src = readFileSync(fileURLToPath(new URL('../NsWorkloadDetail.vue', import.meta.url)), 'utf8')
const topo = readFileSync(fileURLToPath(new URL('../../components/common/WorkloadTopologyTab.vue', import.meta.url)), 'utf8')

test('R10:指标双图手机单列;YAML 高度手机 60vh;diff 容器可横滚', () => {
  expect(src).toContain('grid-cols-1 md:grid-cols-2')
  expect(src).toContain(':height="isPhone ? \'60vh\' : \'560px\'"')
  expect(src.match(/overflow-hidden[^"]*whitespace-pre|whitespace-pre[^"]*overflow-hidden/) || []).length).toBe(0)
})

test('R9 触控:快速伸缩/时间窗/容器行/历史行钮四件套(文件 ≥ 90 处 after 命中区)', () => {
  expect((src.match(/max-sm:after:-inset-2/g) || []).length).toBeGreaterThanOrEqual(90)
})

test('R10:label/configRef/port chip 可断行(break-all 在场)', () => {
  expect((src.match(/break-all/g) || []).length).toBeGreaterThanOrEqual(3)
})

test('R10:编辑弹窗网格补断点(grid-cols-4 全部带 sm: 变体)', () => {
  const bare = src.match(/class="[^"]*grid-cols-[34][^"]*"/g) || []
  const offending = bare.filter(c => !c.includes('sm:grid-cols') && !c.includes('grid-cols-1'))
  expect(offending).toEqual([])
})

test('R11:拓扑画布手机 min-zoom 0.15', () => {
  expect(topo).toContain(':min-zoom="isPhone ? 0.15 : 0.5"')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.mobile-misc.test.js`
Expected: FAIL ×5

- [ ] **Step 3: 实现(NsWorkloadDetail 逐点)**

1. 1517 指标双图:`grid grid-cols-2 divide-x` → `grid grid-cols-1 md:grid-cols-2 md:divide-x`
2. 1758 YAML:`height="560px"` → `:height="isPhone ? '60vh' : '560px'"`
3. 2257 diff 预览容器:`overflow-hidden` → `overflow-x-auto`(whitespace-pre 行保持)
4. 1290/1293 快速伸缩钮 class 追加:`relative max-sm:w-8 max-sm:h-8 max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']`
5. 1513-1515 时间窗钮 class 追加:`relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']`
6. 1451-1453 历史版本紧凑行钮、1564-1568 容器卡操作行钮:同款四件套追加;1564 行容器加 `flex-wrap`
7. 1614 label chip、1621 configRefs chip、1638 端口 chip:chip 根 span 加 `break-all`(外层容器已 flex-wrap)
8. 编辑 Modal 网格群(约 1889 资源/2047 污点/2060 更新策略/18xx 三列):`grid-cols-4` → `grid-cols-2 sm:grid-cols-4`;裸 `grid-cols-3` → `grid-cols-1 sm:grid-cols-3`。执行时以 `grep -n 'grid-cols-[34]' src/views/NsWorkloadDetail.vue` 圈定(应全在 1790-2260 Modal 区),逐一加前缀。

`WorkloadTopologyTab.vue`:

```js
// script 头加:
import { useIsPhone } from '@/composables/useBreakpoint'
const { isPhone } = useIsPhone()
// 98 行:
:min-zoom="isPhone ? 0.15 : 0.5"
```

- [ ] **Step 4: 跑测试确认通过 + 全量 view 回归**

Run: `npx vitest run src/views/__tests__/NsWorkloadDetail.mobile-misc.test.js` → PASS ×5
Run: `npx vitest run src/views/__tests__` → 全绿(既有 edit-shell/action-bar 等不受累)

- [ ] **Step 5: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/components/common/WorkloadTopologyTab.vue src/views/__tests__/NsWorkloadDetail.mobile-misc.test.js
git commit -m "fix(mobile): workload overview misc recipes + topology canvas phone zoom (Wave5 R9/R10/R11)"
```

---

### Task 9: 波末门禁 + 合并 + 390px 截图验收(orchestrator 执行)

- [ ] **Step 1: 四道门禁全绿**

Run: `npm test && npm run test:unit && npm run typecheck && npm run build`
Expected: 全绿(overflow-guard V1-V5、ui-language-guard、i18n 检查含在内)

- [ ] **Step 2: 390px 截图验收(orchestrator 用 Playwright MCP,resize 390×844,本地网关 8787 + build 后 dist)**

涉及登录态:向用户要本地测试账号(或用户代登)。路由清单:
- `/workbench` 项目列表、任一项目页 Agent 模式(开抽屉/选中自动收)、Edit 模式(文件树抽屉、编辑器全宽)
- workbench「服务器」tab:手机卡片、终端/文件/编辑/删除扁平钮、新增弹窗全宽
- `/ns/<ns>/workloads/Deployment/<name>`:页头(名字 truncate、按钮组换行)、tab 条横滚到 events、overview 单列、revisions/events 卡片、拓扑画布 fit-view、YAML 60vh
- 回归抽查桌面 1440 宽:WorkbenchDetail 双 pane、服务器表格、workload 详情页头/表格与改前一致

判定:无整页横向滚动(body scrollWidth ≤ 视口)、tab 全部可达、操作钮可达。取证存 `docs/mobile-shots/2026-09-09-wave5-w1w2/`(文件名=路由 slug)。

- [ ] **Step 3: 合并**

```bash
git checkout main && git merge --no-ff feat/mobile-wave5-w1w2 -m "Merge branch 'feat/mobile-wave5-w1w2' — mobile Wave5 W1+W2: FloatingWindow phone full-bleed + responsive Pagination/Breadcrumbs (shared infra), workbench agent/edit sidebars as phone drawers, servers list DataTable cards + responsive modals, workload detail header/scrollable-tabs/DataTable revisions+events/topology zoom + tab i18n + ghost-alpha cleanup; 26 audit findings closed incl 5 P0"
```

- [ ] **Step 4: 向用户汇报 W1+W2 结果,征集 W3(详情页全族)计划开工确认**

---

## Self-Review 记录(写计划时已核对)

- **Spec 覆盖**:W1 三文件(11 条发现)→ Task 1-3;W2 的 WorkbenchDetail 4 条 → Task 4;WorkbenchServers 3 条 → Task 5;NsWorkloadDetail 7 条 + 探索补充(metrics/labels/touch/yaml)→ Task 6-8;WorkloadTopologyTab 1 条 → Task 8。SshFileBrowserWindow P0 由 Task 1 的 R1 覆盖(消费方零改动)。
- **类型一致**:`useEscClose(isOpenRef, onClose)` 与源码签名一致;DataTable headers/slots 用法与源码一致;`workload.tabs` 键已存在只改值。
- **无占位符**:模板搬运处(`...原内容...`)均指明「原样保留/row 替代 s」的精确指令,源行号可定位。
