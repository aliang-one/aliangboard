# Workbench 模块身份(氛围 × 舞台 × 门面)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 workbench 建立独立于 K8s 管理面板的模块身份——氛围画布、独立舞台容器、舞台标题栏门面,三批次交付。

**Architecture:** 表现层三支柱:①`meta.module='workbench'` 路由标记驱动 AppLayout main 挂 `wb-atmosphere` 氛围类(绿雾/右上辉光/点阵,纯 CSS 渐变);②新共享组件 `WbStage.vue`(圆角舞台+回声线,舷板轮廓语言延伸)供 Shell/Detail/Ledger 三页共用;③Shell 标题栏升级为模块门面(32px 品牌瓷砖+sheen 握手)。三幕入场总谱复用既有 wb-enter/wb-rise 词汇,零新数据层改动。

**Tech Stack:** Vue 3 + Tailwind(M3 token,`rgb(var(--md-sys-color-*))`)+ vitest/happy-dom + 自研 overflow-guard V1–V5 静态守卫。

**Spec:** `docs/superpowers/specs/2026-09-05-workbench-module-identity-design.md`(实现者须同读)

## Global Constraints

- 纯表现层:零数据层/逻辑改动;WorkbenchDetail 只做模板外层手术,dirty-confirm 等内部逻辑零触碰。
- K8s 域零改动:非 workbench 路由渲染结果与改前一致。
- 品牌色只走 primary 族(禁橘令);透明度落 Tailwind 刻度(5 的倍数,overflow-guard V5 管辖 .vue class;main.css 裸 CSS 同纪律)。
- 所有新动画带 motion-reduce 兜底,且静止态=自然态(无 fill 依赖,animate-none 恒安全)。
- 提交作者 `aliang-one <aliangdone@gmail.com>`,禁止 Co-Authored-By 尾注,提交信息英文。
- 开发在 worktree 分支 `worktree-feat-identity-panel-v4` 上进行;Edit 用 worktree 绝对路径
  `/home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat-identity-panel-v4/`。
- 测试命令:vitest 单文件 `npx vitest run <path>`;全量 `npm run test:unit -- --maxWorkers=2`(多会话期降 worker);WorkbenchChat.test.js 是已知 flaky,红灯先隔离复跑再判定。
- 高度链契约:fullHeight 路由下 AppLayout 包裹层 h-full → 页面 h-full → 舞台 h-full → 内容 flex-1 min-h-0 自管滚动,chat 输入框贴底不悬空。

---

### Task 1: 批次 A——氛围画布(router meta + AppLayout 挂类 + main.css 三层)

**Files:**
- Modify: `src/router/index.js`(workbench 三路由 meta)
- Modify: `src/components/layout/AppLayout.vue`(main 类绑定 + transition 包裹 div)
- Modify: `src/styles/main.css`(wb-atmosphere 三层 + wb-glow-in,追加在 wb-enter 块之后)
- Test: `src/components/layout/__tests__/AppLayout.atmosphere.test.js`(新建,静态契约)

**Interfaces:**
- Produces: `meta.module === 'workbench'` 路由标记(Task 3/4/5 的页面隐式依赖,main 层画布由此点亮);`wb-atmosphere` CSS 类与 `wb-glow-in` keyframes(main.css,Task 6 浏览器验收对象)。

- [ ] **Step 1: 写失败测试**

新建 `src/components/layout/__tests__/AppLayout.atmosphere.test.js`:

