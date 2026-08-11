import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, reactive, defineComponent } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: () => ({ data: { value: [] } }),
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ fetchConfigMaps: async () => [], fetchSecrets: async () => [], currentCluster: 'c1' }),
}))

import VolumeMountCard from '@/components/common/VolumeMountCard.vue'

// 用会 emit 'created' 的桩替代真实 CreatePvcDialog,隔离其内部逻辑(Task 3 已单独覆盖)。
const CreatePvcStub = defineComponent({
  name: 'CreatePvcDialog',
  emits: ['created', 'update:modelValue'],
  props: { modelValue: Boolean, namespace: String },
  template: '<button data-testid="stub-emit-created" @click="$emit(\'created\', \'newpvc\')">stub</button>',
})

function makeEntry() {
  return reactive({ name: 'vol-1', target: 'main', type: 'pvc', mountPath: '/data', subPath: '', readOnly: false, pvcName: '', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] })
}

test('VolumeMountCard: PVC 下拉含传入 pvcs;点新建→stub emit created→entry.pvcName 与 options 同步', async () => {
  const entry = makeEntry()
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: ['a', 'b'], namespace: 'default' },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })

  // 初始:PVC 下拉含 a/b,不含 newpvc(第二个 select = 来源/PVC 下拉)
  const select = () => wrapper.findAll('select')[1]
  expect(select().text()).toContain('a')
  expect(select().text()).toContain('b')
  expect(select().text()).not.toContain('newpvc')

  // 点「新建」打开弹窗(stub 渲染)
  const newBtn = wrapper.findAll('button').find(b => b.attributes('title') === i18n.global.t('component.volumeMount.newPvc'))
  expect(newBtn).toBeTruthy()
  await newBtn.trigger('click')

  // stub 发 created('newpvc') → onPvcCreated
  await wrapper.find('[data-testid="stub-emit-created"]').trigger('click')

  // 自动选中(defineModel entry 直接 mutate 同一 reactive 对象)
  expect(entry.pvcName).toBe('newpvc')
  // 下拉 options 并入新名(createdPvcName ref 触发 pvcOptions 重算)
  expect(select().text()).toContain('newpvc')
  wrapper.unmount()
})

test('VolumeMountCard: namespace 为空时「新建」按钮 disabled', () => {
  const entry = makeEntry()
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: [], namespace: '' },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const newBtn = wrapper.findAll('button').find(b => b.attributes('title') === i18n.global.t('component.volumeMount.newPvc'))
  expect(newBtn.attributes('disabled')).toBeDefined()
  wrapper.unmount()
})
