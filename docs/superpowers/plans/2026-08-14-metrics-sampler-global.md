# 集群指标采样全局化 + localStorage 持久化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ClusterOverview/MonitoringCenter 共享一个全局指标采样器(store 引用计数),采样窗口(15 分钟)按集群持久化到 localStorage,图表改时间轴,首屏即有历史。

**Architecture:** 纯逻辑模块 `src/logic/metricsWindow.js`(push/restore/persist,node 可测)→ cluster store 接线(引用计数 timer + visibility 门控 + 集群切换重载)→ `buildTimeAreaLineOption` 时间轴 builder → AreaLineChart 加 `samples` prop → 两视图删本地采样块换 store 调用。

**Tech Stack:** Vue 3 setup store(Pinia)、localStorage(`aliangboard.metrics.<clusterId>.v1`)、ECharts time 轴、scripts/test.mjs(node 运行器)+ vitest(happy-dom)。

**Spec:** `docs/superpowers/specs/2026-08-14-metrics-sampler-global-design.md`

## Global Constraints

- 窗口参数固定:`WINDOW_MS = 15 * 60_000`、`MAX_SAMPLES = 180`、采样间隔 `10000ms`(不引入新配置项)。
- localStorage key:`aliangboard.metrics.<encodeURIComponent(currentCluster)>.v1`(与既有 `aliangboard.*` 前缀一致)。
- 不动:Pod 级采样(useMetricsHistory/NsWorkloadDetail)、`refreshMetrics` 拉取逻辑本身、AreaLineChart 的 `series` 路径(pod 图仍用)。
- 纯逻辑(metricsWindow/chart-options)测试进 `scripts/test.mjs`(node 运行器,`test(name, fn)` + node:assert);组件/store 测试进 vitest(`src/**/*.{test,spec}.js`)。
- 无新依赖、无新 i18n 键(tooltip 相对时间 `-3m20s`/`0s` 语言中立)。
- store 内部闭包调用(`metricsTick` 调 `refreshMetrics()`),不经 store 实例属性——测试须经 mocked `@/api/client` 走真实链路,勿 spy store 方法。
- 工作目录:worktree `feat-metrics-sampler`(分支 `worktree-feat-metrics-sampler`)。

---

### Task 1: metricsWindow 纯逻辑模块

**Files:**
- Create: `src/logic/metricsWindow.js`
- Test: `scripts/test.mjs`(追加)

**Interfaces:**
- Produces(Task 4 依赖,签名固定):
  - `WINDOW_MS: number`(=900000)、`MAX_SAMPLES: number`(=180)
  - `pushSample(samples: Sample[], sample: {t:number,v:number}, opts?: {maxAgeMs?, maxCount?, now?}): Sample[]` — 不可变:append + 按龄过滤 + 尾部截断。
  - `restoreSamples(raw: any, opts?: {maxAgeMs?, now?}): Sample[]` — 容错解析(损坏/非对象/缺字段/陈旧全滤),任何异常返回 `[]` 不抛。
  - `persistPayload(cpuSamples, memSamples): {cpu: Sample[], mem: Sample[]}` — 深拷贝序列化形状。
  - `Sample = {t:number, v:number}`。

- [ ] **Step 1: 写失败测试**(追加到 `scripts/test.mjs`,放在图表美化测试块之后、「--- 汇总 ---」之前)

