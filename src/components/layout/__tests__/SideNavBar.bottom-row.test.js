import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'

// 回归:底部「事件/活动记录/设置」从整行文本项改为单行 icon-only。
// 守护:三个入口存在、各自含正确 icon、无 .text-body-sm 文本标签(icon-only)、
// 事件受 ns 作用域 gating(选中 ns 才出现)。

const { pushSpy } = vi.hoisted(() => ({ pushSpy: vi.fn() }))
let currentNs = 'default'

vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentNamespace: currentNs,
    namespaceList: [],
    currentCluster: 'demo',
    cluster: { name: 'test', version: 'v1' },
    setNamespace: vi.fn(),
    fetchNamespaces: vi.fn(),
  }),
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: false }) }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
  // 桥接:旧的 currentNs 变量驱动新的 scope 门控(测 ns=有/无 两态)
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/ns/default', params: { namespace: currentNs }, name: 'NamespaceOverview', meta: { scope: currentNs ? 'namespace' : 'global' } }),
  useRouter: () => ({ push: pushSpy }),
}))

import SideNavBar from '../SideNavBar.vue'
const mountIt = () => mount(SideNavBar, { global: { mocks: { $t: (k) => k } } })

describe('SideNavBar 底部 icon 行(事件/活动记录/设置)', () => {
  it('选中 ns:三项都在,各含正确 icon 且 icon-only(无文本标签)', () => {
    currentNs = 'default'
    const w = mountIt()
    const cases = [
      ['bottom-events', 'notifications_active'],
      ['bottom-activity', 'history'],
      ['bottom-settings', 'settings'],
    ]
    for (const [t, icon] of cases) {
      const el = w.find(`[data-test="${t}"]`)
      expect(el.exists(), `${t} 应存在`).toBe(true)
      const ic = el.find('.material-symbols-outlined')
      expect(ic.exists(), `${t} 应含 icon`).toBe(true)
      expect(ic.text(), `${t} icon 应为 ${icon}`).toBe(icon)
      expect(el.find('.text-body-sm').exists(), `${t} 应 icon-only(无文本标签)`).toBe(false)
    }
  })

  it('未选 ns:事件隐藏(ns 作用域),活动记录/设置仍在', () => {
    currentNs = ''
    const w = mountIt()
    expect(w.find('[data-test="bottom-events"]').exists()).toBe(false)
    expect(w.find('[data-test="bottom-activity"]').exists()).toBe(true)
    expect(w.find('[data-test="bottom-settings"]').exists()).toBe(true)
  })

  it('点事件 → 跳 NsEvents(ns 作用域路由)', async () => {
    currentNs = 'default'
    const w = mountIt()
    await w.find('[data-test="bottom-events"]').trigger('click')
    expect(pushSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'NsEvents', params: { namespace: 'default' } }))
  })
})
