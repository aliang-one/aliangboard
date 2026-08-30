import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import YamlEditor from '@/components/common/YamlEditor.vue'
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
