// WorkbenchShell 导航(2026-09-12 spec §10):常驻 项目/服务器(admin)/凭据(admin) + 更多▾(知识/记录,全员)。
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { i18n } from '@/i18n'

vi.mock('vue-router', () => ({ useRoute: () => ({ query: {} }), useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/views/WorkbenchProjects.vue', () => ({ default: { template: '<div data-test-stub="projects" />', props: ['openCreate'] } }))
vi.mock('@/views/WorkbenchLedger.vue', () => ({ default: { template: '<div data-test-stub="ledger" />' } }))
vi.mock('@/views/WorkbenchRecords.vue', () => ({ default: { template: '<div data-test-stub="records" />' } }))
vi.mock('@/views/WorkbenchServers.vue', () => ({ default: { template: '<div data-test-stub="servers" />' } }))
vi.mock('@/views/WorkbenchCredentials.vue', () => ({ default: { template: '<div data-test-stub="credentials" />' } }))
vi.mock('@/components/common/DropdownMenu.vue', () => ({ default: {
  props: ['triggerIcon', 'triggerLabel', 'items'],
  template: '<div data-test-stub="more"><span data-test="more-label">{{ triggerLabel }}</span><button v-for="(it,i) in items" :key="i" data-test="more-item" @click="it.action">{{ it.label }}</button></div>',
} }))
import WorkbenchShell from '@/views/WorkbenchShell.vue'

function mountShell(role) {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = role === 'admin' ? { role: 'admin' } : null
  return mount(WorkbenchShell, { global: { plugins: [pinia, i18n] } })
}
// 平铺 tab 条文本:排除「更多」stub 内的 item 按钮(stub 忠实于真实 DropdownMenu——item 也是 button),
// 只度量平铺条本身;更多▾内容走下方 more-item 专属断言。
const tabTexts = w => w.findAll('button')
  .filter(b => !b.element.closest('[data-test-stub="more"]'))
  .map(b => b.text()).join('|')

test('admin:常驻 项目/服务器/凭据;知识/记录收进更多▾', () => {
  const w = mountShell('admin')
  const txt = tabTexts(w)
  for (const name of ['项目', '服务器', '凭据']) expect(txt).toContain(name)
  expect(txt).not.toContain('知识'); expect(txt).not.toContain('记录')
  const more = w.find('[data-test-stub="more"]')
  expect(more.exists()).toBe(true)
  const moreNames = more.findAll('[data-test="more-item"]').map(b => b.text())
  expect(moreNames).toEqual(['知识', '记录'])
  expect(w.find('[data-test="more-label"]').text()).toBe('更多')
})

test('非 admin:项目 + 更多▾(无服务器/凭据)', () => {
  const w = mountShell('user')
  const txt = tabTexts(w)
  expect(txt).toContain('项目')
  expect(txt).not.toContain('服务器'); expect(txt).not.toContain('凭据')
  const moreNames = w.find('[data-test-stub="more"]').findAll('[data-test="more-item"]').map(b => b.text())
  expect(moreNames).toEqual(['知识', '记录'])
})

test('点更多里的 知识 → 渲染 WorkbenchLedger 且触发器显示当前 tab 名', async () => {
  const w = mountShell('admin')
  await w.findAll('[data-test="more-item"]').find(b => b.text() === '知识').trigger('click')
  expect(w.find('[data-test-stub="ledger"]').exists()).toBe(true)
  expect(w.find('[data-test="more-label"]').text()).toBe('知识')
})

test('点凭据 tab 渲染 WorkbenchCredentials(admin)', async () => {
  const w = mountShell('admin')
  // includes 而非 ===:平铺按钮含 material icon 文本(key 凭据),旧 tab 测试同款取法
  await w.findAll('button').find(b => b.text().includes('凭据')).trigger('click')
  expect(w.find('[data-test-stub="credentials"]').exists()).toBe(true)
})
