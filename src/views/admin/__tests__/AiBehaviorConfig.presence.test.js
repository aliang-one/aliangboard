// AiBehaviorConfig「悬浮对话入口」卡片(自 WorkbenchConfig 迁入,2026-08-29 双域化):
// 读配置回填;保存带输入值;读取失败兜底默认 5/30。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AiBehaviorConfig from '@/views/admin/AiBehaviorConfig.vue'
import { adminApi } from '@/api/client'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  adminApi: {
    workbenchAiConfig: { get: vi.fn(), save: vi.fn() },
    presenceConfig: { get: vi.fn(), save: vi.fn(async () => ({ ok: true })) },
  },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

const FIXTURE = { additionalInstructions: '', disabledTools: [], toolCatalog: [], effectivePreview: '' }

beforeEach(() => {
  vi.clearAllMocks()
  adminApi.workbenchAiConfig.get.mockResolvedValue(FIXTURE)
  adminApi.presenceConfig.get.mockResolvedValue({ maxItems: 8, windowMin: 45 })
})

const mountCfg = async () => {
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

test('读配置回填两个输入', async () => {
  const w = await mountCfg()
  // 2026-09-03 起面板新增 maxSteps 数字输入,索引选择器随 DOM 改版迁移为 data-testid 定位
  expect(w.find('[data-testid="presence-max"]').element.value).toBe('8')
  expect(w.find('[data-testid="presence-window"]').element.value).toBe('45')
})

test('修改后保存:带当前输入值调 save', async () => {
  const w = await mountCfg()
  await w.find('[data-testid="presence-max"]').setValue('12')
  await w.find('[data-testid="presence-save"]').trigger('click')
  await flushPromises()
  expect(adminApi.presenceConfig.save).toHaveBeenCalledWith({ maxItems: 12, windowMin: 45 })
})

test('读取失败 → 回默认 5/30 不炸', async () => {
  adminApi.presenceConfig.get.mockRejectedValueOnce(new Error('403'))
  const w = await mountCfg()
  expect(w.find('[data-testid="presence-max"]').element.value).toBe('5')
  expect(w.find('[data-testid="presence-window"]').element.value).toBe('30')
})