```js
// --- 指标采样全局化:滚动窗口纯逻辑 ---
import { WINDOW_MS, MAX_SAMPLES, pushSample, restoreSamples, persistPayload } from '../src/logic/metricsWindow.js'

test('pushSample: 追加新样本;越龄样本被丢弃(以 now 为准)', () => {
  const now = 10_000_000
  const fresh = pushSample([], { t: now, v: 3 }, { now })
  assert.deepEqual(fresh, [{ t: now, v: 3 }])
  // 越龄:比 now 早超过 maxAgeMs 的旧样本在 push 时一并清掉(默认 maxAge=15min)
  const base = [{ t: now - 5000, v: 1 }, { t: now - WINDOW_MS - 1000, v: 9 }]
  const out = pushSample(base, { t: now, v: 3 }, { now })
  assert.deepEqual(out, [{ t: now - 5000, v: 1 }, { t: now, v: 3 }])
})

test('pushSample: maxCount 尾部截断(保最新)', () => {
  const now = 5_000_000
  let arr = []
  for (let i = 0; i < 205; i++) arr = pushSample(arr, { t: now + i, v: i }, { now, maxCount: 180 })
  assert.equal(arr.length, 180)
  assert.equal(arr[arr.length - 1].v, 204)
  assert.equal(arr[0].v, 25)   // 丢掉最老的 25 个
})

test('pushSample: 不修改原数组(不可变)', () => {
  const base = [{ t: 1, v: 1 }]
  pushSample(base, { t: 2, v: 2 }, { now: 3 })
  assert.deepEqual(base, [{ t: 1, v: 1 }])
})

test('restoreSamples: 正常恢复 + 陈旧过滤 + 非法项过滤', () => {
  const now = 10_000_000
  const raw = [
    { t: now - 1000, v: 50 },            // 新鲜
    { t: now - WINDOW_MS - 5000, v: 40 }, // 陈旧 → 滤
    { t: 'x', v: 1 }, { v: 2 }, { t: 3 }, null, 42, // 非法 → 滤
  ]
  assert.deepEqual(restoreSamples(raw, { now }), [{ t: now - 1000, v: 50 }])
})

test('restoreSamples: 损坏入参全降级为 [] 不抛', () => {
  assert.deepEqual(restoreSamples(undefined, { now: 1 }), [])
  assert.deepEqual(restoreSamples(null, { now: 1 }), [])
  assert.deepEqual(restoreSamples('{"cpu":', { now: 1 }), [])   // 字符串当数组遍历不炸
  assert.deepEqual(restoreSamples({}, { now: 1 }), [])
})

test('persistPayload: 形状 {cpu,mem} 且深拷贝(改源不影响产物)', () => {
  const cpu = [{ t: 1, v: 1 }], mem = [{ t: 2, v: 2 }]
  const p = persistPayload(cpu, mem)
  assert.deepEqual(p, { cpu: [{ t: 1, v: 1 }], mem: [{ t: 2, v: 2 }] })
  p.cpu.push({ t: 9, v: 9 })
  assert.equal(cpu.length, 1)
})

test('常量: 15 分钟窗口 / 180 条上限', () => {
  assert.equal(WINDOW_MS, 900000)
  assert.equal(MAX_SAMPLES, 180)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test.mjs 2>&1 | tail -4`
Expected: FAIL —`Cannot find module '../src/logic/metricsWindow.js'`

- [ ] **Step 3: 创建 `src/logic/metricsWindow.js`**

```js
// 集群指标采样滚动窗口纯逻辑:不碰 localStorage/DOM(node 零依赖可测)。
// 读写持久化由 cluster store 侧做;本模块只管数据形状与窗口语义。
// Sample = { t: 毫秒时间戳, v: 数值 }
export const WINDOW_MS = 15 * 60 * 1000   // 15 分钟回看
export const MAX_SAMPLES = 180            // 条数上限(防异常时钟写爆)

function isValidSample(s) {
  return s && typeof s === 'object' && typeof s.t === 'number' && typeof s.v === 'number'
    && !isNaN(s.t) && !isNaN(s.v)
}

// 追加样本 → 按龄过滤(以 now 为准)→ 尾部截断 maxCount(保最新)。不可变。
export function pushSample(samples, sample, { maxAgeMs = WINDOW_MS, maxCount = MAX_SAMPLES, now = Date.now() } = {}) {
  const arr = Array.isArray(samples) ? samples.filter(isValidSample) : []
  if (!isValidSample(sample)) return arr.slice(-maxCount)
  const minT = now - maxAgeMs
  return [...arr, sample].filter(s => s.t >= minT).slice(-maxCount)
}

// 从 localStorage JSON 恢复:过滤非法与陈旧样本;任何入参异常都返回 [] 不抛。
export function restoreSamples(raw, { maxAgeMs = WINDOW_MS, now = Date.now() } = {}) {
  if (!Array.isArray(raw)) return []
  const minT = now - maxAgeMs
  return raw.filter(s => isValidSample(s) && s.t >= minT)
}

// 序列化形状(深拷贝,避免引用共享)
export function persistPayload(cpuSamples, memSamples) {
  const cp = (Array.isArray(cpuSamples) ? cpuSamples : []).filter(isValidSample)
  const mp = (Array.isArray(memSamples) ? memSamples : []).filter(isValidSample)
  return { cpu: cp.map(s => ({ t: s.t, v: s.v })), mem: mp.map(s => ({ t: s.t, v: s.v })) }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test.mjs 2>&1 | tail -3`
