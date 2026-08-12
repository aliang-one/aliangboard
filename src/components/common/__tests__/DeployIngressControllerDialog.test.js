import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: {
    ingressControllers: {
      catalog: vi.fn(async () => ({ templates: [
        { id: 'nginx-ingress', labelKey: 'ingressController.nginx-ingress.label', version: 'v1', variant: 'bare-metal', controller: 'k8s.io/ingress-nginx', defaultClassName: 'nginx' },
      ] })),
      manifest: vi.fn(async () => ({ yaml: 'apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: nginx\n' })),
      applyYaml: vi.fn(async () => ({ applied: [], failed: [], total: 0 })),
    },
    k8s: vi.fn(async () => ({ status: { allowed: true } })),
  },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ currentCluster: 'demo', checkAccessServer: vi.fn(async () => ({ allowed: true })) }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployIngressControllerDialog from '../DeployIngressControllerDialog.vue'

// Modal 会 Teleport 到 body,交互测试里用不 Teleport 的桩替换,便于 wrapper.find(沿用 CreatePvcDialog 约定)。
const ModalStub = {
  props: { modelValue: Boolean, title: String, width: String },
  emits: ['update:modelValue', 'confirm', 'cancel'],
  template: '<div v-if="modelValue"><slot /><slot name="actions" /></div>',
}

function mountDlg() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployIngressControllerDialog, {
    props: { modelValue: true },
    global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: ModalStub } },
  })
}

test('打开即拉 catalog 并渲染控制器卡片', async () => {
  const w = mountDlg()
  await flushPromises()
  // 不依赖 i18n 回退文本(labelKey 未翻译时恰好含 'nginx-ingress' 子串,Task 6 加翻译后会失效);
  // 改用稳定的 testid + 非 i18n 字段(version/variant)断言卡片已渲染。
  expect(w.find('[data-testid="controller-card"]').exists()).toBe(true)
  expect(w.text()).toContain('v1 · bare-metal')
})

test('选控制器后载入清单到编辑器(props.manifest 调用一次)', async () => {
  const { api } = await import('@/api/client')
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  expect(api.ingressControllers.manifest).toHaveBeenCalledWith('nginx-ingress')
})
