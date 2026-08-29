import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, reactive, defineComponent } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const { qData } = vi.hoisted(() => ({ qData: { cm: { value: [] }, secret: { value: [] } } }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: ({ key }) => ({ data: key[2] === 'configmaps' ? qData.cm : key[2] === 'secrets' ? qData.secret : { value: [] } }),
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

test('VolumeMountCard: issues 驱动红框/黄框/行内文案;头部状态灯分级', () => {
  const entry = makeEntry()
  const wrapper = mount(VolumeMountCard, {
    props: {
      modelValue: entry, pvcs: [], namespace: 'default',
      issues: [
        { code: 'mountPathRoot', field: 'mountPath', level: 'error' },
        { code: 'mountPathNested', field: 'mountPath', level: 'warn' },
        { code: 'readOnlySuggested', field: 'readOnly', level: 'hint' },
      ],
    },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const mpInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '/etc/config')
  expect(mpInput.classes().join(' ')).toContain('!border-error')
  expect(wrapper.text()).toContain(i18n.global.t('component.volumeMount.issue.mountPathRoot'))
  expect(wrapper.text()).toContain(i18n.global.t('component.volumeMount.issue.readOnlySuggested'))
  const dot = wrapper.find('[data-testid="status-dot"]')
  expect(dot.classes().join(' ')).toContain('bg-error')
  wrapper.unmount()
})

test('VolumeMountCard: 无 error 有 warn → 状态灯黄;干净 → 隐藏', () => {
  const mk = issues => mount(VolumeMountCard, {
    props: { modelValue: makeEntry(), pvcs: [], namespace: 'default', issues },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const warnOnly = mk([{ code: 'mountPathNested', field: 'mountPath', level: 'warn' }])
  expect(warnOnly.find('[data-testid="status-dot"]').classes().join(' ')).toContain('bg-tertiary-container')
  warnOnly.unmount()
  const clean = mk([])
  expect(clean.find('[data-testid="status-dot"]').exists()).toBe(false)
  clean.unmount()
})

test('VolumeMountCard: mountPath 失焦自动归一(写回 entry)', async () => {
  const entry = makeEntry()
  entry.mountPath = ' /data// '
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const mpInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '/etc/config')
  await mpInput.trigger('blur')
  expect(entry.mountPath).toBe('/data')
  wrapper.unmount()
})

test('VolumeMountCard: hostPath 类型显示 hostPathType 下拉(默认值可改写 entry);cm/secret 显示 defaultMode', async () => {
  const entry = makeEntry()
  entry.type = 'hostPath'; entry.hostPath = '/data'
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const typeSel = wrapper.findAll('select').find(s => s.element.value === 'DirectoryOrCreate')
  expect(typeSel).toBeTruthy()
  await typeSel.setValue('Directory')
  expect(entry.hostPathType).toBe('Directory')
  wrapper.unmount()

  const cm = makeEntry(); cm.type = 'configMap'; cm.cmName = 'cm'
  const w2 = mount(VolumeMountCard, {
    props: { modelValue: cm, pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const modeSel = w2.findAll('select').find(s => s.element.value === '')
  await modeSel.setValue('0640')
  expect(cm.defaultMode).toBe('0640')
  w2.unmount()
})
