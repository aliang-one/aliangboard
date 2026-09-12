// src/views/__tests__/WorkbenchShell.query-params.test.js
// 顶栏胶囊快捷区落点(2026-08-30 spec §4.3):?tab= 一次性设初值、?create=1 传 openCreate。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { i18n } from '@/i18n'

const state = vi.hoisted(() => ({ query: {} }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: state.query }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/views/WorkbenchProjects.vue', () => ({ default: { template: '<div data-test-stub="projects" />', props: ['openCreate'] } }))
vi.mock('@/views/WorkbenchLedger.vue', () => ({ default: { template: '<div data-test-stub="ledger" />' } }))
vi.mock('@/views/WorkbenchRecords.vue', () => ({ default: { template: '<div data-test-stub="records" />' } }))
vi.mock('@/views/WorkbenchServers.vue', () => ({ default: { template: '<div data-test-stub="servers" />' } }))
vi.mock('@/views/WorkbenchCredentials.vue', () => ({ default: { template: '<div data-test-stub="credentials" />' } }))
vi.mock('@/components/common/DropdownMenu.vue', () => ({ default: { props: ['triggerIcon','triggerLabel','items'], template: '<div data-test-stub="more" />' } }))
import WorkbenchShell from '@/views/WorkbenchShell.vue'
import WorkbenchProjects from '@/views/WorkbenchProjects.vue'

const mountShell = (role = 'user') => {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = role === 'admin' ? { role: 'admin' } : null
  return mount(WorkbenchShell, { global: { plugins: [pinia, i18n] } })
}

test('?tab=records → 记录 tab 渲染', async () => {
  state.query = { tab: 'records' }
  const w = mountShell(); await w.vm.$nextTick()
  expect(w.find('[data-test-stub="records"]').exists()).toBe(true)
})

test('非法 tab 值忽略,落默认项目 tab', async () => {
  state.query = { tab: 'nope' }
  const w = mountShell(); await w.vm.$nextTick()
  expect(w.find('[data-test-stub="projects"]').exists()).toBe(true)
})

test('?create=1 → openCreate=true 传给项目 tab;无 query 时 false', async () => {
  state.query = { create: '1' }
  const w = mountShell(); await w.vm.$nextTick()
  expect(w.findComponent(WorkbenchProjects).props('openCreate')).toBe(true)
  w.unmount()
  state.query = {}
  const w2 = mountShell(); await w2.vm.$nextTick()
  expect(w2.findComponent(WorkbenchProjects).props('openCreate')).toBe(false)
})

test('?tab=credentials(admin)→ 凭据 tab 渲染;非 admin 忽略落默认', async () => {
  state.query = { tab: 'credentials' }
  const w = mountShell('admin'); await w.vm.$nextTick()
  expect(w.find('[data-test-stub="credentials"]').exists()).toBe(true)
  w.unmount()
  const w2 = mountShell('user'); await w2.vm.$nextTick()
  expect(w2.find('[data-test-stub="projects"]').exists()).toBe(true)
})
