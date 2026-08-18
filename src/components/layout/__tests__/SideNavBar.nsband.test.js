import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import { i18n } from '@/i18n'

// 与 SideNavBar.test.js 同法:reactive route/store 供逐用例改写;真实 i18n 插件(断言翻译文案)
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

function setMode(scope, path) {
  routeRef.meta.scope = scope
  routeRef.path = path
}

describe('SideNavBar ns-band 两态契约', () => {
  it('集群态:band 挂 ns-band--cluster,ns-enter 存在,只渲染未进入/进入对', () => {
    setMode('global', '/cluster')
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    const band = w.find('.ns-band')
    expect(band.exists()).toBe(true)
    expect(band.classes()).toContain('ns-band--cluster')
    expect(w.find('[data-test="ns-enter"]').exists()).toBe(true)
    expect(band.text()).toContain('命名空间 · 未进入')
    expect(band.text()).toContain('进入命名空间')
    expect(band.text()).not.toContain('当前所在')
    expect(band.text()).not.toContain('回拓扑总览')
  })

  it('ns 态:band 挂 ns-band--ns,ns-enter 不存在,只渲染当前所在/回总览对', () => {
    setMode('namespace', '/ns/default')
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    const band = w.find('.ns-band')
    expect(band.classes()).toContain('ns-band--ns')
    expect(w.find('[data-test="ns-enter"]').exists()).toBe(false)
    expect(band.text()).toContain('命名空间 · 当前所在')
    expect(band.text()).toContain('↩ 回拓扑总览')
    expect(band.text()).not.toContain('未进入')
  })

  it('空态:名称=选择命名空间、无箭头,点 ns-home 开下拉且不跳转', async () => {
    setMode('global', '/cluster')
    storeMock.currentNamespace = null
    pushMock.mockClear()
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    const home = w.find('[data-test="ns-home"]')
    expect(home.text()).toContain('选择命名空间')
    expect(w.find('[data-test="ns-enter"]').exists()).toBe(false)
    await home.trigger('click')
    expect(pushMock).not.toHaveBeenCalled()
    expect(w.find('.ns-drop').exists()).toBe(true)
    storeMock.currentNamespace = 'default'
  })

  it('瓦片点击开/关下拉,aria-expanded 跟随', async () => {
    setMode('namespace', '/ns/default')
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    const tile = w.find('.ns-tile')
    expect(tile.attributes('aria-expanded')).toBe('false')
    await tile.trigger('click')
    expect(w.find('.ns-drop').exists()).toBe(true)
    expect(tile.attributes('aria-expanded')).toBe('true')
    await tile.trigger('click')
    expect(w.find('.ns-drop').exists()).toBe(false)
    expect(tile.attributes('aria-expanded')).toBe('false')
  })

  it('下拉行点击 → setNamespace + push NamespaceOverview + 关闭', async () => {
    setMode('namespace', '/ns/default')
    storeMock.namespaceList.splice(0, storeMock.namespaceList.length, { name: 'staging', status: 'Active', pods: 3 })
    storeMock.setNamespace.mockClear()
    pushMock.mockClear()
    const w = mount(SideNavBar, { global: { plugins: [i18n] } })
    await w.find('.ns-tile').trigger('click')
    const row = w.find('.ns-row')
    expect(row.exists()).toBe(true)
    expect(row.text()).toContain('staging')
    await row.trigger('click')
    expect(storeMock.setNamespace).toHaveBeenCalledWith('staging')
    expect(pushMock).toHaveBeenCalledWith({ name: 'NamespaceOverview', params: { namespace: 'staging' } })
    expect(w.find('.ns-drop').exists()).toBe(false)
  })
})
