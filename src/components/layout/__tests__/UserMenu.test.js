// 根治回归(2026-08-29):点击头像必须只开菜单;登出必须经 ConfirmDialog 二次确认。
// 2026-10-23 顶栏退役 Task 4:UserMenu 迁「侧栏头像行 + 向上 Teleport 菜单」——菜单传送
// 到 document.body(侧栏 overflow-hidden 裁切防线),下拉内容断言一律 body 查询;
// 主题/语言快捷切换退役(归设置页 Task 9)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const pushMock = vi.fn()
const apiMocks = vi.hoisted(() => ({
  getAvatar: vi.fn(),
  clearAvatar: vi.fn(),
  uploadAvatar: vi.fn(),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: pushMock }) }))
vi.mock('@/api/client', async (importOriginal) => {
  const orig = await importOriginal()
  return { ...orig, authApi: { ...orig.authApi, ...apiMocks } }
})

import UserMenu from '@/components/layout/UserMenu.vue'
import { resetAvatarForTest } from '@/composables/useAvatar'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'

beforeEach(() => {
  setActivePinia(createPinia())
  pushMock.mockClear()
  localStorage.clear()
  i18n.global.locale.value = 'zh'
  document.body.innerHTML = ''
  apiMocks.getAvatar.mockReset().mockRejectedValue({ status: 404 })
  // 头像单例跨用例残留清理(2026-09-04 Wave1 Task13):apply/clearLocal 直写模块级 ref
  resetAvatarForTest()
})

function mountMenu() {
  return mount(UserMenu, { global: { plugins: [i18n] }, attachTo: document.body })
}

// Teleport 内容不在组件树:统一经 document.body 查询
const bodyPanel = () => document.body.querySelector('[data-testid="user-menu-dropdown"]')

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
  // 侧栏头像行形态:整行 w-full 可点(不再是顶栏 rounded-full 身份舱段)
  expect(w.find('[data-testid="user-menu-trigger"]').classes()).toContain('w-full')
  expect(w.find('[data-testid="user-menu-trigger"]').classes()).not.toContain('rounded-full')
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(false) // 已传送出组件树
  expect(bodyPanel()).toBeTruthy()
  expect(document.body.textContent).toContain('alice')
  expect(document.body.querySelector('[data-testid="user-menu-profile"]')).toBeTruthy()
  expect(document.body.querySelector('[data-testid="user-menu-logout"]')).toBeTruthy()
  expect(logoutSpy).not.toHaveBeenCalled()
  expect(pushMock).not.toHaveBeenCalled()
  w.unmount()
})

test('再点触发钮:关菜单(开合切换)', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(bodyPanel()).toBeTruthy()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(bodyPanel()).toBeNull()
  w.unmount()
})

test('菜单经 Teleport 渲染在 body(侧栏 overflow-hidden 裁切防线)', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(w.find('[data-testid="user-menu-dropdown"]').exists()).toBe(false) // 组件树内不可见
  expect(document.body.querySelector('[data-testid="user-menu-dropdown"]')).toBeTruthy()
  w.unmount()
})

test('主题/语言快捷切换已退役(归设置页)', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  expect(document.body.querySelector('[data-testid="user-menu-theme-dark"]')).toBeNull()
  expect(document.body.querySelector('[data-testid="user-menu-lang-en"]')).toBeNull()
  w.unmount()
})

test('点「用户中心」:关菜单并 push /profile', async () => {
  seedUser()
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  document.body.querySelector('[data-testid="user-menu-profile"]').click()
  await nextTick()
  expect(pushMock).toHaveBeenCalledWith('/profile')
  expect(bodyPanel()).toBeNull()
  w.unmount()
})

test('点「退出登录」:先弹 ConfirmDialog,确认才 logout + 跳 /login', async () => {
  seedUser()
  const auth = useAuthStore()
  const logoutSpy = vi.spyOn(auth, 'logout').mockImplementation(() => {})
  const stopSpy = vi.spyOn(useClusterStore(), 'stopPodWatch').mockImplementation(() => {})
  const w = mountMenu()
  await w.find('[data-testid="user-menu-trigger"]').trigger('click')
  document.body.querySelector('[data-testid="user-menu-logout"]').click()
  await nextTick()
  expect(logoutSpy).not.toHaveBeenCalled()
  const ok = document.body.querySelector('[data-testid="confirm-ok"]')
  expect(ok).toBeTruthy()
  ok.click()
  await nextTick()
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
  document.body.querySelector('[data-testid="user-menu-logout"]').click()
  await nextTick()
  document.body.querySelector('[data-testid="confirm-cancel"]').click()
  await nextTick()
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

// === Task 13: 头像位渲染(触发钮 img/fallback,testid 不变) ===
test('头像已设置:触发钮渲染 img(getAvatar resolve dataUrl)', async () => {
  seedUser()
  apiMocks.getAvatar.mockResolvedValue({ dataUrl: 'data:image/jpeg;base64,AAA' })
  const w = mountMenu()
  await flushPromises()
  expect(w.find('[data-testid="user-avatar-img"]').exists()).toBe(true)
  w.unmount()
})

test('头像未设置(getAvatar 404):回退首字母圆', async () => {
  seedUser()
  apiMocks.getAvatar.mockRejectedValue({ status: 404 })
  const w = mountMenu()
  await flushPromises()
  expect(w.find('[data-testid="user-avatar-fallback"]').exists()).toBe(true)
  w.unmount()
})
