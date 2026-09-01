// 手机抽屉形态:<640 时不挂 rail 类、root 挂 drawer-mode;shell.drawerOpen 驱动 drawer-open;
// 路由跳转自动关抽屉。≥640 不挂 drawer-mode(桌面/iPad 零回归)。
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

// mount 前置:照抄 SideNavBar.rail.test.js 既有做法(store/router/i18n stub)
const { _routeObj, pushMock, _store } = vi.hoisted(() => ({
  _routeObj: { meta: { scope: 'global' }, fullPath: '/cluster', path: '/cluster', params: {} },
  pushMock: vi.fn(),
  _store: {
    cluster: { name: 'prod-cluster', version: 'v1.28.2' },
    currentNamespace: 'default',
    setNamespace: vi.fn(),
    namespaceList: [],
    fetchNamespaces: vi.fn(),
    currentCluster: 'prod-cluster',
  },
}))
const routeRef = reactive(_routeObj)
const storeMock = reactive(_store)

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => storeMock }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false, init: vi.fn(), user: null }) }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: storeMock.namespaceList }, isFetching: { value: false }, refetch: vi.fn() }),
}))

import SideNavBar from '@/components/layout/SideNavBar.vue'
import { useShellStore } from '@/stores/shell'

let matchMediaSpy
// 捕获各 query 的 change 监听器:测试可经事件路径翻转 useBreakpoint(与真实浏览器一致)
const mqListeners = new Map()
function fireChange(query, matches) {
  const cb = mqListeners.get(query)
  if (cb) cb({ matches })
}
function mockViewport(belowSm, belowLg) {
  matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)' ? belowSm : q === '(max-width: 1023.98px)' ? belowLg : false,
    addEventListener: (_ev, cb) => { mqListeners.set(q, cb) },
    removeEventListener: () => { mqListeners.delete(q) },
  }))
}

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { matchMediaSpy?.mockRestore(); document.body.innerHTML = '' })
afterEach(() => { vi.restoreAllMocks() })
// 泄漏收口:前面用例会改 route 字段/播种 namespaceList/pushMock 调用记录,逐用例还原
afterEach(() => {
  routeRef.fullPath = '/cluster'
  routeRef.path = '/cluster'
  routeRef.params = {}
  routeRef.meta.scope = 'global'
  storeMock.namespaceList.splice(0, storeMock.namespaceList.length)
  pushMock.mockClear()
})

function mountNav() {
  return mount(SideNavBar, { global: { plugins: [i18n] } })
}

test('手机档:root 挂 drawer-mode 不挂 rail;drawerOpen 驱动 drawer-open', async () => {
  mockViewport(true, true)
  const wrapper = mountNav()
  const shell = useShellStore()
  const root = wrapper.find('[data-test="sidenav-root"]')
  expect(root.exists()).toBe(true)
  expect(root.classes()).toContain('drawer-mode')
  expect(root.classes()).not.toContain('rail')
  shell.toggleDrawer()
  await Promise.resolve()
  expect(root.classes()).toContain('drawer-open')
  wrapper.unmount()
})

test('手机档:路由跳转(watch route)自动 closeDrawer', async () => {
  mockViewport(true, true)
  const wrapper = mountNav()
  const shell = useShellStore()
  shell.toggleDrawer()
  await Promise.resolve()
  expect(shell.drawerOpen).toBe(true)
  // 触发路由变化:组件 watch 的是 route.fullPath(reactive mock 可直接改)
  routeRef.fullPath = '/nodes'
  routeRef.path = '/nodes'
  await Promise.resolve()
  await Promise.resolve()
  expect(shell.drawerOpen).toBe(false)
  wrapper.unmount()
})

test('桌面档(≥1024):不挂 drawer-mode 不挂 rail', async () => {
  mockViewport(false, false)
  const wrapper = mountNav()
  const root = wrapper.find('[data-test="sidenav-root"]')
  expect(root.classes()).not.toContain('drawer-mode')
  expect(root.classes()).not.toContain('rail')
  wrapper.unmount()
})

test('跨断点:手机开抽屉→切到非手机(belowSm 变 false)自动 closeDrawer', async () => {
  mockViewport(true, true)
  const wrapper = mountNav()
  const shell = useShellStore()
  shell.toggleDrawer()
  await Promise.resolve()
  expect(shell.drawerOpen).toBe(true)
  // 经 matchMedia change 事件路径翻转 belowSm(与真实浏览器跨断点一致)
  fireChange('(max-width: 639.98px)', false)
  fireChange('(max-width: 1023.98px)', false)
  await Promise.resolve()
  await Promise.resolve()
  expect(shell.drawerOpen).toBe(false)
  wrapper.unmount()
})

