# 图表美化(ECharts + MD3)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 Apache ECharts(按需引入)升级折线/环形/表盘三类图表,MD3 色板单一来源化并修复 18 处 `var(--md-sys-color-*)` 未定义 bug,ProgressBar 渐变增强。

**Architecture:** 薄基座 `EChart.vue`(init/resize/dispose)→ 业务组件(AreaLineChart/RingGauge/StatusSummaryCard);option 构建抽为纯函数 `src/lib/chart-options.js`(node 零依赖可测);色板唯一来源 `src/styles/md-palette.js`(tailwind 展开 + `:root` CSS 变量注入 + 图表取色)。视图数据流(session 采样)不动,只换展示层。

**Tech Stack:** Vue 3 `<script setup>` + Tailwind(MD3 token)、echarts@^6.1.0(`echarts/core` 树摇 + SVGRenderer)、vitest(happy-dom)+ scripts/test.mjs 自研运行器。

**Spec:** `docs/superpowers/specs/2026-08-14-chart-beautification-design.md`

## Global Constraints

- 新增依赖仅限 `echarts@^6.1.0`(runtime,已裁决登记 CLAUDE.md);**禁止其它任何新依赖**。
- MD3 色值唯一来源 `src/styles/md-palette.js`;tailwind.config.js、图表 option、`:root` 变量全部由它派生,hex 不得散落第二处。
- 新图表组件的颜色 prop 一律传 **palette token 名**(如 `'primary'`/`'secondary'`/`'error'`),**禁止** `var(--md-sys-color-…)` 字符串(历史 bug 根因)。
- i18n **不新增键**:图表空态复用已有 `common.noData`(en "No data found" / zh "暂无数据");状态名 Running/Pending/Failed/Other 照旧英文直出(与现状一致)。改动涉及文案时跑 `npm run i18n:check`。
- 测试分层:纯逻辑(builder/palette)追加进 `scripts/test.mjs`(node 运行器);组件测试放 `src/components/__tests__/*.test.js`(vitest,匹配现有 include 规则 `src/**/*.test.js`)。每任务以 commit 结束,提交信息用仓库惯例(`feat(chart): …` 中文描述)。
- 现有阈值语义不变:>80 error / >60 tertiary(amber)/ 其余 primary。
- 不动 StatusChip;不动视图里的采样 timer/refetch 逻辑。
- 工作目录:worktree `feat-chart-beautification`(分支 `worktree-feat-chart-beautification`)。

---

### Task 1: echarts 依赖 + md-palette 单一来源 + tailwind 归一 + `:root` 变量注入(修 var() bug)

**Files:**
- Create: `src/styles/md-palette.js`
- Modify: `package.json`(npm i 写入)、`tailwind.config.js:1-73`、`src/main.js:15`、`CLAUDE.md`(例外表)
- Test: `scripts/test.mjs`(追加)

**Interfaces:**
- Produces(Task 2/3/7 依赖):
  - `MD_PALETTE: Record<string,string>` — 键为 tailwind 风格 kebab token(如 `'primary-container'`),值为 `#rrggbb`。
  - `tokenHex(token: string): string` — token→hex,未知 token 回落 `MD_PALETTE.primary`。
  - `paletteVarsCss(): string` — 形如 `:root{--md-sys-color-primary:#006c49;…}`(全部 token 一并注入)。
  - `installPaletteVars(doc?: Document): void` — 幂等注入 `<style id="md-palette-vars">` 到 head。

- [ ] **Step 1: 安装依赖并登记**

```bash
npm install echarts@^6.1.0
```

CLAUDE.md 依赖例外表(「依赖政策」节)追加一行:

```markdown
| `echarts` | 运行时(dependencies) | 图表美化:折线/环形/表盘。`echarts/core` 按需引入(树摇,gzip ≈100KB),tooltip/渐变/过渡动画开箱即用。 | 2026-08-14 图表美化设计 `docs/superpowers/specs/2026-08-14-chart-beautification-design.md` |
```

- [ ] **Step 2: 先写失败测试**(追加到 `scripts/test.mjs` 末尾「--- 汇总 ---」注释之前)

