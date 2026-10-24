// 品牌铺开回归(侧边栏):集群态头部(cluster-brand)必须是 aliang-logo 品牌 img,
// 不再是绿盒 + kubernetes 通用图标。路由 meta 为空 → cluster 模式(useNavMode)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia' // shell store(手机抽屉)依赖 pinia 实例
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { i18n } from '@/i18n'

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentNamespace: 'default',
    namespaceList: [],
    fetchNamespaces: vi.fn(),
    cluster: { name: 'test', version: 'v1' },
    setNamespace: vi.fn(),
  }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false }) }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/cluster/x', params: {}, name: 'ClusterHome', meta: {} }),
  useRouter: () => ({ push: vi.fn() }),
}))

import SideNavBar from '../SideNavBar.vue'

beforeEach(() => {
  sessionStorage.setItem('aliangboard.session', 'test-session') // round-3:侧边栏区分无集群态,这些用例测有集群行为须声明会话
})

describe('SideNavBar 集群头品牌位', () => {
  it('集群态 cluster-brand 展示 aliang-logo 品牌 img', () => {
    // Task 7 起侧栏装真实子组件(SideNavSearch/WorkbenchNavItem/UserMenu/AlertBell):
    // useI18n 须 i18n 插件、useQuery 须 VueQueryPlugin
    const w = mount(SideNavBar, {
      global: {
        plugins: [createPinia(), i18n, [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]],
        mocks: { $t: (k) => k },
      },
    })
    const brand = w.find('[data-test="cluster-brand"]')
    expect(brand.exists()).toBe(true)
    expect(brand.find('img[alt="AliangBoard"]').exists()).toBe(true)
  })
})
