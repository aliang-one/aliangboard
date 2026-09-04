// src/components/layout/__tests__/TopNavBar.workbench-entry.test.js
// 工作台入口品牌胶囊(方案 C3,docs/superpowers/specs/2026-08-28-workbench-entry-prominent-design.md):
// 有文字标签(非 icon-only)、点击直达 /workbench、/workbench* 前缀激活态。
// 2026-09-04 身份舱改造:工作台与用户中心合入分隔符右侧同一枚 rounded-full 容器
// (刷新留在舱外左侧——「页面工具」与「工作区/账户」语义分区)。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'

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
vi.mock('@/stores/preferences', () => ({
  usePreferencesStore: () => ({
    theme: null,
    language: null,
    setTheme: vi.fn(),
    setLanguage: vi.fn(),
  }),
}))
vi.mock('@/composables/usePageRefresh', () => ({
  usePageRefresh: () => ({ bump: vi.fn() }),
}))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/api/client', () => ({
  api: {},
  clearSession: vi.fn(),
  getSession: () => false,
  getPlatformToken: () => null,
  workbenchApi: { summary: vi.fn().mockResolvedValue({ projects: [], totals: { projects: 0, runningConvs: 0, pendingApprovals: 0, sshSessions: 0 } }) },
}))

import TopNavBar from '../TopNavBar.vue'

const mountIt = () => mount(TopNavBar, {
  global: {
    mocks: { $t: (k) => k },
    stubs: { ConfirmDialog: true },
    plugins: [createPinia(), createI18n({ legacy: false, locale: 'zh', messages: { zh: {} } }), [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]],
  },
})
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

  it('位于刷新按钮之后,与用户中心同处一枚身份舱(分隔符右侧)', () => {
    const w = mountIt()
    const buttons = w.findAll('header button')
    const pill = findPill(w)
    const pillIdx = buttons.findIndex(b => b.attributes('aria-label') === 'nav.workbench')
    const refreshIdx = buttons.findIndex(b => b.attributes('aria-label') === 'nav.refreshPage')
    expect(pillIdx).toBeGreaterThan(-1)
    expect(refreshIdx).toBeGreaterThan(-1)
    expect(pillIdx).toBeGreaterThan(refreshIdx)
    // 同舱:胶囊容器 = 工作台段 | hairline | 用户中心段;刷新钮在舱外
    const capsule = w.find('[data-test="identity-capsule"]')
    expect(capsule.exists()).toBe(true)
    expect(capsule.element.children[0].getAttribute('data-test')).toBe('wb-pill')
    expect(capsule.element.children[1].getAttribute('data-test')).toBe('identity-hairline')
    const userTrigger = w.find('[data-testid="user-menu-trigger"]')
    expect(userTrigger.exists()).toBe(true)
    expect(capsule.element.contains(userTrigger.element)).toBe(true)
    expect(capsule.element.contains(buttons[refreshIdx].element)).toBe(false)
  })

  it('点击直达 /workbench', async () => {
    const w = mountIt()
    await findPill(w).trigger('click')
    expect(state.pushSpy).toHaveBeenCalledWith('/workbench')
  })

  it('非工作台路由:身份舱中性底色,工作台段无激活填充', () => {
    state.path = '/cluster'
    const w = mountIt()
    const capsule = w.find('[data-test="identity-capsule"]')
    expect(capsule.classes()).toContain('border-outline-variant')
    expect(capsule.classes()).toContain('bg-surface-container-low')
    expect(findPill(w).classes()).not.toContain('bg-primary-container')
  })

  it('工作台路由(含项目详情子路径):整舱着色 + 工作台段填充', () => {
    state.path = '/workbench/p1'
    const w = mountIt()
    const capsule = w.find('[data-test="identity-capsule"]')
    expect(capsule.classes()).toContain('bg-primary-container/25')
    expect(capsule.classes()).toContain('border-primary/30')
    expect(findPill(w).classes()).toContain('bg-primary-container')
  })
})
