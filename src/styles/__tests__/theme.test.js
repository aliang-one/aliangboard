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
