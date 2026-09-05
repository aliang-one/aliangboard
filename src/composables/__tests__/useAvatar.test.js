// useAvatar 会话泄漏回归(终审 F1):登出必须清空模块级单例,下一账号重新拉取。
import { test, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/api/client', () => ({
  authApi: {
    getAvatar: vi.fn().mockResolvedValue({ dataUrl: null }),
    logout: vi.fn().mockResolvedValue({}),
  },
  api: { logout: vi.fn().mockResolvedValue({}) },
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  getSessionToken: vi.fn(() => 'k8s-token'),
  getStashedSession: vi.fn(() => null),
  clearStashedSession: vi.fn(),
  rekeyApi: { windowRecords: vi.fn().mockResolvedValue({}) },
}))
vi.mock('@/stores/preferences', () => ({
  usePreferencesStore: () => ({ hydrateFromServer: vi.fn(), defaultClusterId: null }),
}))

import { useAvatar, resetAvatarForTest } from '@/composables/useAvatar'
import { useAuthStore } from '@/stores/auth'
import { authApi } from '@/api/client'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
  resetAvatarForTest()
})

test('logout 清空头像单例(fetchOnce 归零),ensureLoaded 重新拉取', async () => {
  const { avatarDataUrl, apply, ensureLoaded } = useAvatar()
  apply('data:image/png;base64,AAA')
  expect(avatarDataUrl.value).toBe('data:image/png;base64,AAA')

  const store = useAuthStore()
  store.token = 'tok' // 触发 best-effort authApi.logout
  store.logout()

  expect(avatarDataUrl.value).toBeNull()

  // 下一账号重新拉取:getAvatar 再次被调
  authApi.getAvatar.mockResolvedValue({ dataUrl: 'data:image/png;base64,BBB' })
  await ensureLoaded()
  expect(authApi.getAvatar).toHaveBeenCalledTimes(1)
  await vi.waitFor(() => expect(avatarDataUrl.value).toBe('data:image/png;base64,BBB'))
})
