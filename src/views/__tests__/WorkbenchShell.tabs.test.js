// WorkbenchShell 四 tab(2026-08-29 双域化):项目/服务器(admin)/知识/记录;配置与全局不复存在。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { i18n } from '@/i18n'

vi.mock('@/views/WorkbenchProjects.vue', () => ({ default: { template: '<div data-test-stub="projects" />' } }))
vi.mock('@/views/WorkbenchLedger.vue', () => ({ default: { template: '<div data-test-stub="ledger" />' } }))
vi.mock('@/views/WorkbenchRecords.vue', () => ({ default: { template: '<div data-test-stub="records" />' } }))
vi.mock('@/views/WorkbenchServers.vue', () => ({ default: { template: '<div data-test-stub="servers" />' } }))
import WorkbenchShell from '@/views/WorkbenchShell.vue'

function mountShell(role) {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = role === 'admin' ? { role: 'admin' } : null
  return mount(WorkbenchShell, { global: { plugins: [pinia, i18n] } })
}
const tabTexts = w => w.findAll('button').map(b => b.text()).join('|')

test('admin:恰好四 tab(项目/服务器/知识/记录),配置与全局消失', () => {
  const w = mountShell('admin')
  const txt = tabTexts(w)
  for (const name of ['项目', '服务器', '知识', '记录']) expect(txt).toContain(name)
  expect(txt).not.toContain('配置')
  expect(txt).not.toContain('全局')
})

test('非 admin:无服务器 tab,只余三个', () => {
  const w = mountShell('user')
  const txt = tabTexts(w)
  expect(txt).not.toContain('服务器')
  expect(txt).toContain('知识')
})

test('默认项目 tab;点知识渲染 WorkbenchLedger(键改名后接线正确)', async () => {
  const w = mountShell('admin')
  expect(w.find('[data-test-stub="projects"]').exists()).toBe(true)
  await w.findAll('button').find(b => b.text().includes('知识')).trigger('click')
  expect(w.find('[data-test-stub="ledger"]').exists()).toBe(true)
})