test('手机档:裸 router.push 点击入口收编 navTo——ns 态锚点/坞 4 入口点已激活路由也收抽屉', async () => {
  mockViewport(true, true)
  // 切到 ns 态:渲染 cluster-anchor(头部)与停靠坞(cluster-slab/settings/activity/deploy)
  routeRef.meta.scope = 'namespace'
  routeRef.fullPath = '/ns/default/workloads'
  routeRef.path = '/ns/default/workloads'
  const wrapper = mountNav()
  const shell = useShellStore()
  shell.toggleDrawer()
  await Promise.resolve()
  expect(shell.drawerOpen).toBe(true)
  // cluster-anchor 推 '/cluster':mock router 下 fullPath 不变由 push stub 吸收,
  // 契约 = navTo 内的 closeDrawer(点击后 drawerOpen === false)
  const anchor = wrapper.find('[data-test="cluster-anchor"]')
  expect(anchor.exists()).toBe(true)
  await anchor.trigger('click')
  expect(pushMock).toHaveBeenCalled()
  expect(shell.drawerOpen).toBe(false)
  // 停靠坞 4 入口逐个重开抽屉再点,同断言
  for (const sel of ['cluster-slab', 'bottom-settings', 'bottom-activity', 'deploy-card']) {
    shell.toggleDrawer()
    await Promise.resolve()
    expect(shell.drawerOpen).toBe(true)
    const el = wrapper.find(`[data-test="${sel}"]`)
    expect(el.exists()).toBe(true)
    await el.trigger('click')
    expect(shell.drawerOpen).toBe(false)
  }
  wrapper.unmount()
  routeRef.meta.scope = 'global'
})

test('手机档:集群态底部 activity/settings 两入口收编 navTo——同路由点击也收抽屉', async () => {
  mockViewport(true, true)
  // 集群态(meta.scope=global):渲染 else 分支的两个底部入口
  const wrapper = mountNav()
  const shell = useShellStore()
  for (const sel of ['bottom-activity', 'bottom-settings']) {
    shell.toggleDrawer()
    await Promise.resolve()
    expect(shell.drawerOpen).toBe(true)
    const el = wrapper.find(`[data-test="${sel}"]`)
    expect(el.exists()).toBe(true)
    await el.trigger('click')
    expect(pushMock).toHaveBeenCalled()
    expect(shell.drawerOpen).toBe(false)
  }
  wrapper.unmount()
})

test('手机档:selectNamespace 与 onNsHomeClick 跳转入口收编 navTo——抽屉即收', async () => {
  mockViewport(true, true)
  routeRef.meta.scope = 'namespace'
  storeMock.namespaceList.push({ name: 'default', status: 'Active', pods: 3 })
  const wrapper = mountNav()
  const shell = useShellStore()
  // onNsHomeClick:currentNs=default → push NamespaceOverview,收编后应收抽屉
  shell.toggleDrawer()
  await Promise.resolve()
  await wrapper.find('[data-test="ns-home"]').trigger('click')
  expect(pushMock).toHaveBeenCalled()
  expect(shell.drawerOpen).toBe(false)
  // selectNamespace:开下拉点 ns 行,同样收抽屉
  shell.toggleDrawer()
  await Promise.resolve()
  await wrapper.find('.ns-tile').trigger('click')
  await Promise.resolve()
  const row = wrapper.find('.ns-row')
  expect(row.exists()).toBe(true)
  await row.trigger('click')
  expect(shell.drawerOpen).toBe(false)
  wrapper.unmount()
  routeRef.meta.scope = 'global'
})

test('手机档:点击导航项(含已激活同路由)抽屉即收起', async () => {
  mockViewport(true, true)
  const wrapper = mountNav()
  const shell = useShellStore()
  shell.toggleDrawer()
  await Promise.resolve()
  expect(shell.drawerOpen).toBe(true)
  // mock route 停在 /cluster(首项 dashboard 已激活):点击同路由项也必须收抽屉
  const first = wrapper.findAll('.nav-item')[0]
  expect(first).toBeTruthy()
  await first.trigger('click')
  await Promise.resolve()
  expect(pushMock).toHaveBeenCalled()
  expect(shell.drawerOpen).toBe(false)
  wrapper.unmount()
})
