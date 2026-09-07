// W3 Task 4:登录二步(MFA)。密码步返 {mfaRequired,mfaTicket} → 二步表单(验证码/恢复码一框)
// → mfaLogin 成功 → 复用既有落地逻辑(store 直写 + redirect/landing/auto-connect);
// 401(票据读即删,错码也消费)→ 行内提示 + 回密码表单重新走密码步取新票。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const state = vi.hoisted(() => ({ query: {}, assign: vi.fn(), push: vi.fn() }))
const authMocks = vi.hoisted(() => ({
  login: vi.fn(),
  mfaLogin: vi.fn(),
  logout: vi.fn(),
  connectCluster: vi.fn(),
}))

// 真 auth/preferences store + mock client:覆盖 mfaLogin 新方法;purgeSession 是 store.login 副作用
vi.mock('@/api/client', () => ({
  authApi: authMocks,
  purgeSession: vi.fn(),
  clearSession: vi.fn(), clearStashedSession: vi.fn(), saveSession: vi.fn(),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: state.push }),
  useRoute: () => ({ query: state.query }),
}))

import Login from '@/views/Login.vue'
import { useAuthStore } from '@/stores/auth'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  state.query = {}
  state.assign.mockClear()
  state.push.mockClear()
  localStorage.clear()
  vi.spyOn(window.location, 'assign').mockImplementation(state.assign)
})

function mountView() { return mount(Login, { global: { plugins: [i18n] } }) }
const submit = w => w.findAll('button').find(b => b.text().includes('登录'))

async function passwordStep(w, { username = 'admin', password = 'pw' } = {}) {
  await w.find('input[type=text]').setValue(username)
  await w.find('input[type=password]').setValue(password)
  await submit(w).trigger('click')
  await flushPromises()
}

test('密码步 mfaRequired → 渲染二步表单(单输入框),mfaLogin 未发', async () => {
  authMocks.login.mockResolvedValue({ mfaRequired: true, mfaTicket: 'tk-1' })
  const w = mountView()
  await passwordStep(w)
  expect(w.find('[data-testid="mfa-step-input"]').exists()).toBe(true)
  expect(w.find('input[type=password]').exists()).toBe(false)
  expect(w.text()).toContain('admin')
  expect(authMocks.mfaLogin).not.toHaveBeenCalled()
  w.unmount()
})

test('二步成功:mfaLogin(username,ticket,code) → 建 session(token/user/localStorage)并落地选择页', async () => {
  authMocks.login.mockResolvedValue({ mfaRequired: true, mfaTicket: 'tk-1' })
  authMocks.mfaLogin.mockResolvedValue({ token: 'tok-1', user: { id: 'u1', username: 'admin', role: 'admin' }, prefs: {} })
  const w = mountView()
  await passwordStep(w)
  await w.find('[data-testid="mfa-step-input"]').setValue('123456')
  await w.find('[data-testid="mfa-step-submit"]').trigger('click')
  await flushPromises()
  expect(authMocks.mfaLogin).toHaveBeenCalledWith('admin', 'tk-1', '123456')
  const store = useAuthStore()
  expect(store.token).toBe('tok-1')
  expect(store.user?.username).toBe('admin')
  expect(localStorage.getItem('aliangboard.platform')).toBe('tok-1')
  expect(state.push).toHaveBeenCalledWith('/select-cluster')
  w.unmount()
})

test('二步 401(票据已消费):行内「重新登录」提示 + 回密码表单;再走密码步取新票', async () => {
  authMocks.login.mockResolvedValue({ mfaRequired: true, mfaTicket: 'tk-1' })
  const bad = new Error('验证码错误')
  bad.status = 401
  authMocks.mfaLogin.mockRejectedValueOnce(bad)
  authMocks.mfaLogin.mockResolvedValue({ token: 'tok-2', user: { id: 'u1', username: 'admin' }, prefs: {} })
  const w = mountView()
  await passwordStep(w)
  await w.find('[data-testid="mfa-step-input"]').setValue('000000')
  await w.find('[data-testid="mfa-step-submit"]').trigger('click')
  await flushPromises()
  // 回密码表单 + 提示重新登录(票据读即删,同票重试必 401)
  expect(w.find('input[type=password]').exists()).toBe(true)
  expect(w.find('[data-testid="mfa-step-input"]').exists()).toBe(false)
  expect(w.text()).toContain(i18n.global.t('login.mfaStepInvalid'))
  // 密码步重走:新票据 tk-2,二步成功
  authMocks.login.mockResolvedValue({ mfaRequired: true, mfaTicket: 'tk-2' })
  await passwordStep(w)
  await w.find('[data-testid="mfa-step-input"]').setValue('654321')
  await w.find('[data-testid="mfa-step-submit"]').trigger('click')
  await flushPromises()
  expect(authMocks.mfaLogin).toHaveBeenLastCalledWith('admin', 'tk-2', '654321')
  expect(useAuthStore().token).toBe('tok-2')
  w.unmount()
})

test('二步空码:客户端拦截不发请求', async () => {
  authMocks.login.mockResolvedValue({ mfaRequired: true, mfaTicket: 'tk-1' })
  const w = mountView()
  await passwordStep(w)
  await w.find('[data-testid="mfa-step-submit"]').trigger('click')
  await flushPromises()
  expect(authMocks.mfaLogin).not.toHaveBeenCalled()
  expect(w.find('[data-testid="mfa-step-input"]').exists()).toBe(true)
  w.unmount()
})

test('密码步 mfaRequired 后清理伪 token:localStorage 不残留 "undefined"', async () => {
  authMocks.login.mockResolvedValue({ mfaRequired: true, mfaTicket: 'tk-1' })
  const w = mountView()
  await passwordStep(w)
  expect(localStorage.getItem('aliangboard.platform')).not.toBe('undefined')
  expect(useAuthStore().isAuthenticated).toBe(false)
  w.unmount()
})
