import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { QueryClient, VueQueryPlugin } from '@tanstack/vue-query'

// 回归:顶栏去重,仅保留刷新;通知/设置图标移除(与侧边栏重复)。
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
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/cluster', params: {}, name: '' }),
  useRouter: () => ({ push: vi.fn() }),
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
    plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh: {} } }), [VueQueryPlugin, { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }]],
  },
})

describe('TopNavBar 去重:仅留刷新', () => {
  it('已移除通知(活动记录)图标按钮', () => {
    const w = mountIt()
    expect(w.find('button[aria-label="nav.activityLog"]').exists()).toBe(false)
  })

  it('已移除设置图标按钮', () => {
    const w = mountIt()
    expect(w.find('button[aria-label="nav.settings"]').exists()).toBe(false)
  })

  it('仍保留刷新按钮', () => {
    const w = mountIt()
    expect(w.find('button[aria-label="nav.refreshPage"]').exists()).toBe(true)
  })
})
