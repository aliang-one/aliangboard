import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 回归:点 ns 名 → 回拓扑首页(NamespaceOverview);箭头单独切 ns。
const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }))

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentNamespace: 'default',
    namespaceList: [],
    cluster: { name: 'test', version: 'v1' },
    setNamespace: vi.fn(),
  }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false }) }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/ns/default/workloads', params: { namespace: 'default' }, name: 'NsWorkloads' }),
  useRouter: () => ({ push: pushSpy }),
}))

import SideNavBar from '../SideNavBar.vue'

describe('SideNavBar ns 名回首页', () => {
  it('点击 ns 名区域 → push NamespaceOverview', async () => {
    const w = mount(SideNavBar, { global: { mocks: { $t: (k) => k } } })
    const nsHome = w.find('[data-test="ns-home"]')
    expect(nsHome.exists()).toBe(true)
    await nsHome.trigger('click')
    expect(pushSpy).toHaveBeenCalledWith({ name: 'NamespaceOverview', params: { namespace: 'default' } })
  })
})
