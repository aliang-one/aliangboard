// src/components/layout/__tests__/TopNavBar.workbench-entry.test.js
// 工作台入口品牌胶囊(方案 C3,docs/superpowers/specs/2026-08-28-workbench-entry-prominent-design.md):
// 有文字标签(非 icon-only)、右区第一位(刷新之前)、点击直达 /workbench、/workbench* 前缀激活态。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'

// 可变路由状态:vi.hoisted 保证 vi.mock 工厂引用时不踩 TDZ(工厂懒执行于模块 import 期)
const state = vi.hoisted(() => ({
  path: '/cluster',
  pushSpy: vi.fn(),
}))

vi.mock('vue-router', () => ({
  useRoute: () => ({ path: state.path, params: {}, name: '' }),
  useRouter: () => ({ push: state.pushSpy }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'test',
    cluster: { name: 'test', apiServer: 'https://x', version: 'v1' },
    clusterList: [],
    clusterHealth: { severity: 'ok', reasons: [] },
    currentNamespace: '',
    namespaceList: [],
    getCurrentCluster: () => ({ name: 'test' }),
    setNamespace: vi.fn(),
    switchCluster: vi.fn(),
    stopPodWatch: vi.fn(),
    stopEventWatch: vi.fn(),
  }),
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({ user: { username: 'tester' }, isAdmin: false, logout: vi.fn() }),
}))
vi.mock('@/composables/usePageRefresh', () => ({
  usePageRefresh: () => ({ bump: vi.fn() }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/api/client', () => ({ api: {}, clearSession: vi.fn(), getSession: () => false }))

import TopNavBar from '../TopNavBar.vue'

const mountIt = () => mount(TopNavBar, { global: { mocks: { $t: (k) => k } } })
const findPill = (w) =>
  w.findAll('header button').find(b => b.attributes('aria-label') === 'nav.workbench')

describe('TopNavBar 工作台品牌胶囊', () => {
  beforeEach(() => {
    state.path = '/cluster'
    state.pushSpy.mockClear()
  })

  it('胶囊存在且有文字标签(非 icon-only)', () => {
    const w = mountIt()
    const pill = findPill(w)
    expect(pill).toBeTruthy()
    expect(pill.text()).toContain('nav.workbench')
    expect(pill.find('.material-symbols-outlined').text()).toBe('workspaces')
  })

  it('位于刷新按钮之前(右区第一位)', () => {
    const w = mountIt()
    const buttons = w.findAll('header button')
    const pillIdx = buttons.findIndex(b => b.attributes('aria-label') === 'nav.workbench')
    const refreshIdx = buttons.findIndex(b => b.attributes('aria-label') === 'nav.refreshPage')
    expect(pillIdx).toBeGreaterThan(-1)
    expect(refreshIdx).toBeGreaterThan(-1)
    expect(pillIdx).toBeLessThan(refreshIdx)
  })

  it('点击直达 /workbench', async () => {
    const w = mountIt()
    await findPill(w).trigger('click')
    expect(state.pushSpy).toHaveBeenCalledWith('/workbench')
  })

  it('非工作台路由:描边浅底默认态,无激活填充', () => {
    state.path = '/cluster'
    const w = mountIt()
    const pill = findPill(w)
    expect(pill.classes()).toContain('border-primary/40')
    expect(pill.classes()).not.toContain('bg-primary-container')
  })

  it('工作台路由(含项目详情子路径):激活态填充', () => {
    state.path = '/workbench/p1'
    const w = mountIt()
    const pill = findPill(w)
    expect(pill.classes()).toContain('bg-primary-container')
    expect(pill.classes()).toContain('border-primary')
  })
})