Expected: 全部通过(新增 7 例)

- [ ] **Step 5: Commit**

```bash
git add src/logic/metricsWindow.js scripts/test.mjs
git commit -m "feat(metrics): 采样滚动窗口纯逻辑(push/restore/persist,node 可测)"
```

---

### Task 2: chart-options 时间轴 builder + formatRelTime

**Files:**
- Modify: `src/lib/chart-options.js`(追加)
- Test: `scripts/test.mjs`(追加)

**Interfaces:**
- Consumes: `tokenHex`/`MD_PALETTE`(同文件既有)。
- Produces(Task 3 依赖):
  - `formatRelTime(deltaSec: number): string` — `'0s'` / `'-40s'` / `'-3m20s'` / `'-3m'`(分钟档,语言中立)。
  - `buildTimeAreaLineOption({ samples, color, unit, refLines, smooth }): option` — x 轴 `type:'time'`(`min:'dataMin', max:'dataMax'`),series data 为 `[t,v]` 对;tooltip 相对**最新有效样本时间**的偏移;refLines markLine 与 y 轴 max 语义同 buildAreaLineOption。

- [ ] **Step 1: 写失败测试**(追加到 `scripts/test.mjs`,import 区补 `formatRelTime, buildTimeAreaLineOption`)

```js
// --- 指标采样全局化:时间轴 builder ---
import { formatRelTime, buildTimeAreaLineOption } from '../src/lib/chart-options.js'

test('formatRelTime: 0/秒/分钟档', () => {
  assert.equal(formatRelTime(0), '0s')
  assert.equal(formatRelTime(-5), '0s')            // 负数夹 0
  assert.equal(formatRelTime(40), '-40s')
  assert.equal(formatRelTime(200), '-3m20s')
  assert.equal(formatRelTime(180), '-3m')
})

test('buildTimeAreaLineOption: time 轴 + [t,v] 数据 + 相对最新样本的 tooltip', () => {
  const samples = [
    { t: 1_000_000, v: 10 },
    { t: 1_060_000, v: 20 },   // 比最新早 60s
    { t: 1_200_000, v: 15 },   // 最新
    { t: 'bad', v: 1 },        // 非法 → 滤
  ]
  const opt = buildTimeAreaLineOption({ samples, color: 'primary', unit: '%' })
  assert.equal(opt.xAxis.type, 'time')
  assert.deepEqual(opt.series[0].data, [[1_000_000, 10], [1_060_000, 20], [1_200_000, 15]])
  // tooltip:第一个点比最新(1_200_000)早 200s
  assert.equal(opt.tooltip.formatter([{ value: [1_000_000, 10], dataIndex: 0 }]), '-3m20s<br/>10%')
  assert.equal(opt.tooltip.formatter([{ value: [1_200_000, 15], dataIndex: 2 }]), '0s<br/>15%')
  assert.equal(opt.series[0].lineStyle.color, MD_PALETTE.primary)
  assert.equal(opt.series[0].areaStyle.color.colorStops[0].color, 'rgba(0,108,73,0.35)')
})

test('buildTimeAreaLineOption: refLines 进 markLine 且计入 y 轴 max', () => {
  const opt = buildTimeAreaLineOption({
    samples: [{ t: 1, v: 10 }, { t: 2, v: 12 }],
    refLines: [{ label: 'limits', value: 80, color: 'error' }],
  })
  assert.equal(opt.yAxis.max, 80)
  assert.equal(opt.series[0].markLine.data[0].yAxis, 80)
  assert.equal(opt.series[0].markLine.data[0].lineStyle.color, MD_PALETTE.error)
})

test('buildTimeAreaLineOption: 空样本不崩(y 轴 max 回落 1)', () => {
  const opt = buildTimeAreaLineOption({ samples: [] })
  assert.deepEqual(opt.series[0].data, [])
  assert.equal(opt.yAxis.max, 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test.mjs 2>&1 | tail -4`
Expected: FAIL —`does not provide an export named 'formatRelTime'`(或同义)