```js
// --- 图表美化:MD3 色板单一来源 + var() 未定义 bug 修复 ---
import { MD_PALETTE, paletteVarsCss, installPaletteVars, tokenHex } from '../src/styles/md-palette.js'

test('MD_PALETTE: 必备 token 齐全且为 6 位 hex', () => {
  const need = ['primary', 'secondary', 'tertiary', 'tertiary-container', 'error', 'status-failed',
    'on-surface', 'on-surface-variant', 'outline', 'outline-variant',
    'surface-container-lowest', 'surface-container-high', 'primary-container', 'secondary-container']
  for (const k of need) assert.ok(/^#[0-9a-f]{6}$/i.test(MD_PALETTE[k] || ''), `token ${k} 缺失或非 #rrggbb`)
})
test('paletteVarsCss: :root 注入且含全仓实际使用的 4 个 --md-sys-color-* 变量', () => {
  const css = paletteVarsCss()
  assert.ok(css.startsWith(':root{'), '应为 :root{...} 形式')
  for (const v of ['--md-sys-color-primary', '--md-sys-color-secondary', '--md-sys-color-tertiary-container', '--md-sys-color-error']) {
    assert.ok(css.includes(v), `缺少 ${v}`)
  }
  assert.ok(css.includes(`--md-sys-color-primary:${MD_PALETTE.primary};`))
})
test('tokenHex: 已知 token→hex;未知/空回落 primary', () => {
  assert.equal(tokenHex('secondary'), MD_PALETTE.secondary)
  assert.equal(tokenHex('nope'), MD_PALETTE.primary)
  assert.equal(tokenHex(), MD_PALETTE.primary)
})
test('installPaletteVars: 幂等(重复调用不重复注入)', () => {
  let appended = 0
  const fakeDoc = { getElementById: () => (appended ? {} : null), head: { appendChild: () => { appended++ } }, createElement: () => ({ textContent: '' }) }
  installPaletteVars(fakeDoc)
  installPaletteVars(fakeDoc)
  assert.equal(appended, 1)
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `node scripts/test.mjs 2>&1 | tail -5`
Expected: FAIL —`Cannot find module '../src/styles/md-palette.js'`

- [ ] **Step 4: 创建 `src/styles/md-palette.js`**

hex 值**逐字照抄** `tailwind.config.js` 12-67 行(surface/primary/secondary/ tertiary/error/status 各族 + outline 族),键名保持 kebab:

```js
// MD3 色板唯一来源:tailwind.config.js(展开进 colors)、:root CSS 变量注入(installPaletteVars)、
// ECharts 图表主题(src/lib/echarts.js、src/lib/chart-options.js)都从本文件取色。
// 背景:历史上 var(--md-sys-color-*) 在 18 处被使用却从未定义,图表/表格颜色静默回落为黑——
// 本模块 + main.js 的 installPaletteVars() 一并修复。修改色值只改这里。
export const MD_PALETTE = {
  // Surface
  'surface': '#f8f9ff',
  'surface-dim': '#cbdbf5',
  'surface-bright': '#f8f9ff',
  'surface-container-lowest': '#ffffff',
  'surface-container-low': '#eff4ff',
  'surface-container': '#e5eeff',
  'surface-container-high': '#dce9ff',
  'surface-container-highest': '#d3e4fe',
  'on-surface': '#0b1c30',
  'on-surface-variant': '#3c4a42',
  'inverse-surface': '#213145',
  'inverse-on-surface': '#eaf1ff',
  'outline': '#6c7a71',
  'outline-variant': '#bbcabf',
  'surface-tint': '#006c49',
  // Primary (Emerald)
  'primary': '#006c49',
  'on-primary': '#ffffff',
  'primary-container': '#10b981',
  'on-primary-container': '#00422b',
  'inverse-primary': '#4edea3',
  'primary-fixed': '#6ffbbe',
  'primary-fixed-dim': '#4edea3',
  'on-primary-fixed': '#002113',
  'on-primary-fixed-variant': '#005236',
  // Secondary (Indigo)
  'secondary': '#4648d4',
  'on-secondary': '#ffffff',
  'secondary-container': '#6063ee',
  'on-secondary-container': '#fffbff',
  'secondary-fixed': '#e1e0ff',
  'secondary-fixed-dim': '#c0c1ff',
  'on-secondary-fixed': '#07006c',
  'on-secondary-fixed-variant': '#2f2ebe',
  // Tertiary (Amber)
  'tertiary': '#855300',
  'on-tertiary': '#ffffff',
  'tertiary-container': '#e29100',
  'on-tertiary-container': '#523200',
  'tertiary-fixed': '#ffddb8',
  'tertiary-fixed-dim': '#ffb95f',
  'on-tertiary-fixed': '#2a1700',
  'on-tertiary-fixed-variant': '#653e00',
  // Error
  'error': '#ba1a1a',
  'on-error': '#ffffff',
  'error-container': '#ffdad6',
  'on-error-container': '#93000a',
  // Status
  'status-running': '#10b981',
  'status-pending': '#f59e0b',
  'status-failed': '#ef4444',
  'status-succeeded': '#3b82f6',
  'status-unknown': '#6b7280',
}

// token → hex;未知 token 回落 primary(宁可用主题绿也不用黑/undefined)
export function tokenHex(token) {
  return MD_PALETTE[token] || MD_PALETTE.primary
}

// 生成 :root{--md-sys-color-<token>:<hex>;…}(全部 token 注入,未来消费零成本)
export function paletteVarsCss() {
  const body = Object.entries(MD_PALETTE).map(([k, v]) => `--md-sys-color-${k}:${v};`).join('')
  return `:root{${body}}`
}

// 幂等注入到 document.head(main.js 启动时调用一次)
export function installPaletteVars(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || doc.getElementById('md-palette-vars')) return
  const style = doc.createElement('style')
  style.id = 'md-palette-vars'
  style.textContent = paletteVarsCss()
  doc.head.appendChild(style)
}
```

- [ ] **Step 5: tailwind.config.js 改为从 palette 展开(行为等价)**

`tailwind.config.js` 顶部 import 区加一行,`colors:` 里删除 surface/primary/secondary/tertiary/error/status 六段字面量(12-67 行),换成展开(保留 code-* 四键与注释):

```js
import { codeTheme } from './src/styles/code-theme.js'
import { MD_PALETTE } from './src/styles/md-palette.js'
// …
      colors: {
        // MD3 全套色板唯一来源:src/styles/md-palette.js(图表/:root 变量同源)
        ...MD_PALETTE,
        // 暗底代码/终端主题(与 xterm/prism 共用 src/styles/code-theme.js,单一来源)
        'code-surface': codeTheme.surface,
        'on-code-surface': codeTheme.onSurface,
        'code-surface-selection': codeTheme.selection,
        'code-surface-dim': codeTheme.dim,
      },
```

- [ ] **Step 6: main.js 启动注入**(在 `import './styles/main.css'` 之后加)

```js
import { installPaletteVars } from './styles/md-palette'
installPaletteVars()
```

- [ ] **Step 7: 跑测试确认通过**

Run: `node scripts/test.mjs 2>&1 | tail -3`
Expected: `✓ …全部通过`(新增 4 例 ✓)

- [ ] **Step 8: 等价性双保险 + commit**

Run: `npm run build 2>&1 | tail -3`(tailwind 展开无语法错)
Run: `git diff tailwind.config.js` 人工确认删掉的键全部在 MD_PALETTE 中。

```bash
git add package.json package-lock.json src/styles/md-palette.js tailwind.config.js src/main.js CLAUDE.md scripts/test.mjs
git commit -m "feat(chart): echarts 依赖 + MD3 色板单一来源(修 18 处 var() 未定义)+ :root 注入"
```

---

### Task 2: echarts 注册入口 + EChart.vue 基座

**Files:**
- Create: `src/lib/echarts.js`、`src/components/common/EChart.vue`
- Test: `src/components/__tests__/EChart.test.js`

**Interfaces:**
- Produces(Task 4/5/6 依赖):
  - `src/lib/echarts.js` 具名导出 `echarts`(echarts/core 实例,已 `use()` 完毕并 `registerTheme('md3', …)`)。
  - `EChart.vue` props:`option: Object`(必填)、`height: Number`(必填,px);行为:挂载 init→setOption,option 变更 setOption(merge),卸载 dispose,ResizeObserver 自适应。

- [ ] **Step 1: 写失败测试 `src/components/__tests__/EChart.test.js`**

```js
// EChart 基座生命周期:init(md3+svg)/setOption/watch/dispose 全部经 mock 的 echarts 断言,
// 不在 happy-dom 里真渲染(真实渲染由 build + 手工 QA 覆盖)。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const { setOptionMock, resizeMock, disposeMock } = vi.hoisted(() => ({
  setOptionMock: vi.fn(), resizeMock: vi.fn(), disposeMock: vi.fn(),
}))
vi.mock('@/lib/echarts', () => ({
  echarts: {
    use: vi.fn(), registerTheme: vi.fn(),
    init: vi.fn(() => ({ setOption: setOptionMock, resize: resizeMock, dispose: disposeMock })),
  },
}))
import { echarts } from '@/lib/echarts'
import EChart from '../common/EChart.vue'

test('挂载: init(el, md3, svg) + setOption(option);容器高度 = height', () => {
  setOptionMock.mockClear()
  const w = mount(EChart, { props: { option: { series: [] }, height: 64 } })
  expect(echarts.init).toHaveBeenCalledTimes(1)
  const [, theme, cfg] = echarts.init.mock.calls[0]
  expect(theme).toBe('md3')
  expect(cfg).toEqual({ renderer: 'svg' })
  expect(setOptionMock).toHaveBeenCalledWith({ series: [] })
  expect(w.element.style.height).toBe('64px')
})

test('option 变更 → 增量 setOption;卸载 → dispose', async () => {
  setOptionMock.mockClear(); disposeMock.mockClear()
  const w = mount(EChart, { props: { option: { a: 1 }, height: 32 } })
  await w.setProps({ option: { a: 2 } })
  expect(setOptionMock).toHaveBeenLastCalledWith({ a: 2 })
  w.unmount()
  expect(disposeMock).toHaveBeenCalledTimes(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/EChart.test.js`
Expected: FAIL —`Cannot find module '@/lib/echarts'`

- [ ] **Step 3: 创建 `src/lib/echarts.js`**

```js
// ECharts 按需注册唯一入口 + MD3 主题注册。所有图表组件只 import 本文件(echarts/core 树摇生效)。
// 只引 Line/Pie/Gauge + Tooltip/Grid/MarkLine + SVGRenderer——数据量 ≤30 点,SVG 比 canvas 更清晰、
// 小尺寸不糊、happy-dom 可挂载。新增图表类型时在此补注册,勿在组件里直接 import 'echarts'。
import * as echarts from 'echarts/core'
import { LineChart, PieChart, GaugeChart } from 'echarts/charts'
import { GridComponent, TooltipComponent, MarkLineComponent } from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'
import { MD_PALETTE } from '@/styles/md-palette.js'

echarts.use([LineChart, PieChart, GaugeChart, GridComponent, TooltipComponent, MarkLineComponent, SVGRenderer])

// MD3 主题:字体栈与 tailwind 一致;tooltip 走 surface-container-lowest 白底圆角卡片。
echarts.registerTheme('md3', {
  color: [MD_PALETTE.primary, MD_PALETTE.secondary, MD_PALETTE['tertiary-container'], MD_PALETTE.error],
  textStyle: {
    fontFamily: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif",
    color: MD_PALETTE['on-surface-variant'],
  },
  tooltip: {
    backgroundColor: MD_PALETTE['surface-container-lowest'],
    borderColor: MD_PALETTE['outline-variant'],
    borderWidth: 1,
    padding: [6, 10],
    textStyle: { color: MD_PALETTE['on-surface'], fontSize: 12 },
    extraCssText: 'border-radius:8px;box-shadow:0 4px 12px rgba(11,28,48,.12);',
  },
  animationDuration: 600,
  animationDurationUpdate: 450,
  animationEasing: 'cubicOut',
  animationEasingUpdate: 'cubicInOut',
})

export { echarts }
```

- [ ] **Step 4: 创建 `src/components/common/EChart.vue`**

```vue
<script setup>
// ECharts 薄基座:业务图表组件不直接碰 echarts,只经本组件。
// 职责:init(md3 主题 + SVG)/ ResizeObserver 自适应 / option 变更增量 setOption / 卸载 dispose。
// merge 模式 setOption 配合 series id —— 滚动窗口更新走数据过渡动画而非整图重绘。
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { echarts } from '@/lib/echarts'

const props = defineProps({
  option: { type: Object, required: true },
  height: { type: Number, required: true },
})
const el = ref(null)
let chart = null
let ro = null

function onWinResize() { if (chart) chart.resize() }

onMounted(() => {
  chart = echarts.init(el.value, 'md3', { renderer: 'svg' })
  chart.setOption(props.option)
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { if (chart) chart.resize() })
    ro.observe(el.value)
  } else {
    window.addEventListener('resize', onWinResize)
  }
})

watch(() => props.option, (opt) => { if (chart) chart.setOption(opt) }, { deep: true })

onBeforeUnmount(() => {
  if (ro) { ro.disconnect(); ro = null }
  window.removeEventListener('resize', onWinResize)
  if (chart) { chart.dispose(); chart = null }
})
</script>

<template>
  <div ref="el" class="w-full" :style="{ height: height + 'px' }"></div>
</template>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/EChart.test.js`
Expected: 2 passed

- [ ] **Step 6: 冒烟验证树摇入口真实可用**

Run: `node -e "import('./src/lib/echarts.js').then(m => console.log('ok', typeof m.echarts.init, m.echarts.getVersion ? m.echarts.getVersion() : ''))"`
Expected: `ok function 6.1.0`(若该 node 版本不支持 `@` 别名解析,则跳过本步——vitest/build 会覆盖,不算失败)。

- [ ] **Step 7: Commit**

```bash
git add src/lib/echarts.js src/components/common/EChart.vue src/components/__tests__/EChart.test.js
git commit -m "feat(chart): EChart 薄基座 + echarts 按需注册入口(md3 主题/SVG/自适应)"
```

---

### Task 3: chart-options 纯构建器(node 可测)

**Files:**
- Create: `src/lib/chart-options.js`
- Test: `scripts/test.mjs`(追加)

**Interfaces:**
- Consumes: `MD_PALETTE`(Task 1)。
- Produces(Task 4/5/6/7 依赖,签名固定):
  - `tokenHex(token)`(re-export 自 md-palette)
  - `hexToRgba(hex: string, alpha: number): string`
  - `relTimeLabel(indexFromEnd: number, intervalSec: number): string` — `'0s'` / `'-20s'`
  - `buildAreaLineOption({ series, color, unit, refLines, spark, smooth, sampleIntervalSec })` — `color`/`refLines[].color` 均为 palette token 名;refLines 进 `series[0].markLine`(spark 模式不带);y 轴 max = max(1, series, refLine 值)。
  - `STATUS_COLORS: { Running:'status-running', Pending:'status-pending', Failed:'status-failed', Succeeded:'status-succeeded', Other:'on-surface-variant' }`
  - `buildStatusSegments(pods: {status}[]) => [{ status, count }]` — 只保留 count>0 的 Running/Pending/Failed,其余全部归 `Other`。
  - `buildDonutOption(segments)` — 圆角扇区、白描边、item tooltip `Running: 3 (75%)`。
  - `buildGaugeOption(value: number|null)` — 0-100 夹取;>80 error / >60 tertiary-container / 其余 primary 渐变;null → 灰环 track、value 0。

- [ ] **Step 1: 写失败测试**(追加到 `scripts/test.mjs`,与 Task 1 的 import 区相邻)

```js
// --- 图表美化:ECharts option 纯构建器 ---
import { hexToRgba, relTimeLabel, buildAreaLineOption, buildDonutOption, buildGaugeOption, buildStatusSegments, STATUS_COLORS } from '../src/lib/chart-options.js'

test('hexToRgba: 6 位 hex → rgba;非法回落黑', () => {
  assert.equal(hexToRgba('#006c49', 0.35), 'rgba(0,108,73,0.35)')
  assert.equal(hexToRgba('nonsense', 0.5), 'rgba(0,0,0,0.5)')
})
test('relTimeLabel: 最新样本 0s、往前 -Ns', () => {
  assert.equal(relTimeLabel(0, 10), '0s')
  assert.equal(relTimeLabel(2, 10), '-20s')
  assert.equal(relTimeLabel(1, 30), '-30s')
})
test('buildAreaLineOption: 平滑线 + 面积渐变(0.35→0.02)+ 相对时间 tooltip', () => {
  const opt = buildAreaLineOption({ series: [10, 20, 15], color: 'primary', unit: '%' })
  const s = opt.series[0]
  assert.equal(s.type, 'line')
  assert.equal(s.smooth, true)
  assert.equal(s.symbol, 'none')
  assert.equal(s.areaStyle.color.colorStops[0].color, 'rgba(0,108,73,0.35)')
  assert.equal(s.areaStyle.color.colorStops[1].color, 'rgba(0,108,73,0.02)')
  assert.equal(opt.tooltip.formatter([{ dataIndex: 0, value: 10 }]), '-20s<br/>10%')
  assert.equal(opt.tooltip.formatter([{ dataIndex: 2, value: 15 }]), '0s<br/>15%')
  assert.ok(Array.isArray(opt.xAxis.data) && opt.xAxis.data.length === 3)
})
test('buildAreaLineOption: refLines 进 markLine 虚线、token 色已解析、计入 y 轴 max', () => {
  const opt = buildAreaLineOption({ series: [10, 12], color: 'primary', refLines: [
    { label: 'requests', value: 250, color: 'secondary' },
    { label: 'limits', value: 400, color: 'error' },
  ] })
  assert.equal(opt.yAxis.max, 400)
  assert.deepEqual(opt.series[0].markLine.data.map(d => d.yAxis), [250, 400])
  assert.equal(opt.series[0].markLine.data[0].lineStyle.type, 'dashed')
  assert.equal(opt.series[0].markLine.data[0].lineStyle.color, MD_PALETTE.secondary)
  assert.equal(opt.series[0].markLine.data[1].lineStyle.color, MD_PALETTE.error)
  assert.equal(opt.series[0].markLine.symbol, 'none')
})
test('buildAreaLineOption: spark 模式无网格线、无 markLine、贴边 grid', () => {
  const opt = buildAreaLineOption({ series: [1, 2, 3], spark: true, refLines: [{ label: 'x', value: 9, color: 'secondary' }] })
  assert.equal(opt.yAxis.splitLine.show, false)
  assert.equal(opt.series[0].markLine, undefined)
  assert.deepEqual(opt.grid, { left: 0, right: 0, top: 2, bottom: 0 })
})
test('buildStatusSegments: 三态计数、其余归 Other(count>0 才保留)', () => {
  const pods = [{ status: 'Running' }, { status: 'Running' }, { status: 'Pending' }, { status: 'Succeeded' }, { status: 'Unknown' }, {}]
  assert.deepEqual(buildStatusSegments(pods), [
    { status: 'Running', count: 2 },
    { status: 'Pending', count: 1 },
    { status: 'Other', count: 3 },
  ])
  assert.deepEqual(buildStatusSegments([]), [])
  assert.deepEqual(buildStatusSegments(), [])
})
test('buildDonutOption: 段色按 STATUS_COLORS 解析、圆角扇区、tooltip 文案', () => {
  const opt = buildDonutOption([{ status: 'Running', count: 3 }, { status: 'Failed', count: 1 }])
  assert.equal(opt.series[0].data[0].name, 'Running')
  assert.equal(opt.series[0].data[0].itemStyle.color, MD_PALETTE['status-running'])
  assert.equal(opt.series[0].data[1].itemStyle.color, MD_PALETTE['status-failed'])
  assert.ok(opt.series[0].itemStyle.borderRadius > 0)
  assert.equal(opt.series[0].label.show, false)
  assert.equal(opt.tooltip.formatter({ name: 'Running', value: 3, percent: 75 }), 'Running: 3 (75%)')
})
test('buildGaugeOption: 阈值三档色 + null 灰环空态 + 0-100 夹取 + 组件全隐', () => {
  const g = (v) => buildGaugeOption(v).series[0]
  assert.equal(g(90).progress.itemStyle.color.colorStops[0].color, MD_PALETTE.error)
  assert.equal(g(70).progress.itemStyle.color.colorStops[0].color, MD_PALETTE['tertiary-container'])
  assert.equal(g(30).progress.itemStyle.color.colorStops[0].color, MD_PALETTE.primary)
  assert.equal(g(null).progress.itemStyle.color.colorStops[0].color, MD_PALETTE['surface-container-high'])
  assert.equal(g(null).data[0].value, 0)
  assert.equal(g(150).data[0].value, 100)
  assert.equal(g(-5).data[0].value, 0)
  assert.equal(g(50).pointer.show, false)
  assert.equal(g(50).axisLabel.show, false)
  assert.equal(g(50).detail.show, false)
})
test('STATUS_COLORS 常量形状', () => {
  assert.equal(STATUS_COLORS.Running, 'status-running')
  assert.equal(STATUS_COLORS.Other, 'on-surface-variant')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test.mjs 2>&1 | tail -5`
Expected: FAIL —`Cannot find module '../src/lib/chart-options.js'`

- [ ] **Step 3: 创建 `src/lib/chart-options.js`**

```js
// ECharts option 纯函数构建器:不 import echarts、不碰 DOM(node 零依赖可测,scripts/test.mjs 覆盖)。
// 颜色一律收 palette token 名(如 'primary'),由 tokenHex 解析——杜绝 var() 字符串。
import { MD_PALETTE, tokenHex } from '../styles/md-palette.js'

export { tokenHex }

export function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
  if (!m) return `rgba(0,0,0,${alpha})`
  const n = parseInt(m[1], 16)
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`
}

// 相对时间标签:最新样本 = '0s',往前第 n 档 = '-n*interval s'(语言中立,免 i18n)
export function relTimeLabel(indexFromEnd, intervalSec) {
  const s = Math.max(0, indexFromEnd) * intervalSec
  return s === 0 ? '0s' : `-${s}s`
}

// 平滑面积折线图(MiniChart 的 ECharts 升级版)。
// series: number[];color/refLines[].color: palette token;refLines: [{label,value,color}]。
// spark=true → KPI 卡迷你模式:无网格、无 markLine、贴边。
export function buildAreaLineOption({ series = [], color = 'primary', unit = '', refLines = [], spark = false, smooth = true, sampleIntervalSec = 10 } = {}) {
  const line = tokenHex(color)
  const values = series.filter(v => typeof v === 'number' && !isNaN(v))
  const maxVal = Math.max(1, ...values, ...refLines.map(r => Number(r.value) || 0))
  const len = series.length
  const option = {
    animationDurationUpdate: 400,
    grid: spark ? { left: 0, right: 0, top: 2, bottom: 0 } : { left: 4, right: 4, top: 8, bottom: 4 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params
        const v = p.value
        return `${relTimeLabel(len - 1 - p.dataIndex, sampleIntervalSec)}<br/>${v == null ? '—' : v}${unit}`
      },
    },
    xAxis: { type: 'category', boundaryGap: false, show: false, data: series.map((_, i) => i) },
    yAxis: {
      type: 'value', max: maxVal,
      axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: spark ? { show: false } : { lineStyle: { color: hexToRgba(MD_PALETTE['outline-variant'], 0.35), width: 1 } },
    },
    series: [{
      id: 'main', type: 'line', smooth, symbol: 'none', data: series,
      lineStyle: { width: 2, color: line, cap: 'round' },
      areaStyle: {
        color: {
          type: 'linear', x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: hexToRgba(line, 0.35) },
            { offset: 1, color: hexToRgba(line, 0.02) },
          ],
        },
      },
      emphasis: { focus: 'series' },
    }],
  }
  if (!spark && refLines.length) {
    option.series[0].markLine = {
      silent: true, symbol: 'none', label: { show: false },
      data: refLines.map(r => ({
        yAxis: Number(r.value) || 0,
        lineStyle: { type: 'dashed', width: 1, color: tokenHex(r.color) },
      })),
    }
  }
  return option
}

