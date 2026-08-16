// src/composables/__tests__/useDeployFastPoll.test.js
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, computed, effectScope } from 'vue'
import { useDeployFastPoll, FAST_MS, SLOW_MS } from '@/composables/useDeployFastPoll'

const busyRaw = { kind: 'Deployment', spec: { replicas: 3 }, status: { readyReplicas: 1 } }
const okRaw = { kind: 'Deployment', spec: { replicas: 2 }, status: { readyReplicas: 2, updatedReplicas: 2 } }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('常量:FAST=3000 / SLOW=30000', () => {
  expect(FAST_MS).toBe(3000)
  expect(SLOW_MS).toBe(30000)
})

test('初始空数据 → fastMode false', () => {
  const src = ref([])
  const { fastMode } = useDeployFastPoll(() => src.value)
  expect(fastMode.value).toBe(false)
})

test('进行中 → 立即 true;收敛 → 保持 holdMs 后才 false', () => {
  const src = ref([okRaw])
  const { fastMode } = useDeployFastPoll(() => src.value, { holdMs: 10000 })
  expect(fastMode.value).toBe(false)
  src.value = [busyRaw]
  expect(fastMode.value).toBe(true)          // 上升沿立即
  src.value = [okRaw]
  expect(fastMode.value).toBe(true)          // 收敛后仍保持
  vi.advanceTimersByTime(9999)
  expect(fastMode.value).toBe(true)
  vi.advanceTimersByTime(1)
  expect(fastMode.value).toBe(false)         // 10s 到点回落
})

test('保持期内再次进行中 → 取消回落并维持 true;再次收敛重新计时', () => {
  const src = ref([okRaw])
  const { fastMode } = useDeployFastPoll(() => src.value, { holdMs: 10000 })
  src.value = [busyRaw]
  src.value = [okRaw]
  vi.advanceTimersByTime(6000)
  src.value = [busyRaw]                       // 保持期内又进行中
  vi.advanceTimersByTime(5000)                // 原计时早已过点但被取消
  expect(fastMode.value).toBe(true)
  src.value = [okRaw]
  vi.advanceTimersByTime(10000)               // 重新计时完整 holdMs
  expect(fastMode.value).toBe(false)
})

test('连续收敛不叠加回落 timer(不提前回落)', () => {
  const src = ref([busyRaw])
  const { fastMode } = useDeployFastPoll(() => src.value, { holdMs: 10000 })
  src.value = [okRaw]
  src.value = [...src.value]                  // 触发 watch 重算(bool 不变,不重置)
  vi.advanceTimersByTime(5000)
  src.value = [...src.value]
  vi.advanceTimersByTime(5000)
  expect(fastMode.value).toBe(false)          // 恰好 10s 回落,未被中途重置延后
})

test('作用域销毁清 timer:dispose 后推进时间无泄漏副作用', () => {
  const scope = effectScope()
  let api
  scope.run(() => {
    const src = ref([busyRaw])
    api = useDeployFastPoll(() => src.value, { holdMs: 10000 })
  })
  expect(api.fastMode.value).toBe(true)
  scope.stop()
  vi.advanceTimersByTime(60000)
  expect(api.fastMode.value).toBe(true)       // timer 已清,不再回落
})
