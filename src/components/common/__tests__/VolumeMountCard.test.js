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
  expect(mpInput.attributes('aria-invalid')).toBe('true') // 无障碍:错误字段标 aria-invalid
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
  // fixture 显式设默认值(Task 9 addVolume 会传 'DirectoryOrCreate');卡片对 undefined 不 coerce(回填保真)
  entry.hostPathType = 'DirectoryOrCreate'
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

test('VolumeMountCard: defaultMode custom 路径——非预设值显示 custom;选 custom 从空播种 0444', async () => {
  const custom = makeEntry(); custom.type = 'configMap'; custom.cmName = 'cm'; custom.defaultMode = '0444'
  const w1 = mount(VolumeMountCard, { props: { modelValue: custom, pvcs: [], namespace: 'default', issues: [] }, global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } } })
  const sel1 = w1.findAll('select').find(s => s.element.value === 'custom')
  expect(sel1).toBeTruthy() // 0444 ∉ {'',0400,0640} → custom 档
  const customInput = w1.findAll('input').find(i => i.attributes('placeholder') === '0444')
  expect(customInput).toBeTruthy()
  await customInput.setValue('0400')
  expect(custom.defaultMode).toBe('0400')
  w1.unmount()

  const blank = makeEntry(); blank.type = 'secret'; blank.secretName = 's'
  const w2 = mount(VolumeMountCard, { props: { modelValue: blank, pvcs: [], namespace: 'default', issues: [] }, global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } } })
  const sel2 = w2.findAll('select').find(s => s.element.value === '')
  await sel2.setValue('custom')
  expect(blank.defaultMode).toBe('0444') // 从空选 custom → 播种合法八进制
  w2.unmount()
})

test('VolumeMountCard: 落点预览——无 items 列全部键(binaryData 键并列);items 树形标注来源与告警;subPath 单文件', () => {
  qData.cm.value = [{ name: 'cm', namespace: 'default', data: { k1: '1' }, binaryKeys: ['b.bin'] }]

  const whole = makeEntry(); whole.type = 'configMap'; whole.cmName = 'cm'; whole.mountPath = '/etc/config'
  const w1 = mount(VolumeMountCard, { props: { modelValue: whole, pvcs: [], namespace: 'default', issues: [] }, global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } } })
  const prev1 = w1.find('[data-testid="mount-preview"]')
  expect(prev1.text()).toContain('/etc/config')
  expect(prev1.text()).toContain('k1')
  expect(prev1.text()).toContain('b.bin')
  // binaryData 键带 B 角标(data 键不带)
  const badges = prev1.findAll('span').filter(s => s.text() === 'B')
  expect(badges.length).toBe(1)
  w1.unmount()

  const items = makeEntry(); items.type = 'configMap'; items.cmName = 'cm'; items.mountPath = '/etc/app'
  items.items = [{ key: 'k1', path: 'conf/a.yml' }, { key: 'ghost', path: 'b.yml' }]
  const w2 = mount(VolumeMountCard, { props: { modelValue: items, pvcs: [], namespace: 'default', issues: [] }, global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } } })
  const prev2 = w2.find('[data-testid="mount-preview"]')
  expect(prev2.text()).toContain('conf/a.yml')
  expect(prev2.text()).toContain('← key: k1')
  expect(prev2.text()).toContain(i18n.global.t('component.volumeMount.issue.itemKeyMissing'))
  w2.unmount()

  const sub = makeEntry(); sub.type = 'configMap'; sub.cmName = 'cm'; sub.mountPath = '/etc/app'; sub.subPath = 'k1'
  const w3 = mount(VolumeMountCard, { props: { modelValue: sub, pvcs: [], namespace: 'default', issues: [] }, global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } } })
  expect(w3.find('[data-testid="mount-preview"]').text()).toContain(i18n.global.t('component.volumeMount.previewSubPath'))
  w3.unmount()
  qData.cm.value = []
})

test('VolumeMountCard: unknown 卷——锁定标签+原样保留提示;mountPath 可编辑;items/defaultMode 区不渲染', () => {
  const entry = makeEntry()
  entry.type = 'unknown'
  entry.raw = { name: 'proj-1', projected: { sources: [] } }
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: [], namespace: 'default', issues: [{ code: 'mountPathRequired', field: 'mountPath', level: 'error' }] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  expect(wrapper.text()).toContain('projected')                        // 锁定标签展示 raw 类型键
  expect(wrapper.text()).toContain(i18n.global.t('component.volumeMount.unknownNotice'))
  const mpInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '/etc/config')
  expect(mpInput).toBeTruthy()                                          // mountPath 仍可编辑
  expect(wrapper.text()).not.toContain(i18n.global.t('component.volumeMount.keyMapping'))
  wrapper.unmount()
})

test('VolumeMountCard: 三区块合并问题区——顶行/底行文案进区块问题区,字段红框保留', () => {
  const entry = makeEntry()
  const wrapper = mount(VolumeMountCard, {
    props: {
      modelValue: entry, pvcs: [], namespace: 'default',
      issues: [
        { code: 'sourceNotFound', field: 'source', level: 'error' },
        { code: 'mountPathRoot', field: 'mountPath', level: 'error' },
        { code: 'subPathNotInVolume', field: 'subPath', level: 'warn' },
      ],
    },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const top = wrapper.find('[data-testid="issues-source-row"]')
  expect(top.exists()).toBe(true)
  expect(top.text()).toContain(i18n.global.t('component.volumeMount.issue.sourceNotFound'))
  const mountRow = wrapper.find('[data-testid="issues-mount-row"]')
  expect(mountRow.text()).toContain(i18n.global.t('component.volumeMount.issue.mountPathRoot'))
  expect(mountRow.text()).toContain(i18n.global.t('component.volumeMount.issue.subPathNotInVolume'))
  // 字段级红框仍在(问题区只管文案,框定位字段)
  const mpInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '/etc/config')
  expect(mpInput.classes().join(' ')).toContain('!border-error')
  wrapper.unmount()
})

test('VolumeMountCard: 键映射问题区收编 items/defaultMode;itemsPath 行级文案仍在行内;无问题零渲染', () => {
  const cm = makeEntry(); cm.type = 'configMap'; cm.cmName = 'cm'
  cm.items = [{ key: 'k1', path: '' }]
  const wrapper = mount(VolumeMountCard, {
    props: {
      modelValue: cm, pvcs: [], namespace: 'default',
      issues: [
        { code: 'itemsIncomplete', field: 'items', level: 'error' },
        { code: 'itemPathInvalid', field: 'itemsPath:0', level: 'error' },
      ],
    },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const itemsBlock = wrapper.find('[data-testid="issues-items"]')
  expect(itemsBlock.exists()).toBe(true)
  expect(itemsBlock.text()).toContain(i18n.global.t('component.volumeMount.issue.itemsIncomplete'))
  expect(itemsBlock.text()).not.toContain(i18n.global.t('component.volumeMount.issue.itemPathInvalid'))
  expect(wrapper.text()).toContain(i18n.global.t('component.volumeMount.issue.itemPathInvalid')) // 行内仍在
  wrapper.unmount()

  const clean = mount(VolumeMountCard, {
    props: { modelValue: makeEntry(), pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  expect(clean.find('[data-testid="issues-source-row"]').exists()).toBe(false)
  expect(clean.find('[data-testid="issues-mount-row"]').exists()).toBe(false)
  clean.unmount()
})
