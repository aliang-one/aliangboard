import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia' // shell store(手机抽屉)依赖 pinia 实例

// 回归:审计日志入口从「集群管理分组」迁到底部「活动记录」,且只此一处。
const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }))
let currentPath = '/cluster'

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentNamespace: '', // 不选 ns:底部仅常驻项;集群管理分组自动展开(v-show="clusterNavOpen || !currentNs")
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
  useRoute: () => ({ path: currentPath, params: {}, name: '' }),
  useRouter: () => ({ push: pushSpy }),
}))

import SideNavBar from '../SideNavBar.vue'

const mountIt = () => mount(SideNavBar, { global: { plugins: [createPinia()], mocks: { $t: (k) => k } } })

describe('SideNavBar 审计日志去重 + 底部 active 高亮', () => {
  it('底部存在「活动记录」入口,点击 → /audit-logs', async () => {
    const w = mountIt()
    const activity = w.find('[data-test="bottom-activity"]')
    expect(activity.exists()).toBe(true)
    await activity.trigger('click')
    expect(pushSpy).toHaveBeenCalledWith('/audit-logs')
  })

  it('集群管理分组不再渲染 Audit Logs', () => {
    const w = mountIt()
    const auditEntries = w.findAll('a').filter(a => a.text().includes('nav.auditLogs'))
    expect(auditEntries).toHaveLength(0)
  })

  it('位于 /audit-logs 时活动记录项高亮', () => {
    currentPath = '/audit-logs'
    const w = mountIt()
    const activity = w.find('[data-test="bottom-activity"]')
    expect(activity.exists()).toBe(true)
    expect(activity.classes()).toContain('bg-primary-container')
  })

  it('位于其它页时活动记录项不高亮', () => {
    currentPath = '/cluster'
    const w = mountIt()
    const activity = w.find('[data-test="bottom-activity"]')
    expect(activity.exists()).toBe(true)
    expect(activity.classes()).not.toContain('bg-primary-container')
  })
})
