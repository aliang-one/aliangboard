// 2026-09-08 性能批:watch 感知的大列表节流策略(纯函数表测)。
// 锁定:①五个 watch 全覆盖族 live 时拉长 staleTime + 关窗口聚焦重拉;②非 live(降级/
// 断开/未启/连接中)与 watch 外资源维持原默认(15s + 聚焦重拉),行为零变化;③pods 因
// 捆绑指标走 120s,其余四族 300s。
import { test, expect } from 'vitest'
import { watchAwareListDefaults, WATCH_THROTTLED_KINDS } from '@/composables/useK8sQuery'

const LEGACY = { staleTime: 15_000, refetchOnWindowFocus: true }

test('watch 覆盖族 live:节流生效(pods 120s,其余 300s,聚焦重拉关)', () => {
  expect(watchAwareListDefaults('pods', 'live')).toEqual({ staleTime: 120_000, refetchOnWindowFocus: false })
  for (const kind of ['events', 'workloads', 'services', 'ingresses']) {
    expect(watchAwareListDefaults(kind, 'live')).toEqual({ staleTime: 300_000, refetchOnWindowFocus: false }, `kind=${kind}`)
  }
})

test('watch 覆盖族非 live(degraded/reconnecting/off/connecting 等):维持原默认', () => {
  for (const kind of [...WATCH_THROTTLED_KINDS]) {
    for (const state of ['off', 'degraded', 'reconnecting', 'connecting', 'stopped', undefined, null]) {
      expect(watchAwareListDefaults(kind, state)).toEqual(LEGACY, `kind=${kind} state=${state}`)
    }
  }
})

test('watch 外资源(configmaps/secrets/…):任何状态都维持原默认', () => {
  for (const kind of ['configmaps', 'secrets', 'endpoints', 'hpas', 'nodes', 'namespaces', 'pvcs', 'networkpolicies', '']) {
    for (const state of ['live', 'off', 'degraded']) {
      expect(watchAwareListDefaults(kind, state)).toEqual(LEGACY, `kind=${kind} state=${state}`)
    }
  }
})
