// AddCluster 独立页:非 admin 弹回 / create 失败内联错误 / 成功→connect→整页跳 /connect
// 失败→重试态。复用真 ClusterForm(集成校验拦截路径)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const { pushMock, replaceMock } = vi.hoisted(() => ({ pushMock: vi.fn(), replaceMock: vi.fn() }))
const createMock = vi.fn()
const connectMock = vi.fn()
const setConnectedMock = vi.fn()
let _isAdmin = true

vi.mock('vue-router', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
  RouterLink: { template: '<a><slot/></a>' },
}))
vi.mock('@/api/client', () => ({
  adminApi: { clusters: { create: (...a) => createMock(...a) } },
}))
vi.mock('@/stores/auth', () => ({
  useAuthStore: () => ({
    user: { username: 'admin', role: 'admin' },
    get isAdmin() { return _isAdmin },
    connectCluster: (...a) => connectMock(...a),
  }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ setConnectedCluster: setConnectedMock }),
}))

import AddCluster from '../AddCluster.vue'

function mountView() { return mount(AddCluster, { global: { plugins: [i18n] } }) }
async function fillAndSubmit(w) {
  await w.find('[data-testid="cluster-form-name"]').setValue('demo')
  await w.find('[data-testid="cluster-form-kubeconfig"]').setValue('apiVersion: v1')
  await w.find('[data-testid="cluster-form-submit"]').trigger('click')
  await flushPromises()
}

beforeEach(() => {
  _isAdmin = true
  createMock.mockReset(); connectMock.mockReset(); setConnectedMock.mockReset()
  pushMock.mockClear(); replaceMock.mockClear()
  window.location.href = 'http://localhost/add-cluster' // 复位上个测试的整页跳转
})

test('非 admin:挂载即 replace 回 SelectCluster', async () => {
  _isAdmin = false
  mountView()
  await flushPromises()
  expect(replaceMock).toHaveBeenCalledWith({ name: 'SelectCluster' })
})

test('空表单提交被 ClusterForm 拦截:create 未调用', async () => {
  const w = mountView()
  await w.find('[data-testid="cluster-form-submit"]').trigger('click')
  await flushPromises()
  expect(createMock).not.toHaveBeenCalled()
})

test('create 失败:内联错误,表单保留,不 connect', async () => {
  createMock.mockRejectedValue(new Error('凭据无效'))
  const w = mountView()
  await fillAndSubmit(w)
  expect(w.find('[data-testid="add-cluster-error"]').text()).toContain('凭据无效')
  expect(w.find('[data-testid="cluster-form-name"]').exists()).toBe(true)
  expect(connectMock).not.toHaveBeenCalled()
})

test('create+connect 成功:setConnectedCluster(去尾斜杠)并整页跳 /cluster', async () => {
  createMock.mockResolvedValue({ cluster: { id: 'c1', name: 'demo', apiServer: 'https://x', version: 'v1.30' } })
  connectMock.mockResolvedValue({ token: 'k8s-t', cluster: { apiServer: 'https://x/', version: 'v1.30' } })
  const w = mountView()
  await fillAndSubmit(w)
  expect(connectMock).toHaveBeenCalledWith('c1')
  expect(setConnectedMock).toHaveBeenCalledWith({ apiServer: 'https://x', version: 'v1.30' })
  expect(window.location.pathname).toBe('/cluster')
})

test('create 成功但 connect 失败:重试卡片;点重试再 connect', async () => {
  createMock.mockResolvedValue({ cluster: { id: 'c1', name: 'demo', apiServer: 'https://x', version: 'v1.30' } })
  connectMock.mockRejectedValueOnce(new Error('网络抖动')).mockResolvedValue({ token: 'k8s-t', cluster: { apiServer: 'https://x', version: 'v1.30' } })
  const w = mountView()
  await fillAndSubmit(w)
  expect(w.find('[data-testid="add-cluster-connect-failed"]').exists()).toBe(true)
  expect(w.text()).toContain('网络抖动')

  await w.find('[data-testid="add-cluster-retry"]').trigger('click')
  await flushPromises()
  expect(connectMock).toHaveBeenCalledTimes(2)
  expect(window.location.pathname).toBe('/cluster')
})
