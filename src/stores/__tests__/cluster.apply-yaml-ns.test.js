import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// === applyResourceYaml 的 defaultNs 透传测试(2026-08-28 全资源 YAML 创建 T3)===
// 断言:store.applyResourceYaml(yamlStr, opts) 把 opts.defaultNs 透传到 api.applyYaml 第二参;
// 不传 opts 时第二参 undefined(既有 ~23 个调用方行为零变化)。
// 桩区以 cluster.crud-factory.test.js 为底本复制(vi.mock '@/api/client' 全量符号 +
// vi.mock '@/queryClient' + localStorage 垫片),否则 store 导入/顶层读 localStorage 会炸。

// 桩 api/client:捕获 applyYaml (create/update) + k8s (patch/delete) 调用
const applyYaml = vi.fn(async () => ({ resources: [], applied: [{ kind: 'Service', name: 's1' }], failed: [], total: 1 }))
const k8s = vi.fn(async () => ({}))
vi.mock('@/api/client', () => ({
  api: { applyYaml, k8s },
  k8sStream: () => ({ abort() {} }),
  portForwardApi: { create: vi.fn(), remove: vi.fn(), list: vi.fn(async () => ({ forwards: [] })) },
  getSavedClusters: () => [],
  addSavedCluster: () => {},
  removeSavedCluster: () => {},
  setActiveToken: () => {},
  activeApiServer: () => '',
  getSessionToken: () => '',
}))

// 桩 queryClient：getQueryData 返回样当前对象；invalidateQueries 记录调用
const getQueryData = vi.fn(() => [])
const invalidateQueries = vi.fn()
const setQueryData = vi.fn()
vi.mock('@/queryClient', () => ({
  queryClient: { getQueryData, invalidateQueries, setQueryData, clear: vi.fn() },
}))

// localStorage 垫片（store setup 顶层读 localStorage）
let _ls, _ss
beforeEach(() => {
  _ls = globalThis.localStorage
  _ss = globalThis.sessionStorage
  const mem = new Map()
  const shim = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
    clear: () => mem.clear(),
    key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
  globalThis.localStorage = shim
  globalThis.sessionStorage = shim
  applyYaml.mockClear()
  k8s.mockClear()
  getQueryData.mockReset()
  invalidateQueries.mockClear()
  setQueryData.mockClear()
})
afterEach(() => {
  globalThis.localStorage = _ls
  globalThis.sessionStorage = _ss
})

// 延迟 import（确保 vi.mock 已注册）
const { useClusterStore } = await import('@/stores/cluster')

test('applyResourceYaml 透传 opts.defaultNs → api.applyYaml 第二参', async () => {
  setActivePinia(createPinia())
  const store = useClusterStore()
  await store.applyResourceYaml('apiVersion: v1\nkind: Service\nmetadata:\n  name: s1', { defaultNs: 'demo' })
  expect(applyYaml).toHaveBeenCalledWith('apiVersion: v1\nkind: Service\nmetadata:\n  name: s1', 'demo')
})

test('applyResourceYaml 不传 opts → api.applyYaml 第二参 undefined(现行为)', async () => {
  setActivePinia(createPinia())
  const store = useClusterStore()
  await store.applyResourceYaml('apiVersion: v1\nkind: Service\nmetadata:\n  name: s1')
  expect(applyYaml.mock.calls[0][1]).toBeUndefined()
})
