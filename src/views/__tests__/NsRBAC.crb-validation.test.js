// NsRBAC 创建 ClusterRoleBinding 必填校验 + {ok} 契约回归:
//   ① subjectName 为空 → 裸发 subjects[].name 为空 → K8s 拒(generateYAML 输出 `name: ` null)。
//   ② subjectKind=ServiceAccount → K8s 要求 subject 带 namespace;表单无输入 → 自动补当前 ns。
//   ③ addClusterRoleBinding 失败({ok:false})→ 保留弹窗不误报(对齐 createSA 已有模式)。
// 背景:2026-08-17 系统审计 P2-A。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const addCRB = vi.fn(async () => ({ ok: true }))
const notify = vi.fn()

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })) },
}))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notify(...a) }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo', setNamespace: () => {},
    fetchRoles: vi.fn(async () => []), fetchRoleBindings: vi.fn(async () => []),
    fetchClusterRoleBindings: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []),
    addClusterRoleBinding: (...a) => addCRB(...a),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'demo' } }), useRouter: () => ({ push: () => {} }) }))

import NsRBAC from '../NsRBAC.vue'

function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsRBAC, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { DataTable: true, Breadcrumbs: true, Pagination: true, Modal: true } } })
}

beforeEach(() => { addCRB.mockClear(); notify.mockClear(); addCRB.mockResolvedValue({ ok: true }) })

test('subjectName 为空:不发请求 + notify 报错 + 弹窗保留', async () => {
  const w = mountView()
  await flushPromises()
  await w.setData({ newCRB: { name: 'crb-1', roleName: 'admin', subjectKind: 'User', subjectName: '' }, showCreateCRBModal: true })
  w.vm.createCRB()
  await flushPromises()
  expect(addCRB).not.toHaveBeenCalled()
  expect(notify).toHaveBeenCalledWith('error', expect.stringContaining(i18n.global.t('ns.rbac.subjectNameRequired')))
  expect(w.vm.showCreateCRBModal).toBe(true)
})

test('subjectName 填齐:提交一次 + 关弹窗', async () => {
  const w = mountView()
  await flushPromises()
  await w.setData({ newCRB: { name: 'crb-1', roleName: 'admin', subjectKind: 'User', subjectName: 'alice' }, showCreateCRBModal: true })
  w.vm.createCRB()
  await flushPromises()
  expect(addCRB).toHaveBeenCalledTimes(1)
  expect(w.vm.showCreateCRBModal).toBe(false)
})

test('subjectKind=ServiceAccount:subject 自动补当前 namespace', async () => {
  const w = mountView()
  await flushPromises()
  await w.setData({ newCRB: { name: 'crb-2', roleName: 'admin', subjectKind: 'ServiceAccount', subjectName: 'default' }, showCreateCRBModal: true })
  w.vm.createCRB()
  await flushPromises()
  const arg = addCRB.mock.calls[0][0]
  expect(arg.subjects).toEqual([{ kind: 'ServiceAccount', name: 'default', namespace: 'demo' }])
})

test('远端失败({ok:false}):弹窗保留不误报', async () => {
  addCRB.mockResolvedValueOnce({ ok: false })
  const w = mountView()
  await flushPromises()
  await w.setData({ newCRB: { name: 'crb-3', roleName: 'admin', subjectKind: 'User', subjectName: 'bob' }, showCreateCRBModal: true })
  w.vm.createCRB()
  await flushPromises()
  expect(w.vm.showCreateCRBModal).toBe(true)
})