```js
// 氛围画布静态契约(spec 2026-09-05 §2):workbench 三路由打 module 标记 → AppLayout main
// 挂 wb-atmosphere → main.css 三层(绿雾本体/辉光 ::before/点阵 ::after)+ reduced-motion。
// AppLayout 过重不挂载(happy-dom 拖全站),静态源断言 + Task 6 浏览器验收互补。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = p => readFileSync(p, 'utf8')
const routerSrc = read('./src/router/index.js')
const layoutSrc = read('./src/components/layout/AppLayout.vue')
const cssSrc = read('./src/styles/main.css')

test('router:workbench 三路由(module 标记 ×3)且 ledger 归队 fullHeight', () => {
  expect((routerSrc.match(/module: 'workbench'/g) || []).length).toBe(3)
  // ledger 路由行:文档式 → 舞台域
  expect(routerSrc).toMatch(/workbench\/ledger[\s\S]{0,220}fullHeight: true/)
})

test('AppLayout:main 按 meta.module 挂 wb-atmosphere,包裹层 relative 压住伪元素层级', () => {
  expect(layoutSrc).toContain("'wb-atmosphere'")
  expect(layoutSrc).toContain('relative')
})

test('main.css:三层俱全(绿雾本体/辉光 ::before/点阵 ::after)+ 辉光 bloom + reduced-motion', () => {
  expect(cssSrc).toContain('.wb-atmosphere')
  expect(cssSrc).toContain('.wb-atmosphere::before')
  expect(cssSrc).toContain('.wb-atmosphere::after')
  expect(cssSrc.match(/\.wb-atmosphere(::before|::after| \.|\{)/g)?.length).toBeGreaterThanOrEqual(4) // 本体+亮暗分档
  expect(cssSrc).toContain('92% 0%')            // 辉光原点=右上(舷板方位)
  expect(cssSrc).toContain('@keyframes wb-glow-in')
  expect(cssSrc).toContain('background-size: 24px 24px')  // 点阵网格
  const reduce = cssSrc.slice(cssSrc.indexOf('prefers-reduced-motion', cssSrc.indexOf('wb-atmosphere')))
  expect(reduce).toContain('wb-atmosphere::before')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/layout/__tests__/AppLayout.atmosphere.test.js`
Expected: 3 个 test 全 FAIL(路由无 module 标记 / AppLayout 无 wb-atmosphere / main.css 无块)。

- [ ] **Step 3: router meta——三条路由打标**

`src/router/index.js` 中:

`/workbench` 路由(约 473 行)meta 改为:

```js
        meta: { titleKey: 'nav.workbench', icon: 'workspaces', scope: 'global', fullHeight: true, requiresCluster: false, module: 'workbench' }
```

`/workbench/ledger` 路由(约 479 行)meta 改为(补 fullHeight 归队):

```js
        meta: { titleKey: 'route.clusterLedger', scope: 'global', fullHeight: true, requiresCluster: false, module: 'workbench' }
```

`/workbench/:id` 路由(约 485 行)meta 改为:

```js
        meta: { titleKey: 'route.project', scope: 'global', fullHeight: true, requiresCluster: false, module: 'workbench' }
```

- [ ] **Step 4: AppLayout——main 挂类 + 包裹层 relative**

`src/components/layout/AppLayout.vue` 约 97 行,main 改为:

```html
      <main class="flex-1 min-h-0 relative" :class="[route?.meta?.fullHeight ? 'overflow-hidden' : 'overflow-y-auto bg-surface p-margin', route?.meta?.module === 'workbench' ? 'wb-atmosphere' : '']">
```

约 102 行,transition 包裹 div 加 `relative`(压住伪元素绘制层级:树序在伪元素之后)。原 `:class="route?.meta?.fullHeight ? 'h-full' : ''"` 合并为写死类——非 fullHeight 路由的包裹层原本无 h-full,但文档式页面(main overflow-y-auto)中 h-full 指向 main 内容盒高度、内容由文档流撑开滚动,不受影响。最终该行为:

```html
            <div :key="route.path + '#' + refreshTick" class="relative h-full">
```

- [ ] **Step 5: main.css——氛围三层 + 辉光 bloom**

在 `src/styles/main.css` 的 wb-enter 块(含 reduced-motion 段)之后追加:

