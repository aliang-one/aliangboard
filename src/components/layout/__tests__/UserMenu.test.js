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

beforeEach(() => {
  setActivePinia(createPinia())
  pushMock.mockClear()
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

test('非 admin 用户不显示 ADMIN 徽章', async () => {
  const auth = useAuthStore()
  auth.user = { id: 'u2', username: 'bob', role: 'user', displayName: '' }
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(document.body.textContent).not.toContain('ADMIN')
  w.unmount()
})
