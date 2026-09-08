// SelectCluster 添加集群入口:空状态主按钮与底部常驻入口(仅 admin)都指 /add-cluster。
// 连接反馈根治(2026-09-08):卡片级 pending(connecting 期网格不消失、其余卡禁用)、
// 成功 SPA push /cluster 且 connecting 不提前清零、失败恢复;免集群通道卡全员可见。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { pushMock, connectClusterMock, setConnectedMock } = vi.hoisted(() => ({
  pushMock: vi.fn(),
  connectClusterMock: vi.fn(),
  setConnectedMock: vi.fn(),
}))
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
    connectCluster: (...a) => connectClusterMock(...a),
    get isAdmin() { return _isAdmin },
  }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ setConnectedCluster: (...a) => setConnectedMock(...a) }),
}))

import SelectCluster from '../SelectCluster.vue'

function mountView() { return mount(SelectCluster, { global: { plugins: [i18n] } }) }
const cards = w => w.findAll('[data-testid="select-cluster-card"]')

beforeEach(() => {
  _isAdmin = true
  pushMock.mockClear()
  myClustersMock.mockReset()
  connectClusterMock.mockReset()
  setConnectedMock.mockClear()
})

test('admin 有集群:底部常驻「添加集群」入口存在,点击 push /add-cluster', async () => {
  myClustersMock.mockResolvedValue({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="select-cluster-add-persistent"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/add-cluster')
})

test('admin 无集群:空状态主按钮 push /add-cluster,常驻入口不渲染', async () => {
  myClustersMock.mockResolvedValue({ clusters: [] })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="select-cluster-add"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/add-cluster')
  expect(w.find('[data-testid="select-cluster-add-persistent"]').exists()).toBe(false)
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

// === 免集群通道卡(全员可见——工作台/个人中心路由 requiresCluster:false) ===

test('通道卡(非 admin 有集群):渲染且点击 push /workbench', async () => {
  _isAdmin = false
  myClustersMock.mockResolvedValue({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="select-cluster-workbench-entry"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/workbench')
})

test('通道卡(非 admin 无集群空状态):仍渲染——不再只有登出一条路', async () => {
  _isAdmin = false
  myClustersMock.mockResolvedValue({ clusters: [] })
  const w = mountView()
  await flushPromises()
  await w.find('[data-testid="select-cluster-workbench-entry"]').trigger('click')
  expect(pushMock).toHaveBeenCalledWith('/workbench')
})

// === 连接流程反馈 ===

test('连接成功:SPA push /cluster + setConnectedCluster(apiServer 去尾斜杠),connecting 不提前清零', async () => {
  myClustersMock.mockResolvedValue({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })
  connectClusterMock.mockResolvedValue({ token: 'tok', cluster: { apiServer: 'https://x/', version: 'v1.29' } })
  const w = mountView()
  await flushPromises()
  await cards(w)[0].trigger('click')
  await flushPromises()
  expect(pushMock).toHaveBeenCalledWith('/cluster')
  expect(setConnectedMock).toHaveBeenCalledWith({ apiServer: 'https://x', version: 'v1.29' })
  // 旧版 finally 清零 connecting → 整页刷新窗口期网格复活 → 重复点击连接风暴。
  // 成功路径必须保持禁用态直到组件卸载(SPA 跳转)。
  expect(cards(w)[0].attributes('disabled')).toBeDefined()
})

test('连接中:网格保持可见,其余卡禁用,重复点击不触发第二次连接', async () => {
  let resolveConnect
  connectClusterMock.mockReturnValue(new Promise(r => { resolveConnect = r }))
  myClustersMock.mockResolvedValue({ clusters: [
    { id: 'c1', name: 'a', apiServer: 'https://a' },
    { id: 'c2', name: 'b', apiServer: 'https://b' },
  ] })
  const w = mountView()
  await flushPromises()
  const list = cards(w)
  await list[0].trigger('click')
  await flushPromises()
  // 网格不消失(旧版把整网格换成一行小字 spinner,丢失上下文)
  expect(w.find('[data-testid="select-cluster-card"]').exists()).toBe(true)
  expect(list[1].attributes('disabled')).toBeDefined()
  // disabled 按钮点击(happy-dom dispatchEvent 会穿透 disabled)+ 连接期 in-flight 守卫,双保险
  await list[1].trigger('click')
  expect(connectClusterMock).toHaveBeenCalledTimes(1)
  resolveConnect({ token: 'tok', cluster: { apiServer: 'https://a', version: 'v' } })
  await flushPromises()
  expect(pushMock).toHaveBeenCalledWith('/cluster')
})

test('连接失败:connecting 清零恢复可选,错误信息展示', async () => {
  myClustersMock.mockResolvedValue({ clusters: [{ id: 'c1', name: 'demo', apiServer: 'https://x' }] })
  connectClusterMock.mockRejectedValue(new Error('probe timeout'))
  const w = mountView()
  await flushPromises()
  await cards(w)[0].trigger('click')
  await flushPromises()
  expect(w.text()).toContain('probe timeout')
  expect(cards(w)[0].attributes('disabled')).toBeUndefined()
})
