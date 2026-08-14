// 集群管理 modal 改用共享 ClusterForm 后的回归:校验拦截 + 成功提交走 create。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { i18n } from '@/i18n'

const createMock = vi.fn(async () => ({ cluster: { id: 'c1', name: 'demo', apiServer: 'https://x', version: 'v1.30' } }))
const notifyMock = vi.fn()

vi.mock('@/api/client', () => ({
  adminApi: {
    clusters: {
      list: vi.fn(async () => ({ clusters: [] })),
      create: (...a) => createMock(...a),
      remove: vi.fn(),
    },
  },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: '' }) }))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))

import ClusterManagement from '../admin/ClusterManagement.vue'

function mountView() {
  return mount(ClusterManagement, {
    global: {
      plugins: [i18n],
      stubs: { Modal: { template: '<div><slot /></div>' }, ClusterCard: true }, // Modal 打穿默认插槽;actions 插槽已随重构移除
    },
  })
}
async function openAddModal(w) {
  const btn = w.findAll('button').find(b => b.text().includes('添加集群'))
  expect(btn, '「添加集群」按钮存在').toBeTruthy()
  await btn.trigger('click')
  await flushPromises()
}
const submitBtn = w => w.find('[data-testid="cluster-form-submit"]')

beforeEach(() => { createMock.mockClear(); notifyMock.mockClear() })

test('空表单提交:create 未被调用,内联错误可见', async () => {
  const w = mountView()
  await openAddModal(w)
  await submitBtn(w).trigger('click')
  await flushPromises()
  expect(createMock).not.toHaveBeenCalled()
  expect(w.find('[data-testid="cluster-form-error-name"]').exists()).toBe(true)
})

test('填齐后提交:create 收到完整 payload,notify success', async () => {
  const w = mountView()
  await openAddModal(w)
  await w.find('[data-testid="cluster-form-name"]').setValue('demo')
  await w.find('[data-testid="cluster-form-kubeconfig"]').setValue('apiVersion: v1')
  await submitBtn(w).trigger('click')
  await flushPromises()
  expect(createMock).toHaveBeenCalledWith(expect.objectContaining({ name: 'demo', authMethod: 'kubeconfig', kubeconfig: 'apiVersion: v1', insecure: false }))
  expect(notifyMock).toHaveBeenCalledWith('success', expect.any(String))
})