- [ ] **Step 3: 在 `src/lib/chart-options.js` 末尾追加**(import 区无需新增)

```js
// 相对时间(秒)→ 人类可读:0s / -40s / -3m20s / -3m。语言中立,免 i18n。
export function formatRelTime(deltaSec) {
  const s = Math.max(0, Math.round(deltaSec))
  if (s === 0) return '0s'
  const m = Math.floor(s / 60)
  const r = s % 60
  return `-${m > 0 ? (r > 0 ? `${m}m${r}s` : `${m}m`) : `${s}s`}`
}

// 时间轴版面积折线图:全局采样器(cpuSamples/memSamples)专用。
// samples: [{t: 毫秒, v: 数值}];x 轴 type 'time' 真实反映采样间隔与空档;
// tooltip 相对最新有效样本时间(formatRelTime)。refLines/y-max 语义与 buildAreaLineOption 一致。
export function buildTimeAreaLineOption({ samples = [], color = 'primary', unit = '', refLines = [], smooth = true } = {}) {
  const line = tokenHex(color)
  const valid = (Array.isArray(samples) ? samples : []).filter(s =>
    s && typeof s === 'object' && typeof s.t === 'number' && typeof s.v === 'number' && !isNaN(s.t) && !isNaN(s.v))
  const values = valid.map(s => s.v)
  const maxVal = Math.max(1, ...values, ...refLines.map(r => Number(r.value) || 0))
  const newest = valid.length ? valid[valid.length - 1].t : 0
  const option = {
    animationDurationUpdate: 400,
    grid: { left: 4, right: 4, top: 8, bottom: 4 },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const p = Array.isArray(params) ? params[0] : params
        const [t, v] = p.value
        return `${formatRelTime((newest - t) / 1000)}<br/>${v == null ? '—' : v}${unit}`
      },
    },
    xAxis: { type: 'time', show: false, min: 'dataMin', max: 'dataMax' },
    yAxis: {
      type: 'value', max: maxVal,
      axisLabel: { show: false }, axisLine: { show: false }, axisTick: { show: false },
      splitLine: { lineStyle: { color: hexToRgba(MD_PALETTE['outline-variant'], 0.35), width: 1 } },
    },
    series: [{
      id: 'main', type: 'line', smooth, symbol: 'none',
      data: valid.map(s => [s.t, s.v]),
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
  if (refLines.length) {
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test.mjs 2>&1 | tail -3`
Expected: 全部通过(新增 4 例)

- [ ] **Step 5: Commit**

```bash
git add src/lib/chart-options.js scripts/test.mjs
git commit -m "feat(metrics): 时间轴面积图 builder(formatRelTime/跨会话空档真实呈现)"
```

---

### Task 3: AreaLineChart 加 samples prop

**Files:**
- Modify: `src/components/common/AreaLineChart.vue`
- Test: `src/components/__tests__/AreaLineChart.test.js`(追加用例)

**Interfaces:**
- Consumes: `buildTimeAreaLineOption`(Task 2)。
- Produces(Task 5 依赖):新增可选 prop `samples: Array`(默认 `null`;**与 `series` 二选一,samples 优先**);传入 samples 时走 time 轴 option;空态=有效 `{t,v}` 样本 <2。`series` 路径(pod 图)行为零改动。

- [ ] **Step 1: 写失败测试**(追加到 `src/components/__tests__/AreaLineChart.test.js`)

```js
test('samples 优先:传 samples 走 time 轴 option,[t,v] 数据', () => {
  setOptionMock.mockClear()
  const w = mountChart({
    samples: [{ t: 1000, v: 10 }, { t: 2000, v: 20 }],
    color: 'primary', unit: '%', height: 128,
  })
  const opt = setOptionMock.mock.calls[0][0]
  expect(opt.xAxis.type).toBe('time')
  expect(opt.series[0].data).toEqual([[1000, 10], [2000, 20]])
  w.unmount()
})

test('samples 不足 2 个有效样本:空态,不渲染图表', () => {
  setOptionMock.mockClear()
  const w = mountChart({ samples: [{ t: 1000, v: 10 }, { t: 'bad', v: 1 }] })
  expect(w.text()).toContain(i18n.global.t('common.noData'))
  expect(setOptionMock).not.toHaveBeenCalled()
})

test('series 路径不受影响:不传 samples 时仍走 interval 轴', () => {
  setOptionMock.mockClear()
  mountChart({ series: [1, 2, 3] })
  const opt = setOptionMock.mock.calls[0][0]
  expect(opt.xAxis.type).toBe('category')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/AreaLineChart.test.js`
