// 品牌铺开回归:登录/选集群/加集群三个独立页头部必须是 aliang-logo 品牌 img。
// 防止后续改动把品牌位退回 Material Symbols 通用图标(kubernetes/hub)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }))
const myClustersMock = vi.fn()

vi.mock('vue-router', () => ({
  useRoute: () => ({ params: {}, query: {}, path: '/', meta: {} }),
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  RouterLink: { template: '<a><slot/></a>' },
}))
vi.mock('@/api/client', () => ({
  authApi: { myClusters: (...a) => myClustersMock(...a) },
  adminApi: { clusters: { create: vi.fn() } },
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { username: 'admin', role: 'admin' },
    get isAdmin() { return true },
    login: vi.fn(async () => ({})),
    logout: vi.fn(),
    connectCluster: vi.fn(async () => ({})),
    tryAutoConnect: vi.fn(async () => null),
  }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ setConnectedCluster: vi.fn() }),
}))

import Login from '../Login.vue'
import SelectCluster from '../SelectCluster.vue'
import AddCluster from '../AddCluster.vue'

beforeEach(() => {
  pushMock.mockClear()
  myClustersMock.mockResolvedValue({ clusters: [] })
})

const BRAND = 'img[alt="AliangBoard"]'

test('Login 头部为品牌 logo', () => {
  setActivePinia(createPinia())
  const w = mount(Login, { global: { plugins: [i18n] } })
  expect(w.find(BRAND).exists()).toBe(true)
})

test('SelectCluster 头部为品牌 logo', async () => {
  setActivePinia(createPinia())
  const w = mount(SelectCluster, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.find(BRAND).exists()).toBe(true)
})

test('AddCluster 头部为品牌 logo', () => {
  setActivePinia(createPinia())
  const w = mount(AddCluster, { global: { plugins: [i18n] } })
  expect(w.find(BRAND).exists()).toBe(true)
})
