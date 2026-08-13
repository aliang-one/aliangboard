import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// makeCrud.add 失败(remoteCreate → {ok:false})时 sideEffects.onAdd 仍触发的回归:
// services 命名空间计数在创建失败时 +1 → 漂移。同理 remoteDeletePath 吞错后 onDelete 照跑。
const applyYaml = vi.fn()
vi.mock('@/api/client', () => ({
  api: { applyYaml: (...a) => applyYaml(...a), k8s: vi.fn(async () => ({})) },
  k8sStream: vi.fn(), portForwardApi: {},
  getSavedClusters: () => [], addSavedCluster: vi.fn(), removeSavedCluster: vi.fn(),
  setActiveToken: vi.fn(), activeApiServer: () => '', getSessionToken: () => '',
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

// localStorage 内存 shim(cluster.store-methods.test.js 同款;afterEach 必须还原)
let _ls, _ss
beforeEach(() => {
  _ls = globalThis.localStorage; _ss = globalThis.sessionStorage
  const mem = new Map()
  const shim = {
    getItem: k => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: k => mem.delete(k),
    clear: () => mem.clear(),
    key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
  globalThis.localStorage = shim; globalThis.sessionStorage = shim
  applyYaml.mockReset()
})
afterEach(() => { globalThis.localStorage = _ls; globalThis.sessionStorage = _ss })

test('add 失败 → onAdd 不触发(services 计数不漂移)', async () => {
  setActivePinia(createPinia())
  const { useClusterStore } = await import('@/stores/cluster')
  const store = useClusterStore()
  store.namespaceList = [{ name: 'default', services: 2 }]
  applyYaml.mockRejectedValueOnce(new Error('boom'))
  const r = await store.addService({ name: 'svc-x', namespace: 'default' })
  expect(r).toEqual({ ok: false })
  expect(store.namespaceList[0].services).toBe(2)
})

test('add 成功 → onAdd 触发(计数 +1)', async () => {
  setActivePinia(createPinia())
  const { useClusterStore } = await import('@/stores/cluster')
  const store = useClusterStore()
  store.namespaceList = [{ name: 'default', services: 2 }]
  applyYaml.mockResolvedValueOnce({})
  const r = await store.addService({ name: 'svc-y', namespace: 'default' })
  expect(r.ok).toBe(true)
  expect(store.namespaceList[0].services).toBe(3)
})
