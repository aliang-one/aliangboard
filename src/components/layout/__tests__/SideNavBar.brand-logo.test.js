// 品牌铺开回归(侧边栏):集群态头部(cluster-brand)必须是 aliang-logo 品牌 img,
// 不再是绿盒 + kubernetes 通用图标。路由 meta 为空 → cluster 模式(useNavMode)。
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

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

describe('SideNavBar 集群头品牌位', () => {
  it('集群态 cluster-brand 展示 aliang-logo 品牌 img', () => {
    const w = mount(SideNavBar, { global: { mocks: { $t: (k) => k } } })
    const brand = w.find('[data-test="cluster-brand"]')
    expect(brand.exists()).toBe(true)
    expect(brand.find('img[alt="AliangBoard"]').exists()).toBe(true)
  })
})