```css
/* workbench 氛围画布(spec 2026-09-05 §2):模块的空气——绿雾(main 本体)+ 辉光(::before,
   原点=右上舷板方位,入场 wb-glow-in 点亮)+ 点阵(::after,工作台面肌理)。
   仅 meta.module==='workbench' 的 fullHeight 路由挂 wb-atmosphere(main overflow-hidden,层稳定)。 */
.wb-atmosphere {
  position: relative;
  background-image: radial-gradient(120% 90% at 85% 0%, rgb(var(--md-sys-color-primary) / 0.05), transparent 60%);
}
.dark .wb-atmosphere {
  background-image: radial-gradient(120% 90% at 85% 0%, rgb(var(--md-sys-color-primary) / 0.08), transparent 60%);
}
.wb-atmosphere::before {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(520px circle at 92% 0%, rgb(var(--md-sys-color-primary) / 0.10), transparent 70%);
  animation: wb-glow-in 0.6s cubic-bezier(0.22, 1, 0.36, 1) 1;
}
.dark .wb-atmosphere::before {
  background-image: radial-gradient(520px circle at 92% 0%, rgb(var(--md-sys-color-primary) / 0.15), transparent 70%);
}
.wb-atmosphere::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: radial-gradient(circle, rgb(var(--md-sys-color-outline-variant) / 0.25) 1px, transparent 1px);
  background-size: 24px 24px;
}
.dark .wb-atmosphere::after {
  background-image: radial-gradient(circle, rgb(var(--md-sys-color-outline-variant) / 0.15) 1px, transparent 1px);
}
@keyframes wb-glow-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .wb-atmosphere::before {
    animation: none;
    opacity: 1;
  }
}
```

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/components/layout/__tests__/AppLayout.atmosphere.test.js src/views/__tests__/WorkbenchShell.motion.test.js`
Expected: 全 PASS(Shell motion 测试不受影响——它 mock 了 vue-router,壳未挂真 AppLayout)。

- [ ] **Step 7: 提交**

```bash
git add src/router/index.js src/components/layout/AppLayout.vue src/styles/main.css src/components/layout/__tests__/AppLayout.atmosphere.test.js
git commit -m "feat(motion): workbench atmosphere canvas — mist, corner bloom, dot grid

Routes tagged meta.module='workbench' (ledger also joins the fullHeight
domain); AppLayout main picks up the wb-atmosphere class: brand-mist wash,
a bloom anchored at the identity-panel's corner (92% 0%) that fades in
once on entry, and a 24px dot-grid texture. K8s routes render unchanged."
```

---

### Task 2: 批次 B-1——WbStage 共享组件

**Files:**
- Create: `src/components/workbench/WbStage.vue`
- Test: `src/components/workbench/__tests__/WbStage.test.js`(新建)

**Interfaces:**
- Produces: `WbStage` 组件(默认导出)。props:无。slots:`titleBar`(可选,舞台顶段,shrink-0)、default(flex-1 min-h-0 flex-col 容器)。根类含 `h-full`——依赖父级有确定高度(fullHeight 契约)。data-test:`wb-stage-echo`(回声线)。Task 3/4/5 消费。

- [ ] **Step 1: 写失败测试**

新建 `src/components/workbench/__tests__/WbStage.test.js`:

```js
// WbStage 舞台容器契约(spec §3):描边+回声线(舷板双钩边语言的直角版)+双 slot+高度链。
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import WbStage from '../WbStage.vue'

test('舞台容器:描边+回声线+双 slot 渲染,高度链类齐全', () => {
  const w = mount(WbStage, {
    slots: { titleBar: '<div data-test="tb">title</div>', default: '<div data-test="body">body</div>' },
  })
  const root = w.find('.wb-stage')
  expect(root.exists()).toBe(true)
  for (const cls of ['h-full', 'flex', 'flex-col', 'rounded-2xl', 'border', 'overflow-hidden', 'relative']) {
    expect(root.classes()).toContain(cls)
  }
  // 回声线:inset 3px、圆角 13px(16-3 同心数学)、pointer-events-none
  const echo = root.find('[data-test="wb-stage-echo"]')
  expect(echo.exists()).toBe(true)
  expect(echo.classes()).toContain('rounded-[13px]')
  expect(echo.classes()).toContain('pointer-events-none')
  expect(w.find('[data-test="tb"]').exists()).toBe(true)
  expect(w.find('[data-test="body"]').exists()).toBe(true)
})

