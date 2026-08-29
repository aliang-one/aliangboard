// 暗色板键集必须与亮色板逐键对齐(缺键 = 暗色下某 token 回落亮色值,视觉穿帮)。
import { test, expect } from 'vitest'
import { MD_PALETTE, DARK_PALETTE, hexToRgbTriplet, paletteVarsCss } from '../md-palette'

test('DARK_PALETTE 与 MD_PALETTE 键集逐一对齐', () => {
  expect(Object.keys(DARK_PALETTE).sort()).toEqual(Object.keys(MD_PALETTE).sort())
  for (const [k, v] of Object.entries(DARK_PALETTE)) expect(v, `key ${k}`).toMatch(/^#[0-9a-f]{6}$/i)
})

test('hexToRgbTriplet:hex → 空格三元组;非法输入回 0 0 0', () => {
  expect(hexToRgbTriplet('#006c49')).toBe('0 108 73')
  expect(hexToRgbTriplet('#ffffff')).toBe('255 255 255')
  expect(hexToRgbTriplet('ba1a1a')).toBe('186 26 26')
  expect(hexToRgbTriplet('nope')).toBe('0 0 0')
  expect(hexToRgbTriplet(undefined)).toBe('0 0 0')
})

test('paletteVarsCss::root 注入亮色三元组,.dark 注入暗色覆盖', () => {
  const css = paletteVarsCss()
  expect(css).toContain(':root{--md-sys-color-surface:248 249 255;')
  expect(css).toContain('.dark{--md-sys-color-surface:17 20 24;')
  expect(css).not.toContain('#006c49', '三元组化后不再有裸 hex')
})

test('亮板关键 token 的三元组值锁定(防手滑改错导致亮色视觉漂移)', () => {
  expect(hexToRgbTriplet(MD_PALETTE.primary)).toBe('0 108 73')
  expect(hexToRgbTriplet(MD_PALETTE.surface)).toBe('248 249 255')
  expect(hexToRgbTriplet(DARK_PALETTE.surface)).toBe('17 20 24')
})
