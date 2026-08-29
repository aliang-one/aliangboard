// 主题运行时(2026-08-29 用户中心设计 §3.1):reactive 主题态 + 色板翻转。
// md-palette.js 保持纯数据(tailwind.config 在 node 侧 import 它,不能引 vue);
// 本模块是浏览器侧唯一入口,图表/组件统一从 activePalette/tokenHexR 取当前板 hex。
import { ref, computed } from 'vue'
import { MD_PALETTE, DARK_PALETTE, installPaletteVars } from './md-palette.js'

const THEME_KEY = 'aliangboard.theme'

export const themeMode = ref('system')        // 'light' | 'dark' | 'system'
export const systemPrefersDark = ref(false)

export const isDark = computed(() =>
  themeMode.value === 'dark' || (themeMode.value === 'system' && systemPrefersDark.value))
export const activePalette = computed(() => (isDark.value ? DARK_PALETTE : MD_PALETTE))
// 响应式取色:模板/computed 内调用,主题翻转自动触发重渲(图表重算)
export function tokenHexR(token) {
  const p = activePalette.value
  return p[token] || p.primary
}

function syncClass(doc) {
  doc.documentElement.classList.toggle('dark', isDark.value)
}

// 切模式:非法值归 system。偏好 store(setTheme)与测试均走这里。
export function applyThemeMode(mode) {
  themeMode.value = mode === 'dark' || mode === 'light' ? mode : 'system'
  if (typeof document !== 'undefined') syncClass(document)
}

// 启动初始化(main.js 调):注入双板 CSS 变量 + 读 localStorage 恢复 + 监听系统偏好。
export function initTheme(doc = (typeof document !== 'undefined' ? document : null)) {
  if (!doc) return
  installPaletteVars(doc)
  let saved = 'system'
  try { saved = localStorage.getItem(THEME_KEY) || 'system' } catch { /* 无 storage */ }
  themeMode.value = saved === 'dark' || saved === 'light' ? saved : 'system'
  const mq = doc.defaultView?.matchMedia?.('(prefers-color-scheme: dark)')
  if (mq) {
    systemPrefersDark.value = !!mq.matches
    // system 态联动;addEventListener 不存在(旧实现)时静默降级为启动时快照
    mq.addEventListener?.('change', e => { systemPrefersDark.value = e.matches; syncClass(doc) })
  }
  syncClass(doc)
}
