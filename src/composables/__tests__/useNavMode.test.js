// src/composables/__tests__/useNavMode.test.js
import { test, expect } from 'vitest'
import { drillDirection } from '../useNavMode'

test('进入 ns = down(下钻)', () => {
  expect(drillDirection('cluster', 'namespace')).toBe('down')
})
test('返回集群 = up(上升)', () => {
  expect(drillDirection('namespace', 'cluster')).toBe('up')
})
test('未变化 = null', () => {
  expect(drillDirection('namespace', 'namespace')).toBe(null)
  expect(drillDirection('cluster', 'cluster')).toBe(null)
})