Expected: 新增 3 例 FAIL(samples prop 不存在 → setOption 未被调/mount 警告)

- [ ] **Step 3: 修改 `AreaLineChart.vue`**(script 的 props/empty/option 三处;template 不变)

```vue
<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import EChart from './EChart.vue'
import { buildAreaLineOption, buildTimeAreaLineOption, tokenHex } from '@/lib/chart-options'

const props = defineProps({
  series: { type: Array, default: () => [] },
  // 时间戳样本(全局采样器):[{t: 毫秒, v: 数值}]。与 series 二选一,samples 优先。
  samples: { type: Array, default: null },
  color: { type: String, default: 'primary' },
  unit: { type: String, default: '' },
  height: { type: Number, default: 64 },
  refLines: { type: Array, default: () => [] },
  spark: { type: Boolean, default: false },
  smooth: { type: Boolean, default: true },
  sampleIntervalSec: { type: Number, default: 10 },
})
const { t } = useI18n()
const validSamples = computed(() => (props.samples || []).filter(s =>
  s && typeof s === 'object' && typeof s.t === 'number' && typeof s.v === 'number' && !isNaN(s.t) && !isNaN(s.v)))
const empty = computed(() => props.samples != null
  ? validSamples.value.length < 2
  : props.series.filter(v => typeof v === 'number' && !isNaN(v)).length < 2)
const option = computed(() => props.samples != null
  ? buildTimeAreaLineOption({ samples: props.samples, color: props.color, unit: props.unit, refLines: props.refLines, smooth: props.smooth })
  : buildAreaLineOption({
      series: props.series, color: props.color, unit: props.unit, refLines: props.refLines,
      spark: props.spark, smooth: props.smooth, sampleIntervalSec: props.sampleIntervalSec,
    }))
</script>
```

(template 与 refLines footer 保持原样——footer 对两种路径同样生效。)

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/AreaLineChart.test.js`
Expected: 全部通过(原 3 例 + 新 3 例)

- [ ] **Step 5: Commit**

```bash
git add src/components/common/AreaLineChart.vue src/components/__tests__/AreaLineChart.test.js
git commit -m "feat(metrics): AreaLineChart 支持 samples 时间戳样本路径(series 路径不动)"
```

---

### Task 4: cluster store 全局采样器

**Files:**
- Modify: `src/stores/cluster.js`(refreshMetrics 之后加采样器段;switchCluster/setConnectedCluster 各加一行;return 块导出)
- Test: `src/stores/__tests__/cluster.metrics-sampler.test.js`(新建)

**Interfaces:**
- Consumes: `pushSample/restoreSamples/persistPayload`(Task 1)、`refreshMetrics`(store 既有)。
- Produces(Task 5 依赖,store 实例上新成员):
  - `cpuSamples: Sample[]`、`memSamples: Sample[]`(响应式)
  - `metricsSampling: boolean`、`metricsLastRefresh: number|null`
  - `startMetricsSampling()` / `stopMetricsSampling()`(引用计数;0→1 时恢复窗口+立即一轮+起 10s timer+注册 visibilitychange;归 0 时清 timer+移除监听)
  - `sampleNow(): Promise`(手动单次采样=一次 metricsTick)

- [ ] **Step 1: 写失败测试 `src/stores/__tests__/cluster.metrics-sampler.test.js`**

```js
// 全局指标采样器:引用计数 timer / 首轮立即采样 / 持久化往返 / 恢复 / 后台暂停。
// 经 mocked '@/api/client' 走真实 refreshMetrics 链路(store 内部闭包调用,无法 spy 实例方法)。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => {
  const nodeMetrics = { items: [{ metadata: { name: 'n1' }, usage: { cpu: '2000m', memory: '4Gi' } }] }
  const podMetrics = { items: [] }
  return {
    api: { k8s: vi.fn(async (url) => {
      if (!url.includes('metrics.k8s.io')) return {}
      return url.endsWith('/nodes') ? nodeMetrics : podMetrics
    }) },
    k8sStream: vi.fn(), portForwardApi: {},
    getSavedClusters: () => [], addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
    setActiveToken: vi.fn(), activeApiServer: () => '', getSessionToken: () => '',
  }
})

