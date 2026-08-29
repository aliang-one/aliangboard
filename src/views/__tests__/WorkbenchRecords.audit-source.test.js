// WorkbenchRecords 双域化:admin 服务器统计卡 + 审计来源三口径(workbench/platform+toolPrefix/all)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  workbenchApi: { records: vi.fn() },
  adminApi: { auditTrail: { list: vi.fn() } },
  sshApi: { list: vi.fn() },
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
import { workbenchApi, adminApi, sshApi } from '@/api/client'
import WorkbenchRecords from '@/views/WorkbenchRecords.vue'

const RECORDS = { counts: { conversations: 1, messages: 2, aiToolCalls: 3, projects: 1 }, storage: null, conversations: [] }
const AUDITS = { items: [{ seq: 1, ts: Date.now(), tool: 'ssh_sftp', resource: 'server=s1', result: 'ok', source: 'platform' }] }

beforeEach(() => {
  vi.clearAllMocks()
  workbenchApi.records.mockResolvedValue(RECORDS)
  adminApi.auditTrail.list.mockResolvedValue(AUDITS)
  sshApi.list.mockResolvedValue({ servers: [{ exposeToAi: true }, { exposeToAi: false }] })
})

function mountRecords(role) {
  const pinia = createPinia()
  const auth = useAuthStore(pinia)
  auth.user = role === 'admin' ? { role: 'admin' } : null
  return mount(WorkbenchRecords, { global: { plugins: [pinia, i18n] } })
}

test('admin:第 5 卡服务器总数/暴露数;默认审计口径 workbench', async () => {
  const w = mountRecords('admin')
  await flushPromises()
  expect(sshApi.list).toHaveBeenCalled()
  expect(w.text()).toContain('2')            // 总数
  expect(w.text()).toContain('1')            // 暴露数
  expect(adminApi.auditTrail.list).toHaveBeenCalledWith(expect.objectContaining({ source: 'workbench' }))
})

test('切换来源=服务器人工操作:带 source=platform+toolPrefix=ssh,行标「人工」', async () => {
  const w = mountRecords('admin')
  await flushPromises()
  adminApi.auditTrail.list.mockClear()
  await w.find('[data-testid="audit-source"]').setValue('platform')
  await flushPromises()
  expect(adminApi.auditTrail.list).toHaveBeenCalledWith({ size: 30, source: 'platform', toolPrefix: 'ssh' })
  expect(w.text()).toContain('人工')
})

test('非 admin:不发 SSH 请求,统计卡 4 张', async () => {
  const w = mountRecords('user')
  await flushPromises()
  expect(sshApi.list).not.toHaveBeenCalled()
  expect(w.findAll('.grid > div').length).toBe(4)
})
