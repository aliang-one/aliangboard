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

// ---- Issue #22 回归锁:保存/放弃常驻工具栏(编辑态恒可见),不再依赖底部按需 Action Bar ----
// 背景:CRD 详情 Instances 展开行内嵌 360px 编辑器,保存按钮只在「编辑中且有改动」后出现在
// 编辑器底部 —— 落在表格展开行的视口折叠线下方,用户编辑完找不到保存按钮(issue#22)。
// 修复:进入编辑态即恒可见 [放弃][应用更改](未改动时禁用防误触),位置在顶部工具栏;
// 底部 Action Bar 移除(单一事实位置)。

const applyLabel = () => i18n.global.t('common.applyChanges')
const discardLabel = () => i18n.global.t('common.discard')

test('YamlEditor: issue#22 进入编辑态工具栏立即出现 应用更改(未改动=禁用,点击无效)与 放弃', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'a: 1\n', readonly: false },
    global: { plugins: [i18n] },
  })
  await wrapper.find('button').trigger('click') // Edit
  const toolbar = wrapper.find('[data-testid="yaml-editor-toolbar"]')
  const apply = toolbar.findAll('button').find(b => b.text() === applyLabel())
  const discard = toolbar.findAll('button').find(b => b.text() === discardLabel())
  expect(apply).toBeTruthy()
  expect(discard).toBeTruthy()
  expect(apply.attributes('disabled')).toBeDefined() // 未改动:禁用
  // 单一事实位置(issue#22 设计裁决):全组件恰一份「应用更改」——底部 Action Bar 若回归成双份,此行锁死
  expect(wrapper.findAll('button').filter(b => b.text() === applyLabel()).length).toBe(1)
  await apply.trigger('click')
  expect(wrapper.emitted('save')).toBeUndefined() // 禁用语义:clean 时程序化点击也不 emit
})

test('YamlEditor: issue#22 打字后 应用更改 启用,点击 emit save 并回到查看态', async () => {
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'a: 1\n', readonly: false },
    global: { plugins: [i18n] },
  })
  await wrapper.find('button').trigger('click') // Edit
  await wrapper.find('textarea').setValue('a: 2\n')
  const toolbar = wrapper.find('[data-testid="yaml-editor-toolbar"]')
  const apply = toolbar.findAll('button').find(b => b.text() === applyLabel())
  expect(apply.attributes('disabled')).toBeUndefined() // 有改动:启用
  await apply.trigger('click')
  expect(wrapper.emitted('save')).toEqual([['a: 2\n']])
  expect(wrapper.find('textarea').exists()).toBe(false) // 回到查看态
})

test('YamlEditor: issue#22 编辑态未打字时外部 modelValue 同步不踢出编辑态(原地换基线)', async () => {
  // 复刻 CrdDetail 展开行竞态:懒拉取的实时 YAML 在用户点 Edit 之后才落地
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'template\n', readonly: false },
    global: { plugins: [i18n] },
  })
  await wrapper.find('button').trigger('click') // Edit(基线=模板)
  await wrapper.setProps({ modelValue: 'real: yaml\n' }) // 懒拉取落地
  // 修复前:watch 把外部同步当「退出编辑」信号 → isEditing=false,textarea 消失
  expect(wrapper.find('textarea').exists()).toBe(true)
  expect(wrapper.find('textarea').element.value).toBe('real: yaml\n')
  // 基线已原地换新:打字 → save 发新值(不会把模板旧底混进来)
  await wrapper.find('textarea').setValue('real: yaml # edited\n')
  const apply = wrapper.findAll('button').find(b => b.text() === applyLabel())
  await apply.trigger('click')
  expect(wrapper.emitted('save')).toEqual([['real: yaml # edited\n']])
})

test('YamlEditor: issue#22 外部同步原地换基线——同步后未打字 apply 禁用,放弃回滚到新基线而非旧模板', async () => {
  // 对抗审查证实项(变异实验:删 watch 中 editBase.value=val 后旧测试全绿):
  // 基线未换时 hasChanges 以陈旧基线比较恒真 → 未打字 apply 误启用(误点=对集群无改动写回)、
  // 放弃回滚旧模板串并把 template 旧底 emit 给父组件。本测试三条断言全部杀该变异。
  const wrapper = mount(YamlEditor, {
    props: { modelValue: 'template\n', readonly: false },
    global: { plugins: [i18n] },
  })
  await wrapper.find('button').trigger('click') // Edit(基线=模板)
  await wrapper.setProps({ modelValue: 'real: yaml\n' }) // 懒拉取落地,原地换基线
  // 未打字:apply 必须禁用(基线未换的变异下此处误启用)
  const apply = wrapper.findAll('button').find(b => b.text() === applyLabel())
  expect(apply.attributes('disabled')).toBeDefined()
  // 放弃:回滚到【新基线】实时 YAML,而非旧模板;v-model 消费方同样收到新基线
  const discard = wrapper.findAll('button').find(b => b.text() === discardLabel())
  await discard.trigger('click')
  expect(wrapper.findComponent(CodeViewer).props('code')).toBe('real: yaml\n')
  expect(wrapper.emitted('update:modelValue').at(-1)).toEqual(['real: yaml\n'])
})
