// NsRBAC 从 YAML 创建:页头单按钮随 activeTab + RoleBinding 断链顺修回归。
// 背景:原 rolebindings tab 的「Create RoleBinding」按钮开的是 Role modal(断链,硬编码英文),
// 本测试是「tab 级按钮移除干净」的唯一防线(i18n 门禁抓不到硬编码英文)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })) } }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo', setNamespace: () => {},
    fetchRoles: vi.fn(async () => []), fetchRoleBindings: vi.fn(async () => []),
    fetchClusterRoleBindings: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'demo' } }), useRouter: () => ({ push: () => {} }) }))

import NsRBAC from '../NsRBAC.vue'

function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsRBAC, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { DataTable: true, Breadcrumbs: true, Pagination: true } } })
}

test('rolebindings tab:无 tab 级创建按钮(断链按钮已移除,硬编码英文消失)', async () => {
  const w = mountView()
  await w.setData({ activeTab: 'rolebindings' })
  await flushPromises()
  expect(document.body.textContent).not.toContain('Create RoleBinding')
  w.unmount()
})

test('rolebindings tab:主按钮直开 YAML 弹窗(RoleBinding 模板)', async () => {
  const w = mountView()
  await w.setData({ activeTab: 'rolebindings' })
  await flushPromises()
  const mainBtn = w.findAll('button').find(b => b.text().endsWith(i18n.global.t('common.create')))
  expect(mainBtn).toBeTruthy()
  await mainBtn.trigger('click')
  await flushPromises()
  expect(document.body.textContent).toContain('my-rolebinding')
  w.unmount()
})

test('roles tab:主按钮开 Role modal(不预置 scope)', async () => {
  const w = mountView()
  await flushPromises()
  const mainBtn = w.findAll('button').find(b => b.text().endsWith(i18n.global.t('common.create')))
  await mainBtn.trigger('click')
  expect(w.vm.showCreateRoleModal).toBe(true)
  w.unmount()
})

test('yamlTemplate 随 activeTab 变化', async () => {
  const w = mountView()
  await flushPromises()
  expect(w.vm.rbacYamlTemplate).toBe('Role')
  await w.setData({ activeTab: 'clusterrolebindings' })
  expect(w.vm.rbacYamlTemplate).toBe('ClusterRoleBinding')
  await w.setData({ activeTab: 'rolebindings' })
  expect(w.vm.rbacYamlTemplate).toBe('RoleBinding')
  w.unmount()
})

test('clusterroles / clusterrolebindings tab:tab 级创建按钮已移除(创建收敛页头)', async () => {
  const w = mountView()
  await w.setData({ activeTab: 'clusterroles' })
  await flushPromises()
  expect(document.body.textContent).not.toContain(i18n.global.t('ns.rbac.createClusterRoleBtn'))
  await w.setData({ activeTab: 'clusterrolebindings' })
  await flushPromises()
  expect(document.body.textContent).not.toContain(i18n.global.t('ns.rbac.createClusterRoleBindingBtn'))
  w.unmount()
})