// Pod 状态 → palette token(NsPods 环形图与图例共用)
export const STATUS_COLORS = {
  Running: 'status-running',
  Pending: 'status-pending',
  Failed: 'status-failed',
  Succeeded: 'status-succeeded',
  Other: 'on-surface-variant',
}

// pods → [{status,count}]:Running/Pending/Failed 保留(count>0),其余(Succeeded/Unknown/缺状态)全归 Other
export function buildStatusSegments(pods = []) {
  const counts = { Running: 0, Pending: 0, Failed: 0 }
  let other = 0
  for (const p of pods) {
    const st = p && p.status
    if (st === 'Running' || st === 'Pending' || st === 'Failed') counts[st]++
    else other++
  }
  const segs = ['Running', 'Pending', 'Failed'].map(k => ({ status: k, count: counts[k] })).filter(s => s.count > 0)
  if (other > 0) segs.push({ status: 'Other', count: other })
  return segs
}

// 环形分布图(donut):圆角扇区 + 卡片底色描边(分段分离感)
export function buildDonutOption(segments = []) {
  return {
    tooltip: { trigger: 'item', formatter: (p) => `${p.name}: ${p.value} (${p.percent}%)` },
    series: [{
      id: 'donut', type: 'pie', radius: ['62%', '88%'], center: ['50%', '50%'],
      avoidLabelOverlap: false, label: { show: false }, labelLine: { show: false },
      itemStyle: { borderRadius: 5, borderColor: MD_PALETTE['surface-container-lowest'], borderWidth: 2 },
      data: segments.map(s => ({ name: s.status, value: s.count, itemStyle: { color: tokenHex(STATUS_COLORS[s.status]) } })),
    }],
  }
}

