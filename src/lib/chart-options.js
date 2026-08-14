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

// 平滑面积折线图(ECharts 版,替代旧 canvas 迷你图)。
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
