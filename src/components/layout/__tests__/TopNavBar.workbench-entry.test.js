// src/components/layout/__tests__/TopNavBar.workbench-entry.test.js
// 工作台入口品牌胶囊(方案 C3,docs/superpowers/specs/2026-08-28-workbench-entry-prominent-design.md):
// 有文字标签(非 icon-only)、点击直达 /workbench、/workbench* 前缀激活态。
// 2026-09-04 身份区改造:工作台与用户中心合入分隔符右侧一块「全高流体舷板」——
// 占满顶栏右端(self-stretch + -mr-lg 贴边),非对称大圆角(左上 36 / 左下 12,右缘平直贴边)
// + 同心回声细线 + 两端渐隐 hairline;描边/渐变随 /workbench* 激活翻转
// (刷新留在板外左侧——「页面工具」与「工作区/账户」语义分区)。
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

  it('位于刷新按钮之后,与用户中心同处一块全高流体舷板(分隔符右侧)', () => {
    const w = mountIt()
    const buttons = w.findAll('header button')
    const pill = findPill(w)
    const pillIdx = buttons.findIndex(b => b.attributes('aria-label') === 'nav.workbench')
    const refreshIdx = buttons.findIndex(b => b.attributes('aria-label') === 'nav.refreshPage')
    expect(pillIdx).toBeGreaterThan(-1)
    expect(refreshIdx).toBeGreaterThan(-1)
    expect(pillIdx).toBeGreaterThan(refreshIdx)
    // 满右区:撑满头部高度(self-stretch)并抵消右内边距贴边(-mr-lg)
    const capsule = w.find('[data-test="identity-capsule"]')
    expect(capsule.exists()).toBe(true)
    expect(capsule.classes()).toContain('self-stretch')
    expect(capsule.classes()).toContain('-mr-lg')
    // 流动轮廓:非对称大圆角(左上 36 / 左下 12;右缘贴边平直),无直角斜切
    expect(capsule.classes()).toContain('rounded-tl-[36px]')
    expect(capsule.classes()).toContain('rounded-bl-[12px]')
    // 同心回声细线(与外描边平行的内弧)
    expect(capsule.find('[data-test="identity-echo"]').classes().join(' ')).toContain('border')
    // 内容行 = 工作台段 | 渐隐 hairline | 用户中心段;刷新钮在板外
    const content = capsule.find('[data-test="identity-content"]')
    expect(content.element.children[0].getAttribute('data-test')).toBe('wb-pill')
    expect(content.element.children[1].getAttribute('data-test')).toBe('identity-hairline')
    expect(content.find('[data-test="identity-hairline"]').classes().join(' ')).toContain('from-transparent')
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

  it('非工作台路由:舷板中性(outline 描边 + 浅色渐变),工作台段无激活填充', () => {
    state.path = '/cluster'
    const w = mountIt()
    const capsule = w.find('[data-test="identity-capsule"]')
    expect(capsule.classes()).toContain('border-outline-variant')
    expect(capsule.classes().join(' ')).toContain('from-surface-container-low')
    expect(findPill(w).classes()).not.toContain('bg-primary-container')
  })

  it('工作台路由(含子路径):舷板激活着色(描边 primary/40 + primary-container 渐变)+ 工作台段填充', () => {
    state.path = '/workbench/p1'
    const w = mountIt()
    const capsule = w.find('[data-test="identity-capsule"]')
    expect(capsule.classes()).toContain('border-primary/40')
    expect(capsule.classes().join(' ')).toContain('from-primary-container/35')
    expect(findPill(w).classes()).toContain('bg-primary-container')
  })
})
