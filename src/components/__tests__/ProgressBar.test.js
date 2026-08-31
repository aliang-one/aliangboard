import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ProgressBar from '../common/ProgressBar.vue'
import { applyThemeMode } from '@/styles/theme'
applyThemeMode('light') // 取色断言锚亮色板字面量;主题默认 auto 随运行时刻翻转,钉亮色保证昼夜一致

function fillStyle(props) {
  const w = mount(ProgressBar, { props })
  const fill = w.findAll('div').at(-1) // 最后一个 div 是填充条
  return { cls: fill.classes(), style: fill.attributes('style') || '' }
}

test('低负载: primary→primary-container 渐变、无斜纹', () => {
  const { cls, style } = fillStyle({ value: 40 })
  expect(style).toContain('width: 40%')
  expect(style).toContain('linear-gradient')
  // DOM 可能序列化为 rgb(),两种都接受(#006c49 = rgb(0,108,73))
  expect(style).toMatch(/#006c49|rgb\(0,\s*108,\s*73\)/)
  expect(cls).not.toContain('animate-bar-stripes')
})

test('高危 >80: error 渐变 + 斜纹流动类', () => {
  const { cls, style } = fillStyle({ value: 90 })
  expect(cls).toContain('animate-bar-stripes')
  expect(style).toMatch(/#ba1a1a|rgb\(186,\s*26,\s*26\)/)
  expect(style).toContain('repeating-linear-gradient')
})

test('值夹取 100;showLabel 渲染 label 与百分比', () => {
  const w = mount(ProgressBar, { props: { value: 150, showLabel: true, label: 'MEM' } })
  const fill = w.findAll('div').at(-1)
  expect(fill.attributes('style')).toContain('width: 100%')
  expect(w.text()).toContain('MEM')
  expect(w.text()).toContain('150%')
})

test('斜纹动画 keyframes: 双层 backgroundPosition,仅斜纹层位移 16.97px(整周期,消接缝)', async () => {
  const { default: tw } = await import('../../../tailwind.config.js')
  const kf = tw.theme.extend.keyframes['bar-stripes']
  // 两层各给一值:斜纹层(第 1 层)动,渐变层(第 2 层)恒 0 0
  expect(kf['0%'].backgroundPosition).toBe('16.97px 0, 0 0')
  expect(kf['100%'].backgroundPosition).toBe('0 0, 0 0')
  // 位移量 = 斜纹周期 12px / cos45° ≈ 16.97px(整周期回绕,无相位跳变)
})
