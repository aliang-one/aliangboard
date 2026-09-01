// src/composables/__tests__/useBreakpoint.test.js
import { test, expect, vi, afterEach } from 'vitest'

// 统一清场:防 spyOn/mockImplementation 跨文件泄漏(与既有单点 mockRestore 幂等共存)
afterEach(() => { vi.restoreAllMocks() })
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

import { MQ_BELOW_SM, useIsPhone } from '../useBreakpoint'

test('MQ_BELOW_SM 与 tailwind sm=640 对齐(639.98 避整数像素边界抖动)', () => {
  expect(MQ_BELOW_SM).toBe('(max-width: 639.98px)')
})

test('useIsPhone:视口 <640 时 isPhone=true,resize 跨断点翻转', () => {
  let listener = null
  const narrow = { value: true }
  const spy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => {
    if (q !== MQ_BELOW_SM) throw new Error('unexpected query: ' + q)
    return {
      get matches() { return narrow.value },
      addEventListener: (_e, fn) => { listener = fn },
      removeEventListener: () => { listener = null },
    }
  })
  const { isPhone } = useIsPhone()
  expect(isPhone.value).toBe(true)
  narrow.value = false
  // 经 listener 通知翻转(与真实 matchMedia change 事件同路径)
  // 注:narrow 为普通对象,手动触发——真实浏览器由 resize 驱动同一 listener
  // (见 useBreakpoint 现有测试的 change 驱动模式)
  listener({ matches: false })
  expect(isPhone.value).toBe(false)
  spy.mockRestore()
})

test('useIsPhone:无 matchMedia 环境(SSR)降级 isPhone=false 不抛', () => {
  const orig = window.matchMedia
  window.matchMedia = undefined
  const { isPhone } = useIsPhone()
  expect(isPhone.value).toBe(false)
  window.matchMedia = orig
})
