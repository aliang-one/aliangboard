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
