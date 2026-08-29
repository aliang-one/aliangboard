// MD3 色板唯一来源:tailwind.config.js(展开进 colors)、:root CSS 变量注入(installPaletteVars)、
// ECharts 图表主题(src/lib/echarts.js、src/lib/chart-options.js)都从本文件取色。
// 背景:历史上 var(--md-sys-color-*) 在 18 处被使用却从未定义,图表/表格颜色静默回落为黑——
// 本模块 + main.js 的 installPaletteVars() 一并修复。修改色值只改这里。
// 注意:CSS 变量值已是 'R G B' 三元组形态——直用方须 rgb(var(--md-sys-color-x)) 包裹,fallback 也须三元组。
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

// MD3 暗色板(2026-08-29 用户中心设计 §3.1):键集与亮色严格对齐;primary-80 沿用亮板
// primary-fixed-dim,fixed 色族两主题同值(MD3 规范:fixed 色不随主题翻转)。
export const DARK_PALETTE = {
  'surface': '#111418',
  'surface-dim': '#111418',
  'surface-bright': '#37393e',
  'surface-container-lowest': '#0c0e13',
  'surface-container-low': '#191c20',
  'surface-container': '#1d2025',
  'surface-container-high': '#282a2f',
  'surface-container-highest': '#33353a',
  'on-surface': '#e2e2e9',
  'on-surface-variant': '#c0c9c4',
  'inverse-surface': '#e2e2e9',
  'inverse-on-surface': '#2e3036',
  'outline': '#8a938f',
  'outline-variant': '#3f4844',
  'surface-tint': '#4edea3',
  'primary': '#4edea3',
  'on-primary': '#003922',
  'primary-container': '#005236',
  'on-primary-container': '#6ffbbe',
  'inverse-primary': '#006c49',
  'primary-fixed': '#6ffbbe',
  'primary-fixed-dim': '#4edea3',
  'on-primary-fixed': '#002113',
  'on-primary-fixed-variant': '#005236',
  'secondary': '#c0c1ff',
  'on-secondary': '#131478',
  'secondary-container': '#2f2ebe',
  'on-secondary-container': '#e1e0ff',
  'secondary-fixed': '#e1e0ff',
  'secondary-fixed-dim': '#c0c1ff',
  'on-secondary-fixed': '#07006c',
  'on-secondary-fixed-variant': '#2f2ebe',
  'tertiary': '#ffb95f',
  'on-tertiary': '#462900',
  'tertiary-container': '#653e00',
  'on-tertiary-container': '#ffddb8',
  'tertiary-fixed': '#ffddb8',
  'tertiary-fixed-dim': '#ffb95f',
  'on-tertiary-fixed': '#2a1700',
  'on-tertiary-fixed-variant': '#653e00',
  'error': '#ffb4ab',
  'on-error': '#690005',
  'error-container': '#93000a',
  'on-error-container': '#ffdad6',
  'status-running': '#34d399',
  'status-pending': '#fbbf24',
  'status-failed': '#f87171',
  'status-succeeded': '#60a5fa',
  'status-unknown': '#9ca3af',
}

// token → hex;未知 token 回落 primary(宁可用主题绿也不用黑/undefined)
export function tokenHex(token) {
  return MD_PALETTE[token] || MD_PALETTE.primary
}

// hex → 'R G B' 空格三元组(供 rgb(var(--x) / <alpha-value>) 消费;非法回落 0 0 0)
export function hexToRgbTriplet(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return '0 0 0'
  const n = parseInt(m[1], 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

// 生成 ':root{亮色三元组}.dark{暗色三元组}'(全 token 注入;html.dark 挂类即整体翻转)
export function paletteVarsCss() {
  const block = p => Object.entries(p).map(([k, v]) => `--md-sys-color-${k}:${hexToRgbTriplet(v)};`).join('')
  return `:root{${block(MD_PALETTE)}}.dark{${block(DARK_PALETTE)}}`
}

// 幂等注入到 document.head(main.js 启动时调用一次)
export function installPaletteVars(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc || doc.getElementById('md-palette-vars')) return
  const style = doc.createElement('style')
  style.id = 'md-palette-vars'
  style.textContent = paletteVarsCss()
  doc.head.appendChild(style)
}
