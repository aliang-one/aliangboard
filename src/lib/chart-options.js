// ECharts option 纯函数构建器:不 import echarts、不碰 DOM(node 零依赖可测,scripts/test.mjs 覆盖)。
// 颜色一律收 palette token 名(如 'primary'),由 tokenHexR(响应式,随主题翻转)解析——杜绝 var() 字符串。
import { tokenHexR } from '../styles/theme.js'

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

// 平滑面积折线图(ECharts 版,替代旧 SVG 迷你图)。
// series: number[];color/refLines[].color: palette token;refLines: [{label,value,color}]。
// spark=true → KPI 卡迷你模式:无网格、无 markLine、贴边。
export function buildAreaLineOption({ series = [], color = 'primary', unit = '', refLines = [], spark = false, smooth = true, sampleIntervalSec = 10 } = {}) {
  const line = tokenHexR(color)
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
      splitLine: spark ? { show: false } : { lineStyle: { color: hexToRgba(tokenHexR('outline-variant'), 0.35), width: 1 } },
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
        lineStyle: { type: 'dashed', width: 1, color: tokenHexR(r.color) },
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
      itemStyle: { borderRadius: 5, borderColor: tokenHexR('surface-container-lowest'), borderWidth: 2 },
      data: segments.map(s => ({ name: s.status, value: s.count, itemStyle: { color: tokenHexR(STATUS_COLORS[s.status]) } })),
    }],
  }
}

// 表盘色阶(响应式:经 tokenHexR 读当前板,主题翻转自动换色)
export function gaugeLevelColor(v) {
  const color = v == null ? tokenHexR('surface-container-high')
    : v > 80 ? tokenHexR('error')
    : v > 60 ? tokenHexR('tertiary-container')
    : tokenHexR('primary')
  return color
}

// 环形表盘(ClusterOverview 节点卡 CPU 环的 ECharts 升级版):整环、渐变进度、roundCap。
// value: 0-100(自动夹取);null → 灰环空态(中心 HTML 叠加显示 '—')。
export function buildGaugeOption(value) {
  const v = (typeof value === 'number' && !isNaN(value)) ? Math.min(100, Math.max(0, value)) : null
  const color = gaugeLevelColor(v)
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
      axisLine: { roundCap: true, lineStyle: { width: 7, color: [[1, hexToRgba(tokenHexR('outline-variant'), 0.4)]] } },
      pointer: { show: false }, axisTick: { show: false }, splitLine: { show: false },
      axisLabel: { show: false }, anchor: { show: false }, detail: { show: false },
      data: [{ value: v == null ? 0 : v }],
    }],
  }
}

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
// spark=true → KPI 卡迷你模式:无网格、贴边(与 buildAreaLineOption 同语义)。
export function buildTimeAreaLineOption({ samples = [], color = 'primary', unit = '', refLines = [], spark = false, smooth = true } = {}) {
  const line = tokenHexR(color)
  const valid = (Array.isArray(samples) ? samples : []).filter(s =>
    s && typeof s === 'object' && typeof s.t === 'number' && typeof s.v === 'number' && !isNaN(s.t) && !isNaN(s.v))
  const values = valid.map(s => s.v)
  const maxVal = Math.max(1, ...values, ...refLines.map(r => Number(r.value) || 0))
  const newest = valid.length ? valid[valid.length - 1].t : 0
  const option = {
    animationDurationUpdate: 400,
    grid: spark ? { left: 0, right: 0, top: 2, bottom: 0 } : { left: 4, right: 4, top: 8, bottom: 4 },
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
      splitLine: spark ? { show: false } : { lineStyle: { color: hexToRgba(tokenHexR('outline-variant'), 0.35), width: 1 } },
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
        lineStyle: { type: 'dashed', width: 1, color: tokenHexR(r.color) },
      })),
    }
  }
  return option
}
