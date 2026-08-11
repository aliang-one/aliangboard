import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const addPVC = vi.fn(async () => ({ ok: true }))

// 隔离 Vue Query 与 store:VolumeMountCard/CreatePvcDialog 都在 setup 调 useResourceList + useClusterStore。
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    addPVC,
    fetchStorageClasses: async () => [],
    currentCluster: 'c1',
  }),
}))

import CreatePvcDialog from '@/components/common/CreatePvcDialog.vue'

// Modal 会 Teleport 到 body,交互测试里用不 Teleport 的桩替换,便于 wrapper.find。
const ModalStub = {
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue', 'confirm', 'cancel'],
  template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
}

function mountDlg(props = {}) {
  return mount(CreatePvcDialog, {
    props: { modelValue: true, namespace: 'default', ...props },
    global: { plugins: [createPinia(), i18n], stubs: { Modal: ModalStub } },
  })
}

test('CreatePvcDialog: 填 name 创建成功 → emit created(name) + 关闭,且 addPVC 收到 namespace', async () => {
  addPVC.mockResolvedValue({ ok: true })
  const wrapper = mountDlg()
  const nameInput = wrapper.findAll('input')[0]
  await nameInput.setValue('my-pvc')
  await wrapper.find('[data-testid="pvc-create"]').trigger('click')
  await Promise.resolve()
  await Promise.resolve()
  expect(addPVC).toHaveBeenCalledWith(expect.objectContaining({ name: 'my-pvc', namespace: 'default' }))
  expect(wrapper.emitted('created')).toEqual([['my-pvc']])
  expect(wrapper.emitted('update:modelValue')).toEqual([[false]])
  wrapper.unmount()
})

test('CreatePvcDialog: 创建失败(ok:false) → 显示错误、不 emit created、不关闭', async () => {
  addPVC.mockResolvedValue({ ok: false })
  const wrapper = mountDlg()
  await wrapper.findAll('input')[0].setValue('bad')
  await wrapper.find('[data-testid="pvc-create"]').trigger('click')
  await Promise.resolve()
  await Promise.resolve()
  expect(wrapper.emitted('created')).toBeUndefined()
  expect(wrapper.emitted('update:modelValue')).toBeUndefined()
  expect(wrapper.text()).toContain(i18n.global.t('component.createPvc.createFailed'))
  wrapper.unmount()
})

test('CreatePvcDialog: name 为空 → 创建按钮 disabled', () => {
  const wrapper = mountDlg()
  const btn = wrapper.find('[data-testid="pvc-create"]')
  expect(btn.attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
