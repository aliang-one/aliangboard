// 根治回归(2026-08-29):点击头像必须只开菜单;登出必须经 ConfirmDialog 二次确认。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const pushMock = vi.fn()
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))

import UserMenu from '@/components/layout/UserMenu.vue'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'
import { usePreferencesStore } from '@/stores/preferences'

beforeEach(() => {
  setActivePinia(createPinia())
  pushMock.mockClear()
  localStorage.clear()
  i18n.global.locale.value = 'zh'
  document.body.innerHTML = ''
})

function mountMenu() {
  return mount(UserMenu, { global: { plugins: [i18n] }, attachTo: document.body })
}

function seedUser() {
  const auth = useAuthStore()
  auth.user = { id: 'u1', username: 'alice', role: 'admin', displayName: 'Alice' }
  return auth
}

test('点击触发钮:开菜单(资料卡+两个菜单项),不触发 logout/push', async () => {
  seedUser()
  const auth = useAuthStore()
  const logoutSpy = vi.spyOn(auth, 'logout')
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(true)
  expect(document.body.textContent).toContain('alice')
  expect(w.find('[data-testid="user-menu-profile"]').exists()).toBe(true)
  expect(w.find('[data-testid="user-menu-logout"]').exists()).toBe(true)
  expect(logoutSpy).not.toHaveBeenCalled()
  expect(pushMock).not.toHaveBeenCalled()
  w.unmount()
})

test('再点触发钮:关菜单(开合切换)', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(false)
  w.unmount()
})

test('点「用户中心」:关菜单并 push /profile', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-profile"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/profile')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(false)
  w.unmount()
})

test('点「退出登录」:先弹 ConfirmDialog,确认才 logout + 跳 /login', async () => {
  seedUser()
  const auth = useAuthStore()
  const logoutSpy = vi.spyOn(auth, 'logout').mockImplementation(() => {})
  const stopSpy = vi.spyOn(useClusterStore(), 'stopPodWatch').mockImplementation(() => {})
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-logout"]').trigger('click')
  expect(logoutSpy).not.toHaveBeenCalled()
  const ok = document.body.querySelector('[data-testid="confirm-ok"]')
  expect(ok).toBeTruthy()
  ok.click()
  await w.vm.$nextTick()
  expect(logoutSpy).toHaveBeenCalledTimes(1)
  expect(stopSpy).toHaveBeenCalledTimes(1)
  expect(pushMock).toHaveBeenCalledWith('/login')
  w.unmount()
})

test('确认框点取消:不登出、窗关', async () => {
  seedUser()
  const auth = useAuthStore()
  const logoutSpy = vi.spyOn(auth, 'logout').mockImplementation(() => {})
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-logout"]').trigger('click')
  document.body.querySelector('[data-testid="confirm-cancel"]').click()
  await w.vm.$nextTick()
  expect(logoutSpy).not.toHaveBeenCalled()
  w.unmount()
})

test('触发钮两行化:admin 用户名下方显示「管理员」小字,横排 ADMIN 徽章消失', async () => {
  seedUser()
  const w = mountMenu()
  const role = w.find('[data-testid="user-menu-role"]')
  expect(role.exists()).toBe(true)
  expect(role.text()).toBe('管理员')
  expect(w.find('[data-testid="user-menu-trigger"]').text()).not.toContain('ADMIN')
  w.unmount()
})

test('非 admin 用户:角色行显示「普通用户」', async () => {
  const auth = useAuthStore()
  auth.user = { id: 'u2', username: 'bob', role: 'user', displayName: '' }
  const w = mountMenu()
  expect(w.find('[data-testid="user-menu-role"]').text()).toBe('普通用户')
  w.unmount()
})

test('role 缺失:角色行隐藏', async () => {
  const auth = useAuthStore()
  auth.user = { id: 'u3', username: 'carol', displayName: '' }
  const w = mountMenu()
  expect(w.find('[data-testid="user-menu-role"]').exists()).toBe(false)
  w.unmount()
})

test('下拉含主题三态+语言两态分段;null 未设置时高亮归一为 system/zh', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  for (const v of ['light', 'dark', 'system']) {
    expect(w.find(`[data-testid="user-menu-theme-${v}"]`).exists()).toBe(true)
  }
  for (const v of ['zh', 'en']) {
    expect(w.find(`[data-testid="user-menu-lang-${v}"]`).exists()).toBe(true)
  }
  expect(usePreferencesStore().theme).toBeNull()
  expect(usePreferencesStore().language).toBeNull()
  expect(w.find('[data-testid="user-menu-theme-system"]').classes()).toContain('bg-primary')
  expect(w.find('[data-testid="user-menu-lang-zh"]').classes()).toContain('bg-primary')
  w.unmount()
})

test('点主题「深色」:prefs.theme 即时变 dark 且菜单保持打开', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-theme-dark"]').trigger('click')
  expect(usePreferencesStore().theme).toBe('dark')
  expect(w.find('[data-testid="user-menu-theme-dark"]').classes()).toContain('bg-primary')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(true)
  w.unmount()
})

test('点语言「English」:prefs.language=en 且 i18n locale 同步切 en', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  await w.find('[data-testid="user-menu-lang-en"]').trigger('click')
  expect(usePreferencesStore().language).toBe('en')
  expect(i18n.global.locale.value).toBe('en')
  w.unmount()
})
