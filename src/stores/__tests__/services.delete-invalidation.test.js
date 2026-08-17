import { test, expect, beforeEach, afterEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { defineComponent, computed, h, nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'

// === 删除→列表同步的端到端复现(2026-08-17 「删了 service,跳回列表还能看到」) ===
// 不 mock queryClient:真 QueryClient + 真 useResourceList(useQuery)+ 真 makeCrud.delete,
// 模拟完整用户流:挂列表(2 svc)→ 卸载(去详情页)→ store.deleteService(远端 DELETE+invalidateResource)
// → 重新挂列表(路由跳回)→ 断言:被删的 svc 不在行里 + fetcher 重拉过。
// 若此链路通,说明数据模型无罪,问题在别处(如 DELETE 实际失败);若挂,即为复现。

// 桩 api/client:内存假集群。GET list → 当前 items;DELETE → 从 items 移除。
const rawSvc = (name, ns) => ({
  metadata: { name, namespace: ns, uid: `uid-${name}` },
  spec: { type: 'ClusterIP', clusterIP: '10.0.0.1', ports: [{ port: 80, targetPort: 8080, protocol: 'TCP' }], selector: { app: name } },
  status: { loadBalancer: {} },
})
let serverItems = [rawSvc('svc-a', 'ns1'), rawSvc('svc-b', 'ns1')]
const k8sCalls = []
const k8s = vi.fn(async (path, opts = {}) => {
  k8sCalls.push({ path, method: opts.method || 'GET' })
  if (opts.method === 'DELETE') {
    const m = path.match(/\/api\/v1\/namespaces\/([^/]+)\/services\/([^/]+)$/)
    if (m) serverItems = serverItems.filter(s => !(s.metadata.name === m[2] && s.metadata.namespace === m[1]))
    return { kind: 'Status', status: 'Success' }
  }
  if (path.startsWith('/api/v1/services')) return { items: serverItems }
  return { items: [] }
})
vi.mock('@/api/client', () => ({
  api: { applyYaml: vi.fn(async () => ({ resources: [], applied: [], failed: [], total: 0 })), k8s },
  k8sStream: () => ({ abort() {} }),
  portForwardApi: { create: vi.fn(), remove: vi.fn(), list: vi.fn(async () => ({ forwards: [] })) },
  getSavedClusters: () => [],
  addSavedCluster: () => {},
  removeSavedCluster: () => {},
  setActiveToken: () => {},
  activeApiServer: () => '',
  getSessionToken: () => '',
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
    key: i => [...mem.keys()][i] ?? null,
    get length() { return mem.size },
  }
  globalThis.localStorage = shim
  globalThis.sessionStorage = shim
  serverItems = [rawSvc('svc-a', 'ns1'), rawSvc('svc-b', 'ns1')]
  k8sCalls.length = 0
  k8s.mockClear()
})
afterEach(() => {
  globalThis.localStorage = _ls
  globalThis.sessionStorage = _ss
})

const { useClusterStore } = await import('@/stores/cluster')
const { queryClient } = await import('@/queryClient')
const { useResourceList } = await import('@/composables/useK8sQuery')

// 最小列表组件:复刻 NsServices 的查询装配(key 形状/fetcher 一致)
const TestList = defineComponent({
  setup() {
    const store = useClusterStore()
    const cid = computed(() => store.currentCluster || 'cluster')
    const q = useResourceList({ key: ['cluster', cid, 'services'], fetcher: () => store.fetchServices() })
    const rows = computed(() => (q.data.value || []).map(r => r.name).sort().join(','))
    return () => h('div', { class: 'rows' }, rows.value)
  },
})

function mountList() {
  return mount(TestList, { global: { plugins: [createPinia(), [VueQueryPlugin, { queryClient }]] } })
}

test('deleteService 后重挂列表:被删 svc 消失 + fetcher 重拉(真 QueryClient 端到端)', async () => {
  setActivePinia(createPinia())
  const store = useClusterStore()

  // 1. 首次进列表:拉到 svc-a,svc-b
  const w1 = mountList()
  await flushPromises()
  expect(w1.get('.rows').text()).toBe('svc-a,svc-b')

  // 2. 离开列表(去详情页)
  w1.unmount()
  await flushPromises()

  // 3. 详情页删除 svc-a:远端 DELETE + invalidateResource(真 client)
  const listCallsBefore = k8sCalls.filter(c => c.path.startsWith('/api/v1/services')).length
  const r = await store.deleteService('svc-a', 'ns1')
  expect(r.ok).toBe(true)
  expect(k8sCalls.some(c => c.method === 'DELETE' && c.path.endsWith('/namespaces/ns1/services/svc-a'))).toBe(true)

  // 4. 路由跳回列表(重新挂载):stale → refetchOnMount 重拉
  const w2 = mountList()
  await flushPromises()
  await nextTick()

  // 5. 断言:svc-a 不在;且 services list 确实重拉过(排除「服务端没删」)
  expect(w2.get('.rows').text()).toBe('svc-b')
  expect(k8sCalls.filter(c => c.path.startsWith('/api/v1/services')).length).toBeGreaterThan(listCallsBefore)
})
