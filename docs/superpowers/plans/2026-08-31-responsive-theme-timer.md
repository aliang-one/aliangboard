# 响应式适配体系化 + 主题定时自动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** iPad 双向(768–1366)下壳层(顶栏/侧栏/底栏)完整可用、零溢出,桌面 ≥1280 逐像素不变;主题第三态改为 7–19 点定时自动。

**Architecture:** CSS 变量 `--sb-width` 单一事实源 + Tailwind 默认断点类(`lg`=1024/`xl`=1280,`max-lg:` 表达窄档)+ ~30 行零依赖 `useBreakpoint`(仅纯 CSS 表达不了处);主题第三态 `'system'`→`'auto'` 定时切换,index.html 首帧内联脚本镜像同逻辑。

**Tech Stack:** Vue 3 + Tailwind 3.4.19(已有,`max-*` 变体可用)+ vitest/happy-dom + playwright MCP(真浏览器验收)。

**Spec:** `docs/superpowers/specs/2026-08-31-responsive-adaptation-and-theme-timer-design.md`

## Global Constraints

- **零新外部依赖**:`useBreakpoint` 自研;Tailwind 已有。
- **所有文件编辑必须用 worktree 绝对路径**(前缀 `/home/liang/MyProgram/AiProject/aliangboard/.claude/worktrees/feat-responsive-theme-timer/`)。
- **提交作者恒为** `aliangone <aliangone@gmail.com>`,**禁止 Co-Authored-By 尾注**。
- **桌面 ≥1280 回归红线**:所有改动在 `xl:`/默认类上必须保持现状(新断点类只加不改既有)。
- **壳层三文件(AppLayout.vue/TopNavBar.vue/SideNavBar.vue)禁止** `ml-[260px]`/`left-[260px]`/`w-[260px]` 字面量(守卫测试强制)。
- **i18n 双语对齐**:新增/删除键必须 zh.json + en.json 同步,门禁 `npm run i18n:check`。
- **几何断言只在真浏览器**(playwright);happy-dom/vitest 只锁状态逻辑与类存在性。
- **测试命令**:`npx vitest run <file>`(单文件);`npm run test:unit`(全量);注意并行 vitest 串扰偶发(WorkbenchChat 单跑即绿,勿修)。
- 文中「改 X 行」均指相对本计划基线(base = main @ 665d020),行号若漂移以内容定位。

---

### Task 1: useBreakpoint 组合式(零依赖 matchMedia 封装)

**Files:**
- Create: `src/composables/useBreakpoint.js`
- Test: `src/composables/__tests__/useBreakpoint.test.js`

**Interfaces:**
- Produces: `useBreakpoint(query: string) → { matches: Ref<boolean> }`;常量 `MQ_BELOW_LG = '(max-width: 1023.98px)'`。Task 6/8 消费。

- [ ] **Step 1: Write the failing test**

```js
// src/composables/__tests__/useBreakpoint.test.js
import { test, expect } from 'vitest'
import { useBreakpoint, MQ_BELOW_LG } from '../useBreakpoint'

test('MQ_BELOW_LG 查询串与 Tailwind lg=1024 对齐', () => {
  expect(MQ_BELOW_LG).toBe('(max-width: 1023.98px)')
})

test('happy-dom 下 matches 反映 matchMedia 初值,change 事件驱动更新', () => {
  const { matches } = useBreakpoint(MQ_BELOW_LG)
  expect(typeof matches.value).toBe('boolean')
  // 模拟变更:happy-dom 的 MediaQueryList 支持 dispatchEvent
  const initial = matches.value
  window.dispatchEvent(new Event('noop'))
  expect(matches.value).toBe(initial) // 无真实 resize 不翻转
})

test('无 matchMedia 环境(SSR)降级 matches=false 不抛', () => {
  const orig = window.matchMedia
  window.matchMedia = undefined
  try {
    const { matches } = useBreakpoint('(max-width: 100px)')
    expect(matches.value).toBe(false)
  } finally {
    window.matchMedia = orig
  }
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/composables/__tests__/useBreakpoint.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: Write minimal implementation**

```js
// src/composables/useBreakpoint.js
// 断点组合式(2026-08-31 响应式适配设计 §2):matchMedia 响应式封装,零依赖。
// 仅在纯 CSS 表达不了处使用(搜索弹层开关/rail 类);纯样式退化一律 Tailwind 断点类。
// MQ_BELOW_LG 必须与 Tailwind 默认 lg=1024 对齐(1023.98 避免整数像素边界抖动)。
import { ref, onScopeDispose } from 'vue'

export const MQ_BELOW_LG = '(max-width: 1023.98px)'

