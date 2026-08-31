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
