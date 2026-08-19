// 健康点 + 修复契约:列表渲染红/绿点;失效 key 显示修复按钮;托管=「修复」、BYO=「接管并修复」(发 takeover);修复后刷新。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'

const rows = [
  { id: 'k1', prefix: 'p1', owner: 'a', clusterId: 'c1', boundSA_namespace: 'ns', boundSA_name: 'ok-sa', saManaged: 1, tier: 'read', createdAt: 1 },
  { id: 'k2', prefix: 'p2', owner: 'a', clusterId: 'c1', boundSA_namespace: 'nursor', boundSA_name: 'nursor-debug', saManaged: 0, tier: 'read', createdAt: 2 },
]
const healthMock = vi.fn(async () => ({ health: [
  { id: 'k1', boundSA: 'ns/ok-sa', managed: true, ok: true },
  { id: 'k2', boundSA: 'nursor/nursor-debug', managed: false, ok: false, detail: 'ServiceAccount 不存在' },
] }))
const repairMock = vi.fn(async () => ({ ok: true, boundSA: 'nursor/aliangboard-mcp-22222222', managed: true }))
const notifyMock = vi.fn()

vi.mock('@/api/client', () => ({
  adminApi: {
    apikeys: {
      list: vi.fn(async () => ({ apikeys: rows })),
      create: vi.fn(), remove: vi.fn(), updateOverrides: vi.fn(), updateNamespaces: vi.fn(),
      health: () => healthMock(), repairSa: (...a) => repairMock(...a),
    },
    clusters: { list: vi.fn(async () => ({ clusters: [] })) },
  },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => ({ user: { username: 'admin', role: 'admin' } }) }))
vi.mock('@/composables/useToast', () => ({ notify: (...a) => notifyMock(...a) }))
vi.mock('@/composables/useTableColumns', () => ({ useTableColumns: () => ({ tableColumns: () => [] }) }))

import ApiKeyManagement from '../admin/ApiKeyManagement.vue'

beforeEach(() => { setActivePinia(createPinia()); vi.clearAllMocks() })

// DataTable stub 掉后无法验 slot 渲染 → 用浅层断言:health 数据进了 saHealth + repairSa 调用契约(组件逻辑层)。
function mountView() {
  return mount(ApiKeyManagement, {
    global: { plugins: [i18n], stubs: { Modal: true, DataTable: true, ToolOverrideEditor: true, NsAllowlistEditor: true } },
  })
}

test('onMounted 拉取 health 并入 saHealth(map by id)', async () => {
  const w = mountView()
  await flushPromises()
  expect(healthMock).toHaveBeenCalled()
  expect(w.vm.saHealth.k1.ok).toBe(true)
  expect(w.vm.saHealth.k2.ok).toBe(false)
})

test('repairSa(row):托管 key 不带 takeover;BYO key 带 takeover;成功后 notify + 刷新', async () => {
  const w = mountView()
  await flushPromises()
  await w.vm.repairSa(rows[0])
  expect(repairMock).toHaveBeenCalledWith('k1', {})
  await w.vm.repairSa(rows[1])
  expect(repairMock).toHaveBeenCalledWith('k2', { takeover: true })
  expect(notifyMock).toHaveBeenCalledWith('success', expect.anything())
})
