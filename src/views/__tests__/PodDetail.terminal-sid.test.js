// PodDetail 内嵌终端(#terminal tab)也必须带稳定 session-id:
// 与浮动窗口/弹窗页同源行为——网关按 sid attach 同一 tmux 会话,刷新后命令续跑。
// 此前内嵌终端不传 sessionId → 网关降级一次性 exec →「⚠ 刷新不保留」。
// 期望:sessionId 由 ns/pod/container 派生且跨挂载稳定(刷新=重挂载,id 不变才能重连)。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { namespace: 'ns1', name: 'pod-a' }, query: {}, hash: '#terminal', path: '/', meta: {} }),
  useRouter: () => ({ push: () => {}, replace: () => {}, go: () => {}, back: () => {} }),
  onBeforeRouteLeave: () => {},
  onBeforeRouteUpdate: () => {},
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))

// API 层 Proxy 桩(与 _allViewsMount 同款):挂载期各 fetcher 全 resolved 空值,不打真实后端。
vi.mock('@/api/client', () => {
  const noop = () => {}
  const api = new Proxy({}, { get: () => () => Promise.resolve({}) })
  return {
    api,
    k8sStream: () => ({ close: noop, abort: noop }),
    portForwardApi: new Proxy({}, { get: () => () => Promise.resolve([]) }),
    registryApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    terminalApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    podFileApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    podDebugApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    pvcFileApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    cronJobApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    resourceTreeApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    workbenchApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    authApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    adminApi: new Proxy({}, { get: () => () => Promise.resolve({}) }),
    getSessionToken: () => '',
    saveSession: noop,
    clearSession: noop,
    getSession: () => null,
    getPlatformToken: () => '',
    savePlatformToken: noop,
    clearPlatformToken: noop,
    exportYaml: noop,
    getSavedClusters: () => [],
    addSavedCluster: noop,
    removeSavedCluster: noop,
    setActiveToken: noop,
    activeApiServer: () => '',
    execStream: () => ({ close: noop }),
  }
})

import PodDetail from '@/views/PodDetail.vue'

// InteractiveTerminal 桩:捕获 session-id(真组件会开 WS)
const sidSeen = []
const TermStub = defineComponent({
  props: ['podName', 'namespace', 'container', 'sessionId', 'attach', 'autoConnect'],
  template: '<div data-testid="term-stub"></div>',
  mounted() { sidSeen.push(this.sessionId) },
})

// localStorage/sessionStorage shim(happy-dom 此配置 getItem 非 fn,与 _allViewsMount 同因)
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
})
afterEach(() => {
  globalThis.localStorage = _ls
  globalThis.sessionStorage = _ss
})

async function mountDetail() {
  sidSeen.length = 0
  setActivePinia(createPinia())
  const w = mount(PodDetail, {
    shallow: true,
    global: {
      plugins: [i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]],
      stubs: { RouterLink: true, RouterView: true, InteractiveTerminal: TermStub },
    },
  })
  await new Promise(r => setTimeout(r, 0))   // 等 hash watch(immediate) + Vue Query 首帧
  return w
}

test('内嵌终端 session-id 由 ns/pod/container 派生,非空', async () => {
  const w = await mountDetail()
  expect(sidSeen.length).toBeGreaterThan(0)
  expect(sidSeen[0]).toBeTruthy()
  expect(sidSeen[0]).toContain('ns1')
  expect(sidSeen[0]).toContain('pod-a')
  w.unmount()
})

test('同一 pod 重复挂载(=刷新)得到同一 session-id → 才能重连同 tmux 会话', async () => {
  const w1 = await mountDetail()
  const first = sidSeen[0]
  w1.unmount()
  await mountDetail()
  expect(sidSeen[0]).toBe(first)
})
