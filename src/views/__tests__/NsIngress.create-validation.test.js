// NsIngress 创建弹窗的 backend 校验回归:
//   hostsToK8sSpec 生成层不兜底(spec §3.3),向导拦了、此处曾没拦 →
//   空端口/命名端口经 Number()→NaN/0 → generateYAML `|| 80` → 静默指向 80 端口。
// 背景:2026-08-17 系统审计 P2-B。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const addIngress = vi.fn(async () => ({ ok: true }))
const notify = vi.fn()

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
}))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notify(...a) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    watchStateOf: () => 'off',
    currentCluster: 'demo', setNamespace: () => {},
    fetchIngresses: vi.fn(async () => []), fetchServices: vi.fn(async () => []),
    fetchIngressClasses: vi.fn(async () => []),
    addIngress: (...a) => addIngress(...a),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'demo' } }), useRouter: () => ({ push: () => {} }) }))

import NsIngress from '../NsIngress.vue'

function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsIngress, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { DataTable: true, Breadcrumbs: true, Pagination: true, Modal: true, AnnotationKeySelect: true, IngressRulesEditor: true, IngressPerfField: true } } })
}

const H = (host, paths) => ({ host, tls: false, tlsSecret: '', paths })
const P = (serviceName, servicePort, path = '/') => ({ path, pathType: 'Prefix', serviceName, servicePort })

beforeEach(() => { addIngress.mockClear(); notify.mockClear(); addIngress.mockResolvedValue({ ok: true }) })

async function createWith(hosts) {
  const w = mountView()
  await flushPromises()
  await w.setData({ hosts, createForm: { name: 'ing-1', className: '' }, showCreateModal: true })
  await w.vm.handleCreate()
  await flushPromises()
  return w
}

test('serviceName 为空:不发请求 + notify + 弹窗保留', async () => {
  const w = await createWith([H('a.com', [P('', '80')])])
  expect(addIngress).not.toHaveBeenCalled()
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining('a.com'))
  expect(w.vm.showCreateModal).toBe(true)
})

test('端口非纯数字(http):不发请求 + notify', async () => {
  await createWith([H('a.com', [P('svc-a', 'http')])])
  expect(addIngress).not.toHaveBeenCalled()
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining(i18n.global.t('ns.ingress.rulesPortNumeric', { host: 'a.com' })))
})

test('合法规则:提交一次 + 关弹窗', async () => {
  const w = await createWith([H('a.com', [P('svc-a', '8080')])])
  expect(addIngress).toHaveBeenCalledTimes(1)
  expect(w.vm.showCreateModal).toBe(false)
})