import { useClusterStore } from '@/stores/cluster'

// localStorage 内存垫(同 cluster.store-methods.test.js;afterEach 还原防污染其它套件)
let _ls, _ss
const mem = new Map()
const shim = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
  clear: () => mem.clear(),
  key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
}
beforeEach(() => {
  _ls = globalThis.localStorage; _ss = globalThis.sessionStorage
  globalThis.localStorage = shim; globalThis.sessionStorage = shim
  mem.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.runOnlyPendingTimers(); vi.useRealTimers()
  globalThis.localStorage = _ls; globalThis.sessionStorage = _ss
})

function freshStore() {
  setActivePinia(createPinia())
  const store = useClusterStore()
  // computeClusterMetrics 读 nodeList 的 allocCpu/allocMem(usedCpu/usedMem 由 refreshMetrics 按 name 注入)
  store.nodeList = [{ name: 'n1', allocCpu: 4000, allocMem: 4194304, usedCpu: null, usedMem: null, cpu: null, memory: null }]
  store.currentCluster = 'demo'
  return store
}

test('start: 立即一轮采样(2000m/4000m=50%),样本入窗并落盘', async () => {
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)   // 冲刷立即轮的微任务
  expect(store.cpuSamples.length).toBe(1)
  expect(store.cpuSamples[0].v).toBe(50)
  expect(store.memSamples[0].v).toBe(50)
  expect(store.metricsLastRefresh).not.toBeNull()
  const raw = JSON.parse(mem.get('aliangboard.metrics.demo.v1'))
  expect(raw.cpu.length).toBe(1)
  store.stopMetricsSampling()
})

test('timer: 每 10s 追加一个样本', async () => {
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(store.cpuSamples.length).toBe(2)
  store.stopMetricsSampling()
})

test('引用计数: start×2 → stop 一次后 timer 仍在,全部 stop 后停止', async () => {
  const store = freshStore()
  store.startMetricsSampling(); store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  store.stopMetricsSampling()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(store.cpuSamples.length).toBe(2)          // 仍有一个消费者,timer 活着
  store.stopMetricsSampling()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(store.cpuSamples.length).toBe(2)          // 全停,timer 清
})

test('恢复: localStorage 里 15 分钟内的旧样本被带回窗口', async () => {
  const now = Date.now()
  mem.set('aliangboard.metrics.demo.v1', JSON.stringify({
    cpu: [{ t: now - 60_000, v: 42 }, { t: now - 20 * 60_000, v: 99 }],   // 1min 新鲜 + 20min 陈旧
    mem: [],
  }))
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  // 陈旧 99 被滤;恢复 42 + 立即轮新样本 50
  expect(store.cpuSamples.map(s => s.v)).toEqual([42, 50])
  store.stopMetricsSampling()
})

test('后台暂停: document.hidden 时跳过该轮', async () => {
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  expect(store.cpuSamples.length).toBe(1)
  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.cpuSamples.length).toBe(1)        // hidden 轮跳过
  } finally {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  }
  await vi.advanceTimersByTimeAsync(10_000)
  expect(store.cpuSamples.length).toBe(2)
  store.stopMetricsSampling()
})

