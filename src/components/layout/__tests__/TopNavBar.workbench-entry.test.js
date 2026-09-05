// src/components/layout/__tests__/TopNavBar.workbench-entry.test.js
// 工作台入口品牌胶囊(方案 C3,docs/superpowers/specs/2026-08-28-workbench-entry-prominent-design.md):
// 有文字标签(非 icon-only)、点击直达 /workbench、/workbench* 前缀激活态。
// 2026-09-04 身份区改造:工作台与用户中心合入分隔符右侧一块「全高流体舷板」——
// 占满顶栏右端(self-stretch + -mr-lg 贴边),非对称大圆角(右缘平直贴边)
// + 同心回声细线 + 两端渐隐 hairline;描边/渐变随 /workbench* 激活翻转
// (刷新留在板外左侧——「页面工具」与「工作区/账户」语义分区)。
// 2026-09-04 v4 精修:轮廓加掠(左上 38 / 左下 16,回声线同心 35/13)+ 三层光照
// (顶部内高光线 / 悬停浮起 shadow-card-hover / 激活 primary 辉光)+ 一次性入场滑入
// + idle 品牌微染(primary-container/12 起笔,告别纯灰)。
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
    // 流动轮廓:非对称大圆角(左上 38 / 左下 16;右缘贴边平直),无直角斜切
    expect(capsule.classes()).toContain('rounded-tl-[38px]')
    expect(capsule.classes()).toContain('rounded-bl-[16px]')
    // 同心回声细线(与外描边平行的内弧,radius 随 3px inset 收减)
    const echo = capsule.find('[data-test="identity-echo"]').classes().join(' ')
    expect(echo).toContain('border')
    expect(echo).toContain('rounded-tl-[35px]')
    expect(echo).toContain('rounded-bl-[13px]')
    // 光照一:顶部内高光线(贴顶 1px;亮色暗发丝线/暗色白天光——白线在亮底物理上不可见,
    // left-[42px] 让出 38px 左上弧段,防悬空断线)
    const toplight = capsule.find('[data-test="identity-toplight"]')
    expect(toplight.exists()).toBe(true)
    expect(toplight.classes()).toContain('h-px')
    expect(toplight.classes().join(' ')).toContain('via-black/10')
    expect(toplight.classes().join(' ')).toContain('dark:via-white/20')
    // 光照三(入场):整板一次性滑入动画(常驻顶栏只播一次),motion-reduce 兜底
    expect(capsule.classes()).toContain('animate-panel-in')
    expect(capsule.classes()).toContain('motion-reduce:animate-none')
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

  it('非工作台路由:舷板中性但不再死灰(outline 描边 + primary-container/10 微染,暗色档换 primary/15 提可见度),工作台段无激活填充', () => {
    state.path = '/cluster'
    const w = mountIt()
    const capsule = w.find('[data-test="identity-capsule"]')
    expect(capsule.classes()).toContain('border-outline-variant')
    // v4:idle 起笔带一缕品牌色;透明度必须落在 Tailwind 刻度(5 的倍数)——/12 是幽灵类,
    // 不生成 CSS,--tw-gradient-from 缺失会让整条渐变失效成空心壳(评审实测)
    expect(capsule.classes().join(' ')).toContain('from-primary-container/10')
    expect(capsule.classes().join(' ')).toContain('dark:from-primary/15')
    expect(capsule.classes()).toContain('hover:shadow-card-hover')
    // 暗色黑影不可见:暗色档悬停换 primary 辉光同语言;idle 无激活脉冲
    expect(capsule.classes().join(' ')).toContain('dark:hover:shadow-')
    expect(capsule.classes()).not.toContain('animate-wb-pulse')
    expect(findPill(w).classes()).not.toContain('bg-primary-container')
  })

  it('工作台路由(含子路径):舷板激活着色(描边 primary/40 + primary-container 渐变 + primary 辉光)+ 工作台段填充', () => {
    state.path = '/workbench/p1'
    const w = mountIt()
    const capsule = w.find('[data-test="identity-capsule"]')
    expect(capsule.classes()).toContain('border-primary/40')
    expect(capsule.classes().join(' ')).toContain('from-primary-container/35')
    // 光照二:激活态柔和 primary 外发光(CSS 变量取色,亮暗主题自动翻转)
    expect(capsule.classes().join(' ')).toContain('rgb(var(--md-sys-color-primary)')
    // 激活瞬间:辉光泛起→回落一次性脉冲(转场批次:入口被点亮的因果感)
    expect(capsule.classes()).toContain('animate-wb-pulse')
    expect(findPill(w).classes()).toContain('bg-primary-container')
  })
})
