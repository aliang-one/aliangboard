// 登录表单必填校验回归:空用户名/密码裸发吃 400「用户名和密码不能为空」。
// 登录页已有行内 errorMessage,直接复用(不弹 toast)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const loginMock = vi.fn(async () => ({}))

vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: null,
    login: (...a) => loginMock(...a),
    tryAutoConnect: vi.fn(async () => null),
  }),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))

import Login from '../Login.vue'

beforeEach(() => loginMock.mockClear())

function mountView() { return mount(Login, { global: { plugins: [i18n] } }) }
const submit = w => w.findAll('button').find(b => b.text().includes('登录'))

test('空用户名/密码 → 不发请求,行内提示', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await submit(w).trigger('click')
  await flushPromises()

  expect(loginMock).not.toHaveBeenCalled()
  expect(w.text()).toContain('请输入用户名和密码')
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
