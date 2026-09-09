// src/views/__tests__/WorkbenchServers.cards.test.js
// Wave5 W2 Task5(R5):服务器清单迁 DataTable——手机卡片化、操作扁平化;桌面表格不变。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

vi.mock('@/api/client', () => ({
  sshApi: {
    list: vi.fn(async () => ({ servers: [
      { id: 's1', name: 'nas', host: '192.168.100.100', port: 22, username: 'root', authMethod: 'password', hasPassword: true, status: 'ok', exposeToAi: true, aiApprovalPolicy: 'always', osId: 'debian' },
      { id: 's2', name: 'mac-mini', host: '192.168.100.101', port: 22, username: 'liang', authMethod: 'key', hasPrivateKey: true, status: 'unknown', exposeToAi: false },
    ] })),
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ isAdmin: true }) }))
vi.mock('@/stores/sshTerminals', () => ({ useSshTerminalStore: () => ({ openOrFocus: vi.fn() }) }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({}) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))
vi.mock('@/components/ssh/SshServerForm.vue', () => ({ default: { name: 'SshServerForm', template: '<div/>' } }))
vi.mock('@/components/ssh/ServerLedgerPanel.vue', () => ({ default: { name: 'ServerLedgerPanel', template: '<div/>' } }))
vi.mock('@/components/ssh/SshFileBrowserWindow.vue', () => ({ default: { name: 'SshFileBrowserWindow', template: '<div/>' } }))

import WorkbenchServers from '../WorkbenchServers.vue'

async function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(WorkbenchServers, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]] } })
  await flushPromises()
  return w
}

test('手机档:DataTable 卡片模式,2 服务器 2 卡片,无裸 table;终端/文件/编辑/删除扁平可达', async () => {
  const spy = mockViewport(true)
  try {
    const w = await mountView()
    expect(w.findAll('[data-card-row]').length).toBe(2)
    expect(w.find('table').exists()).toBe(false)
    expect(w.find('[data-test="btnTerm"]').exists()).toBe(true)
    expect(w.find('[data-test="btnFiles"]').exists()).toBe(true)
    expect(w.find('[data-test="btnEdit"]').exists()).toBe(true)
    expect(w.find('[data-test="btnDelete"]').exists()).toBe(true)
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('桌面档:表格分支在场,更多▾菜单走共享 DropdownMenu(传送 body,不受 DataTable overflow 裁切)', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountView()
    expect(w.find('table').exists()).toBe(true)
    expect(w.find('[data-test="btnMore"]').exists()).toBe(true)
    // 旧就地 absolute 菜单在 DataTable overflow-x-auto/overflow-hidden 链里首两行被裁;
    // 共享 DropdownMenu = Teleport body + fixed(仓库既定配方),菜单项必须出现在 body
    await w.find('[data-test="btnMore"] button').trigger('click')
    await flushPromises()
    const menu = document.body.querySelector('[data-testid="dropdown-menu-panel"]')
    expect(menu).toBeTruthy()
    expect(menu.textContent).toContain(i18n.global.t('ssh.testConnection'))
    expect(menu.textContent).toContain(i18n.global.t('common.edit'))
    expect(menu.textContent).toContain(i18n.global.t('common.delete'))
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})

test('弹窗宽度响应式:w-[min(...)] 不再是裸 w-[720px]/w-[860px]', async () => {
  const spy = mockViewport(false)
  try {
    const w = await mountView()
    await w.find('[data-test="btnAdd"]').trigger('click')
    const html = document.body.innerHTML
    expect(html).toContain('w-[min(720px,calc(100vw-2rem))]')
    expect(html).not.toContain('w-[720px]')
    w.unmount(); document.body.innerHTML = ''
  } finally { spy.mockRestore() }
})
