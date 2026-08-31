import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'

// mountSideNav:复制自 SideNavBar.nsband.test.js 顶部的既有 mount 配置
// (store/router/i18n stub);第二参可覆盖 store.currentNamespace 初值
const { _routeObj, pushMock, _store } = vi.hoisted(() => ({
  _routeObj: { meta: { scope: 'global' }, path: '/cluster', params: {} },
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

import SideNavBar from '../SideNavBar.vue'

function mountSideNav(nsOverride) {
  if (nsOverride && 'currentNamespace' in nsOverride) storeMock.currentNamespace = nsOverride.currentNamespace
  return mount(SideNavBar, { global: { plugins: [i18n] } })
}

function belowLg() {
  return vi.spyOn(window, 'matchMedia').mockImplementation(q => ({
    matches: q.includes('1023.98'), media: q, addEventListener() {}, removeEventListener() {},
  }))
}

test('<lg:根节点挂 rail 类;≥lg:不挂', () => {
  const spy = belowLg()
  const w = mountSideNav()
  expect(w.find('[data-test="sidenav-root"]').classes()).toContain('rail')
  spy.mockRestore()
  const w2 = mountSideNav()
  expect(w2.find('[data-test="sidenav-root"]').classes()).not.toContain('rail')
})

test('rail 空态点 ns 主钮 → 跳 /namespaces(72px 弹层放不下,不 extradrop)', async () => {
  const spy = belowLg()
  pushMock.mockClear()
  const w = mountSideNav({ currentNamespace: '' })
  await w.find('[data-test="ns-home"]').trigger('click')
  expect(w.find('.ns-drop').exists()).toBe(false)
  expect(pushMock).toHaveBeenCalledWith('/namespaces')
  spy.mockRestore()
  storeMock.currentNamespace = 'default'
})
