// AiBehaviorConfig:加载回显 + 开关状态 + 保存 payload + 保存后预览刷新(2026-08-25 设计)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AiBehaviorConfig from '@/views/admin/AiBehaviorConfig.vue'
import { adminApi } from '@/api/client'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  adminApi: { workbenchAiConfig: { get: vi.fn(), save: vi.fn() } },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

const FIXTURE = {
  additionalInstructions: '生产谨慎',
  disabledTools: ['wb_exec'],
  toolCatalog: [
    { name: 'wb_describe_resource', description: 'describe', promptHint: 'h1', requiresApproval: false },
    { name: 'wb_exec', description: 'exec', promptHint: 'h2', requiresApproval: true },
  ],
  effectivePreview: 'PREVIEW_V1',
}

beforeEach(() => { vi.clearAllMocks() })

test('挂载即加载:指令回显、禁用工具开关关闭、预览展示', async () => {
  adminApi.workbenchAiConfig.get.mockResolvedValue(FIXTURE)
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.find('textarea').element.value).toBe('生产谨慎')
  expect(w.text()).toContain('PREVIEW_V1')
  expect(w.text()).toContain('wb_describe_resource')
})

test('保存:payload 含指令与禁用名单;保存后重载预览', async () => {
  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, effectivePreview: 'PREVIEW_V2' })
  adminApi.workbenchAiConfig.save.mockResolvedValue({ ok: true })
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  await w.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(adminApi.workbenchAiConfig.save).toHaveBeenCalledWith({ additionalInstructions: '生产谨慎', disabledTools: ['wb_exec'], projectMemory: true, maxSteps: 16 })
  expect(adminApi.workbenchAiConfig.get).toHaveBeenCalledTimes(2) // 保存后 load() 刷新预览
})

// 项目记忆 T4(2026-08-29):projectMemory 开关默认开;取消+保存后 payload 含 false,回读仍关
test('projectMemory 开关:默认开;切换保存后回读', async () => {
  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, projectMemory: true })
  adminApi.workbenchAiConfig.save.mockResolvedValue({ ok: true })
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  const sw = w.find('[data-testid="project-memory-switch"]')
  expect(sw.attributes('aria-checked')).toBe('true')
  await sw.trigger('click')
  await w.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(adminApi.workbenchAiConfig.save).toHaveBeenCalledWith(
    expect.objectContaining({ projectMemory: false }))
  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, projectMemory: false })
  // 回读:重新挂载(刷新语义)后开关仍关
  const w2 = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(w2.find('[data-testid="project-memory-switch"]').attributes('aria-checked')).toBe('false')
})

// ===== 最大执行步数(2026-09-03):回显 / 不限制开关联动禁用 / 保存 payload =====
test('maxSteps 回显:服务端 30 → 输入框 30;0 → 不限制开关开+输入禁用', async () => {
  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, maxSteps: 30 })
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(w.find('[data-testid="max-steps"]').element.value).toBe('30')
  expect(w.find('[data-testid="max-steps-unlimited"]').attributes('aria-checked')).toBe('false')

  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, maxSteps: 0 })
  const w2 = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  expect(w2.find('[data-testid="max-steps-unlimited"]').attributes('aria-checked')).toBe('true')
  expect(w2.find('[data-testid="max-steps"]').element.disabled).toBe(true)
})

test('maxSteps 保存:开不限制 → payload 0;改 40 → payload 40', async () => {
  adminApi.workbenchAiConfig.get.mockResolvedValue({ ...FIXTURE, maxSteps: 16 })
  adminApi.workbenchAiConfig.save.mockResolvedValue({ ok: true })
  const w = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  await w.find('[data-testid="max-steps-unlimited"]').trigger('click')
  await w.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(adminApi.workbenchAiConfig.save).toHaveBeenLastCalledWith(expect.objectContaining({ maxSteps: 0 }))

  const w2 = mount(AiBehaviorConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  await w2.find('[data-testid="max-steps"]').setValue(40)
  await w2.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(adminApi.workbenchAiConfig.save).toHaveBeenLastCalledWith(expect.objectContaining({ maxSteps: 40 }))
})
