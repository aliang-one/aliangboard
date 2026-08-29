// happy-dom 提供 matchMedia;防御性:无 matchMedia 环境按 light 处理。
import { test, expect, beforeEach } from 'vitest'
import { themeMode, isDark, activePalette, tokenHexR, applyThemeMode, initTheme } from '../theme'
import { MD_PALETTE, DARK_PALETTE } from '../md-palette'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.classList.remove('dark')
  applyThemeMode('system')
  initTheme(document)
})

test('默认 system;亮色系统下 isDark=false,activePalette=亮板', () => {
  expect(themeMode.value).toBe('system')
  expect(activePalette.value).toBe(MD_PALETTE)
})

test('applyThemeMode(dark):isDark=true + html.dark + activePalette=暗板 + tokenHexR 走暗板', () => {
  applyThemeMode('dark')
  expect(isDark.value).toBe(true)
  expect(document.documentElement.classList.contains('dark')).toBe(true)
  expect(activePalette.value).toBe(DARK_PALETTE)
  expect(tokenHexR('primary')).toBe(DARK_PALETTE.primary)
})

test('applyThemeMode(light):显式亮色,即使系统偏好暗', () => {
  applyThemeMode('light')
  expect(isDark.value).toBe(false)
  expect(document.documentElement.classList.contains('dark')).toBe(false)
})

test('initTheme:从 localStorage 恢复 dark', () => {
  localStorage.setItem('aliangboard.theme', 'dark')
  applyThemeMode('system')
  initTheme(document)
  expect(themeMode.value).toBe('dark')
  expect(document.documentElement.classList.contains('dark')).toBe(true)
})

test('localStorage 坏值按 system 处理', () => {
  localStorage.setItem('aliangboard.theme', 'purple')
  initTheme(document)
  expect(themeMode.value).toBe('system')
})

test('tokenHexR:未知 token 回落当前板 primary', () => {
  applyThemeMode('dark')
  expect(tokenHexR('no-such-token')).toBe(DARK_PALETTE.primary)
})