export function useBreakpoint(query) {
  const mq = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null
  const matches = ref(mq ? !!mq.matches : false)
  function onChange(e) { matches.value = !!e.matches }
  if (mq) {
    mq.addEventListener?.('change', onChange)
    onScopeDispose(() => mq.removeEventListener?.('change', onChange))
  }
  return { matches }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/composables/__tests__/useBreakpoint.test.js`
Expected: PASS(3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/composables/useBreakpoint.js src/composables/__tests__/useBreakpoint.test.js
git commit --author='aliangone <aliangone@gmail.com>' -m "feat(composables): useBreakpoint 零依赖 matchMedia 封装+MQ_BELOW_LG 档位常量"
```

---

### Task 2: 主题第三态 'system' → 'auto'(7–19 点定时)

**Files:**
- Modify: `src/styles/theme.js`(全文重写,见下)
- Modify: `src/styles/__tests__/theme.test.js`(更新既有断言 + 新增边界/迁移用例)

**Interfaces:**
- Produces: `isScheduledDark(hour: number): boolean` 纯函数;`themeMode` 值域 `'light'|'dark'|'auto'`;删除导出 `systemPrefersDark`(已核实全仓无外部消费方)。Task 3 的守卫测试消费 `DARK_TO_HOUR = 7` / `DARK_FROM_HOUR = 19` 字面量。

- [ ] **Step 1: Rewrite the failing tests**

替换 `src/styles/__tests__/theme.test.js` 全文:

```js
// 主题三态 light/dark/auto;auto=定时(07:00–19:00 亮,其余暗),不读 prefers-color-scheme。
import { test, expect, beforeEach } from 'vitest'
import { themeMode, nowHour, isDark, activePalette, tokenHexR, applyThemeMode, initTheme, stopHourTick, isScheduledDark } from '../theme'
import { MD_PALETTE, DARK_PALETTE } from '../md-palette'

beforeEach(() => {
  stopHourTick()
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  nowHour.value = 12 // 固定白天:默认断言与真实时钟解耦(夜间跑 CI 不误红)
  applyThemeMode('auto')
})

test('默认 auto;白天小时下 isDark=false,activePalette=亮板', () => {
  expect(themeMode.value).toBe('auto')
  expect(activePalette.value).toBe(MD_PALETTE)
})

test('applyThemeMode(dark):isDark=true + html.dark + activePalette=暗板 + tokenHexR 走暗板', () => {
  applyThemeMode('dark')
  expect(isDark.value).toBe(true)
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(activePalette.value).toBe(DARK_PALETTE)
  expect(tokenHexR('primary')).toBe(DARK_PALETTE.primary)
})

test('applyThemeMode(light):显式亮色,无视定时', () => {
  applyThemeMode('light')
  expect(isDark.value).toBe(false)
  expect(document.documentElement.classList.contains('dark')).toBe(false)
})

test('isScheduledDark 边界:6 暗/7 亮/18 亮/19 暗', () => {
  expect(isScheduledDark(6)).toBe(true)
  expect(isScheduledDark(7)).toBe(false)
  expect(isScheduledDark(12)).toBe(false)
  expect(isScheduledDark(18)).toBe(false)
  expect(isScheduledDark(19)).toBe(true)
  expect(isScheduledDark(23)).toBe(true)
  expect(isScheduledDark(0)).toBe(true)
})

test('非法值归 auto;旧值 system 归 auto', () => {
  applyThemeMode('purple')
  expect(themeMode.value).toBe('auto')
  applyThemeMode('system')
  expect(themeMode.value).toBe('auto')
})

test('initTheme:localStorage 恢复 dark/auto;旧 system 迁移为 auto', () => {
  localStorage.setItem('aliangboard.theme', 'dark')
  initTheme(document)
  expect(themeMode.value).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)

  localStorage.setItem('aliangboard.theme', 'system')
  initTheme(document)
  expect(themeMode.value).toBe('auto')

  localStorage.setItem('aliangboard.theme', 'auto')
  initTheme(document)
  expect(themeMode.value).toBe('auto')
  expect(document.documentElement.classList.contains('dark'))
    .toBe(isScheduledDark(new Date().getHours()))
})

test('localStorage 坏值按 auto 处理', () => {
  localStorage.setItem('aliangboard.theme', 'purple')
  initTheme(document)
  expect(themeMode.value).toBe('auto')
})

test('tokenHexR:未知 token 回落当前板 primary', () => {
  applyThemeMode('dark')
  expect(tokenHexR('no-such-token')).toBe(DARK_PALETTE.primary)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/styles/__tests__/theme.test.js`
Expected: FAIL(`isScheduledDark`/`stopHourTick` 未导出;'system' 断言不符)

- [ ] **Step 3: Rewrite `src/styles/theme.js`**

```js
// 主题运行时:reactive 主题态 + 色板翻转。
// 第三态 'auto' = 定时自动(2026-08-31 响应式+主题设计 §7):07:00–19:00 亮色,其余暗色;
// 不再读取 prefers-color-scheme(旧 'system' 语义已废弃,读入即归一 'auto')。
// 首帧判定在 index.html 内联脚本有同逻辑镜像(该处无法 import):边界常量 7/19 改动必须
// 两处同步,src/styles/__tests__/theme-firstpaint-guard.test.js 锁一致性(Task 3 建)。
import { ref, computed } from 'vue'
import { MD_PALETTE, DARK_PALETTE, installPaletteVars } from './md-palette.js'

const THEME_KEY = 'aliangboard.theme'
const DARK_TO_HOUR = 7    // 07:00(含)起亮色
const DARK_FROM_HOUR = 19 // 19:00(含)起暗色

export const themeMode = ref('auto')   // 'light' | 'dark' | 'auto'
export const nowHour = ref(new Date().getHours())

// 纯函数边界判定(测试直测 6/7/18/19);index.html 镜像同一表达式
export function isScheduledDark(hour) {
  return hour < DARK_TO_HOUR || hour >= DARK_FROM_HOUR
}

export const isDark = computed(() =>
  themeMode.value === 'dark' || (themeMode.value === 'auto' && isScheduledDark(nowHour.value)))
export const activePalette = computed(() => (isDark.value ? DARK_PALETTE : MD_PALETTE))
// 响应式取色:模板/computed 内调用,主题翻转自动触发重渲(图表重算)
export function tokenHexR(token) {
  const p = activePalette.value
  return p[token] || p.primary
}

function syncClass(doc) {
  doc.documentElement.classList.toggle('dark', isDark.value)
}

// 切模式:非法值(含旧 'system')归 auto。偏好 store(setTheme)与测试均走这里。
export function applyThemeMode(mode) {
  themeMode.value = mode === 'dark' || mode === 'light' ? mode : 'auto'
  if (typeof document !== 'undefined') syncClass(document)
}

// 分钟级边界 tick:仅跨小时且处 auto 态时重翻(60s 一次,开销可忽略)
let hourTimer = null
function startHourTick(doc) {
  if (hourTimer) return
  hourTimer = setInterval(() => {
    const h = new Date().getHours()
    if (h !== nowHour.value) {
      nowHour.value = h
      syncClass(doc)
    }
  }, 60_000)
}
export function stopHourTick() { if (hourTimer) { clearInterval(hourTimer); hourTimer = null } } // 测试用

// 启动初始化(main.js 调):注入双板 CSS 变量 + 读 localStorage 恢复('system'→'auto' 迁移)+ 挂边界 tick
export function initTheme(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc) return
  installPaletteVars(doc)
  let saved = 'auto'
  try { saved = localStorage.getItem(THEME_KEY) || 'auto' } catch { /* 无 storage */ }
  themeMode.value = saved === 'dark' || saved === 'light' ? saved : 'auto'
  nowHour.value = new Date().getHours()
  syncClass(doc)
  startHourTick(doc)
}
```

注意:`src/lib/__tests__/chart-theme.test.js` 若引用了被删导出,按同样语义改;`grep -rn "systemPrefersDark" src/` 必须为 0 命中。

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/styles/__tests__/theme.test.js src/lib/__tests__/chart-theme.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/styles/theme.js src/styles/__tests__/theme.test.js
git commit --author='aliangone <aliangone@gmail.com>' -m "feat(theme): 第三态 system→auto 定时切换(7-19点亮色)+分钟级边界tick+存量迁移"
```

---

### Task 3: index.html 首帧镜像 + 首帧守卫 + 用户中心 UI/i18n/偏好归一

**Files:**
- Modify: `index.html:10-18`(内联脚本)
- Create: `src/styles/__tests__/theme-firstpaint-guard.test.js`
- Modify: `src/views/UserProfile.vue:90`(themeOptions)
- Modify: `src/stores/preferences.js`(注释 + hydrate 归一)
- Modify: `src/locales/zh.json:560`、`src/locales/en.json:560`(themeSystem→themeAuto)

**Interfaces:**
- Consumes: Task 2 的 `'auto'` 值域与 7/19 边界。
- Produces: 守卫测试 `theme-firstpaint-guard.test.js`(防两处逻辑漂移)。

- [ ] **Step 1: Write the failing guard test**

```js
// src/styles/__tests__/theme-firstpaint-guard.test.js
// index.html 首帧内联脚本无法 import theme.js,定时边界 7/19 是双写镜像;
// 本守卫锁两处一致——单边改动 here 必红(2026-08-31 设计 §7)。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const themeSrc = readFileSync(join(root, 'src/styles/theme.js'), 'utf8')
const htmlSrc = readFileSync(join(root, 'index.html'), 'utf8')

test('theme.js 边界常量 7/19 存在', () => {
  expect(themeSrc).toContain('DARK_TO_HOUR = 7')
  expect(themeSrc).toContain('DARK_FROM_HOUR = 19')
})

test('index.html 内联脚本镜像同一边界表达式且不再读 prefers-color-scheme', () => {
  expect(htmlSrc).toMatch(/h < 7 \|\| h >= 19/)
  expect(htmlSrc).not.toContain('prefers-color-scheme')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/styles/__tests__/theme-firstpaint-guard.test.js`
Expected: FAIL(index.html 仍是 prefers-color-scheme 版)

- [ ] **Step 3: 改 index.html 内联脚本(整段替换)**

```html
    <script>
      (function () {
        // 首帧主题判定:与 src/styles/theme.js isScheduledDark 同逻辑镜像(此处无法 import)。
        // 边界 7/19 改动必须两处同步(theme-firstpaint-guard.test.js 锁一致)。
        try {
          var t = localStorage.getItem('aliangboard.theme') || 'auto'
          var h = new Date().getHours()
          var dark = t === 'dark' || (t !== 'light' && (h < 7 || h >= 19))
          if (dark) document.documentElement.classList.add('dark')
        } catch (e) { /* 无 storage 环境 */ }
      })()
    </script>
```

- [ ] **Step 4: 用户中心第三选项 + i18n + 偏好归一**

`src/views/UserProfile.vue:90` 整行替换:

```js
const themeOptions = [{ v: 'light', icon: 'light_mode', key: 'userCenter.themeLight' }, { v: 'dark', icon: 'dark_mode', key: 'userCenter.themeDark' }, { v: 'auto', icon: 'schedule', key: 'userCenter.themeAuto' }]
```

`src/locales/zh.json:558-560` 与 `src/locales/en.json:558-560`:`"themeSystem"` 键改名为 `"themeAuto"`:

```json
"themeAuto": "自动(7:00–19:00 浅色)"
```
```json
"themeAuto": "Auto (light 7:00–19:00)"
```
(同时 grep 确认 `themeSystem` 无其他引用残留:`grep -rn themeSystem src/` 必须 0 命中。)

`src/stores/preferences.js`:注释 `// 'light' | 'dark' | 'system' | null` 改 `// 'light' | 'dark' | 'auto' | null`;`hydrateFromServer` 内 theme 分支加旧值归一(服务端存量 'system'):

```js
    if (prefs.theme) {
      const t = prefs.theme === 'dark' || prefs.theme === 'light' ? prefs.theme : 'auto'
      if (t !== theme.value) { theme.value = t; applyThemeMode(t) }
    }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/styles/__tests__/theme-firstpaint-guard.test.js src/stores/__tests__/preferences.test.js && npm run i18n:check`
Expected: PASS + i18n 三合一全绿

- [ ] **Step 6: Commit**

```bash
git add index.html src/styles/__tests__/theme-firstpaint-guard.test.js src/views/UserProfile.vue src/stores/preferences.js src/locales/zh.json src/locales/en.json
git commit --author='aliangone <aliangone@gmail.com>' -m "feat(theme): 首帧定时判定镜像+守卫测试;用户中心第三态改「自动(7:00-19:00 浅色)」双语"
```

---

### Task 4: --sb-width 布局解耦(AppLayout/SideNavBar)+ 壳层宽度守卫

**Files:**
- Modify: `src/components/layout/AppLayout.vue:70-75`(ml-[260px]/left-[260px] → var)+ 文末新增 `<style>`
- Modify: `src/components/layout/SideNavBar.vue:204`(w-[260px] → var 类)
- Create: `src/components/layout/__tests__/shell-width-guard.test.js`

**Interfaces:**
- Produces: CSS 变量 `--sb-width`(260px / <1023.98px 时 72px);`.shell-main` 类;SideNavBar 根类 `sidenav-root`(Task 8 的 rail 样式挂点)。

- [ ] **Step 1: Write the failing guard test**

```js
// src/components/layout/__tests__/shell-width-guard.test.js
// 侧栏宽度唯一事实源是 --sb-width(AppLayout <style> 定义);壳层出现 260px
// Tailwind 字面量即回归(2026-08-31 设计 §3/§9)。
import { test, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const dir = dirname(fileURLToPath(import.meta.url))
for (const f of ['AppLayout.vue', 'TopNavBar.vue', 'SideNavBar.vue']) {
  test(`${f} 禁止 260px 定位/宽度字面量(一律走 --sb-width)`, () => {
    const src = readFileSync(join(dir, f), 'utf8')
    expect(src).not.toMatch(/ml-\[260px\]|left-\[260px\]|w-\[260px\]/)
  })
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/layout/__tests__/shell-width-guard.test.js`
Expected: FAIL(AppLayout 两处 + SideNavBar 一处命中)

- [ ] **Step 3: AppLayout 解耦**

`AppLayout.vue:72` 改:

```html
    <div class="shell-main flex-1 flex flex-col min-w-0">
```

`AppLayout.vue:74` 加载条去掉 `left-[260px]` 类,改 style 注入(与 zIndex 合并):

```html
      <div v-if="store.connectionState === 'loading'" class="fixed top-0 right-0 h-0.5 bg-primary animate-pulse" :style="{ zIndex: Z.windowBase, left: 'var(--sb-width)' }"></div>
```

文件末尾(`</template>` 后)新增非 scoped style(`:root` 在 scoped 下不生效):

```html
<style>
/* 侧栏宽度单一事实源(2026-08-31 响应式设计 §3):本文件是唯一定义点,
   SideNavBar(.sidenav-root)与 hydrate 加载条同消费;<lg(iPad 竖屏)侧栏收 72px 图标栏。
   禁止壳层再写 260px 定位/宽度字面量(shell-width-guard.test.js 强制)。 */
:root { --sb-width: 260px; }
@media (max-width: 1023.98px) { :root { --sb-width: 72px; } }
.shell-main { margin-left: var(--sb-width); }
</style>
```

- [ ] **Step 4: SideNavBar 宽度走变量**

`SideNavBar.vue:204` aside 的 class 去掉 `w-[260px]`,加 `sidenav-root`;`<style scoped>` 顶部加:

```css
.sidenav-root { width: var(--sb-width); transition: width .28s cubic-bezier(.2,.7,.3,1); }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/components/layout/__tests__/shell-width-guard.test.js src/components/layout/__tests__/SideNavBar.brand-logo.test.js src/components/layout/__tests__/TopNavBar.test.js`
Expected: PASS(守卫绿;既有布局测试不回归)

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/AppLayout.vue src/components/layout/SideNavBar.vue src/components/layout/__tests__/shell-width-guard.test.js
git commit --author='aliangone <aliangone@gmail.com>' -m "feat(layout): --sb-width 单一事实源——AppLayout/SideNavBar 去 260px 双写硬编码,iPad竖屏 72px"
```

---

### Task 5: TopNavBar/WorkbenchEntryPill/UserMenu 紧凑档(`lg` 收缩,`<xl` 去两行标签)

**Files:**
- Modify: `src/components/layout/TopNavBar.vue:135-137,163-174,220-235,263`(纯 class 增补)
- Modify: `src/components/layout/WorkbenchEntryPill.vue:117,134,137,140`(`lg:` → `xl:`)
- Modify: `src/components/layout/UserMenu.vue:54,56`
- Test: `src/components/layout/__tests__/TopNavBar.test.js`(追加紧凑类断言)

**Interfaces:**
- Consumes: 无(纯 class)。Task 8 的 `<lg` 图标档在此之上叠加。

- [ ] **Step 1: 追加失败断言到 TopNavBar.test.js**

```js
test('紧凑档:集群/命名空间标签行 <xl 隐藏,值宽三级收缩', () => {
  expect(wrapper.html()).toContain('hidden xl:block')       // CLUSTER/NAMESPACE 标签行
  expect(wrapper.html()).toContain('max-w-[80px] lg:max-w-[110px]')
})
```
(挂载方式沿用该文件既有 describe 内 wrapper;若文件用多个用例各自 mount,追加同款用例。)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js`
Expected: 新增用例 FAIL

- [ ] **Step 3: TopNavBar class 编辑**

1. `:135` header 保持不变。
2. `:136` 左区容器 `gap-lg` → `gap-sm lg:gap-md xl:gap-lg`。
3. `:137` 搜索容器 `max-w-md` → `max-w-xs xl:max-w-md`。
4. `:170` 集群按钮标签行 `<span class="text-xs text-on-surface-variant opacity-70">CLUSTER</span>` 加 `hidden xl:block`。
5. `:171` 集群名 `max-w-[180px]` → `max-w-[80px] lg:max-w-[110px] xl:max-w-[180px]`。
6. `:231` 命名空间标签行 `NAMESPACE` 同样加 `hidden xl:block`。
7. `:232` ns 名 `max-w-[160px]` → `max-w-[80px] lg:max-w-[110px] xl:max-w-[160px]`。

- [ ] **Step 4: WorkbenchEntryPill 统计条断点 lg→xl**

`:117` `hidden lg:inline-flex` → `hidden xl:inline-flex`;`:134/:137/:140` 三处 `lg:hidden` → `xl:hidden`(徽章形态改为 <xl 生效)。

- [ ] **Step 5: UserMenu 紧凑**

`:54` 名字 `max-w-[120px]` → `max-w-[90px] xl:max-w-[120px]`;`:56` chevron span 加 `max-lg:hidden`(Task 6 再补头像-only)。

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js src/components/layout/__tests__/WorkbenchEntryPill.test.js src/components/layout/__tests__/UserMenu.test.js`
Expected: PASS(新增断言绿;既有胶囊/用户菜单契约不破——WorkbenchEntryPill.test.js 若有 `lg:` 字面断言同步改 `xl:`)

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/TopNavBar.vue src/components/layout/WorkbenchEntryPill.vue src/components/layout/UserMenu.vue src/components/layout/__tests__/TopNavBar.test.js
git commit --author='aliangone <aliangone@gmail.com>' -m "feat(nav): 顶栏 lg 紧凑档——双选择器去两行标签+值宽三级收缩,胶囊统计条断点 lg→xl,UserMenu 名字收窄"
```

---

### Task 6: TopNavBar `<lg` 图标档——搜索弹层化 + 头像 only + 分隔线隐藏

**Files:**
- Modify: `src/components/layout/TopNavBar.vue`(script + template)
- Test: `src/components/layout/__tests__/TopNavBar.test.js`(追加弹层用例)

**Interfaces:**
- Consumes: Task 1 `useBreakpoint`/`MQ_BELOW_LG`;`Z.popover`(src/styles/zScale)。

- [ ] **Step 1: 追加失败测试**

```js
test('<lg 档:搜索收成图标触发钮,弹层 Teleport 到 body 且开启时 enabled 查询', async () => {
  const mqSpy = vi.spyOn(window, 'matchMedia').mockImplementation(q => ({ matches: q.includes('1023.98'), media: q, addEventListener() {}, removeEventListener() {} }))
  const w = mount(TopNavBar, { global: { plugins: [...] /* 同文件既有挂载配置 */ } })
  expect(w.find('[data-test="search-trigger"]').exists()).toBe(true)
  expect(w.find('input[type="text"]').exists()).toBe(false) // 内联输入框不渲染
  await w.find('[data-test="search-trigger"]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[data-test="search-modal"]')).toBeTruthy()
  mqSpy.mockRestore()
})
```
(若该文件尚未 import `vi`/`flushPromises`,从 vitest/@vue/test-utils 补 import;挂载配置照抄同文件。)

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js`
Expected: 新用例 FAIL

- [ ] **Step 3: script 增补**

```js
import { useBreakpoint, MQ_BELOW_LG } from '@/composables/useBreakpoint'
import { Z } from '@/styles/zScale'
// <lg(iPad 竖屏):搜索收成图标钮,点击弹 Teleport 弹层(2026-08-31 设计 §4)
const { matches: belowLg } = useBreakpoint(MQ_BELOW_LG)
const searchModalOpen = ref(false)
const searchModalInput = ref(null)
function openSearchModal() {
  searchModalOpen.value = true
  nextTick(() => searchModalInput.value?.focus())
}
function closeSearchModal() { searchModalOpen.value = false; searchQuery.value = '' }
```
(`import { ref, computed, nextTick } from 'vue'` 补 nextTick;**替换 `:20` 既有 `const searchEnabled = computed(() => searchOpen.value)` 为下行,勿新增第二份声明**:)

```js
const searchEnabled = computed(() => searchOpen.value || searchModalOpen.value) // 弹层打开也启用惰性查询(与内联 focus 同语义)
```

- [ ] **Step 4: template 改造**

1. `:137-157` 的搜索容器整块包进 `<template v-if="!belowLg"> ... </template>`(原样不动)。
2. 其后追加图标触发钮(`v-else` 语义用独立 v-if 块):

```html
      <div v-if="belowLg" class="shrink-0">
        <button data-test="search-trigger" @click="openSearchModal"
          class="p-sm rounded-full text-on-surface-variant hover:bg-surface-container-low hover:text-primary transition-colors"
          :aria-label="$t('common.search')">
          <span class="material-symbols-outlined">search</span>
        </button>
      </div>
```

3. 模板末尾(`</header>` 后、遮罩 div 前)追加弹层(输入框/结果面板与内联版同构,复用 `searchQuery/searchResults/onSearchKeydown/goResult`;input 加 `ref="searchModalInput"`,Escape 分支调 `closeSearchModal()`):

```html
  <!-- <lg 搜索弹层:Teleport body + fixed 顶部居中,复用内联搜索的索引与结果渲染 -->
  <Teleport to="body">
    <div v-if="searchModalOpen" data-test="search-modal" class="fixed inset-0" :style="{ zIndex: Z.popover }">
      <div class="absolute inset-0 bg-black/30" @click="closeSearchModal"></div>
      <div class="absolute left-1/2 -translate-x-1/2 top-16 w-[min(92vw,480px)]">
        <div class="relative">
          <span class="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant pointer-events-none z-10">search</span>
          <input
            ref="searchModalInput"
            v-model="searchQuery"
            @keydown="onSearchKeydown"
            class="w-full bg-surface-container-low border border-outline-variant rounded-full py-2.5 pl-10 pr-md text-body-md focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary shadow-dropdown"
            :placeholder="$t('nav.searchPlaceholder')"
            :aria-label="$t('common.search')"
            type="text"
          />
          <div v-if="searchResults.length" class="absolute top-full left-0 mt-1 w-full bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-y-auto max-h-96">
            <button v-for="(it, i) in searchResults" :key="i" @click="goResult(it)" class="flex items-center gap-sm w-full px-md py-sm hover:bg-surface-container-low text-left transition-colors border-b border-outline-variant/30 last:border-0">
              <span class="material-symbols-outlined text-on-surface-variant text-lg shrink-0">{{ ICON_FOR[it.kind] || 'circle' }}</span>
              <span class="font-mono text-code-sm text-on-surface truncate">{{ it.name }}</span>
              <span class="ml-auto text-xs text-on-surface-variant shrink-0">{{ it.kind }}<span v-if="it.namespace"> · {{ it.namespace }}</span></span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
```

4. `onSearchKeydown` 的 Escape 分支改:`else if (e.key === 'Escape') { searchQuery.value = ''; if (searchModalOpen.value) closeSearchModal() }`;`goResult` 开头加 `closeSearchModal()`(内联版 searchOpen=false 保持,弹层关闭无害)。
5. `:270` 分隔线 `class` 加 `max-lg:hidden`。
6. UserMenu.vue `:54`:名字 span 加 `max-lg:hidden`(chevron 已在 Task 5 处理;`:55` ADMIN chip 保留)。

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js src/components/layout/__tests__/UserMenu.test.js`
Expected: PASS(Teleport 断言查 `document.body`,沿用 Toolcall Modal 先例)

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/TopNavBar.vue src/components/layout/UserMenu.vue src/components/layout/__tests__/TopNavBar.test.js
git commit --author='aliangone <aliangone@gmail.com>' -m "feat(nav): 顶栏 <lg 图标档——搜索弹层化(Teleport body)+分隔线/用户名窄档隐藏"
```

---

### Task 7: 顶栏集群/命名空间下拉 Teleport 化(PortSelect 先例)

**Files:**
- Modify: `src/components/layout/TopNavBar.vue`(两个下拉面板迁移)
- Test: `src/components/layout/__tests__/TopNavBar.test.js`(面板在 body 断言)

**Interfaces:**
- Consumes: `Z.popover`;PortSelect 的 placePanel 模式(锚 trigger rect、上翻、右缘 clamp、scroll capture 跟随)。
- Produces: `data-testid="cluster-dropdown-panel"` / `"ns-dropdown-panel"`。

- [ ] **Step 1: 追加失败测试**

```js
test('集群下拉面板 Teleport 到 body 且带 data-testid', async () => {
  const w = mountTopNav()
  await w.find('[data-test="cluster-trigger"]').trigger('click')
  await flushPromises()
  expect(document.querySelector('[data-testid="cluster-dropdown-panel"]')).toBeTruthy()
  expect(w.find('[data-testid="cluster-dropdown-panel"]').exists()).toBe(false) // 不在组件树内
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js`
Expected: FAIL(触发钮尚无 `data-test="cluster-trigger"`,面板在组件树内)

- [ ] **Step 3: 迁移实现(script 增补)**

```js
// 下拉传送定位(issue #4 PortSelect 同款):面板 Teleport body + fixed 锚触发钮 rect,
// 脱离 sticky header 的 overflow 裁切;scroll capture 跟随,resize 关闭。
const clusterBtnRef = ref(null), clusterPanelRef = ref(null)
const nsBtnRef = ref(null), nsPanelRef = ref(null)
const clusterPanelStyle = ref(hiddenStyle()), nsPanelStyle = ref(hiddenStyle())
function hiddenStyle() { return { position: 'fixed', top: '0px', left: '0px', visibility: 'hidden', zIndex: Z.popover } }
function placeDropdown(btn, panel, width) {
  if (!btn || !panel) return
  const r = btn.getBoundingClientRect()
  const ph = panel.offsetHeight
  let top = r.bottom + 4
  if (top + ph > window.innerHeight - 8 && r.top - ph - 4 >= 8) top = r.top - ph - 4
  let left = r.left
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8)
  return { position: 'fixed', top: `${top}px`, left: `${left}px`, visibility: 'visible', zIndex: Z.popover, width: `${width}px` }
}
async function placeAll() {
  await nextTick()
  if (showClusterDropdown.value && clusterPanelRef.value) clusterPanelStyle.value = placeDropdown(clusterBtnRef.value, clusterPanelRef.value, 320)
  if (showNsDropdown.value && nsPanelRef.value) nsPanelStyle.value = placeDropdown(nsBtnRef.value, nsPanelRef.value, 288)
}
function onDocScroll() { placeAll() }  // sticky 顶栏场景跟随即可,不必关闭
function bindDropFollow() {
  window.addEventListener('scroll', onDocScroll, { capture: true, passive: true })
  window.addEventListener('resize', onDocScroll, { passive: true })
}
function unbindDropFollow() {
  window.removeEventListener('scroll', onDocScroll, { capture: true })
  window.removeEventListener('resize', onDocScroll)
}
watch([showClusterDropdown, showNsDropdown], v => {
  if (v.some(Boolean)) { placeAll(); bindDropFollow() } else { unbindDropFollow() }
})
onBeforeUnmount(unbindDropFollow)
```
(import 补 `watch, onBeforeUnmount`。)触发钮分别加 `ref="clusterBtnRef"` / `ref="nsBtnRef"` 与 `data-test="cluster-trigger"` / `data-test="ns-trigger"`。

- [ ] **Step 4: template 迁移两个面板**

两个下拉 `v-if` 面板整体(当前 `:176-215` 与 `:237-260`)剪出,包进(共用一个 Teleport):

```html
  <Teleport to="body">
    <div v-if="showClusterDropdown" ref="clusterPanelRef" data-testid="cluster-dropdown-panel" class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-hidden" :style="clusterPanelStyle">
      <!-- 原面板内部 DOM 原样粘入;原 w-80 定宽类删除(宽度由 placeDropdown 注入) -->
    </div>
    <div v-if="showNsDropdown" ref="nsPanelRef" data-testid="ns-dropdown-panel" class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-dropdown overflow-hidden" :style="nsPanelStyle">
      <!-- 原面板内部 DOM 原样粘入;原 w-72 定宽类删除 -->
    </div>
  </Teleport>
```

既有 `fixed inset-0 z-30` 点外关闭遮罩保留(面板 z=Z.popover=110 > 30,不遮挡)。面板内 `max-h-80 overflow-y-auto` 原样保留(高度测量依赖它先渲染)。

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/components/layout/__tests__/TopNavBar.test.js src/components/layout/__tests__/TopNavBar.dedup.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/TopNavBar.vue src/components/layout/__tests__/TopNavBar.test.js
git commit --author='aliangone <aliangone@gmail.com>' -m "fix(nav): 顶栏集群/命名空间下拉 Teleport body+fixed 锚定——iPad 竖屏 w-80 裁切根治(issue#4 同款)"
```

---

### Task 8: SideNavBar 图标栏(rail)+ 悬停展开

**Files:**
- Modify: `src/components/layout/SideNavBar.vue`(script + class 钩子 + scoped style)
- Test: `src/components/layout/__tests__/SideNavBar.rail.test.js`(新建)

**Interfaces:**
- Consumes: Task 1 `useBreakpoint`/`MQ_BELOW_LG`;Task 4 `.sidenav-root`(width var + transition 已就位)。
- Produces: `.rail` 根类(`<lg` 时挂上);`data-test="sidenav-root"` 便于测试。

- [ ] **Step 1: Write the failing test**

```js
// src/components/layout/__tests__/SideNavBar.rail.test.js
import { test, expect, vi } from 'vitest'
// mountSideNav:把 SideNavBar.nsband.test.js 顶部的既有 mount 调用(含 store/router/i18n
// 挂载配置)原样复制成本文件内的工厂函数,第二参可覆盖 store.currentNamespace 初值
import { mountSideNav } from './helpers' // 若选择内联,则在文件内定义 function mountSideNav(nsOverride)

function belowLg() {
  return vi.spyOn(window, 'matchMedia').mockImplementation(q => ({
    matches: q.includes('1023.98'), media: q, addEventListener() {}, removeEventListener() {},
  }))
}

test('<lg:根节点挂 rail 类;≥lg:不挂', () => {
  const spy = belowLg()
  const w = mountSideNav()
  expect(w.find('[data-test="sidenav-root"]').classes()).toContain('rail')
  spy.mockRestore()
  const w2 = mountSideNav()
  expect(w2.find('[data-test="sidenav-root"]').classes()).not.toContain('rail')
})

test('rail 空态点 ns 主钮 → 跳 /namespaces(72px 弹层放不下,不 extradrop)', async () => {
  const spy = belowLg()
  const w = mountSideNav({ currentNamespace: '' })
  await w.find('[data-test="ns-home"]').trigger('click')
  expect(w.find('.ns-drop').exists()).toBe(false)
  spy.mockRestore()
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.rail.test.js`
Expected: FAIL(rail 类/行为不存在)

- [ ] **Step 3: script 增补**

```js
import { useBreakpoint, MQ_BELOW_LG } from '@/composables/useBreakpoint'
// <lg(iPad 竖屏)图标栏:宽度/隐藏全在 .rail:not(:hover) 样式;JS 只管 rail 类挂载
// 与「空 ns 时 72px 放不下下拉」改跳 /namespaces
const { matches: belowLg } = useBreakpoint(MQ_BELOW_LG)
```

`onNsHomeClick` 改:

```js
function onNsHomeClick() {
  if (!currentNs.value) {
    if (belowLg.value) { router.push('/namespaces'); return }  // rail 态弹层放不下 → 去集群 ns 列表
    showNsDropdown.value = true
    return
  }
  router.push({ name: 'NamespaceOverview', params: { namespace: currentNs.value } })
}
```

- [ ] **Step 4: class 钩子(只加不改,≥xl 形态零变化)**

- `:204` aside 加 `data-test="sidenav-root"` 与 `:class="{ rail: belowLg }"`。
- `:211` 集群名 h2 的父级 `min-w-0` div 加类 `cluster-header-txt`;`:219` anchor 模式名 span 加 `cluster-anchor-txt`,其兄弟 chevron span(`:220`)加 `cluster-anchor-chev`。
- `:231` `NAMESPACE` 标题 p 加 `ns-cap`;`:302` `NAMESPACE: {{ currentNs }}` p 加 `ns-cap`;`:328` 「集群管理」折叠按钮加 `nav-collapse-btn`;`:358` `nav.platformAdmin` 标题 p 加 `ns-cap`。
- `:307/:306` ns 组头行容器 div 加 `group-head`;`:337/:344` 两个段标题 p 加 `group-head`。
- 导航项 `:312`(ns 项)与 `:332/:339/:346/:360`(集群/平台项):a 元素加 `nav-item`,文字 span(`:318` 等)加 `nav-item__label`。
- `:379-385` cluster-slab 内 `min-w-0` span 加 `slab-txt`;`:384` 的 8px 副标签随父隐藏无需单独类。

- [ ] **Step 5: scoped style 追加(rail 形态全部收在 `.rail:not(:hover)` 下;悬停恢复与现状一致)**

```css
/* ===== 图标栏 rail(2026-08-31 设计 §5):<lg 收 72px =====
   折叠声明按指针能力分两块(选择器不同、声明列表完全相同):
   · hover:hover(鼠标)→ .rail:not(:hover):悬停恢复与现状完全一致的完整侧栏
     (fixed 覆盖展开,不推挤内容,width 回 260px);
   · hover:none(触屏)→ .rail 恒为图标态+微标签(规避 tap 粘滞 hover 意外展开)。 */
@media (max-width: 1023.98px) and (hover: hover) {
  .rail:not(:hover) { width: 72px; }
}
@media (max-width: 1023.98px) and (hover: none) {
  .rail { width: 72px; }
}
@media (max-width: 1023.98px) and (hover: hover) {
  .rail:hover { width: 260px; box-shadow: 12px 0 32px rgba(0, 0, 0, .18); }
}

/* —— 折叠态内容规则(hover:hover 用 .rail:not(:hover),hover:none 用 .rail;两块声明一致) —— */
@media (max-width: 1023.98px) and (hover: hover) {
  .rail:not(:hover) .cluster-header-txt,
  .rail:not(:hover) .cluster-anchor-txt,
  .rail:not(:hover) .cluster-anchor-chev,
  .rail:not(:hover) .ns-cap,
  .rail:not(:hover) .nav-collapse-btn,
  .rail:not(:hover) .group-head,
  .rail:not(:hover) .ns-txt,
  .rail:not(:hover) .ns-arr,
  .rail:not(:hover) .ns-tile,
  .rail:not(:hover) .slab-txt { display: none; }
  .rail:not(:hover) .nav-item { flex-direction: column; gap: 2px; padding: 7px 2px; margin-left: 0; }
  .rail:not(:hover) .nav-item .material-symbols-outlined { text-align: center; }
  .rail:not(:hover) .nav-item__label { font-size: 9px; line-height: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .rail:not(:hover) .ns-main { justify-content: center; }
  .rail:not(:hover) .dock { flex-direction: column; align-items: stretch; }
  .rail:not(:hover) .dock > .grid { display: flex; flex-direction: column; }
  .rail:not(:hover) .cluster-slab { justify-content: center; }
}
@media (max-width: 1023.98px) and (hover: none) {
  .rail .cluster-header-txt,
  .rail .cluster-anchor-txt,
  .rail .cluster-anchor-chev,
  .rail .ns-cap,
  .rail .nav-collapse-btn,
  .rail .group-head,
  .rail .ns-txt,
  .rail .ns-arr,
  .rail .ns-tile,
  .rail .slab-txt { display: none; }
  .rail .nav-item { flex-direction: column; gap: 2px; padding: 7px 2px; margin-left: 0; }
  .rail .nav-item .material-symbols-outlined { text-align: center; }
  .rail .nav-item__label { font-size: 9px; line-height: 12px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
  .rail .ns-main { justify-content: center; }
  .rail .dock { flex-direction: column; align-items: stretch; }
  .rail .dock > .grid { display: flex; flex-direction: column; }
  .rail .cluster-slab { justify-content: center; }
}
@media (prefers-reduced-motion: reduce) {
  .sidenav-root { transition: none !important; }
}
```

- [ ] **Step 6: Run to verify pass**

Run: `npx vitest run src/components/layout/__tests__/SideNavBar.rail.test.js src/components/layout/__tests__/SideNavBar.nsband.test.js src/components/layout/__tests__/SideNavBar.bottom-dedup.test.js src/components/layout/__tests__/SideNavBar.home.test.js`
Expected: PASS(rail 新用例绿;既有 SideNavBar 契约不破)

- [ ] **Step 7: Commit**

```bash
git add src/components/layout/SideNavBar.vue src/components/layout/__tests__/SideNavBar.rail.test.js
git commit --author='aliangone <aliangone@gmail.com>' -m "feat(sidenav): <lg 图标栏 rail——图标+9px微标签+悬停覆盖展开(fixed不推挤),空ns跳/namespaces"
```

---

### Task 9: Footer + UpdateBanner 窄屏兜底

**Files:**
- Modify: `src/components/layout/AppLayout.vue:99-110`(footer)
- Modify: `src/components/layout/UpdateBanner.vue:24-28`
- Test: `src/components/layout/__tests__/UpdateBanner.test.js`(追加类断言)

- [ ] **Step 1: 追加失败断言到 UpdateBanner.test.js**

```js
test('横幅文本可截断不撑爆窄屏', () => {
  expect(wrapper.html()).toContain('min-w-0')
  expect(wrapper.html()).toContain('truncate')
})
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run src/components/layout/__tests__/UpdateBanner.test.js`
Expected: FAIL

- [ ] **Step 3: AppLayout footer**

`:100` 左组容器 `flex items-center gap-lg` → 加 `min-w-0`;`:103` 摘要 span 加 `min-w-0 truncate`(父级 div 同加 `min-w-0`);`:106` 右组容器加 `max-lg:hidden`。

- [ ] **Step 4: UpdateBanner**

`:24` 容器加 `min-w-0`;`:26` 文本 span 改 `class="min-w-0 truncate"`(内嵌 v-latest 的 font-mono span 保留,外层截断)。

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/components/layout/__tests__/UpdateBanner.test.js src/components/layout/__tests__/TopNavBar.test.js`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/layout/AppLayout.vue src/components/layout/UpdateBanner.vue src/components/layout/__tests__/UpdateBanner.test.js
git commit --author='aliangone <aliangone@gmail.com>' -m "fix(layout): footer <lg 隐藏右组+左组truncate;更新横幅文本截断兜底"
```

---

### Task 10: 真浏览器五档巡检 + 严重溢出修复(非 TDD,验收型)

**Files:**
- Modify: 巡检中发现的溢出文件(逐个判断,修「严重溢出」= 横向滚动/截断/重叠;美化记 backlog)

**Interfaces:**
- Consumes: Task 4–9 的壳层形态。登录前置:**需用户在自动化浏览器登录一次(或提供测试凭证)**;dev server `localhost:5173`。

- [ ] **Step 1: 启动/确认 dev server 与登录态**

playwright MCP 打开 `http://localhost:5173/`,若落登录页请用户登录。

- [ ] **Step 2: 五档 × 七页 DOM 度量**

对 `768/834/1024/1280/1440` 各 `browser_resize`,逐页(ClusterOverview、NamespaceOverview、Pods 列表、NsWorkloadDetail、Workbench、UserProfile、admin clusters)执行:

```js
// browser_evaluate:
() => {
  const doc = document.scrollingElement
  const bad = []
  if (doc.scrollWidth > doc.clientWidth + 1) bad.push(`page-overflow ${doc.scrollWidth}>${doc.clientWidth}`)
  for (const el of document.querySelectorAll('main *')) {
    const r = el.getBoundingClientRect()
    if (r.width > 1 && (r.right > doc.clientWidth + 8 || r.left < -8) && getComputedStyle(el).position !== 'fixed')
      bad.push(`${el.tagName}.${String(el.className).slice(0, 40)} right=${Math.round(r.right)}`)
  }
  return bad.slice(0, 12)
}
```

- [ ] **Step 3: 修复严重溢出 + 每处一个 commit**

每修复一处:`npx vitest run <相关测试>` 全绿后 `git commit --author='aliangone <aliangone@gmail.com>' -m "fix(responsive): <页面> <档位> <症状>——<手段>"`。美化性/低频问题记入本文件末尾 backlog 节,不修。

- [ ] **Step 4: 桌面回归红线核对**

1280/1440 档与改动前对照(截图对比):顶栏/侧栏/底栏形态必须逐像素一致。

---

### Task 11: 全量门禁 + 手测清单 + 收尾

- [ ] **Step 1: 四门禁全绿**

```bash
npm test          # 服务器+纯逻辑+单测(WorkbenchChat 并行串扰偶发,单跑复核即可)
npm run typecheck
npm run i18n:check
npx vitest run src/components/layout src/styles src/composables
```

- [ ] **Step 2: 手测清单核对(iPad 真机或 DevTools 模拟)**

1. iPad 竖屏 768×1024:图标栏+微标签、图标档顶栏、搜索弹层开关/搜索/选中跳转、集群/ns 下拉完整可见、Footer 单组。
2. iPad 横屏 1180×820:紧凑档全元素、侧栏 260px、搜索内联。
3. 桌面 1440:与改动前逐像素一致。
4. 主题:选「自动」,改系统时间跨 19:00/07:00(或临时改 DARK_FROM_HOUR 冒烟后还原)→ ≤60s 自动翻转;19:00–07:00 间刷新无首帧闪白;存量 localStorage 'system' 打开后显示为自动。
5. 侧栏悬停:鼠标移入展开 260px、移出收回;iPad 触屏点图标直达。

- [ ] **Step 3: 合并(按用户 worktree 硬约束)**

main 无并行推进时:`git checkout main && git merge --no-ff worktree-feat-responsive-theme-timer`(**合并前必核 `git log main..HEAD` 构成**,防混入提交;main 被并行推进则先 rebase 分支再重跑全部门禁)。

---

## Backlog(巡检发现但不修,移交后续)

- (Task 10 填写:低频页面/美化性重排项)
