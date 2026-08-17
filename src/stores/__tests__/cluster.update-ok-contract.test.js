import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// makeCrud.update 的 {ok} 契约:remoteUpdate/remotePatch 失败时吞异常(内部已 toast),
// 必须以 {ok:false} 返回,让调用方(saveAddPort 等)不再无条件报成功。
// 对齐 add/delete 已有的 {ok} 契约。

const applyYaml = vi.fn(async () => ({ resources: [], applied: [], failed: [], total: 0 }))
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
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

const getQueryData = vi.fn(() => [])
const invalidateQueries = vi.fn()
const setQueryData = vi.fn()
vi.mock('@/queryClient', () => ({
  queryClient: { getQueryData, invalidateQueries, setQueryData, clear: vi.fn() },
}))

// localStorage 垫片(store setup 顶层读 localStorage)
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
  }
  globalThis.localStorage = shim
  globalThis.sessionStorage = shim
})
afterEach(() => {
  globalThis.localStorage = _ls
  globalThis.sessionStorage = _ss
})

const { useClusterStore } = await import('@/stores/cluster')

const SVC = { name: 'kind-svc', namespace: 'demo', type: 'ClusterIP', selector: { app: 'web' }, portList: [], ports: '', uid: 'u1' }
const HPA = { name: 'hpa-1', namespace: 'demo', uid: 'u2' }

let store
beforeEach(() => {
  setActivePinia(createPinia())
  store = useClusterStore()
  applyYaml.mockClear(); k8s.mockClear()
})

test('updateService:applyYaml 失败 → resolve {ok:false}(不抛、不误报)', async () => {
  getQueryData.mockReturnValue([SVC])
  applyYaml.mockRejectedValueOnce(new Error('Service "kind-svc" is invalid: spec.ports[1].name: Required value'))
  const r = await store.updateService('kind-svc', 'demo', { ports: '80:80/TCP,443:8443/TCP' })
  expect(r).toEqual({ ok: false })
})

test('updateService:applyYaml 成功 → resolve {ok:true}', async () => {
  getQueryData.mockReturnValue([SVC])
  const r = await store.updateService('kind-svc', 'demo', { ports: '80:80/TCP' })
  expect(r).toEqual({ ok: true })
})

test('updateService:缓存未命中且 fetch 兜底也失败 → resolve {ok:false, skipped:true}', async () => {
  getQueryData.mockReturnValue([])
  k8s.mockRejectedValueOnce(new Error('404')) // fetchService 走 api.k8s,失败 → cur=null
  const r = await store.updateService('kind-svc', 'demo', { ports: '80:80/TCP' })
  expect(r).toEqual({ ok: false, skipped: true })
})

test('updateHPA(patchFn 路径):k8s PATCH 失败 → resolve {ok:false}', async () => {
  getQueryData.mockReturnValue([HPA])
  k8s.mockRejectedValueOnce(new Error('patch refused'))
  const r = await store.updateHPA('hpa-1', 'demo', { min: 1, max: 5 })
  expect(r).toEqual({ ok: false })
})
