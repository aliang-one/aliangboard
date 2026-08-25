import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref, h } from 'vue'
import { i18n } from '@/i18n'
import DataKeysEditor from '@/components/common/DataKeysEditor.vue'

const CVStub = { props: ['code', 'lang', 'maxHeight'], template: '<pre data-testid="cv">{{ code }}</pre>' }
// v-model 宿主：emit 驱动的组件须回灌 modelValue 才能看到状态推进
function mountEditor(props = {}) {
  const extra = { ...props }
  delete extra.modelValue
  const initial = props.modelValue || []
  const Host = defineComponent({
    setup() {
      const mv = ref(initial)
      return () => h(DataKeysEditor, {
        modelValue: mv.value,
        'onUpdate:modelValue': (v) => { mv.value = v },
        ...extra,
      })
    },
  })
  const w = mount(Host, { global: { plugins: [i18n], stubs: { CodeViewer: CVStub } } })
  // 透传内层组件的 emitted/vm，测试统一用 w.emitted()/w.vm
  const inner = () => w.findComponent(DataKeysEditor)
  return new Proxy(w, {
    get(target, prop) {
      if (prop === 'emitted') return inner().emitted.bind(inner())
      if (prop === 'vm') return inner().vm
      const v = target[prop]
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

test('自由模式:添加键→编辑→Save 写回 modelValue', async () => {
  const w = mountEditor()
  await w.find('[data-testid="dk-add"]').trigger('click')
  await w.findAll('input')[0].setValue('app.yml')     // 新行 key 输入
  await w.find('[data-testid="dk-edit"]').trigger('click')
  await w.find('textarea').setValue('a: 1')
  await w.find('[data-testid="dk-save"]').trigger('click')
  expect(w.emitted('update:modelValue').at(-1)[0]).toEqual([{ key: 'app.yml', value: 'a: 1' }])
})

test('自由模式:删除键', async () => {
  const w = mountEditor({ modelValue: [{ key: 'k', value: 'v' }] })
  await w.find('[data-testid="dk-del-0"]').trigger('click')
  expect(w.emitted('update:modelValue')[0][0]).toEqual([])
})

test('自由模式:Cancel 丢弃 draft 不 emit', async () => {
  const w = mountEditor({ modelValue: [{ key: 'k', value: 'v' }] })
  await w.find('[data-testid="dk-edit"]').trigger('click')
  await w.find('textarea').setValue('changed')
  await w.find('[data-testid="dk-cancel"]').trigger('click')
  expect(w.emitted('update:modelValue')).toBeUndefined()
  // 回到查看态，内容仍是原值
  expect(w.find('[data-testid="cv"]').text()).toContain('v')
})

test('secret 掩码:左栏未选中行显示 ••••，toggle 后 revealed 生效', async () => {
  const w = mountEditor({ modelValue: [{ key: 'pwd', value: 'x' }, { key: 'tok', value: 'y' }], secret: true })
  // 左栏键名可见，值摘要为掩码
  expect(w.text()).toContain('pwd')
  expect(w.text()).not.toContain('x:')
  await w.find('[data-testid="dk-mask"]').trigger('click')
  expect(w.vm.revealed.has('')).toBe(true)
})

test('固定字段模式:渲染 labelKey 字段并写回', async () => {
  const w = mountEditor({
    modelValue: [{ key: 'tls.crt', value: '' }],
    fixedFields: [{ key: 'tls.crt', labelKey: 'component.createConfigModal.fTlsCrt', multiline: true }],
  })
  await w.find('textarea').setValue('CERT')
  expect(w.emitted('update:modelValue').at(-1)[0]).toEqual([{ key: 'tls.crt', value: 'CERT' }])
})

test('固定字段模式:secret 单行 input 掩码可切换', async () => {
  const w = mountEditor({
    modelValue: [{ key: 'password', value: 'x' }],
    fixedFields: [{ key: 'password', labelKey: 'component.createConfigModal.fPassword', multiline: false, secret: true }],
  })
  const input = w.find('input[type="password"]')
  expect(input.exists()).toBe(true)
  await w.find('[data-testid="dk-mask-password"]').trigger('click')
  expect(w.find('input[type="text"]').exists()).toBe(true)
})

test('编辑会话不被 modelValue 回灌静默丢弃:编辑中改键名→draft 保留,Save 写到新键名条目', async () => {
  const w = mountEditor({ modelValue: [{ key: 'app.yml', value: 'old' }] })
  await w.find('[data-testid="dk-edit"]').trigger('click')
  await w.find('textarea').setValue('draft-value')
  // 编辑中在左栏改键名 → updateKey emit → 宿主回灌 modelValue（引用级变化）
  await w.findAll('input')[0].setValue('renamed.yml')
  // watch 不得重置 editing：textarea 仍在且 draft 未丢
  expect(w.find('textarea').exists()).toBe(true)
  expect(w.vm.editing).toBe(true)
  expect(w.vm.draft).toBe('draft-value')
  await w.find('[data-testid="dk-save"]').trigger('click')
  // Save 按当前索引写回：新键名条目的值为 draft 值
  expect(w.emitted('update:modelValue').at(-1)[0]).toEqual([{ key: 'renamed.yml', value: 'draft-value' }])
})

test('空态:无键显示引导文案', () => {
  const w = mountEditor()
  expect(w.find('[data-testid="dk-empty"]').exists()).toBe(true)
})