test('titleBar 缺省时不渲染该段(default 照常)', () => {
  const w = mount(WbStage, { slots: { default: '<div data-test="body"/>' } })
  expect(w.find('[data-test="wb-stage-echo"]').exists()).toBe(true)
  expect(w.text()).not.toContain('title')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/WbStage.test.js`
Expected: FAIL(组件不存在,import 报错即红)。

- [ ] **Step 3: 实现 WbStage.vue**

```vue
<!-- src/components/workbench/WbStage.vue -->
<template>
  <!-- workbench 独立舞台(spec 2026-09-05 §3):圆角容器+回声线(inset 3px、圆角 13px=16-3
       同心)——舷板「双钩边」语言的直角版,模块 DNA 可识别。h-full 依赖 fullHeight 契约
       (父级有确定高度);titleBar 可选段 + default 段(flex-1 min-h-0,内容自管滚动)。 -->
  <div class="wb-stage relative h-full flex flex-col rounded-2xl border border-outline-variant overflow-hidden bg-surface-container-lowest/85 dark:bg-surface-container/85 shadow-card dark:shadow-none">
    <div data-test="wb-stage-echo" aria-hidden="true"
      class="pointer-events-none absolute inset-[3px] rounded-[13px] border border-outline-variant/40"></div>
    <div v-if="$slots.titleBar" class="relative shrink-0">
      <slot name="titleBar" />
    </div>
    <div class="relative flex-1 min-h-0 flex flex-col">
      <slot />
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/workbench/__tests__/WbStage.test.js`
Expected: 2 test PASS。

- [ ] **Step 5: 提交**

```bash
git add src/components/workbench/WbStage.vue src/components/workbench/__tests__/WbStage.test.js
git commit -m "feat(workbench): WbStage — shared stage container with echo-line border

Rounded stage (rounded-2xl + outline border, lowest/85 light and
container/85 dark) carrying the identity panel's double-edge language as
right angles; optional titleBar slot plus a flex-1 min-h-0 default slot
preserving the fullHeight chain."
```

---

### Task 3: 批次 B-2——Shell 换装(舞台 + 门面标题栏)

**Files:**
- Modify: `src/views/WorkbenchShell.vue`(template 全重排:section 保留根,内嵌 WbStage)
- Modify: `src/views/__tests__/WorkbenchShell.motion.test.js`(stagger 选择器迁移 + 门面契约)

**Interfaces:**
- Consumes: `WbStage`(Task 2);`wb-atmosphere` 画布(Task 1,main 层,Shell 不感知)。
- Produces: Shell 门面瓷砖 `data-test="wb-facade-tile"` 与 `wb-facade-sheen`(Task 6 浏览器验收对象)。

- [ ] **Step 1: 迁移失败测试**

`src/views/__tests__/WorkbenchShell.motion.test.js` 中「staggered 入场」test 整体替换为(其余 test 不动):

```js
test('staggered 入场:门面标题栏立即/tabs 40ms;pane 挂 wb-rise 且随 tab 切换重播;门面瓷砖+一次性 sheen 在案', async () => {
  const w = mountShell('admin')
  const rises = w.findAll('section .animate-wb-rise')
  expect(rises.length).toBeGreaterThanOrEqual(3)
  expect(rises[0].classes().join(' ')).not.toContain('animation-delay')
  expect(rises[1].classes().join(' ')).toContain('[animation-delay:40ms]')
  expect(w.find('[data-test-stub="projects"]').element.closest('.animate-wb-rise')).toBeTruthy()
  await w.findAll('button').find(b => b.text().includes('知识')).trigger('click')
  expect(w.find('[data-test-stub="ledger"]').element.closest('.animate-wb-rise')).toBeTruthy()
  // 门面:32px 品牌瓷砖(与顶栏 pill 瓷砖同配方)+ 挂载即播的一次性 sheen(入口→模块 logo 握手)
  const tile = w.find('[data-test="wb-facade-tile"]')
  expect(tile.exists()).toBe(true)
  expect(tile.classes()).toContain('bg-gradient-to-br')
  expect(tile.classes()).toContain('from-primary')
  expect(tile.classes()).toContain('to-primary-container')
  expect(tile.find('.material-symbols-outlined').text()).toBe('workspaces')
  expect(w.find('[data-test="wb-facade-sheen"]').classes()).toContain('animate-sheen')
  expect(w.find('[data-test="wb-facade-sheen"]').classes()).toContain('bg-no-repeat')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/WorkbenchShell.motion.test.js`
Expected: staggered 入场 test FAIL(无 wb-facade-tile);其余 PASS。

- [ ] **Step 3: Shell template 重排**

`src/views/WorkbenchShell.vue` 的 `<template>` 整体替换为:

```html
<template>
  <!-- 入场动效(2026-09-05 转场批次)延续:标题栏 wb-rise 立即 / tabs 40ms / pane 随切换重播。
       2026-09-05 模块身份(spec §3-4):根 section 降级为画布上的呼吸留白,内容坐进 WbStage;
       标题栏升级为模块门面——32px 品牌瓷砖(与顶栏 pill 瓷砖同配方,双绿渐变+内高光)挂载即播
       一次 sheen(工作台每次进入重挂,天然一次性),「入口瓷砖 → 模块 logo」的概念握手。 -->
  <section class="h-full min-h-0 p-md">
    <WbStage>
      <template #titleBar>
        <div class="animate-wb-rise motion-reduce:animate-none flex items-center justify-between gap-md pl-md pr-md py-sm border-b border-outline-variant/40">
          <div class="flex items-center gap-sm min-w-0">
            <span data-test="wb-facade-tile"
              class="relative inline-flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-gradient-to-br from-primary to-primary-container shadow-[0_1px_3px_rgb(0_0_0/0.25),inset_0_1px_0_rgb(255_255_255/0.35)]">
              <span class="material-symbols-outlined text-xl text-on-primary">workspaces</span>
              <span data-test="wb-facade-sheen" aria-hidden="true"
                class="absolute inset-0 bg-no-repeat bg-gradient-to-r from-transparent via-white/45 to-transparent bg-[length:200%_100%] animate-sheen motion-reduce:hidden"></span>
            </span>
            <h2 class="text-headline-sm font-bold text-on-surface">{{ t('workbench.shell.title') }}</h2>
          </div>
          <button @click="router.push('/cluster')" class="flex items-center gap-xs text-on-surface-variant hover:text-primary transition-colors">
            <span class="material-symbols-outlined text-lg">arrow_back</span>
            <span class="text-body-sm">{{ t('workbench.shell.backToCluster') }}</span>
          </button>
        </div>
      </template>
      <div class="animate-wb-rise motion-reduce:animate-none [animation-delay:40ms] flex gap-xs px-md py-sm border-b border-outline-variant/40">
        <button v-for="tab in tabs" :key="tab.key" @click="activeTab = tab.key"
          class="flex items-center gap-xs px-md py-sm rounded-lg text-body-sm transition-all"
          :class="activeTab === tab.key ? 'bg-primary-container text-on-primary-container font-semibold' : 'text-on-surface-variant hover:bg-surface-container'">
          <span class="material-symbols-outlined text-sm">{{ tab.icon }}</span>
          {{ tab.label }}
        </button>
      </div>
      <div class="flex-1 min-h-0 p-md overflow-y-auto">
        <div :key="activeTab" class="animate-wb-rise motion-reduce:animate-none">
          <WorkbenchProjects v-if="activeTab === 'projects'" :open-create="route.query.create === '1'" />
          <WorkbenchLedger v-else-if="activeTab === 'knowledge'" />
          <WorkbenchRecords v-else-if="activeTab === 'records'" />
          <WorkbenchServers v-else-if="activeTab === 'servers'" @open-files="s => {}" />
        </div>
      </div>
    </WbStage>
  </section>
</template>
```

同时在 `<script setup>` 增加 import(其余 script 零改动):

```js
import WbStage from '@/components/workbench/WbStage.vue'
```

- [ ] **Step 4: 门面 sheen 改为挂载即播**

上一步模板中 sheen 写了 `v-if="false"`(占位防测试误判)——实际改为无条件渲染(工作台每次进入 Shell 重挂,sheen 天然一次性;且 Task 3 Step 1 测试断言其存在)。把:

```html
              <span v-if="false" data-test="wb-facade-sheen" aria-hidden="true"></span>
```

改为:

```html
              <span data-test="wb-facade-sheen" aria-hidden="true"
                class="absolute inset-0 bg-no-repeat bg-gradient-to-r from-transparent via-white/45 to-transparent bg-[length:200%_100%] animate-sheen motion-reduce:hidden"></span>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/views/__tests__/WorkbenchShell.motion.test.js src/views/__tests__/WorkbenchShell.tabs.test.js src/views/__tests__/WorkbenchShell.query-params.test.js src/components/workbench/__tests__/WbStage.test.js`
Expected: 全 PASS(tabs/query-params 按文本与 stub 选择,不受容器重排影响)。

- [ ] **Step 6: 提交**

```bash
git add src/views/WorkbenchShell.vue src/views/__tests__/WorkbenchShell.motion.test.js
git commit -m "feat(workbench): shell moves onto the stage — facade title bar with brand tile

Root section becomes canvas breathing room; content sits in WbStage.
Title bar is the module facade: 32px brand tile (same dual-green recipe
as the topbar pill tile) with a once-per-entry sheen — the entry tile
shaking hands with the module logo — plus title and demoted ghost back
button. Tabs divider weakened a notch; stagger and keyed pane replay
preserved."
```

---

### Task 4: 批次 C-1——WorkbenchDetail 收编

**Files:**
- Modify: `src/views/WorkbenchDetail.vue`(仅 template 外层手术)
- Test: 既有 `src/views/__tests__/WorkbenchDetail.{background,lifecycle,pausedBanner}.test.js` 全绿为闸

**Interfaces:**
- Consumes: `WbStage`(Task 2)。
- Produces: 无新接口。

- [ ] **Step 1: 跑既有 Detail 测试记录基线**

Run: `npx vitest run src/views/__tests__/WorkbenchDetail.background.test.js src/views/__tests__/WorkbenchDetail.lifecycle.test.js src/views/__tests__/WorkbenchDetail.pausedBanner.test.js`
Expected: 全 PASS(基线;术后必须同样全绿)。

- [ ] **Step 2: 模板手术**

`src/views/WorkbenchDetail.vue` template 的 project 分支——原:

```html
  <section v-else-if="project" class="animate-fade-in h-full flex flex-col min-h-0">
```

改为:

```html
  <section v-else-if="project" class="h-full min-h-0 p-md">
    <WbStage>
      <template #titleBar>
```

原 header div(「<!-- Header -->」注释所在 div,含返回钮/标题/绑定横幅/挂后台/模式切换/reconcile)整体移入 titleBar slot,仅改容器类:

```html
        <div class="shrink-0 flex items-center gap-sm flex-wrap px-md py-sm border-b border-outline-variant/40">
```

(原类 `border-b border-outline-variant bg-surface-container-lowest` → `border-b border-outline-variant/40`,去底色;新增 `flex-wrap` 容纳窄舞台下横幅换行;其余子节点逐字保留。)

header 之后的所有兄弟节点(Reconcile status、主内容区等)**原样**移入 WbStage 默认 slot。section 收尾:

```html
    </WbStage>
  </section>
```

loading / loadError 两个 v-if 根**不动**(过渡态不进舞台)。

`<script setup>` 增加(零逻辑改动):

```js
import WbStage from '@/components/workbench/WbStage.vue'
```

- [ ] **Step 3: 跑 Detail 测试确认无回归**

Run: `npx vitest run src/views/__tests__/WorkbenchDetail.background.test.js src/views/__tests__/WorkbenchDetail.lifecycle.test.js src/views/__tests__/WorkbenchDetail.pausedBanner.test.js`
Expected: 与 Step 1 基线一致全 PASS。若有选择器红灯:仅允许改测试选择器对准新容器(内容 data-testid 均未动),禁止改生产逻辑迁就。

- [ ] **Step 4: 提交**

```bash
git add src/views/WorkbenchDetail.vue src/views/__tests__/WorkbenchDetail.background.test.js src/views/__tests__/WorkbenchDetail.lifecycle.test.js src/views/__tests__/WorkbenchDetail.pausedBanner.test.js
git commit -m "feat(workbench): project chat moves onto the stage

Project state wraps in WbStage (titleBar carries the existing header —
back, title, bind banner, background button, mode switcher, reconcile —
verbatim with the strip styling weakened); loading/error transitional
states stay outside the stage. Zero logic changes; existing suite is the
gate."
```

---

### Task 5: 批次 C-2——WorkbenchLedger 收编

**Files:**
- Modify: `src/views/WorkbenchLedger.vue`(文档式 → 舞台式,内部滚动区接管)
- Test: 既有 Ledger 相关测试(执行时 `grep -rl WorkbenchLedger src/views/__tests__/ src/components/workbench/__tests__/` 定位;Shell.query-params 不涉 ledger 路由页)

**Interfaces:**
- Consumes: `WbStage`(Task 2);Task 1 的 ledger 路由 fullHeight。

- [ ] **Step 1: 定位既有测试并记录基线**

Run: `grep -rl "WorkbenchLedger" src/views/__tests__/ src/components/workbench/__tests__/ 2>/dev/null` 与 `npx vitest run $(grep -rl "WorkbenchLedger" src/views/__tests__/ src/components/workbench/__tests__/ 2>/dev/null | tr '\n' ' ')`
Expected: 记录基线(全 PASS;若无专属测试文件,基线为空集,跳过)。

- [ ] **Step 2: 模板手术**

原根:

```html
  <section class="animate-fade-in p-md max-w-5xl flex flex-col gap-md">
```

改为:

```html
  <section class="h-full min-h-0 p-md">
    <WbStage>
      <template #titleBar>
        <div class="px-md py-sm border-b border-outline-variant/40">
          <h2 class="text-headline-sm font-bold text-on-surface flex items-center gap-sm"><span class="material-symbols-outlined">menu_book</span> {{ t('workbench.ledger.title') }}</h2>
        </div>
      </template>
      <div class="flex-1 min-h-0 overflow-y-auto">
        <div class="p-md max-w-5xl flex flex-col gap-md">
```

原标题行中的 `<h2 ...text-headline-lg...>`(menu_book 图标+标题)与副标题 `<p>` 由上式 titleBar 承接标题(副标题与集群选择/bootstrap/distill 控制行、section 切换 tabs、正文清单**原样**留在内容区 div 内)。收尾补:

```html
        </div>
      </div>
    </WbStage>
  </section>
```

`<script setup>` 增加:

```js
import WbStage from '@/components/workbench/WbStage.vue'
```

注意:路由已 fullHeight(Task 1),页面不再文档滚动——内容区 `flex-1 min-h-0 overflow-y-auto` 接管;`max-w-5xl` 保持内容行宽。

- [ ] **Step 3: 跑基线测试确认无回归**

Run: 同 Step 1 的 vitest 命令
Expected: 与基线一致。

- [ ] **Step 4: 提交**

```bash
git add src/views/WorkbenchLedger.vue
git commit -m "feat(workbench): ledger joins the stage domain

Document-style ledger becomes a stage page (route gained fullHeight in
the atmosphere batch): title in the stage title bar, body in an
internally-scrolling region capped at max-w-5xl."
```

---

### Task 6: 门禁 + 浏览器验收 + 合并回 main

**Files:**
- Modify: 无(验证与合并)

**Interfaces:**
- Consumes: Task 1–5 全部产出。

- [ ] **Step 1: 全量门禁**

```bash
npm run test:unit -- --maxWorkers=2      # 全绿(WorkbenchChat flaky 隔离复跑判定)
npm run test:server                       # 含 overflow-guard V1–V5
npm run typecheck
npm run build
```
Expected: 全绿;flaky 隔离 3 连绿才判无关。

- [ ] **Step 2: 浏览器验收(无头 chrome + 临时预览壳,验完即删)**

沿用已验证通路:THROWAWAY 预览壳(memory history + `?path=&theme=` 参数)+ `npx vite --port 5277 --strictPort --config vite.config.preview.mjs`(THROWAWAY 配置 `fs.allow` 放行主 checkout node_modules)+ `google-chrome --headless=new --screenshot --virtual-time-budget=6000 --force-device-scale-factor=2`。

预览壳须含 AppLayout 同款结构:`<main class="relative">` 挂 wb-atmosphere 的条件与 `route.meta` 一致,内嵌真 WorkbenchShell(经 Task 3 已不拖真实 router——Shell 的子视图(Projects 等)会拖,故壳内 Shell 的四个子视图按 WorkbenchShell.tabs.test.js 的 stub 方式替换,或仅验证 Shell 骨架+Detail 骨架的静态模拟)。捕获:

1. `/workbench` 亮色:画布三层可见(雾不抢、辉光在右上、点阵无 moiré),舞台描边+回声线,门面瓷砖
2. `/workbench` 暗色:同上,辉光 /15 不脏
3. `/cluster`(或任一 K8s 页)亮暗各一张:与改前逐像素零差(main 无 wb-atmosphere)
4. `?slowmo=1` 注入 `.wb-enter-enter-active{transition-duration:30s!important}` 截滑入中帧:辉光 bloom 与滑入同框
5. reduced-motion 模拟(`--force-prefers-reduced-motion`):无动画、辉光常显
6. **1280px 视口**(browser_resize 或 `--window-size=1280,800`):chat 舞台可用宽度实测(spec §8 风险项);过挤则把 Shell/Detail section 的 `p-md` 回调 `p-sm` 并复拍

- [ ] **Step 3: 清理与合并**

worktree 中 checkout main 会失败(main 被主 checkout 持有)——合并经主 checkout 执行:

```bash
rm -f identity-preview.html identity-preview.js vite.config.preview.mjs
git status --short   # 仅含 5 个任务的预期改动;严禁 git add -A
MAIN=/home/liang/MyProgram/AiProject/aliangboard
git -C "$MAIN" merge --no-ff worktree-feat-identity-panel-v4 -m "Merge branch 'worktree-feat-identity-panel-v4' — workbench module identity: atmosphere canvas (mist + corner bloom + dot grid) on module-tagged routes, WbStage shared stage container with echo-line border (Shell/Detail/Ledger), facade title bar with brand-tile sheen handshake"
cd "$MAIN" && npm run test:unit -- --maxWorkers=2 && npm run build   # main 上复跑
```

Expected: main 全绿;合并若与并行会话在 WorkbenchShell/Detail/Ledger 冲突,以「保留双方语义、容器取本设计」裁决后复跑门禁。
