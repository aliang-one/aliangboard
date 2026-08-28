import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { notify } from '@/composables/useToast'

const addIngress = vi.fn(async () => ({ ok: true }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', watchStateOf: () => 'off', nsServices: [], fetchServices: vi.fn(async () => []), fetchIngresses: vi.fn(async () => []), fetchIngressClasses: vi.fn(async () => [{ name: 'traefik' }, { name: 'nginx' }, { name: 'istio-thing' }]), addIngress, setNamespace: () => {} }) }))
vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn() } }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import NsIngress from '../NsIngress.vue'

// CreateWithYamlButton 须 stub:其内嵌 CreateFromYamlDialog 的 Modal 也吃下面的 Modal stub,
// 且 DOM 序在创建 Modal 之前 → w.find('[data-testid="modal-x"]') 会命中 YAML 弹窗的 X 而非创建弹窗的。
function mountDlg() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsIngress, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: { props: ['modelValue','title','width'], emits: ['update:modelValue','cancel'], template: '<div><slot/><slot name="actions"/><button data-testid="modal-x" @click="$emit(\'cancel\'); $emit(\'update:modelValue\', false)">x</button></div>' }, Breadcrumbs: true, Pagination: true, PortSelect: true, AnnotationKeySelect: true, DataTable: true, CreateWithYamlButton: true } } })
}

test('选 traefik + 填 entrypoints → addIngress 注解带 traefik 前缀、无 nginx 键', async () => {
  const w = mountDlg()
  await flushPromises()
  // 填写必填字段以启用 create 按钮(多 host 规则模型:hosts[0] + PortSelect 被 stub,通过 vm 直接设值)
  w.vm.createForm.name = 'test-ing'
  w.vm.hosts[0].host = 'app.test.com'
  w.vm.hosts[0].paths[0].serviceName = 'svc1'
  w.vm.hosts[0].paths[0].servicePort = '80'
  await flushPromises()   // 编辑器 validation watch 重算,清空 rulesErrors 解锁按钮
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
  w.vm.createForm.name = 'g1'; w.vm.hosts[0].host = 'a.test'; w.vm.hosts[0].paths[0].serviceName = 's'; w.vm.hosts[0].paths[0].servicePort = '80'
  await flushPromises()
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
  w.vm.hosts[0].host = 'leak.example.com'
  w.vm.customAnnotations.push({ key: 'a/b', value: '1' })
  await w.find('[data-testid="modal-x"]').trigger('click')
  await flushPromises()
  expect(w.vm.createForm.name).toBe('')
  expect(w.vm.hosts[0].host).toBe('')
  expect(w.vm.hosts[0].paths).toEqual([{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '' }])
  expect(w.vm.customAnnotations.length).toBe(0)
  expect(w.vm.createTab).toBe('basic')
})

// vt 元信息落地:size 字段=数字+单位下拉,emit 规范串;非法值提交被拦截
test('proxy-buffer-size 渲染单位下拉,4+k → 注解值 "4k"', async () => {
  const w = mountDlg()
  await flushPromises()
  w.vm.createForm.name = 'sz'; w.vm.hosts[0].host = 'a.test'; w.vm.hosts[0].paths[0].serviceName = 's'; w.vm.hosts[0].paths[0].servicePort = '80'
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  await flushPromises()
  await w.find('[data-testid="tab-perf"]').trigger('click')
  await flushPromises()
  const num = w.find('[data-testid="perf-panel"] input[placeholder="4k"]')
  await num.setValue('4')
  await w.find('[data-testid="unit-proxy-buffer-size"]').setValue('k')
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  const arg = addIngress.mock.calls.at(-1)[0]
  expect(arg.annotations['nginx.ingress.kubernetes.io/proxy-buffer-size']).toBe('4k')
})

test('非法值(自定义注解 proxy-buffer-size=4kb)→ 拦截:addIngress 不被调、弹窗保留、toast 报错', async () => {
  addIngress.mockClear()
  const w = mountDlg()
  await flushPromises()
  w.vm.createForm.name = 'bad'; w.vm.hosts[0].host = 'a.test'; w.vm.hosts[0].paths[0].serviceName = 's'; w.vm.hosts[0].paths[0].servicePort = '80'
  w.vm.showCreateModal = true   // Modal 被 stub 恒渲染内容,显式打开以断言「拦截后弹窗保留」
  w.vm.customAnnotations.push({ key: 'nginx.ingress.kubernetes.io/proxy-buffer-size', value: '4kb' })
  await flushPromises()   // 等待 :disabled 重渲染;VTU trigger 对 disabled 元素不派发事件
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  expect(addIngress).not.toHaveBeenCalled()
  expect(w.vm.showCreateModal).toBe(true)
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('k/m/g'))
})

test('非法性能字段值(proxy-send-timeout=6o)→ 拦截且 toast 指名字段', async () => {
  addIngress.mockClear()
  const w = mountDlg()
  await flushPromises()
  w.vm.createForm.name = 'bad2'; w.vm.hosts[0].host = 'a.test'; w.vm.hosts[0].paths[0].serviceName = 's'; w.vm.hosts[0].paths[0].servicePort = '80'
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')   // proxy-send-timeout 属 nginx 方言,校验器按方言分组扫描
  await flushPromises()
  w.vm.adv['proxy-send-timeout'] = '6o'   // 数字框拦不住脚本注入,走校验器兜底(须在切方言后注入,watch 会清 adv)
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  expect(addIngress).not.toHaveBeenCalled()
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('发送超时'))
})
