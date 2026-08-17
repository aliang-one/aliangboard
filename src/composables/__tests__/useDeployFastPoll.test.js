// src/composables/__tests__/useDeployFastPoll.test.js
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, effectScope } from 'vue'
import { useDeployFastPoll, FAST_MS, SLOW_MS, MAX_FAST_MS } from '@/composables/useDeployFastPoll'

const busyRaw = { kind: 'Deployment', spec: { replicas: 3 }, status: { readyReplicas: 1 } }
const okRaw = { kind: 'Deployment', spec: { replicas: 2 }, status: { readyReplicas: 2, updatedReplicas: 2 } }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

test('常量:FAST=3000 / SLOW=30000 / MAX_FAST=300000', () => {
  expect(FAST_MS).toBe(3000)
  expect(SLOW_MS).toBe(30000)
  expect(MAX_FAST_MS).toBe(300000)
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

// === 高频封顶 + 抑制态(spec 2026-08-17)===
test('封顶:持续 busy 满默认 5min → 强制回落并抑制;抑制期 rising 被忽略(短暂平静不算解除)', () => {
  const src = ref([busyRaw])
  const { fastMode } = useDeployFastPoll(() => src.value)
  expect(fastMode.value).toBe(true)
  vi.advanceTimersByTime(300000)
  expect(fastMode.value).toBe(false)        // 封顶强制回落
  src.value = [okRaw]                        // 平静 → 解除计时启动
  vi.advanceTimersByTime(5000)
  src.value = [{ ...busyRaw }]               // 5s 后又 busy → 取消解除计时,维持抑制
  vi.advanceTimersByTime(60000)
  expect(fastMode.value).toBe(false)         // 未连续平静 10s,不得解除
})

test('抑制解除:连续 10s 平静 → 重新武装;新会话有完整 5min 额度', () => {
  const src = ref([busyRaw])
  const { fastMode } = useDeployFastPoll(() => src.value)
  vi.advanceTimersByTime(300000)             // 封顶进入抑制
  src.value = [okRaw]
  vi.advanceTimersByTime(10000)              // 连续平静 10s → 解除
  src.value = [{ ...busyRaw }]
  expect(fastMode.value).toBe(true)          // 新部署正常进 fast
  vi.advanceTimersByTime(299999)
  expect(fastMode.value).toBe(true)          // 额度完整(旧 timer 已清)
  vi.advanceTimersByTime(1)
  expect(fastMode.value).toBe(false)
})

test('抖动不续命:fast 期间 busy 反复抖动不重置封顶计时', () => {
  const src = ref([busyRaw])
  const { fastMode } = useDeployFastPoll(() => src.value)
  for (let i = 0; i < 30; i++) {             // 30 轮:3s busy + 瞬时平静 + 又 busy
    vi.advanceTimersByTime(3000)
    src.value = [okRaw]
    src.value = [{ ...busyRaw }]
  }
  expect(fastMode.value).toBe(true)          // 抖动期间仍 fast(突发未断)
  vi.advanceTimersByTime(210000)             // 累计 300s → 封顶照触发
  expect(fastMode.value).toBe(false)
})
