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
import { api } from '@/api/client'

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
// metrics mock 默认实现(与 vi.mock 工厂一致):节点名可控,供竞态测试按需覆写。
const nodeMetricsFor = (name) => ({ items: [{ metadata: { name }, usage: { cpu: '2000m', memory: '4Gi' } }] })
const defaultK8s = async (url) => {
  if (!url.includes('metrics.k8s.io')) return {}
  return url.endsWith('/nodes') ? nodeMetricsFor('n1') : { items: [] }
}
beforeEach(() => {
  _ls = globalThis.localStorage; _ss = globalThis.sessionStorage
  globalThis.localStorage = shim; globalThis.sessionStorage = shim
  mem.clear()
  api.k8s.mockImplementation(defaultK8s)
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

// === 最终审查修复波:切集群竞态双守卫 + 降级持久化 + 孤儿 key + 重入 ===

// 手动 Promise 门:延迟 resolve 的 api mock 用
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
function twoClusters(store) {
  store.savedClusters = [
    { name: 'demo', apiServer: 'https://demo', token: 't1' },
    { name: 'other', apiServer: 'https://other', token: 't2' },
  ]
}

test('竞态 A(epoch): tick 挂起间切集群,恢复后旧集群值不进新窗口/新 key', async () => {
  const store = freshStore()
  twoClusters(store)
  const pending = deferred()
  api.k8s.mockImplementation(async (url) => {
    if (url.includes('metrics.k8s.io')) return pending.promise   // metrics 悬置;hydrate 正常返回
    return {}
  })
  const tickPromise = store.sampleNow()        // tick 进入 await refreshMetrics 挂起
  expect(store.metricsSampling).toBe(true)
  const swPromise = store.switchCluster('https://other')   // 挂起间切集群(reloadMetricsWindow → epoch++)
  await vi.advanceTimersByTimeAsync(0)
  expect(store.currentCluster).toBe('other')
  pending.resolve(nodeMetricsFor('n1'))        // 旧集群节点数据此刻才 resolve
  await tickPromise
  await swPromise
  // 无守卫时:旧值 50 会被推入 'other' 的新窗口并持久化到新 key
  expect(store.cpuSamples).toEqual([])
  expect(mem.has('aliangboard.metrics.other.v1')).toBe(false)
  expect(store.metricsLastRefresh).toBeNull()
})

test('竞态 B(hold): hydrate 未换血前 tick 被挡,hydrate 完成后采样恢复', async () => {
  const store = freshStore()
  twoClusters(store)
  const hydrateGate = deferred()
  api.k8s.mockImplementation(async (url) => {
    if (url.includes('metrics.k8s.io')) return url.endsWith('/nodes') ? nodeMetricsFor('x1') : { items: [] }  // 新集群节点名 x1
    if (url === '/api/v1/namespaces') return hydrateGate.promise   // 悬置切集群水合(nodeList 未换血)
    return {}
  })
  const swPromise = store.switchCluster('https://other')
  await vi.advanceTimersByTimeAsync(0)
  expect(store.currentCluster).toBe('other')
  // 此刻 nodeList 仍是旧集群节点(n1);新集群 metrics(节点 x1)与之不匹配 → 无守卫会算出 0% 并持久化
  await store.sampleNow()
  expect(store.cpuSamples).toEqual([])
  expect(mem.has('aliangboard.metrics.other.v1')).toBe(false)
  // 水合完成 → hold 释放,采样恢复(不永久卡死)
  hydrateGate.resolve({ items: [] })
  await swPromise
  store.nodeList = [{ name: 'x1', allocCpu: 4000, allocMem: 8388608, usedCpu: null, usedMem: null, cpu: null, memory: null }]
  await store.sampleNow()
  expect(store.cpuSamples.length).toBe(1)
  expect(store.cpuSamples[0].v).toBe(50)
})

test('切窗口重载时 metricsLastRefresh 清空(残留不跨集群)', async () => {
  const store = freshStore()
  twoClusters(store)
  await store.sampleNow()                     // demo: lastRefresh 置位
  expect(store.metricsLastRefresh).not.toBeNull()
  await store.switchCluster('https://other')  // reloadMetricsWindow → lastRefresh=null
  expect(store.metricsLastRefresh).toBeNull()
})

test('降级持久化: 同集群重启采样不清窗(隐私模式/配额下导航)', async () => {
  const store = freshStore()
  store.startMetricsSampling()
  await vi.advanceTimersByTimeAsync(0)
  expect(store.cpuSamples.length).toBe(1)
  store.stopMetricsSampling()
  mem.delete('aliangboard.metrics.demo.v1')   // 模拟隐私模式:盘上读不回
  store.startMetricsSampling()                // 导航再进:同集群,窗口延续而非清零
  await vi.advanceTimersByTimeAsync(0)
  expect(store.cpuSamples.length).toBe(2)
  store.stopMetricsSampling()
})

test('孤儿 key: removeSavedClusterStore 连带删该集群的 metrics 持久化 key', () => {
  mem.set('aliangboard.metrics.demo.v1', JSON.stringify({ cpu: [], mem: [] }))
  mem.set('aliangboard.metrics.other.v1', JSON.stringify({ cpu: [], mem: [] }))
  const store = freshStore()
  twoClusters(store)
  store.removeSavedClusterStore('https://demo')
  expect(mem.has('aliangboard.metrics.demo.v1')).toBe(false)
  expect(mem.has('aliangboard.metrics.other.v1')).toBe(true)
})

test('tick 重入守卫: 上一轮未完成时本轮直接跳过', async () => {
  const store = freshStore()
  const gate = deferred()
  api.k8s.mockImplementation(async (url) => {
    if (url.includes('metrics.k8s.io')) return gate.promise
    return {}
  })
  const first = store.sampleNow()
  await vi.advanceTimersByTimeAsync(0)        // 第一轮挂在 metrics fetch
  expect(store.metricsSampling).toBe(true)
  await store.sampleNow()                     // 慢 fetch 未完:本轮重入被守卫挡下
  gate.resolve(nodeMetricsFor('n1'))
  await first
  expect(store.cpuSamples.length).toBe(1)     // 只有第一轮的样本
})
