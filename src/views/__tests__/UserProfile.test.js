// 三卡交互:资料就地编辑 / 改密表单校验+提交 / 会话列表渲染+吊销确认 / 偏好联动 store。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
const apiMocks = vi.hoisted(() => ({
  updateMe: vi.fn(),
  changePassword: vi.fn(),
  listSessions: vi.fn(),
  revokeSession: vi.fn(),
  revokeOtherSessions: vi.fn(),
  savePreferences: vi.fn().mockResolvedValue({}),
}))
vi.mock('@/api/client', () => ({ authApi: apiMocks }))

import UserProfile from '@/views/UserProfile.vue'
import { useAuthStore } from '@/stores/auth'
import { usePreferencesStore } from '@/stores/preferences'

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  apiMocks.savePreferences.mockResolvedValue({})
  const auth = useAuthStore()
  auth.user = { id: 'u1', username: 'alice', role: 'user', displayName: 'Alice', createdAt: 1756400000000 }
  apiMocks.listSessions.mockResolvedValue({ sessions: [
    { fingerprint: 'abcd1234', ip: '1.2.3.4', userAgent: 'Mozilla/5.0 Chrome Safari', createdAt: 1756400000000, lastSeenAt: 1756400100000, current: true },
    { fingerprint: 'beef5678', ip: '5.6.7.8', userAgent: 'Mozilla/5.0 Firefox', createdAt: 1756300000000, lastSeenAt: 1756390000000, current: false },
  ] })
  apiMocks.updateMe.mockResolvedValue({ user: { id: 'u1', username: 'alice', role: 'user', displayName: '阿亮' } })
})

function mountPage() {
  return mount(UserProfile, { global: { plugins: [i18n] } })
}

test('挂载:拉会话列表,渲染两行,当前行有标记', async () => {
  const w = mountPage()
  await flushPromises()
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(1)
  const rows = w.findAll('[data-testid="session-row"]')
  expect(rows).toHaveLength(2)
  expect(rows[0].text()).toContain('1.2.3.4')
  expect(w.text()).toContain('Chrome')
  w.unmount()
})

test('displayName 就地编辑:保存调 updateMe 并回写 authStore', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="profile-displayname-input"]').setValue('阿亮')
  await w.find('[data-testid="profile-displayname-save"]').trigger('click')
  await flushPromises()
  expect(apiMocks.updateMe).toHaveBeenCalledWith({ displayName: '阿亮' })
  expect(useAuthStore().user.displayName).toBe('阿亮')
  w.unmount()
})

test('改密:两次新密不一致 → 客户端拒绝不发请求', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-confirm"]').setValue('newpassword2')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  expect(apiMocks.changePassword).not.toHaveBeenCalled()
  w.unmount()
})

test('改密:新密 <8 → 客户端拒绝;通过则调 API + 成功清表单', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('short')
  await w.find('[data-testid="pwd-confirm"]').setValue('short')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  expect(apiMocks.changePassword).not.toHaveBeenCalled()

  apiMocks.changePassword.mockResolvedValueOnce({ ok: true, revoked: 1 })
  await w.find('[data-testid="pwd-current"]').setValue('right-password')
  await w.find('[data-testid="pwd-new"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-confirm"]').setValue('newpassword1')
  await w.find('[data-testid="pwd-submit"]').trigger('click')
  await flushPromises()
  expect(apiMocks.changePassword).toHaveBeenCalledWith('right-password', 'newpassword1')
  expect(w.find('[data-testid="pwd-new"]').element.value).toBe('')
  w.unmount()
})

test('吊销单会话:走 ConfirmDialog,确认后调 revokeSession 并刷新列表', async () => {
  const w = mountPage()
  await flushPromises()
  apiMocks.revokeSession.mockResolvedValueOnce({ ok: true })
  await w.find('[data-testid="session-revoke-beef5678"]').trigger('click')
  expect(apiMocks.revokeSession).not.toHaveBeenCalled()
  document.body.querySelector('[data-testid="confirm-ok"]').click()
  await flushPromises()
  expect(apiMocks.revokeSession).toHaveBeenCalledWith('beef5678')
  expect(apiMocks.listSessions).toHaveBeenCalledTimes(2)
  w.unmount()
})

test('当前会话行不渲染吊销按钮(防自锁)', async () => {
  const w = mountPage()
  await flushPromises()
  expect(w.find('[data-testid="session-revoke-abcd1234"]').exists()).toBe(false)
  expect(w.find('[data-testid="sessions-revoke-others"]').exists()).toBe(true)
  w.unmount()
})

test('偏好卡:语言/主题选择联动 preferences store', async () => {
  const w = mountPage()
  await flushPromises()
  await w.find('[data-testid="pref-lang-en"]').trigger('click')
  await w.find('[data-testid="pref-theme-dark"]').trigger('click')
  const prefs = usePreferencesStore()
  expect(prefs.language).toBe('en')
  expect(prefs.theme).toBe('dark')
  w.unmount()
})
