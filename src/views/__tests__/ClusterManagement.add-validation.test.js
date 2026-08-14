// 添加集群表单必填校验回归(与 API Key 签发表单同类:空字段裸发吃服务端 400)。
// 必填:集群名称 + 按 authMethod 的凭据(kubeconfig / token:apiServer+token / basic:apiServer+username)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const createMock = vi.fn(async () => ({ cluster: { id: 'c1' } }))

vi.mock('@/api/client', () => ({
  adminApi: {
    clusters: { list: vi.fn(async () => ({ clusters: [] })), create: (...a) => createMock(...a), remove: vi.fn() },
  },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: '' }) }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import ClusterManagement from '../admin/ClusterManagement.vue'

function mountView() {
  return mount(ClusterManagement, {
    global: {
      plugins: [i18n],
      stubs: { Modal: { template: '<div><slot /><slot name="actions" /></div>' }, ClusterCard: true },
    },
  })
}
async function openAdd(w) {
  const btn = w.findAll('button').find(b => b.text().includes('添加集群'))
  expect(btn).toBeTruthy()
  await btn.trigger('click')
  await flushPromises()
}
const submitBtn = w => w.findAll('button').find(b => b.text().trim() === '添加并验证')
// 凭据方式切换按钮(text = Kubeconfig / Token / 账密)
const authTab = (w, label) => w.findAll('button').find(b => b.text().trim() === label)

beforeEach(() => createMock.mockClear())

test('kubeconfig 模式:名称/凭据为空 → 不发请求 + 行内提示', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await openAdd(w)

  await submitBtn(w).trigger('click')
  await flushPromises()

  expect(createMock).not.toHaveBeenCalled()
  expect(w.find('[data-testid="cluster-form-error-name"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-error-kubeconfig"]').exists()).toBe(true)
})

test('token 模式:apiServer/token 为空 → 行内提示;填齐才提交(trim)', async () => {
  setActivePinia(createPinia())
  const w = mountView()
  await flushPromises()
  await openAdd(w)
  await authTab(w, 'Token').trigger('click')

  await w.findAll('input').find(i => i.attributes('placeholder')?.includes('prod-cluster')).setValue(' c1 ')
  await w.findAll('input').find(i => i.attributes('placeholder')?.includes('10.0.0.1')).setValue(' https://k8s:6443 ')
  await submitBtn(w).trigger('click')
  await flushPromises()

  expect(createMock).not.toHaveBeenCalled()
  expect(w.find('[data-testid="cluster-form-error-token"]').exists()).toBe(true)
  expect(w.find('[data-testid="cluster-form-error-name"]').exists()).toBe(false)

  await w.findAll('input').find(i => i.attributes('placeholder')?.includes('eyJhb')).setValue('tok')
  await submitBtn(w).trigger('click')
  await flushPromises()

  expect(createMock).toHaveBeenCalledTimes(1)
  const payload = createMock.mock.calls[0][0]
  expect(payload.name).toBe('c1')
  expect(payload.apiServer).toBe('https://k8s:6443')
  expect(payload.token).toBe('tok')
})
