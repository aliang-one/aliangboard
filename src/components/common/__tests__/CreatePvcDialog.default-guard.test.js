// CreatePvcDialog「集群默认」守卫回归(2026-09-04 集群默认不变式,spec §3.6 扩展:
// VolumeMountCard 的 PVC 内联快速创建是第三处 PVC 创建面,同病同治):
//   有默认 SC → option 可选,label 含默认名,创建按钮可用,提交 addPVC 收到显式默认名;
//   无默认 → option disabled + hint + 创建按钮 disabled(未显式选择时)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const state = vi.hoisted(() => ({ scs: [] }))
const addPVC = vi.fn(async () => ({ ok: true }))

vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: state.scs } }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    addPVC: (...a) => addPVC(...a),
    fetchStorageClasses: async () => state.scs,
    currentCluster: 'c1',
  }),
}))

import CreatePvcDialog from '@/components/common/CreatePvcDialog.vue'

beforeEach(() => { addPVC.mockClear(); addPVC.mockResolvedValue({ ok: true }) })

const ModalStub = {
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue'],
  template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
}

function mountDlg(props = {}) {
  return mount(CreatePvcDialog, {
    props: { modelValue: true, namespace: 'default', ...props },
    global: { plugins: [createPinia(), i18n], stubs: { Modal: ModalStub } },
  })
}

test('有默认 SC → option 可选 + label 含默认名 + 创建按钮可用;提交 addPVC 收到显式默认名', async () => {
  state.scs = [{ name: 'a', default: false }, { name: 'fast-sc', default: true }]
  const w = mountDlg()
  const opt = w.find('[data-testid="pvc-cluster-default-option"]')
  expect(opt.exists()).toBe(true)
  expect(opt.attributes('disabled')).toBeUndefined()
  expect(opt.text()).toContain('fast-sc')
  expect(w.find('[data-testid="pvc-cluster-default-hint"]').exists()).toBe(false)
  await w.findAll('input')[0].setValue('my-pvc')
  const btn = w.find('[data-testid="pvc-create"]')
  expect(btn.attributes('disabled')).toBeUndefined()
  await btn.trigger('click')
  await Promise.resolve()
  await Promise.resolve()
  expect(addPVC).toHaveBeenCalledTimes(1)
  expect(addPVC.mock.calls[0][0].storageClass).toBe('fast-sc')
  expect(w.emitted('created')).toEqual([['my-pvc']])
})

test('无默认 SC 且未显式选择 → option disabled + hint + 创建按钮 disabled', async () => {
  state.scs = [{ name: 'a', default: false }]
  const w = mountDlg()
  expect(w.find('[data-testid="pvc-cluster-default-option"]').attributes('disabled')).toBeDefined()
  expect(w.find('[data-testid="pvc-cluster-default-hint"]').exists()).toBe(true)
  await w.findAll('input')[0].setValue('my-pvc')
  expect(w.find('[data-testid="pvc-create"]').attributes('disabled')).toBeDefined()
  expect(addPVC).not.toHaveBeenCalled()
})

test('无默认 SC 但显式选择类 → 创建按钮可用,addPVC 收到显式类名', async () => {
  state.scs = [{ name: 'a', default: false }]
  const w = mountDlg()
  await w.findAll('input')[0].setValue('my-pvc')
  // 弹窗里有两个 select(accessModes 在前):按 storageClass select 定位
  await w.findAll('select')[1].setValue('a')
  expect(w.find('[data-testid="pvc-create"]').attributes('disabled')).toBeUndefined()
  await w.find('[data-testid="pvc-create"]').trigger('click')
  await Promise.resolve()
  await Promise.resolve()
  expect(addPVC).toHaveBeenCalledTimes(1)
  expect(addPVC.mock.calls[0][0].storageClass).toBe('a')
})
