import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ProgressBar from '../common/ProgressBar.vue'

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
