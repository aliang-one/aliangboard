// ServerLedgerPanel:结构层 markdown 只读展示 + 自由层(全局/每服务器)备注编辑(2026-08-29 双域化)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ServerLedgerPanel from '@/components/ssh/ServerLedgerPanel.vue'
import { sshApi } from '@/api/client'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  sshApi: { getLedger: vi.fn(), saveLedger: vi.fn(async () => ({ ok: true })) },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

const FIXTURE = {
  globalNotes: '全局备注G',
  servers: [{ id: 's1', name: 'node-a', notes: 'N1' }],
  markdown: '# LEDGER_MARKDOWN',
}

beforeEach(() => { vi.clearAllMocks(); sshApi.getLedger.mockResolvedValue(FIXTURE) })

const mountPanel = async () => {
  const w = mount(ServerLedgerPanel, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

test('挂载即拉台账:结构层 markdown 只读 + 自由层回填', async () => {
  const w = await mountPanel()
  expect(w.find('[data-test="ledgerMarkdown"]').text()).toContain('# LEDGER_MARKDOWN')
  expect(w.find('[data-test="ledgerGlobal"]').element.value).toBe('全局备注G')
  expect(w.find('[data-test="ledgerNotes-s1"]').element.value).toBe('N1')
})

test('保存全局备注:带当前输入值按 scope 调 saveLedger', async () => {
  const w = await mountPanel()
  await w.find('[data-test="ledgerGlobal"]').setValue('新全局')
  await w.find('[data-test="ledgerSaveGlobal"]').trigger('click')
  await flushPromises()
  expect(sshApi.saveLedger).toHaveBeenCalledWith('__global__', '新全局')
})

test('零服务器空态提示', async () => {
  sshApi.getLedger.mockResolvedValue({ globalNotes: '', servers: [], markdown: '' })
  const w = await mountPanel()
  expect(w.text()).toContain('暂无服务器')
})
