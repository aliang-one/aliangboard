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
function mockViewport(belowSm, belowLg) {
  matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((q) => ({
    matches: q === '(max-width: 639.98px)' ? belowSm : q === '(max-width: 1023.98px)' ? belowLg : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

beforeEach(() => { setActivePinia(createPinia()) })
afterEach(() => { matchMediaSpy?.mockRestore(); document.body.innerHTML = '' })

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
