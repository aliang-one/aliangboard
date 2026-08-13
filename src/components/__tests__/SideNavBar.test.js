import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'

const { _routeObj, pushMock } = vi.hoisted(() => ({
  _routeObj: { meta: { scope: 'global' }, path: '/cluster', params: {} },
  pushMock: vi.fn(),
}))
const routeRef = reactive(_routeObj)

vi.mock('vue-router', () => ({
  useRoute: () => routeRef,
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: '<a><slot/></a>' },
  RouterView: { template: '<div></div>' },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    cluster: { name: 'prod-cluster', version: 'v1.28.2' },
    currentNamespace: 'default',
    setNamespace: vi.fn(),
    namespaceList: [],
    fetchNamespaces: vi.fn(),
    currentCluster: 'prod-cluster',
  }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ isAdmin: false, init: vi.fn(), user: null }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] }, isFetching: { value: false }, refetch: vi.fn() }),
}))

import SideNavBar from '../layout/SideNavBar.vue'

function mountSideNavBar() {
  return mount(SideNavBar, { global: { plugins: [i18n] } })
}

test('ns mode: 集群导航组隐藏、ns 资源组显示', () => {
  routeRef.meta.scope = 'namespace'
  routeRef.path = '/ns/default'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-nav-section"]').exists()).toBe(false)
  expect(w.find('[data-test="ns-nav-section"]').exists()).toBe(true)
})

test('cluster mode: 集群导航组显示、ns 资源组隐藏', () => {
  routeRef.meta.scope = 'global'
  routeRef.path = '/cluster'
  const w = mountSideNavBar()
  expect(w.find('[data-test="cluster-nav-section"]').exists()).toBe(true)
  expect(w.find('[data-test="ns-nav-section"]').exists()).toBe(false)
})
