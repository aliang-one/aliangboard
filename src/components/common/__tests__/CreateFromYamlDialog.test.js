import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

// 组件挂载即触发 useResourceApply()→useClusterStore()→activeApiServer()→localStorage。
// happy-dom 在 vitest 下对 localStorage 的支持不稳定(见 vitest --localstorage-file 警告),
// 且本冒烟测试只校验「渲染标题 + YamlEditor 模板填充」,不测 apply 行为,故 mock 掉 composable,
// 与仓库既有 NsIngress 测试 mock @/stores/cluster 同理(隔离网络/storage 副作用)。
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: vi.fn(async () => ({ ok: true, kind: 'Deployment', name: 'my-app' })) }),
}))

import CreateFromYamlDialog from '@/components/common/CreateFromYamlDialog.vue'

test('CreateFromYamlDialog: 挂载并渲染标题 + YamlEditor', () => {
  const wrapper = mount(CreateFromYamlDialog, {
    props: { modelValue: true, namespace: 'default' },
    global: { plugins: [createPinia(), i18n] },
  })
  // Modal teleport 到 body,wrapper.text() 可能不含标题;统一查 document.body。
  expect(document.body.textContent).toContain(i18n.global.t('component.createFromYaml.title'))
  // YamlEditor 存在(modelValue 已被 immediate watch 填充为模板,非空,含 my-app)
  expect(document.body.textContent).toContain('my-app')
  wrapper.unmount()
})
