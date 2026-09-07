// 登录表单必填校验回归:空用户名/密码裸发吃 400「用户名和密码不能为空」。
// 登录页已有行内 errorMessage,直接复用(不弹 toast)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const state = vi.hoisted(() => ({ query: {}, assign: vi.fn() }))
const loginMock = vi.fn(async () => ({}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: null,
    login: (...a) => loginMock(...a),
    tryAutoConnect: vi.fn(async () => null),
  }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }), useRoute: () => ({ query: state.query }) }))

import Login from '../Login.vue'

beforeEach(() => {
  loginMock.mockClear()
  state.query = {}
  state.assign.mockClear()
  vi.spyOn(window.location, 'assign').mockImplementation(state.assign)
})

function mountView() { return mount(Login, { global: { plugins: [i18n] } }) }
// W4 起 SSO 钮(「使用 SSO 登录」)含「登录」字样,text 匹配会先撞上它——改钉 testid
const submit = w => w.find('[data-testid="login-submit"]')

test('空用户名/密码 → 不发请求,行内提示', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await submit(w).trigger('click')
  await flushPromises()

  expect(loginMock).not.toHaveBeenCalled()
  expect(w.text()).toContain('请输入用户名和密码')
})

test('带 redirect(复审 F5):登录后原路回跳,不走 auto-connect 分支', async () => {
  state.query = { redirect: '/ssh-terminal-popup?serverId=sv1&sid=ssh-x' }
  const w = mountView()
  await w.find('input[type=text]').setValue('admin')
  await w.find('input[type=password]').setValue('pw')
  await submit(w).trigger('click')
  await flushPromises()

  expect(state.assign).toHaveBeenCalledWith('/ssh-terminal-popup?serverId=sv1&sid=ssh-x')
})

test('无 redirect:保持原 auto-connect 流(守卫 Layer 2 兜底)', async () => {
  const w = mountView()
  await w.find('input[type=text]').setValue('admin')
  await w.find('input[type=password]').setValue('pw')
  await submit(w).trigger('click')
  await flushPromises()

  expect(state.assign).not.toHaveBeenCalled()
})

test('填齐才提交(用户名 trim,密码原样——空格是合法密码字符)', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await w.find('input[type=text]').setValue(' admin ')
  await w.find('input[type=password]').setValue(' pw ')
  await submit(w).trigger('click')
  await flushPromises()

  expect(loginMock).toHaveBeenCalledWith('admin', ' pw ')
})