test('sampleNow: 手动单次采样(供刷新按钮)', async () => {
  const store = freshStore()
  await store.sampleNow()
  expect(store.cpuSamples.length).toBe(1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/stores/__tests__/cluster.metrics-sampler.test.js`
Expected: FAIL —`store.startMetricsSampling is not a function`

- [ ] **Step 3: 在 `src/stores/cluster.js` 的 `refreshMetrics` 函数之后插入采样器段**

```js
  // === 集群指标采样(全局共享,15min 窗口按集群持久化) ===
  // ClusterOverview/MonitoringCenter 引用计数共享:切页不清零、不双倍轮询;
  // 恢复窗口来自 localStorage,图表首屏即有最近 15 分钟历史。
  const cpuSamples = ref([])
  const memSamples = ref([])
  const metricsSampling = ref(false)
  const metricsLastRefresh = ref(null)
  let metricsTimer = null
  let metricsConsumers = 0
  let metricsVisListener = null

  function metricsStorageKey() {
    return currentCluster.value ? `aliangboard.metrics.${encodeURIComponent(currentCluster.value)}.v1` : null
  }
  function persistMetricsWindow() {
    const key = metricsStorageKey()
    if (!key) return
    try { localStorage.setItem(key, JSON.stringify(persistPayload(cpuSamples.value, memSamples.value))) } catch { /* 配额/隐私模式:退化为会话内窗口 */ }
  }
  // 从 localStorage 恢复当前集群窗口(切集群/首个消费者上线时调用)
  function reloadMetricsWindow() {
    const key = metricsStorageKey()
    let cpu = [], mem = []
    if (key) {
      try {
        const raw = JSON.parse(localStorage.getItem(key) || 'null')
        const now = Date.now()
        cpu = restoreSamples(raw?.cpu, { now })
        mem = restoreSamples(raw?.mem, { now })
      } catch { cpu = []; mem = [] }
    }
    cpuSamples.value = cpu
    memSamples.value = mem
  }
  async function metricsTick() {
    if (document.hidden) return
    metricsSampling.value = true
    try {
      await refreshMetrics()
      const now = Date.now()
      const cpu = cluster.value.cpuUsage
      const mem = cluster.value.memoryUsage
      if (cpu != null) cpuSamples.value = pushSample(cpuSamples.value, { t: now, v: cpu })
      if (mem != null) memSamples.value = pushSample(memSamples.value, { t: now, v: mem })
      if (cpu != null || mem != null) {
        metricsLastRefresh.value = now
        persistMetricsWindow()
      }
    } finally { metricsSampling.value = false }
  }
  function startMetricsSampling() {
    metricsConsumers++
    if (metricsConsumers === 1) {
      reloadMetricsWindow()
      metricsVisListener = () => { if (!document.hidden && metricsTimer) metricsTick() }
      document.addEventListener('visibilitychange', metricsVisListener)
      metricsTick()   // 立即一轮(不 await)
      metricsTimer = setInterval(metricsTick, 10000)
    }
  }
  function stopMetricsSampling() {
    metricsConsumers = Math.max(0, metricsConsumers - 1)
    if (metricsConsumers === 0) {
      if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null }
      if (metricsVisListener) { document.removeEventListener('visibilitychange', metricsVisListener); metricsVisListener = null }
    }
  }
  function sampleNow() { return metricsTick() }
```

同文件三处接线:
1. **import 区**(与 `deriveClusterCounts` 相邻):`import { pushSample, restoreSamples, persistPayload } from '@/logic/metricsWindow'`
2. **`switchCluster`**(在 `currentCluster.value = c.name` 之后一行):`reloadMetricsWindow()`
3. **`setConnectedCluster`**(在 `currentCluster.value = name` 之后一行):`reloadMetricsWindow()`
4. **return 块**(与 `refreshMetrics,` 相邻):

```js
    refreshMetrics,
    // 全局指标采样(引用计数 + localStorage 持久化)
    cpuSamples, memSamples, metricsSampling, metricsLastRefresh,
    startMetricsSampling, stopMetricsSampling, sampleNow,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/stores/__tests__/cluster.metrics-sampler.test.js`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add src/stores/cluster.js src/stores/__tests__/cluster.metrics-sampler.test.js
git commit -m "feat(metrics): store 全局采样器(引用计数 timer/持久化/恢复/后台暂停)"
```

---

### Task 5: 两视图迁移到全局采样器

**Files:**
- Modify: `src/views/ClusterOverview.vue:50-65,143-160`、`src/views/MonitoringCenter.vue:42-61,99-104,120,129`

**Interfaces:**
- Consumes: store 的 `cpuSamples/memSamples/metricsSampling/metricsLastRefresh/startMetricsSampling/stopMetricsSampling/sampleNow`(Task 4)、AreaLineChart `samples` prop(Task 3)。

- [ ] **Step 1: ClusterOverview.vue**

1. 删除 50-65 行整个采样块(`cpuSeries/memSeries/SAMPLE_MAX/metricsTimer/tick/onMounted/onUnmounted`),替换为:

```js
// 全局指标采样:store 引用计数(与 MonitoringCenter 共享),15min 窗口切页不清零
onMounted(() => store.startMetricsSampling())
onUnmounted(() => store.stopMetricsSampling())
```

2. import 行 `import { ref, computed, onMounted, onUnmounted } from 'vue'` → 若 `ref` 再无使用则删掉 `ref`(grep 确认)。
3. 模板两处(`<div class="h-32 w-full">` 内):`<AreaLineChart :series="cpuSeries" color="primary" unit="%" :height="128" />` → `:samples="store.cpuSamples"`;`:series="memSeries"` 同理 → `:samples="store.memSamples"`。

- [ ] **Step 2: MonitoringCenter.vue**

1. 删除 42-61 行采样块,替换为:

```js
// 全局指标采样:store 引用计数(与 ClusterOverview 共享);lastRefresh 由 store 维护
const lastRefresh = computed(() => store.metricsLastRefresh ? new Date(store.metricsLastRefresh).toLocaleTimeString() : '')
onMounted(() => { store.startMetricsSampling(); store.startEventWatch() })
onUnmounted(() => { store.stopMetricsSampling(); store.stopEventWatch() })
```

2. 手动刷新按钮:`@click="tick" :disabled="sampling"` → `@click="store.sampleNow()" :disabled="store.metricsSampling"`;图标 spin 条件 `sampling` → `store.metricsSampling`。
3. 模板两处 sparkline:`<AreaLineChart :series="cpuSeries" … />` → `:samples="store.cpuSamples"`;`:series="memSeries"` → `:samples="store.memSamples"`(spark 模式对 samples 路径无效——time 版无 spark 分支,视觉上 48px 高 + 无网格由 time 版 grid/轴线配置天然满足,去掉 `spark` 属性)。
4. import 行清理:`ref` 若再无使用则删;`onMounted/onUnmounted` 保留。

- [ ] **Step 3: 验证**

Run: `npx vitest run src/views/__tests__/_allViewsMount.test.js && npx vitest run src/stores/__tests__/cluster.metrics-sampler.test.js && npm run typecheck`
Expected: 全过

- [ ] **Step 4: Commit**

```bash
git add src/views/ClusterOverview.vue src/views/MonitoringCenter.vue
git commit -m "feat(metrics): 概览/监控中心迁全局采样器(删本地双采样块)"
```

---

### Task 6: 全量验证 + 手工 QA

**Files:**
- 无新文件(验证任务;发现问题就地修)

- [ ] **Step 1: 全量四绿**

```bash
npm test && npm run typecheck && npm run build && npm run i18n:check
```

- [ ] **Step 2: 手工 QA 清单**(需集群;无集群时 dev server 目检降级,同图表美化任务先例)

- 打开 `/cluster`:图表**立即**渲染(若 localStorage 有历史)或 ~20s 后出图(首次);等 30s 确认曲线右端增长。
- 切到 `/monitoring`:两图**不清零**(共享窗口);KPI sparkline 有 tooltip;手动刷新按钮可用且 spin 正常。
- 刷新页面:图表立即带出最近 15 分钟历史(时间轴真实间隔)。
- 切换集群:窗口换成新集群自己的历史(无则空态)。
- 后台标签页 1 分钟再回:恢复采样,空档在时间轴上如实断开/连线。
- DevTools → Application → Local Storage:`aliangboard.metrics.<集群名>.v1` 存在且 ≤180 样本/侧。

- [ ] **Step 3: Commit(如有修复)**

```bash
git add -A && git commit -m "fix(metrics): 全量验证收尾"
```

---

## Self-Review 记录

- **Spec 覆盖**:纯模块(Task 1)、time builder+formatRelTime(Task 2)、samples prop(Task 3)、store 引用计数/持久化/恢复/visibility/集群切换/sampleNow(Task 4)、两视图迁移+手动刷新改造(Task 5)、边界(metrics-server 静默=refreshMetrics 既有行为;localStorage 异常=catch 退化;首用 ~20s 空态)与测试策略(Task 6)。Pod 级/网关侧记录=明确不动。✓
- **占位符**:无 TBD/TODO;所有测试/实现步骤都带完整代码。✓
- **类型一致性**:`Sample={t,v}`、`pushSample/restoreSamples/persistPayload` 签名 Task 1↔4 一致;`formatRelTime/buildTimeAreaLineOption` Task 2↔3 一致;store 新成员名 Task 4↔5 一致。✓
