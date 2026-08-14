import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const addIngress = vi.fn(async () => ({ ok: true }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', nsServices: [], fetchServices: vi.fn(async () => []), fetchIngresses: vi.fn(async () => []), fetchIngressClasses: vi.fn(async () => [{ name: 'traefik' }, { name: 'nginx' }, { name: 'istio-thing' }]), addIngress, setNamespace: () => {} }) }))
vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn() } }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsIngress from '../NsIngress.vue'

function mountDlg() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsIngress, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: { props: ['modelValue','title','width'], emits: ['update:modelValue','cancel'], template: '<div><slot/><slot name="actions"/><button data-testid="modal-x" @click="$emit(\'cancel\'); $emit(\'update:modelValue\', false)">x</button></div>' }, Breadcrumbs: true, Pagination: true, PortSelect: true, AnnotationKeySelect: true, DataTable: true } } })
}

test('选 traefik + 填 entrypoints → addIngress 注解带 traefik 前缀、无 nginx 键', async () => {
  const w = mountDlg()
  await flushPromises()
  // 填写必填字段以启用 create 按钮(PortSelect 被 stub,通过 vm 直接设值)
  w.vm.createForm.name = 'test-ing'
  w.vm.createForm.host = 'app.test.com'
  w.vm.createForm.serviceName = 'svc1'
  await w.find('[data-testid="ingress-class-select"]').setValue('traefik')
  await flushPromises()
  // 切到「性能调优」标签(traefik 有 perf 组)
  await w.find('[data-testid="tab-perf"]').trigger('click')
  await flushPromises()
  await w.find('[data-testid="perf-panel"] input[placeholder="web"]').setValue('websecure')
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  const arg = addIngress.mock.calls.at(-1)[0]
  expect(arg.annotations['traefik.ingress.kubernetes.io/router.entrypoints']).toBe('websecure')
  expect(Object.keys(arg.annotations).some(k => k.startsWith('nginx.ingress.kubernetes.io/'))).toBe(false)
})

// 复查发现的真实缺陷回归:自定义注解原先只在 extra 标签渲染,traefik/kong/generic 无 extra 组 → 不可达(违反 spec「generic 保留自定义注解」)
test('generic(未知类)→ perf 标签可达且自定义注解兜底显示,能进提交注解', async () => {
  const w = mountDlg()
  await flushPromises()
  w.vm.createForm.name = 'g1'; w.vm.createForm.host = 'a.test'; w.vm.createForm.serviceName = 's'
  await w.find('[data-testid="ingress-class-select"]').setValue('istio-thing')
  await flushPromises()
  await w.find('[data-testid="tab-perf"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="custom-annotations"]').exists()).toBe(true)   // generic 下兜底显示
  expect(w.find('[data-testid="tab-extra"]').exists()).toBe(false)           // 无 extra 组,标签隐藏
  w.vm.customAnnotations.push({ key: 'custom.example/x', value: '1' })
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  const arg = addIngress.mock.calls.at(-1)[0]
  expect(arg.annotations['custom.example/x']).toBe('1')
  expect(Object.keys(arg.annotations).some(k => k.startsWith('nginx.') || k.startsWith('traefik.'))).toBe(false)
})

test('停在 extra 标签时切到无 extra 组的方言 → 自动跳回 perf,自定义注解仍可达', async () => {
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  await flushPromises()
  await w.find('[data-testid="tab-extra"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="custom-annotations"]').exists()).toBe(true)   // nginx extra 下原有位置
  // 停在 extra 时直接改 className(类下拉在 basic 标签里,经 vm 改源状态)
  w.vm.createForm.className = 'traefik'
  await flushPromises()
  expect(w.find('[data-testid="tab-extra"]').exists()).toBe(false)           // extra 按钮随方言消失
  expect(w.find('[data-testid="custom-annotations"]').exists()).toBe(true)   // watch 自动跳 perf 后兜底显示
})

// 复查缺陷回归:经 X/ESC/背景关闭(cancel)同样重置创建表单,防旧值泄漏到下次打开
test('cancel 事件(X/ESC/背景关闭)重置创建表单', async () => {
  const w = mountDlg()
  await flushPromises()
  w.vm.createForm.name = 'leak-test'
  w.vm.customAnnotations.push({ key: 'a/b', value: '1' })
  await w.find('[data-testid="modal-x"]').trigger('click')
  await flushPromises()
  expect(w.vm.createForm.name).toBe('')
  expect(w.vm.customAnnotations.length).toBe(0)
  expect(w.vm.createTab).toBe('basic')
})
