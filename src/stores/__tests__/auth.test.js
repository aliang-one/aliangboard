// W2-0 §0.4-4:浏览器 token 生命周期——login 成功即 purge 上一账号 K8s token(双键全清不暂存);
// logout 追加清暂存(防下账号同集群 rekey 继承窗口记录)。
import { test, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const mocks = vi.hoisted(() => ({
  api: { logout: vi.fn().mockResolvedValue({}) },
  authApi: {
    login: vi.fn(),
    logout: vi.fn().mockResolvedValue({}),
    me: vi.fn(),
    connectCluster: vi.fn(),
  },
  saveSession: vi.fn(),
  clearSession: vi.fn(),
  getSessionToken: vi.fn().mockReturnValue(''),
  getStashedSession: vi.fn().mockReturnValue(''),
  clearStashedSession: vi.fn(() => { localStorage.removeItem('aliangboard.prevSession') }),
  rekeyApi: { windowRecords: vi.fn().mockResolvedValue({}) },
  // purge/clearStashed 被全量 mock,但被测行为恰是其存储副作用——桩按真实现语义清 key
  purgeSession: vi.fn(() => {
    sessionStorage.removeItem('aliangboard.session')
    localStorage.removeItem('aliangboard.session')
    localStorage.removeItem('aliangboard.prevSession')
  }),
}))

vi.mock('@/api/client', () => mocks)
vi.mock('@/composables/useAvatar', () => ({ resetAvatarSession: vi.fn() }))

import { useAuthStore } from '@/stores/auth'

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  sessionStorage.clear()
  vi.clearAllMocks()
  mocks.getSessionToken.mockReturnValue('')
  mocks.getStashedSession.mockReturnValue('')
})

test('login 成功即清上一账号残留:sessionKey 与 prevSessionKey 双清(purge,不暂存)', async () => {
  localStorage.setItem('aliangboard.session', 'A-k8s-token')
  localStorage.setItem('aliangboard.prevSession', 'A-old-token')
  mocks.authApi.login.mockResolvedValue({ token: 'p-tok', user: { id: 'u2', username: 'bob', role: 'user' }, prefs: {} })
  const auth = useAuthStore()
  await auth.login('bob', 'pw')
  expect(localStorage.getItem('aliangboard.session')).toBe(null)
  expect(localStorage.getItem('aliangboard.prevSession')).toBe(null)
  expect(localStorage.getItem('aliangboard.platform')).toBe('p-tok')
})

test('logout 清暂存:prevSessionKey 不残留(防下账号同集群 rekey 继承窗口记录)', async () => {
  localStorage.setItem('aliangboard.platform', 'p-tok')
  localStorage.setItem('aliangboard.prevSession', 'A-old-token')
  const auth = useAuthStore()
  auth.token = 'p-tok'; auth.user = { id: 'u1', username: 'alice', role: 'user' }; auth.k8sToken = 'k1'
  auth.logout()
  expect(localStorage.getItem('aliangboard.prevSession')).toBe(null)
  expect(localStorage.getItem('aliangboard.session')).toBe(null)
})
