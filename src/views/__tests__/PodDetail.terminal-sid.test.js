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

// === 手机适配 Wave 2 Task 4:手机档头部按钮触控目标 + 底部止血条 ===
// 止血条(重启/删除)必须复用 askRestart/askDelete → ConfirmDialog 二次确认不放松(spec 红线);
// 桌面/iPad 档零回归:无止血条、既有用例断言零改动。
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

test('手机档:头部按钮 40px 触控目标;底部止血条(重启/删除)在场且点击走既有确认弹窗', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountDetail()
    // 头部既有按钮(导出/删除/重启)在手机档获得 min-h-40px 触控目标
    const headerBtns = w.findAll('.mb-lg button')
    expect(headerBtns.length).toBeGreaterThan(0)
    for (const b of headerBtns) expect(b.classes().join(' ')).toContain('max-sm:min-h-[40px]')
    // 止血条在场:恰好 重启/删除 两钮
    const bar = w.find('[data-testid="pod-action-bar"]')
    expect(bar.exists()).toBe(true)
    const barBtns = bar.findAll('button')
    expect(barBtns.length).toBe(2)
    // 点击重启钮 → 走既有 askRestart(confirmOpen=true,shallow 桩 Modal 收到 modelValue),非直接执行
    await barBtns[0].trigger('click')
    const modals = w.findAllComponents({ name: 'Modal' })
    expect(modals.length).toBeGreaterThan(0)
    expect(modals.some(m => m.attributes('modelvalue') === 'true' || m.props('modelValue') === true)).toBe(true)
    w.unmount()
  } finally { spy.mockRestore() }
})

test('桌面档:无底部止血条(零回归)', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountDetail()
    expect(w.find('[data-testid="pod-action-bar"]').exists()).toBe(false)
    w.unmount()
  } finally { spy.mockRestore() }
})
