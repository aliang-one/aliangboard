// 图表主题响应化:builder 输出随 activePalette 翻转;双主题注册存在。
import { test, expect } from 'vitest'
import { applyThemeMode } from '@/styles/theme'
import { MD_PALETTE, DARK_PALETTE } from '@/styles/md-palette'
import { buildEchartsTheme } from '@/lib/echarts'

test('buildEchartsTheme:亮/暗两板产出不同 tooltip 底色', () => {
  const light = buildEchartsTheme(MD_PALETTE)
  const dark = buildEchartsTheme(DARK_PALETTE)
  expect(light.tooltip.backgroundColor).toBe(MD_PALETTE['surface-container-lowest'])
  expect(dark.tooltip.backgroundColor).toBe(DARK_PALETTE['surface-container-lowest'])
  expect(dark.color[0]).toBe(DARK_PALETTE.primary)
})

test('chart-options gauge 色阶随主题翻转', async () => {
  const { gaugeLevelColor } = await import('@/lib/chart-options')
  applyThemeMode('light')
  expect(gaugeLevelColor(90)).toBe(MD_PALETTE.error)
  applyThemeMode('dark')
  expect(gaugeLevelColor(90)).toBe(DARK_PALETTE.error)
})
