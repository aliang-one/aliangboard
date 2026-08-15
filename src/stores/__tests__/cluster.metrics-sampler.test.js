// 全局指标采样器:引用计数 timer / 首轮立即采样 / 持久化往返 / 恢复 / 后台暂停。
// 经 mocked '@/api/client' 走真实 refreshMetrics 链路(store 内部闭包调用,无法 spy 实例方法)。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/api/client', () => {
  const nodeMetrics = { items: [{ metadata: { name: 'n1' }, usage: { cpu: '2000m', memory: '4Gi' } }] }
  const podMetrics = { items: [] }
  return {
    api: { k8s: vi.fn(async (url) => {
      if (!url.includes('metrics.k8s.io')) return {}
      return url.endsWith('/nodes') ? nodeMetrics : podMetrics
    }) },
    k8sStream: vi.fn(), portForwardApi: {},
    getSavedClusters: () => [], addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
    setActiveToken: vi.fn(), activeApiServer: () => '', getSessionToken: () => '',
  }
})

import { useClusterStore } from '@/stores/cluster'

// localStorage 内存垫(同 cluster.store-methods.test.js;afterEach 还原防污染其它套件)
let _ls, _ss
const mem = new Map()
const shim = {
  getItem: k => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: k => mem.delete(k),
  clear: () => mem.clear(),
  key: i => [...mem.keys()][i] ?? null,
  get length() { return mem.size },
}
beforeEach(() => {
  _ls = globalThis.localStorage; _ss = globalThis.sessionStorage
  globalThis.localStorage = shim; globalThis.sessionStorage = shim
  mem.clear()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.runOnlyPendingTimers(); vi.useRealTimers()
  globalThis.localStorage = _ls; globalThis.sessionStorage = _ss
})

function freshStore() {
  setActivePinia(createPinia())
  const store = useClusterStore()
  // computeClusterMetrics 读 nodeList 的 allocCpu/allocMem(usedCpu/usedMem 由 refreshMetrics 按 name 注入)
  // allocMem 单位是 Ki(mapNode 约定):8388608Ki=8Gi,usage 4Gi → 50%(brief 原稿 4194304=4Gi 会得 100%,与断言矛盾,已修)
  store.nodeList = [{ name: 'n1', allocCpu: 4000, allocMem: 8388608, usedCpu: null, usedMem: null, cpu: null, memory: null }]
  store.currentCluster = 'demo'
  return store
}

test('start: 立即一轮采样(2000m/4000m=50%),样本入窗并落盘', async () => {
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)   // 冲刷立即轮的微任务
  expect(store.cpuSamples.length).toBe(1)
  expect(store.cpuSamples[0].v).toBe(50)
  expect(store.memSamples[0].v).toBe(50)
  expect(store.metricsLastRefresh).not.toBeNull()
  const raw = JSON.parse(mem.get('aliangboard.metrics.demo.v1'))
  expect(raw.cpu.length).toBe(1)
  store.stopMetricsSampling()
})

test('timer: 每 10s 追加一个样本', async () => {
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(store.cpuSamples.length).toBe(2)
  store.stopMetricsSampling()
})

test('引用计数: start×2 → stop 一次后 timer 仍在,全部 stop 后停止', async () => {
  const store = freshStore()
  store.startMetricsSampling(); store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  store.stopMetricsSampling()
  await vi.advanceTimersByTimeAsync(10_000)
  expect(store.cpuSamples.length).toBe(2)          // 仍有一个消费者,timer 活着
  store.stopMetricsSampling()
  await vi.advanceTimersByTimeAsync(30_000)
  expect(store.cpuSamples.length).toBe(2)          // 全停,timer 清
})

test('恢复: localStorage 里 15 分钟内的旧样本被带回窗口', async () => {
  const now = Date.now()
  mem.set('aliangboard.metrics.demo.v1', JSON.stringify({
    cpu: [{ t: now - 60_000, v: 42 }, { t: now - 20 * 60_000, v: 99 }],   // 1min 新鲜 + 20min 陈旧
    mem: [],
  }))
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  // 陈旧 99 被滤;恢复 42 + 立即轮新样本 50
  expect(store.cpuSamples.map(s => s.v)).toEqual([42, 50])
  store.stopMetricsSampling()
})

test('后台暂停: document.hidden 时跳过该轮', async () => {
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  expect(store.cpuSamples.length).toBe(1)
  Object.defineProperty(document, 'hidden', { value: true, configurable: true })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    expect(store.cpuSamples.length).toBe(1)        // hidden 轮跳过
  } finally {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true })
  }
  await vi.advanceTimersByTimeAsync(10_000)
  expect(store.cpuSamples.length).toBe(2)
  store.stopMetricsSampling()
})

test('sampleNow: 手动单次采样(供刷新按钮)', async () => {
  const store = freshStore()
  await store.sampleNow()
  expect(store.cpuSamples.length).toBe(1)
})
