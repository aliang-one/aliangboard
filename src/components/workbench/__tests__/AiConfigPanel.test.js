// AiConfigPanel:打开即拉取;有 conversationId 时优先显示该对话烘焙的 system(2026-08-25 设计)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AiConfigPanel from '@/components/workbench/AiConfigPanel.vue'
import { workbenchApi } from '@/api/client'
import { i18n } from '@/i18n'

vi.mock('@/api/client', () => ({
  workbenchApi: {
    aiConfig: vi.fn(),
    conversations: { get: vi.fn() },
  },
}))

const CFG = {
  effectivePrompt: 'GLOBAL_PROMPT',
  tools: [
    { name: 'wb_describe_resource', description: 'd1', requiresApproval: false, enabled: true },
    { name: 'wb_exec', description: 'd2', requiresApproval: true, enabled: false },
  ],
  additionalInstructions: '生产谨慎',
  model: 'm7',
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

test('无对话:显示全局生效提示词 + 工具 enabled 标记 + 追加指令 + model', async () => {
  workbenchApi.aiConfig.mockResolvedValue(CFG)
  const w = mount(AiConfigPanel, {
    props: { modelValue: true, conversationId: null },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  expect(workbenchApi.conversations.get).not.toHaveBeenCalled()
  const bodyText = document.body.textContent
  expect(bodyText).toContain('GLOBAL_PROMPT')
  expect(bodyText).toContain('wb_exec')
  expect(bodyText).toContain('生产谨慎')
  expect(bodyText).toContain('m7')
})

test('有对话:优先显示该对话 conv.system', async () => {
  workbenchApi.aiConfig.mockResolvedValue(CFG)
  workbenchApi.conversations.get.mockResolvedValue({ system: 'CONV_BAKED_PROMPT' })
  const w = mount(AiConfigPanel, {
    props: { modelValue: true, conversationId: 'c1' },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
  await flushPromises()
  expect(workbenchApi.conversations.get).toHaveBeenCalledWith('c1')
  const bodyText = document.body.textContent
  expect(bodyText).toContain('CONV_BAKED_PROMPT')
  expect(bodyText).not.toContain('GLOBAL_PROMPT')
})
