// SelectCluster 添加集群入口:空状态主按钮与底部常驻入口(仅 admin)都指 /add-cluster。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { pushMock } = vi.hoisted(() => ({ pushMock: vi.fn() }))
const myClustersMock = vi.fn()
let _isAdmin = true

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock }),
  RouterLink: { template: '<a><slot/></a>' },
}))
vi.mock('@/api/client', () => ({
  authApi: { myClusters: (...a) => myClustersMock(...a) },
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { username: 'admin', role: 'admin' },
    logout: vi.fn(),
    get isAdmin() { return _isAdmin },
  }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ setConnectedCluster: vi.fn() }),
}))

import SelectCluster from '../SelectCluster.vue'

function mountView() { return mount(SelectCluster, { global: { plugins: [i18n] } }) }

beforeEach(() => {
  _isAdmin = true
  pushMock.mockClear()
  myClustersMock.mockReset()
})

test('admin 有集群:底部常驻「添加集群」入口存在,点击 push /add-cluster', async () => {
  myClustersMock.mockResolvedValue({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="select-cluster-add-persistent"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/add-cluster')
})

test('admin 无集群:空状态主按钮 push /add-cluster', async () => {
  myClustersMock.mockResolvedValue({ clusters: [] })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="select-cluster-add"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/add-cluster')
})

test('非 admin:无添加入口,显示联系管理员提示', async () => {
  _isAdmin = false
  myClustersMock.mockResolvedValue({ clusters: [] })
  const w = mountView()
  await flushPromises()
  expect(w.find('[data-testid="select-cluster-add"]').exists()).toBe(false)
  expect(w.find('[data-testid="select-cluster-add-persistent"]').exists()).toBe(false)
  expect(w.text()).toContain('请联系管理员')
})
