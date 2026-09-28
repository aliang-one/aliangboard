import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, ref } from 'vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import CodeViewer from '@/components/common/CodeViewer.vue'
import { i18n } from '@/i18n'

test('YamlEditor: 点 Edit 触发 edit-start 事件', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'kind: NetworkPolicy\n', readonly: false },
    global: { plugins: [i18n] },
  })
  await wrapper.find('button').trigger('click') // 工具栏首个按钮(Edit)
  expect(wrapper.emitted('edit-start')).toBeTruthy()
})

test('YamlEditor: 未传 heightClass 行为不变(根无填充类,textarea 固定 min/max-height)', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'kind: Service\n', readonly: false, height: '420px' },
    global: { plugins: [i18n] },
  })
  expect(wrapper.find('textarea').exists()).toBe(false)
  await wrapper.find('button').trigger('click') // 工具栏首按钮 = Edit,进入编辑态
  const ta = wrapper.find('textarea')
  expect(ta.classes()).not.toContain('flex-1')
  expect(ta.attributes('style')).toContain('420px')
  expect(wrapper.find('[data-testid="yaml-view"]').classes()).not.toContain('flex-1')
  wrapper.unmount()
})

test('YamlEditor: 传 heightClass → 根挂类,视图区 flex 填充,textarea 撑满非固定高', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'kind: Service\n', readonly: false, height: '420px', heightClass: 'flex-1 min-h-0' },
    global: { plugins: [i18n] },
  })
  // 根元素挂上传的 class
  expect(wrapper.element.className).toContain('min-h-0')
  // 查看态:视图容器获得填充类
  const view = wrapper.find('[data-testid="yaml-view"]')
  expect(view.classes()).toContain('flex-1')
  expect(view.classes()).toContain('flex')
  await wrapper.find('button').trigger('click')
  const ta = wrapper.find('textarea')
  expect(ta.classes()).toContain('flex-1')
  expect(ta.classes()).toContain('min-h-0')
  expect(ta.attributes('style') ?? '').not.toContain('420px')
  wrapper.unmount()
})

// ---- 回声(echo)回归锁 ----
// 背景:v-model 双向消费方(如 CreateFromYamlDialog)键入一字 → emit('update:modelValue')
// → 父回写 → props.modelValue 变 → 组件内 watch 误把【自己的回声】当外部变化,isEditing=false,
// 第一字符即被踢出编辑态。修复 = 回声守卫 + editBase 基线。

// 复刻 CreateFromYamlDialog.vue:62 的 v-model 消费形态
function mountTwoWay(initial = 'kind: Service\n') {
  const Host = defineComponent({
    components: { YamlEditor },
    setup() { const yaml = ref(initial); return { yaml } },
    template: '<YamlEditor v-model="yaml" />',
  })
  const wrapper = mount(Host, { global: { plugins: [i18n] } })
  return { wrapper, editor: wrapper.findComponent(YamlEditor), getYaml: () => wrapper.vm.yaml }
}

async function enterEdit(wrapper) {
  await wrapper.find('button').trigger('click') // 工具栏首个按钮(Edit)
}

test('YamlEditor: v-model 双向接线键入字符不退出编辑态(回声守卫)', async () => {
  const { wrapper, editor } = mountTwoWay()
  await enterEdit(wrapper)
  expect(editor.find('textarea').exists()).toBe(true)
  // 键入一个字符:emit 回声经父组件 v-model 回写 props.modelValue
  await editor.find('textarea').setValue('kind: ServiceX\n')
  // 修复前:回声触发 watch → isEditing=false,textarea 消失、回到 CodeViewer
  expect(editor.find('textarea').exists()).toBe(true)
  expect(editor.findComponent(CodeViewer).exists()).toBe(false)
})

test('YamlEditor: v-model 接线编辑中 Action Bar 出现且 Discard 回滚到编辑前基线', async () => {
  const { wrapper, editor, getYaml } = mountTwoWay()
  await enterEdit(wrapper)
  await editor.find('textarea').setValue('kind: ServiceX\n')
  // 修复前:回声把 hasChanges 一并清掉,Action Bar 不出现
  const discard = editor.findAll('button').find(b => b.text() === i18n.global.t('common.discard'))
  expect(discard).toBeTruthy()
  await discard.trigger('click')
  // 父值(经 v-model)与视图均回到基线
  expect(getYaml()).toBe('kind: Service\n')
  expect(editor.findComponent(CodeViewer).exists()).toBe(true)
  expect(editor.findComponent(CodeViewer).props('code')).toBe('kind: Service\n')
})

test('YamlEditor: 单向接线外部 modelValue 变化仍同步(回声守卫不误伤外部同步)', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'a: 1\n', readonly: false },
    global: { plugins: [i18n] },
  })
  await wrapper.setProps({ modelValue: 'a: 2\n' })
  const cv = wrapper.findComponent(CodeViewer)
  expect(cv.exists()).toBe(true)
  expect(cv.props('code')).toBe('a: 2\n')
})

test('YamlEditor: 单向接线编辑中有未保存改动时外部变化不覆盖用户草稿', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'a: 1\n', readonly: false },
    global: { plugins: [i18n] },
  })
  await wrapper.find('button').trigger('click') // Edit
  await wrapper.find('textarea').setValue('a: 1 # 用户草稿\n')
  // 外部(如 live refetch)modelValue 变化:不踢出、不覆盖草稿
  await wrapper.setProps({ modelValue: 'a: 2\n' })
  expect(wrapper.find('textarea').exists()).toBe(true)
  expect(wrapper.find('textarea').element.value).toBe('a: 1 # 用户草稿\n')
  // Discard → 回到编辑前基线
  const discard = wrapper.findAll('button').find(b => b.text() === i18n.global.t('common.discard'))
  await discard.trigger('click')
  expect(wrapper.findComponent(CodeViewer).props('code')).toBe('a: 1\n')
})
