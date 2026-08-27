// 漂移三态契约:绿=ok且无漂移;黄=ok但 drift/over;红=!ok。黄 drift 出修复、over 不出;title 含 i18n 明细。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const rows = [
  { id: 'k1', prefix: 'p1', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa1', saManaged: 1, tier: 'read', createdAt: 1 },
  { id: 'k2', prefix: 'p2', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa2', saManaged: 1, tier: 'read', createdAt: 2 },
  { id: 'k3', prefix: 'p3', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa3', saManaged: 1, tier: 'read', createdAt: 3 },
  { id: 'k4', prefix: 'p4', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'sa4', saManaged: 0, tier: 'read', createdAt: 4 },
]
const healthMock = vi.fn(async () => ({ health: [
  { id: 'k1', boundSA: 'ns/sa1', managed: true, ok: true, rbac: { status: 'ok', issues: [] } },
  { id: 'k2', boundSA: 'ns/sa2', managed: true, ok: true, rbac: { status: 'drift', issues: [{ type: 'role-missing', ns: 'help-friends' }] } },
  { id: 'k3', boundSA: 'ns/sa3', managed: true, ok: true, rbac: { status: 'over', issues: [{ type: 'foreign-binding', ns: 'nursor', name: 'x-admin' }] } },
  { id: 'k4', boundSA: 'ns/sa4', managed: false, ok: false, detail: 'ServiceAccount 不存在' },
] }))

vi.mock('@/api/client', () => ({
  adminApi: {
    apikeys: {
      list: vi.fn(async () => ({ apikeys: rows })),
      create: vi.fn(), remove: vi.fn(), updateOverrides: vi.fn(), updateNamespaces: vi.fn(),
      health: () => healthMock(), repairSa: vi.fn(async () => ({ ok: true })),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [] })) },
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { username: 'admin', role: 'admin' } }) }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import ApiKeyManagement from '../admin/ApiKeyManagement.vue'

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

function mountView() {
  return mount(ApiKeyManagement, {
    global: { plugins: [i18n], stubs: { Modal: true, DataTable: true, ToolOverrideEditor: true, NsAllowlistEditor: true } },
  })
}

const byId = (w, id) => ({ row: rows.find(r => r.id === id), h: w.vm.saHealth[id] })

test('三态:k1 绿 / k2 黄 / k3 黄 / k4 红;旧网关无 rbac 字段 → ok 即绿', async () => {
  const w = mountView()
  await flushPromises()
  const { dotColor } = w.vm
  expect(dotColor(byId(w, 'k1').h)).toBe('#10b981')
  expect(dotColor(byId(w, 'k2').h)).toBe('#f59e0b')
  expect(dotColor(byId(w, 'k3').h)).toBe('#f59e0b')
  expect(dotColor(byId(w, 'k4').h)).toBe('#dc2626')
  expect(dotColor({ ok: true })).toBe('#10b981') // 无 rbac 字段(旧网关)退化两态
  expect(dotColor(undefined)).toContain('outline-variant') // 无数据灰
})

test('修复条件:k2(drift)要修、k3(over)不出、k4(红)要修、k1 不出', async () => {
  const w = mountView()
  await flushPromises()
  const { needsRepair } = w.vm
  expect(needsRepair(byId(w, 'k2').row)).toBe(true)
  expect(needsRepair(byId(w, 'k3').row)).toBe(false)
  expect(needsRepair(byId(w, 'k4').row)).toBe(true)
  expect(needsRepair(byId(w, 'k1').row)).toBe(false)
})

test('title:issue 明细(i18n+ns)拼接;over 追加 foreignHint', async () => {
  const w = mountView()
  await flushPromises()
  const { dotTitle } = w.vm
  const t2 = dotTitle(byId(w, 'k2').h)
  expect(t2).toContain('help-friends')
  const t3 = dotTitle(byId(w, 'k3').h)
  expect(t3).toContain('nursor/x-admin')
  expect(t3).toContain(i18n.global.t('admin.apiKeys.drift.foreignHint'))
})
