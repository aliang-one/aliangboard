// preferences store:本地缓存即时生效 + 服务端同步失败静默(离线兜底)。
import { test, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

vi.mock('@/api/client', () => ({
  authApi: {
    savePreferences: vi.fn().mockResolvedValue({ prefs: {} }),
  },
}))
vi.mock('@/i18n', () => ({ setLocale: vi.fn() }))
vi.mock('@/styles/theme', () => ({ applyThemeMode: vi.fn() }))

import { usePreferencesStore } from '@/stores/preferences'
import { rowsPerPageDefault, setRowsPerPageDefault } from '@/utils/rowsPerPage'
import { authApi } from '@/api/client'
import { setLocale } from '@/i18n'
import { applyThemeMode } from '@/styles/theme'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.clearAllMocks()
})

test('setLanguage:更新 state + setLocale + 双写(localStorage + 服务端)', async () => {
  const s = usePreferencesStore()
  s.setLanguage('en')
  expect(s.language).toBe('en')
  expect(setLocale).toHaveBeenCalledWith('en')
  expect(localStorage.getItem('aliangboard.locale')).toBe('en')
  await vi.waitFor(() => expect(authApi.savePreferences).toHaveBeenCalledWith({ language: 'en', theme: null, landingView: null, defaultClusterId: null, defaultNamespace: null, rowsPerPage: null }))
})

test('setTheme:更新 state + applyThemeMode + 本地缓存', () => {
  const s = usePreferencesStore()
  s.setTheme('dark')
  expect(s.theme).toBe('dark')
  expect(applyThemeMode).toHaveBeenCalledWith('dark')
  expect(localStorage.getItem('aliangboard.theme')).toBe('dark')
})

test('hydrateFromServer:服务端值覆盖本地并生效', () => {
  const s = usePreferencesStore()
  s.hydrateFromServer({ language: 'en', theme: 'light' })
  expect(s.language).toBe('en')
  expect(s.theme).toBe('light')
  expect(setLocale).toHaveBeenCalledWith('en')
  expect(applyThemeMode).toHaveBeenCalledWith('light')
})

test('hydrateFromServer:prefs 为空/字段缺失时不动本地', () => {
  const s = usePreferencesStore()
  s.hydrateFromServer(null)
  s.hydrateFromServer({})
  expect(s.language).toBeNull()
  expect(s.theme).toBeNull()
  expect(setLocale).not.toHaveBeenCalled()
})

test('savePreferences 失败静默:本地已生效不回滚', async () => {
  authApi.savePreferences.mockRejectedValueOnce(new Error('offline'))
  const s = usePreferencesStore()
  s.setTheme('dark')
  await vi.waitFor(() => expect(authApi.savePreferences).toHaveBeenCalled())
  expect(s.theme).toBe('dark')
})

test('新偏好键:hydrateFromServer 覆盖 + setXxx 即时生效并 PUT 全量键', async () => {
  const prefs = usePreferencesStore()
  prefs.hydrateFromServer({ language: 'zh', theme: 'dark', landingView: 'workbench', defaultClusterId: 'c9', defaultNamespace: 'team-a', rowsPerPage: 50 })
  expect(prefs.landingView).toBe('workbench')
  expect(prefs.defaultNamespace).toBe('team-a')
  prefs.setRowsPerPage(100)
  expect(prefs.rowsPerPage).toBe(100)
  expect(authApi.savePreferences).toHaveBeenLastCalledWith({ language: 'zh', theme: 'dark', landingView: 'workbench', defaultClusterId: 'c9', defaultNamespace: 'team-a', rowsPerPage: 100 })
  expect(rowsPerPageDefault.value).toBe(100)   // 联动单源模块
})

test('rowsPerPageDefault:setRowsPerPageDefault 白名单外回 10', () => {
  setRowsPerPageDefault(33); expect(rowsPerPageDefault.value).toBe(10)
  setRowsPerPageDefault(20); expect(rowsPerPageDefault.value).toBe(20)
  setRowsPerPageDefault('x'); expect(rowsPerPageDefault.value).toBe(10)
})
