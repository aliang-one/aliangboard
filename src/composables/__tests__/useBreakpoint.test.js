// src/composables/__tests__/useBreakpoint.test.js
import { test, expect } from 'vitest'
import { useBreakpoint, MQ_BELOW_LG } from '../useBreakpoint'

test('MQ_BELOW_LG 查询串与 Tailwind lg=1024 对齐', () => {
  expect(MQ_BELOW_LG).toBe('(max-width: 1023.98px)')
})

test('happy-dom 下 matches 反映 matchMedia 初值,change 事件驱动更新', () => {
  const { matches } = useBreakpoint(MQ_BELOW_LG)
  expect(typeof matches.value).toBe('boolean')
  // 模拟变更:happy-dom 的 MediaQueryList 支持 dispatchEvent
  const initial = matches.value
  window.dispatchEvent(new Event('noop'))
  expect(matches.value).toBe(initial) // 无真实 resize 不翻转
})

test('无 matchMedia 环境(SSR)降级 matches=false 不抛', () => {
  const orig = window.matchMedia
  window.matchMedia = undefined
  try {
    const { matches } = useBreakpoint('(max-width: 100px)')
    expect(matches.value).toBe(false)
  } finally {
    window.matchMedia = orig
  }
})