// 环形表盘(ClusterOverview 节点卡 CPU 环的 ECharts 升级版):整环、渐变进度、roundCap。
// value: 0-100(自动夹取);null → 灰环空态(中心 HTML 叠加显示 '—')。
export function buildGaugeOption(value) {
  const v = (typeof value === 'number' && !isNaN(value)) ? Math.min(100, Math.max(0, value)) : null
  const color = v == null ? MD_PALETTE['surface-container-high']
    : v > 80 ? MD_PALETTE.error
    : v > 60 ? MD_PALETTE['tertiary-container']
    : MD_PALETTE.primary
  return {
    series: [{
      id: 'gauge', type: 'gauge', startAngle: 90, endAngle: -270, radius: '100%', center: ['50%', '50%'],
      progress: {
        show: true, width: 7, roundCap: true,
        itemStyle: {
          color: {
            type: 'linear', x: 0, y: 0, x2: 1, y2: 1,
            colorStops: [{ offset: 0, color }, { offset: 1, color: hexToRgba(color, 0.55) }],
          },
        },
      },
      axisLine: { roundCap: true, lineStyle: { width: 7, color: [[1, hexToRgba(MD_PALETTE['outline-variant'], 0.4)]] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { show: false }, anchor: { show: false }, detail: { show: false },
      data: [{ value: v == null ? 0 : v }],
    }],
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test.mjs 2>&1 | tail -3`
Expected: 全部通过(新增 9 例 ✓)

- [ ] **Step 5: Commit**

```bash
git add src/lib/chart-options.js scripts/test.mjs
git commit -m "feat(chart): option 纯构建器(面积线/环形/表盘/状态分段,node 可测)"
```

---

### Task 4: AreaLineChart 组件

**Files:**
- Create: `src/components/common/AreaLineChart.vue`
- Test: `src/components/__tests__/AreaLineChart.test.js`

**Interfaces:**
- Consumes: `EChart.vue`(Task 2)、`buildAreaLineOption`/`tokenHex`(Task 3)。
- Produces(Task 8/9 依赖)props:`series: number[]`、`color: string`(token,默认 `'primary'`)、`unit: string`、`height: number`(默认 64)、`refLines: [{label,value,color}]`(color 为 token)、`spark: boolean`、`smooth: boolean`(默认 true)、`sampleIntervalSec: number`(默认 10)。series 有效值 <2 → 空态(`common.noData`)。

- [ ] **Step 1: 写失败测试 `src/components/__tests__/AreaLineChart.test.js`**

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { setOptionMock } = vi.hoisted(() => ({ setOptionMock: vi.fn() }))
vi.mock('@/lib/echarts', () => ({
  echarts: { use: vi.fn(), registerTheme: vi.fn(), init: vi.fn(() => ({ setOption: setOptionMock, resize: vi.fn(), dispose: vi.fn() })) },
}))
import AreaLineChart from '../common/AreaLineChart.vue'

function mountChart(props) {
  return mount(AreaLineChart, { props, global: { plugins: [i18n] } })
}

test('series≥2: setOption 收到渐变/线色(token→hex 已解析)', () => {
  setOptionMock.mockClear()
  const w = mountChart({ series: [1, 2, 3], color: 'secondary', height: 48 })
  expect(setOptionMock).toHaveBeenCalledTimes(1)
  const opt = setOptionMock.mock.calls[0][0]
  expect(opt.series[0].lineStyle.color).toBe('#4648d4')
  expect(opt.series[0].areaStyle.color.colorStops[0].color).toBe('rgba(70,72,212,0.35)')
  w.unmount()
})

test('series<2: 空态文案 common.noData,不渲染图表', () => {
  const w = mountChart({ series: [1], height: 48 })
  expect(w.text()).toContain(i18n.global.t('common.noData'))
})

test('refLines footer: label + value + unit,chip 背景为 token 色', () => {
  const w = mountChart({ series: [1, 2], refLines: [{ label: 'requests', value: 250, color: 'secondary' }], unit: 'm' })
  expect(w.text()).toContain('requests 250m')
  // DOM 可能把 hex 序列化为 rgb(),两者都接受
  const chip = w.findAll('span').find(s => (s.attributes('style') || '').includes('background'))
  expect(chip.attributes('style')).toMatch(/background:\s*(#4648d4|rgb\(70,\s*72,\s*212\))/)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/AreaLineChart.test.js`
Expected: FAIL —`Cannot find module '../common/AreaLineChart.vue'`

- [ ] **Step 3: 创建 `src/components/common/AreaLineChart.vue`**

```vue
<script setup>
// 平滑面积折线图:MiniChart 的 ECharts 升级(tooltip/渐变/数据过渡动画)。
// 颜色与 refLines 颜色都传 palette token 名('primary'/'secondary'/'error'…),杜绝 var() 未定义坑。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EChart from './EChart.vue'
import { buildAreaLineOption, tokenHex } from '@/lib/chart-options'

const props = defineProps({
  series: { type: Array, default: () => [] },
  color: { type: String, default: 'primary' },
  unit: { type: String, default: '' },
  height: { type: Number, default: 64 },
  refLines: { type: Array, default: () => [] },
  spark: { type: Boolean, default: false },
  smooth: { type: Boolean, default: true },
  sampleIntervalSec: { type: Number, default: 10 },
})
const { t } = useI18n()
const empty = computed(() => props.series.filter(v => typeof v === 'number' && !isNaN(v)).length < 2)
const option = computed(() => buildAreaLineOption({
  series: props.series, color: props.color, unit: props.unit, refLines: props.refLines,
  spark: props.spark, smooth: props.smooth, sampleIntervalSec: props.sampleIntervalSec,
}))
</script>

<template>
  <div>
    <div v-if="empty" class="flex items-center justify-center text-body-sm text-on-surface-variant/60" :style="{ height: height + 'px' }">
      {{ t('common.noData') }}
    </div>
    <EChart v-else :option="option" :height="height" />
    <!-- refLines 图例 footer(沿用 MiniChart 的 HTML 形式) -->
    <div v-if="refLines.length" class="flex flex-wrap gap-sm mt-xs">
      <span v-for="(r, i) in refLines" :key="i" class="flex items-center gap-0.5 text-xs text-on-surface-variant">
        <span class="w-2.5 h-0.5 rounded" :style="{ background: tokenHex(r.color) }"></span>{{ r.label }} {{ r.value }}{{ unit }}
      </span>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/AreaLineChart.test.js`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/components/common/AreaLineChart.vue src/components/__tests__/AreaLineChart.test.js
git commit -m "feat(chart): AreaLineChart 平滑面积折线(渐变/tooltip/refLines 图例/空态)"
```

---

### Task 5: RingGauge 组件

**Files:**
- Create: `src/components/common/RingGauge.vue`
- Test: `src/components/__tests__/RingGauge.test.js`

**Interfaces:**
- Consumes: `EChart.vue`、`buildGaugeOption`。
- Produces(Task 8 依赖)props:`value: number|null`、`label: string`(默认 `'CPU'`)、`size: number`(默认 56)。中心 HTML 叠加:`value%` / `—` + label。

- [ ] **Step 1: 写失败测试 `src/components/__tests__/RingGauge.test.js`**

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

const { setOptionMock } = vi.hoisted(() => ({ setOptionMock: vi.fn() }))
vi.mock('@/lib/echarts', () => ({
  echarts: { use: vi.fn(), registerTheme: vi.fn(), init: vi.fn(() => ({ setOption: setOptionMock, resize: vi.fn(), dispose: vi.fn() })) },
}))
import RingGauge from '../common/RingGauge.vue'

test('value 有值: option value 夹取 + 中心显示 N% 与 label', () => {
  setOptionMock.mockClear()
  const w = mount(RingGauge, { props: { value: 42, label: 'CPU' } })
  expect(setOptionMock.mock.calls[0][0].series[0].data[0].value).toBe(42)
  expect(w.text()).toContain('42%')
  expect(w.text()).toContain('CPU')
})

test('value=null: 空态 —(图表 value=0)且仍渲染 label', () => {
  setOptionMock.mockClear()
  const w = mount(RingGauge, { props: { value: null } })
  expect(setOptionMock.mock.calls[0][0].series[0].data[0].value).toBe(0)
  expect(w.text()).toContain('—')
  expect(w.text()).toContain('CPU')
})

test('容器 pointer-events:none(不挡外层 router-link 点击)', () => {
  const w = mount(RingGauge, { props: { value: 10 } })
  expect(w.find('.pointer-events-none').exists()).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/RingGauge.test.js`
Expected: FAIL —`Cannot find module '../common/RingGauge.vue'`

- [ ] **Step 3: 创建 `src/components/common/RingGauge.vue`**

```vue
<script setup>
// 环形表盘(ECharts gauge 渐变 + 数值过渡动画);中心数值仍由 HTML 叠加(与旧 SVG 版观感一致)。
// 容器 pointer-events:none——外层常是 router-link 卡片,图表不得挡点击。
import { computed } from 'vue'
import EChart from './EChart.vue'
import { buildGaugeOption } from '@/lib/chart-options'

const props = defineProps({
  value: { type: Number, default: null },
  label: { type: String, default: 'CPU' },
  size: { type: Number, default: 56 },
})
const option = computed(() => buildGaugeOption(props.value))
</script>

<template>
  <div class="relative flex-shrink-0 self-center" :style="{ width: size + 'px', height: size + 'px' }">
    <div class="pointer-events-none absolute inset-0">
      <EChart :option="option" :height="size" />
    </div>
    <div class="absolute inset-0 flex flex-col items-center justify-center">
      <span class="text-body-sm font-bold leading-none" :class="value != null ? 'text-on-surface' : 'text-on-surface-variant'">{{ value != null ? value + '%' : '—' }}</span>
      <span class="text-[9px] text-on-surface-variant uppercase tracking-wide mt-0.5">{{ label }}</span>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/RingGauge.test.js`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add src/components/common/RingGauge.vue src/components/__tests__/RingGauge.test.js
git commit -m "feat(chart): RingGauge 环形表盘(渐变/过渡动画/空态灰环/不挡卡片点击)"
```

---

### Task 6: StatusSummaryCard 组件

**Files:**
- Create: `src/components/common/StatusSummaryCard.vue`
- Test: `src/components/__tests__/StatusSummaryCard.test.js`

**Interfaces:**
- Consumes: `EChart.vue`、`buildStatusSegments`/`buildDonutOption`/`STATUS_COLORS`/`tokenHex`。
- Produces(Task 10 依赖)props:`pods: Array`、`statusFilter: string`(默认 `'All'`);emit `filter(status: string)` —— 点击已选中状态 → `'All'`,否则 → 该状态(等价旧 4 格栏的切换过滤)。

- [ ] **Step 1: 写失败测试 `src/components/__tests__/StatusSummaryCard.test.js`**

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { setOptionMock } = vi.hoisted(() => ({ setOptionMock: vi.fn() }))
vi.mock('@/lib/echarts', () => ({
  echarts: { use: vi.fn(), registerTheme: vi.fn(), init: vi.fn(() => ({ setOption: setOptionMock, resize: vi.fn(), dispose: vi.fn() })) },
}))
import StatusSummaryCard from '../common/StatusSummaryCard.vue'

const PODS = [
  { status: 'Running' }, { status: 'Running' }, { status: 'Running' },
  { status: 'Pending' }, { status: 'Failed' }, { status: 'Succeeded' },
]

function mountCard(props = {}) {
  return mount(StatusSummaryCard, { props: { pods: PODS, ...props }, global: { plugins: [i18n] } })
}

test('donut option: 分段 = Running3/Pending1/Failed1/Other1;中心总数 6', () => {
  setOptionMock.mockClear()
  const w = mountCard()
  const data = setOptionMock.mock.calls[0][0].series[0].data
  expect(data.map(d => [d.name, d.value])).toEqual([['Running', 3], ['Pending', 1], ['Failed', 1], ['Other', 1]])
  expect(w.text()).toContain('6')
})

test('图例计数可见,点击 Running → emit filter Running;statusFilter=Running 再点 → All', async () => {
  const w = mountCard()
  expect(w.text()).toContain('Running')
  await w.findAll('button').find(b => b.text().includes('Running')).trigger('click')
  expect(w.emitted('filter')).toEqual([['Running']])
  await w.setProps({ statusFilter: 'Running' })
  await w.findAll('button').find(b => b.text().includes('Running')).trigger('click')
  expect(w.emitted('filter')).toEqual([['Running'], ['All']])
})

test('选中态:statusFilter=Running 的按钮带 primary 边框类', () => {
  const w = mountCard({ statusFilter: 'Running' })
  const active = w.findAll('button').find(b => b.text().includes('Running'))
  expect(active.classes().some(c => c.includes('border-primary'))).toBe(true)
})

test('空 pods: 不渲染 EChart,总数 0,图例为空', () => {
  setOptionMock.mockClear()
  const w = mountCard({ pods: [] })
  expect(setOptionMock).not.toHaveBeenCalled()
  expect(w.text()).toContain('0')
  expect(w.findAll('button').length).toBe(0)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/StatusSummaryCard.test.js`
Expected: FAIL —`Cannot find module '../common/StatusSummaryCard.vue'`

- [ ] **Step 3: 创建 `src/components/common/StatusSummaryCard.vue`**

```vue
<script setup>
// Pod 状态摘要卡:左环形分布 + 右可点击图例(等价替换 NsPods 原 4 格状态栏,保留点击切换过滤)。
// 状态名(Running/Pending/Failed/Other)照旧英文直出,与全站状态展示一致,不加 i18n。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EChart from './EChart.vue'
import { buildStatusSegments, buildDonutOption, STATUS_COLORS, tokenHex } from '@/lib/chart-options'

const props = defineProps({
  pods: { type: Array, default: () => [] },
  statusFilter: { type: String, default: 'All' },
})
const emit = defineEmits(['filter'])
const { t } = useI18n()

const segments = computed(() => buildStatusSegments(props.pods))
const total = computed(() => props.pods.length)
const option = computed(() => buildDonutOption(segments.value))
const dot = (status) => tokenHex(STATUS_COLORS[status] || STATUS_COLORS.Other)
function toggle(status) {
  emit('filter', props.statusFilter === status ? 'All' : status)
}
</script>

<template>
  <div class="rounded-xl bg-surface-container-lowest border border-outline-variant px-md py-sm flex items-center gap-md mb-md">
    <div class="relative w-24 h-24 flex-shrink-0">
      <EChart v-if="segments.length" :option="option" :height="96" />
      <div v-else class="w-24 h-24 rounded-full border-[7px] border-outline-variant/40"></div>
      <div class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
        <span class="text-headline-sm font-bold text-on-surface leading-none">{{ total }}</span>
        <span class="text-[10px] text-on-surface-variant mt-0.5">{{ t('ns.pods.total') }}</span>
      </div>
    </div>
    <div class="flex flex-wrap gap-sm">
      <button
        v-for="s in segments" :key="s.status" type="button" @click="toggle(s.status)"
        class="flex items-center gap-xs px-sm py-1 rounded-lg border transition-colors"
        :class="statusFilter === s.status ? 'border-primary bg-primary-container/10' : 'border-outline-variant/50 hover:border-primary/60'"
      >
        <span class="w-2.5 h-2.5 rounded-full" :style="{ background: dot(s.status) }"></span>
        <span class="text-body-sm text-on-surface-variant">{{ s.status }}</span>
        <span class="text-body-md font-bold" :style="{ color: dot(s.status) }">{{ s.count }}</span>
      </button>
    </div>
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/StatusSummaryCard.test.js`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add src/components/common/StatusSummaryCard.vue src/components/__tests__/StatusSummaryCard.test.js
git commit -m "feat(chart): StatusSummaryCard 状态环形分布+可点击图例(替换 NsPods 状态栏)"
```

---

### Task 7: ProgressBar 渐变/斜纹增强

**Files:**
- Modify: `src/components/common/ProgressBar.vue`(全量替换)、`tailwind.config.js`(animation/keyframes 追加)
- Test: `src/components/__tests__/ProgressBar.test.js`(新建)

**Interfaces:**
- Consumes: `tokenHex`(chart-options re-export)。
- Produces: props 契约**不变**(`value/max/color/size/showLabel/label`),零调用方改动;视觉:三档渐变填充、>80% 斜纹流动、宽度过渡 700ms。

- [ ] **Step 1: 写失败测试 `src/components/__tests__/ProgressBar.test.js`**

```js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ProgressBar from '../common/ProgressBar.vue'

function fillStyle(props) {
  const w = mount(ProgressBar, { props })
  const fill = w.findAll('div').at(-1) // 最后一个 div 是填充条
  return { cls: fill.classes(), style: fill.attributes('style') || '' }
}

test('低负载: primary→primary-container 渐变、无斜纹', () => {
  const { cls, style } = fillStyle({ value: 40 })
  expect(style).toContain('width:40%')
  expect(style).toContain('linear-gradient')
  // DOM 可能序列化为 rgb(),两种都接受(#006c49 = rgb(0,108,73))
  expect(style).toMatch(/#006c49|rgb\(0,\s*108,\s*73\)/)
  expect(cls).not.toContain('animate-bar-stripes')
})

test('高危 >80: error 渐变 + 斜纹流动类', () => {
  const { cls, style } = fillStyle({ value: 90 })
  expect(cls).toContain('animate-bar-stripes')
  expect(style).toMatch(/#ba1a1a|rgb\(186,\s*26,\s*26\)/)
  expect(style).toContain('repeating-linear-gradient')
})

test('值夹取 100;showLabel 渲染 label 与百分比', () => {
  const w = mount(ProgressBar, { props: { value: 150, showLabel: true, label: 'MEM' } })
  const fill = w.findAll('div').at(-1)
  expect(fill.attributes('style')).toContain('width:100%')
  expect(w.text()).toContain('MEM')
  expect(w.text()).toContain('150%')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/ProgressBar.test.js`
Expected: FAIL(旧实现无渐变/斜纹类)

- [ ] **Step 3: tailwind.config.js 追加斜纹动画**(extend.animation / extend.keyframes 内,与 `pulse-status` 并列)

```js
      animation: {
        // …既有项保留…
        'bar-stripes': 'bar-stripes 1.2s linear infinite',
      },
      keyframes: {
        // …既有项保留…
        'bar-stripes': {
          '0%': { backgroundPosition: '0 0' },
          '100%': { backgroundPosition: '24px 0' },
        },
      },
```

- [ ] **Step 4: 全量替换 `src/components/common/ProgressBar.vue`**

```vue
<script setup>
// 进度条:MD3 token 渐变填充 + 高危(>80%)斜纹流动示警。阈值语义与旧版一致(>80 error / >60 tertiary)。
// 渐变 hex 从 md-palette 取单一来源;props 契约与旧版完全一致(调用方零改动)。
import { computed } from 'vue'
import { tokenHex } from '@/lib/chart-options'

const props = defineProps({
  value: { type: Number, required: true },
  max: { type: Number, default: 100 },
  color: { type: String, default: 'primary' },
  size: { type: String, default: 'sm' },
  showLabel: { type: Boolean, default: false },
  label: { type: String, default: '' },
})

// 阈值档位(token 名);旧 color prop 的 primaryContainer camelCase 归一到 kebab
function tier(value) {
  if (value > 80) return 'error'
  if (value > 60) return 'tertiary-container'
  const map = { primary: 'primary', secondary: 'secondary', primaryContainer: 'primary-container' }
  return map[props.color] || 'primary'
}
// 每档渐变的亮端 token(比原色亮一档,纵向 90° 渐变)
const TO = {
  'primary': 'primary-container',
  'secondary': 'secondary-container',
  'primary-container': 'primary-fixed',
  'tertiary-container': 'tertiary-fixed-dim',
  'error': 'status-failed',
}
const stripes = computed(() => props.value > 80)
const fillStyle = computed(() => {
  const tok = tier(props.value)
  const grad = `linear-gradient(90deg, ${tokenHex(tok)} 0%, ${tokenHex(TO[tok] || 'primary-container')} 100%)`
  return {
    width: `${Math.min(props.value, 100)}%`,
    backgroundImage: stripes.value
      ? `repeating-linear-gradient(45deg, rgba(255,255,255,.25) 0 6px, transparent 6px 12px), ${grad}`
      : grad,
  }
})
</script>

<template>
  <div class="w-full">
    <div v-if="showLabel" class="flex justify-between text-body-sm mb-1">
      <span class="text-on-surface-variant">{{ label }}</span>
      <span class="font-medium">{{ value }}%</span>
    </div>
    <div
      class="w-full bg-surface-container-high rounded-full overflow-hidden"
      :class="size === 'sm' ? 'h-1.5' : size === 'md' ? 'h-2' : 'h-3'"
    >
      <div
        class="h-full rounded-full transition-all duration-700 ease-out"
        :class="stripes ? 'animate-bar-stripes' : ''"
        :style="fillStyle"
      ></div>
    </div>
  </div>
</template>
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/ProgressBar.test.js`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add src/components/common/ProgressBar.vue src/components/__tests__/ProgressBar.test.js tailwind.config.js
git commit -m "feat(chart): ProgressBar 渐变填充+高危斜纹流动(props 契约不变)"
```

---

### Task 8: ClusterOverview 迁移(AreaLineChart ×2 + RingGauge ×6)

**Files:**
- Modify: `src/views/ClusterOverview.vue`(imports/39-45/143-160/180-194)、`src/views/__tests__/_allViewsMount.test.js`(加 echarts 桩)

**Interfaces:**
- Consumes: `AreaLineChart`(color='primary'、height=128、unit='%')、`RingGauge`(value=node.cpu、label='CPU'、size=56)。

- [ ] **Step 1: `_allViewsMount.test.js` 加 echarts 桩**(避免冒烟测试真渲染 SVG、拖慢且无断言价值;放在现有 `vi.mock('@/api/client')` 之前)

```js
// ECharts 桩:图表组件冒烟只需不炸,无需真实渲染(SVG 渲染器在 happy-dom 中开销大)。
vi.mock('@/lib/echarts', () => {
  const noop = () => {}
  return { echarts: { use: noop, registerTheme: noop, init: () => ({ setOption: noop, resize: noop, dispose: noop }) } }
})
```

- [ ] **Step 2: 视图替换**

1. import 区:`import MiniChart from '@/components/common/MiniChart.vue'` → `import AreaLineChart from '@/components/common/AreaLineChart.vue'` + `import RingGauge from '@/components/common/RingGauge.vue'`。
2. 删除 `gaugeClass` 函数(script 39-45 行)。
3. CPU 图(144 行)→ `<AreaLineChart :series="cpuSeries" color="primary" unit="%" :height="128" />`;Memory 图(159 行)同。
4. 节点卡 CPU 环(181-194 行整个 `<div class="relative w-14 h-14 …">…</div>`)→ `<RingGauge :value="node.cpu" label="CPU" :size="56" />`(w-14 = 56px,布局 class 由组件自带 `relative flex-shrink-0 self-center`)。
5. 采样 `tick()`/`onMounted` 逻辑**不动**。

- [ ] **Step 3: 验证**

Run: `npx vitest run src/views/__tests__/_allViewsMount.test.js`
Expected: PASS(全视图冒烟无运行期错误)
Run: `npm run typecheck`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add src/views/ClusterOverview.vue src/views/__tests__/_allViewsMount.test.js
git commit -m "feat(chart): 集群概览迁移 AreaLineChart+RingGauge(删手画 SVG 环)"
```

---

### Task 9: MonitoringCenter + NsWorkloadDetail 迁移 + 删 MiniChart

**Files:**
- Modify: `src/views/MonitoringCenter.vue`(imports/120/129)、`src/views/NsWorkloadDetail.vue`(imports/21、refLines 666-679、模板 1516/1526)
- Delete: `src/components/common/MiniChart.vue`

**Interfaces:**
- Consumes: `AreaLineChart`;refLines 颜色改传 token 名(`'secondary'`/`'error'`)。

- [ ] **Step 1: MonitoringCenter**

1. import:`MiniChart` → `AreaLineChart`。
2. CPU 卡(120 行)→ `<AreaLineChart :series="cpuSeries" color="primary" unit="%" :height="48" spark />`
3. 内存卡(129 行)→ `<AreaLineChart :series="memSeries" color="tertiary-container" unit="%" :height="48" spark />`

- [ ] **Step 2: NsWorkloadDetail**

1. import(21 行):`MiniChart` → `AreaLineChart`。
2. `podCpuRefLines`/`podMemRefLines`(666-679 行)里 `color: 'var(--md-sys-color-secondary)'` → `color: 'secondary'`;`color: 'var(--md-sys-color-error)'` → `color: 'error'`。
3. 模板 1516 行 → `<AreaLineChart :series="windowed(podCpuSeries)" color="primary" unit="m" :ref-lines="podCpuRefLines" :height="72" />`
4. 模板 1526 行 → `<AreaLineChart :series="windowed(podMemSeries)" color="secondary" unit="Mi" :ref-lines="podMemRefLines" :height="72" />`

- [ ] **Step 3: 删 MiniChart 并确认无残留引用**

```bash
rm src/components/common/MiniChart.vue
grep -rn "MiniChart" src/ || echo "无残留"
```
Expected: `无残留`

- [ ] **Step 4: 验证**

Run: `npx vitest run src/views/__tests__/_allViewsMount.test.js && npm run typecheck`
Expected: 均通过

- [ ] **Step 5: Commit**

```bash
git add -A src/views/MonitoringCenter.vue src/views/NsWorkloadDetail.vue src/components/common/MiniChart.vue
git commit -m "feat(chart): 监控中心/负载详情迁移 AreaLineChart,删除 MiniChart"
```

---

### Task 10: NsPods 状态栏换 StatusSummaryCard

**Files:**
- Modify: `src/views/NsPods.vue`(imports、49-51 行计数、140-161 行状态栏)

**Interfaces:**
- Consumes: `StatusSummaryCard`(`pods`/`statusFilter` + `@filter`)。

- [ ] **Step 1: 视图替换**

1. import 区加 `import StatusSummaryCard from '@/components/common/StatusSummaryCard.vue'`。
2. 模板 140-161 行(`<!-- Status Summary Bar -->` 的整个 `<div class="grid grid-cols-4 …">…</div>`)替换为:

```html
    <!-- Status Summary(环形分布 + 点击过滤,等价旧 4 格栏) -->
    <StatusSummaryCard :pods="nsPods" :status-filter="statusFilter" @filter="(s) => statusFilter = s" />
```

3. 删除 49-51 行 `runningCount`/`pendingCount`/`failedCount` 三个 computed(替换后无引用;先 `grep -n "runningCount\|pendingCount\|failedCount" src/views/NsPods.vue` 确认只剩定义行)。

- [ ] **Step 2: 验证**

Run: `npx vitest run src/views/__tests__/_allViewsMount.test.js && npm run typecheck && npm run i18n:check`
Expected: 均通过(未新增 i18n 键,`ns.pods.total` 为既有键)

- [ ] **Step 3: Commit**

```bash
git add src/views/NsPods.vue
git commit -m "feat(chart): NsPods 状态栏升级为环形分布卡(点击过滤交互不变)"
```

---

### Task 11: 全量验证 + 包体记录

**Files:**
- Modify: 无新改动(验证任务;发现问题就地修,修复随本任务 commit)

- [ ] **Step 1: 全量测试**

```bash
npm test && npm run typecheck && npm run build && npm run i18n:check
```
Expected: test(node 运行器 + vitest + server node --test)、typecheck、build、i18n 四绿。

- [ ] **Step 2: 包体记录**

Run: `npm run build 2>&1 | grep -iE "echarts|dist/assets.*(js|css)" | tail -8`
把 echarts 相关 chunk 的 gzip 大小记入本文件末尾(附在 commit message 里亦可)。预期 gzip 增量 ≈100KB 量级;若单 chunk gzip > 300KB,在 `vite.config.js` `build.rollupOptions.output.manualChunks` 里把 `echarts` 拆独立 chunk(仅此一种情况才动)。

- [ ] **Step 3: 手工 QA 清单**(需要真实/模拟集群;无集群环境时跑 `npm run dev` 目检空态与布局)

- `/cluster`:两张面积图平滑+渐变+hover tooltip(-Ns/0s);节点卡环形渐变、点击进详情不受挡;`—` 空态。
- `/monitoring`:KPI sparkline 无网格、有 tooltip;ProgressBar 渐变(节点卡)。
- 工作负载详情:CPU/内存图 requests/limits 虚线 + 图例 footer;tooltip 带 m/Mi 单位。
- `/ns/<ns>/pods`:环形分布 + 图例点击过滤(与下拉过滤器联动);Other 归并正确。
- 回归:任一 DataTable 页(色板注入后 var() 消费者变色,确认无违和)、ColumnManager 弹层。

- [ ] **Step 4: Commit(如本任务无代码改动则跳过;有则:)**

```bash
git add -A
git commit -m "chore(chart): 全量验证收尾(包体记录/回归修复)"
```

---

## Self-Review 记录

- **Spec 覆盖**:依赖+注册(Task 1/2)、palette 单一来源+bug 修复(Task 1)、AreaLineChart(Task 3/4)、StatusSummaryCard(Task 3/6)、RingGauge(Task 3/5)、ProgressBar 增强(Task 7)、四视图迁移+删 MiniChart(Task 8/9/10)、边界(空态/夹取/pointer-events,散布在 3-6)、测试策略(3-7 各自 TDD + 11 全量)、CLAUDE.md 登记(Task 1)。✓ 无遗漏。
- **占位符扫描**:无 TBD/TODO;"目检清单"为验证动作而非实现占位。✓
- **类型一致性**:`tokenHex`/`buildAreaLineOption`/`buildDonutOption`/`buildGaugeOption`/`buildStatusSegments`/`STATUS_COLORS` 在 Task 3 定义,Task 4-10 消费处签名一致;props 名(`series/color/unit/height/refLines/spark/sampleIntervalSec`、`value/label/size`、`pods/statusFilter`+emit `filter`)跨任务一致。✓
