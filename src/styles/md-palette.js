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
