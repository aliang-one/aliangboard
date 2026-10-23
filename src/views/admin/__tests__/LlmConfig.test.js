// LlmConfig:「上文大小(contextWindow)」字段——预设 chips、M/K 单位输入、生效值展示、
// 原样字符串提交(服务端 parse 单源;2026-10-23 设计)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LlmConfig from '@/views/admin/LlmConfig.vue'
import { adminApi } from '@/api/client'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  adminApi: { llmConfig: { get: vi.fn(), save: vi.fn(), test: vi.fn(), probeReasoning: vi.fn() } },
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

const FIXTURE = {
  baseURL: 'http://llm', model: 'mock-1', hasApiKey: false, apiKeySource: 'none',
  baseURLSource: 'none', modelSource: 'none', temperature: '0.2', maxTokens: '8192',
  contextWindow: '', effectiveWindow: 200_000,
}

beforeEach(() => { vi.clearAllMocks() })

const mountView = async (fixture = FIXTURE) => {
  adminApi.llmConfig.get.mockResolvedValue({ ...fixture })
  adminApi.llmConfig.save.mockResolvedValue({ ok: true })
  const w = mount(LlmConfig, { global: { plugins: [i18n] } })
  await flushPromises()
  return w
}

test('未配置:输入框空 + 生效值按模型名自动(mock-1 → 200K)', async () => {
  const w = await mountView()
  expect(w.find('[data-testid="ctx-window-input"]').element.value).toBe('')
  expect(w.find('[data-testid="ctx-effective"]').text()).toContain('200K')
  expect(w.find('[data-testid="ctx-effective"]').text()).toContain('自动')
})

test('已配置回显无损格式化:1000000→1M;131072 原样', async () => {
  const w = await mountView({ ...FIXTURE, contextWindow: '1000000', effectiveWindow: 1_000_000 })
  expect(w.find('[data-testid="ctx-window-input"]').element.value).toBe('1M')
  expect(w.find('[data-testid="ctx-effective"]').text()).toContain('1M')
  expect(w.find('[data-testid="ctx-effective"]').text()).toContain('已配置')
  const w2 = await mountView({ ...FIXTURE, contextWindow: '131072', effectiveWindow: 131_072 })
  expect(w2.find('[data-testid="ctx-window-input"]').element.value).toBe('131072', '非整千不强行格式化(无损回显)')
})

test('预设 chips:8 个精确集合;点击 200K → 输入框填入 "200K"', async () => {
  const w = await mountView()
  const chips = w.findAll('[data-testid="ctx-preset"]')
  const labels = chips.map(c => c.text())
  expect(labels).toEqual(['32K', '64K', '128K', '200K', '256K', '512K', '1M', '2M'])
  await chips.find(c => c.text() === '200K').trigger('click')
  expect(w.find('[data-testid="ctx-window-input"]').element.value).toBe('200K')
})

test('保存:输入 "300K" → payload 原样字符串(服务端 parse 单源)', async () => {
  const w = await mountView()
  await w.find('[data-testid="ctx-window-input"]').setValue('300K')
  await w.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(adminApi.llmConfig.save).toHaveBeenCalledWith(
    expect.objectContaining({ contextWindow: '300K', baseURL: 'http://llm', model: 'mock-1' }))
})

test('保存:输入清空 → payload contextWindow 空串(清除=回落自动)', async () => {
  const w = await mountView({ ...FIXTURE, contextWindow: '1000000', effectiveWindow: 1_000_000 })
  expect(w.find('[data-testid="ctx-window-input"]').element.value).toBe('1M')
  await w.find('[data-testid="ctx-window-input"]').setValue('')
  await w.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(adminApi.llmConfig.save).toHaveBeenCalledWith(
    expect.objectContaining({ contextWindow: '' }))
})

// 审查修复(2026-10-23):保存后刷新不得翻转 loading(旧 await load() 置 loading=true 使
// v-if 整块卸载重建表单——焦点被毁、保存期间在途击键丢失)。静默刷新:元素身份保持。
test('保存后静默刷新:表单不卸载(输入元素身份跨保存保持)', async () => {
  const w = await mountView()
  const inputEl = w.find('[data-testid="ctx-window-input"]').element
  await w.find('[data-testid="save-btn"]').trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="ctx-window-input"]').element).toBe(inputEl)
  expect(adminApi.llmConfig.get).toHaveBeenCalledTimes(2) // 保存后仍回读刷新生效值
})
