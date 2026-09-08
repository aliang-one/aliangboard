// 登录落地 auto-connect 分支:连接成功 → SPA push /cluster(旧版 window.location.href
// 整页刷新 = 白屏重解析 + 守卫双网络往返,全程无反馈)。与 SelectCluster 的 SPA 化同批。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const state = vi.hoisted(() => ({ pushMock: vi.fn(), loginMock: vi.fn(), autoMock: vi.fn(), assign: vi.fn() }))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: null,
    login: (...a) => state.loginMock(...a),
    tryAutoConnect: () => state.autoMock(),
  }),
}))
vi.mock('@/stores/preferences', () => ({
  usePreferencesStore: () => ({ hydrateFromServer: vi.fn(), landingView: '', language: 'zh', setLanguage: vi.fn() }),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: state.pushMock }),
  useRoute: () => ({ query: {} }),
}))
vi.mock('@/api/client', () => ({ authApi: {}, purgeSession: vi.fn() }))

import Login from '../Login.vue'

beforeEach(() => {
  vi.spyOn(window.location, 'assign').mockImplementation(state.assign)
  state.pushMock.mockClear()
  state.assign.mockClear()
  state.loginMock.mockReset()
  state.autoMock.mockReset()
})

test('auto-connect 成功:SPA push /cluster,不走整页刷新', async () => {
  setActivePinia(createPinia())
  state.loginMock.mockResolvedValue({ token: 'tok', user: { username: 'u' }, prefs: {} })
  state.autoMock.mockResolvedValue({ token: 'k8s', cluster: { apiServer: 'https://x', version: 'v1.29' } })
  const w = mount(Login, { global: { plugins: [i18n] } })
  await w.find('input[type=text]').setValue('u')
  await w.find('input[type=password]').setValue('pw')
  await w.find('[data-testid="login-submit"]').trigger('click')
  await flushPromises()
  expect(state.pushMock).toHaveBeenCalledWith('/cluster')
  expect(state.assign).not.toHaveBeenCalled()
})

test('auto-connect 失败:push /select-cluster(原行为回归锁)', async () => {
  setActivePinia(createPinia())
  state.loginMock.mockResolvedValue({ token: 'tok', user: { username: 'u' }, prefs: {} })
  state.autoMock.mockResolvedValue(null)
  const w = mount(Login, { global: { plugins: [i18n] } })
  await w.find('input[type=text]').setValue('u')
  await w.find('input[type=password]').setValue('pw')
  await w.find('[data-testid="login-submit"]').trigger('click')
  await flushPromises()
  expect(state.pushMock).toHaveBeenCalledWith('/select-cluster')
})

test('独立页语言切换:LocaleToggle 挂载(round-2)', async () => {
  setActivePinia(createPinia())
  state.loginMock.mockResolvedValue({ token: 'tok', user: { username: 'u' }, prefs: {} })
  state.autoMock.mockResolvedValue(null)
  const w = mount(Login, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.find('[data-testid="locale-toggle"]').exists()).toBe(true)
})
