// W4 Task 5:登录页 SSO。三面:
// ① ?oidcCode= 挂载即 exchange → 与 W3 mfa 分支同款落地(applyLogin 直写 + purgeSession
//    账号切换语义 + landing();不能走 store.login——那会打密码端点);
// ② ?oidcError= 白名单(8 码,含 W4-B 前瞻的 ratelimited)→ 行内错误条;表外码走通用文案;
// ③ SSO 钮恒显示(R2 零配置探测)——未配置也渲染,点击整页跳 /api/auth/oidc/login。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const state = vi.hoisted(() => ({ query: {}, push: vi.fn() }))
const authMocks = vi.hoisted(() => ({
  login: vi.fn(),
  mfaLogin: vi.fn(),
  oidcExchange: vi.fn(),
}))
const clientFns = vi.hoisted(() => ({ purgeSession: vi.fn() }))

// 真 auth/preferences store + mock client(W3 mfa 测试同款);purgeSession 是 store.login 的
// 账号切换副作用——OIDC 无密码步,组件须自己补调(镜像 store.login 语义)。
vi.mock('@/api/client', () => ({
  authApi: authMocks,
  purgeSession: clientFns.purgeSession,
  clearSession: vi.fn(), clearStashedSession: vi.fn(), saveSession: vi.fn(),
}))
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: state.push }),
  useRoute: () => ({ query: state.query }),
}))

import Login from '@/views/Login.vue'
import { useAuthStore } from '@/stores/auth'

// 服务端 auth.mjs 全量错误码(8 个,白名单与服务端 302 码一一对应)
const OIDC_ERROR_CODES = ['disabled', 'state', 'denied', 'token', 'verify', 'usernameTaken', 'jit', 'ratelimited']

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  state.query = {}
  state.push.mockClear()
  localStorage.clear()
  window.location.href = 'http://localhost/login' // 复位上个测试的 SSO 整页跳转(AddCluster 测试同款)
})

function mountView() { return mount(Login, { global: { plugins: [i18n] } }) }

test('?oidcCode= 挂载即 exchange(code) → 建 session(token/user/localStorage)+ purgeSession + 落地选择页', async () => {
  authMocks.oidcExchange.mockResolvedValue({ token: 'tok-sso', user: { id: 'u9', username: 'sso.user', role: 'user' }, prefs: {} })
  state.query = { oidcCode: 'xc-1' }
  const w = mountView()
  await flushPromises()
  expect(authMocks.oidcExchange).toHaveBeenCalledWith('xc-1')
  expect(authMocks.login).not.toHaveBeenCalled() // 不打密码端点
  const store = useAuthStore()
  expect(store.token).toBe('tok-sso')
  expect(store.user?.username).toBe('sso.user')
  expect(localStorage.getItem('aliangboard.platform')).toBe('tok-sso')
  expect(clientFns.purgeSession).toHaveBeenCalledTimes(1) // 账号切换语义(镜像 store.login)
  expect(state.push).toHaveBeenCalledWith('/select-cluster') // landing():无 redirect/偏好 → auto-connect 失败回选择页
  w.unmount()
})

test('exchange 失败(401 错码):行内通用错误,不建 session 不落地', async () => {
  // 无 message 的 401(错码/过期/重放)→ 组件回退通用文案;带 message 时透传(与密码登录同构)
  const bad = new Error('')
  bad.status = 401
  authMocks.oidcExchange.mockRejectedValue(bad)
  state.query = { oidcCode: 'bad' }
  const w = mountView()
  await flushPromises()
  expect(w.text()).toContain(i18n.global.t('login.oidcExchangeFailed'))
  expect(useAuthStore().token).toBe('')
  expect(state.push).not.toHaveBeenCalled()
  w.unmount()
})

test('?oidcError= 白名单码 → 行内错误条按码取键;表外码走通用文案', async () => {
  state.query = { oidcError: 'disabled' }
  let w = mountView()
  await flushPromises()
  expect(w.text()).toContain(i18n.global.t('login.oidcError.disabled'))
  expect(authMocks.oidcExchange).not.toHaveBeenCalled()
  w.unmount()

  state.query = { oidcError: 'ratelimited' } // W4-B 前瞻码
  w = mountView()
  await flushPromises()
  expect(w.text()).toContain(i18n.global.t('login.oidcError.ratelimited'))
  w.unmount()

  state.query = { oidcError: 'not-a-code' } // 表外码:不渲染裸键路径,回通用文案
  w = mountView()
  await flushPromises()
  expect(w.text()).toContain(i18n.global.t('login.oidcExchangeFailed'))
  expect(w.text()).not.toContain('login.oidcError.')
  w.unmount()
})

test('8 个错误码键在 zh/en 双语齐全(白名单↔locale 契约)', () => {
  const prev = i18n.global.locale.value
  for (const locale of ['zh', 'en']) {
    i18n.global.locale.value = locale
    for (const code of OIDC_ERROR_CODES) {
      expect(i18n.global.te(`login.oidcError.${code}`), `${locale}:${code}`).toBe(true)
    }
  }
  i18n.global.locale.value = prev
})

test('SSO 钮恒显示(未配置也渲染),点击整页跳 /api/auth/oidc/login', async () => {
  const w = mountView() // 无任何 query(零配置探测:服务端 302 回 disabled 错误码)
  await flushPromises()
  const btn = w.find('[data-testid="sso-login"]')
  expect(btn.exists()).toBe(true)
  expect(btn.text()).toContain(i18n.global.t('login.ssoLogin'))
  await btn.trigger('click')
  // happy-dom 把相对 href 解析成绝对 URL,按 pathname 断言
  expect(new URL(window.location.href).pathname).toBe('/api/auth/oidc/login')
  w.unmount()
})

test('本地密码表单恒在(D4):SSO 钮在表单上方,用户名/密码输入框不受影响', async () => {
  const w = mountView()
  await flushPromises()
  expect(w.find('input[type=text]').exists()).toBe(true)
  expect(w.find('input[type=password]').exists()).toBe(true)
  expect(w.find('[data-testid="sso-login"]').exists()).toBe(true)
  w.unmount()
})
