// 工作台配置页「悬浮对话」卡片:读配置回填;保存按钮带输入值调 save;非 admin(403)静默兜底默认。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'

const api = vi.hoisted(() => ({
  myClusters: vi.fn(async () => ({ clusters: [] })),
  presenceConfig: { get: vi.fn(), save: vi.fn(async () => ({ ok: true })) },
}))
vi.mock('@/api/client', () => ({ authApi: api, adminApi: api }))
vi.mock('@/composables/useToast.js', () => ({ notify: vi.fn() }))

import WorkbenchConfig from '@/views/WorkbenchConfig.vue'

const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh: { workbench: { config: {
  title: '配置', cluster: '集群', projectRoot: '根目录', distillStatus: '蒸馏',
  presenceTitle: '悬浮对话', presenceMaxItems: '展示条数', presenceWindowMin: '隐去时间',
  presenceSave: '保存', presenceSaved: '已保存', presenceSaveFailed: '保存失败', presenceHint: '提示',
} } } } })

beforeEach(() => { vi.clearAllMocks(); api.presenceConfig.get.mockResolvedValue({ maxItems: 8, windowMin: 45, maxItemsSource: 'db', windowMinSource: 'db' }) })

async function mountCfg() {
  const w = mount(WorkbenchConfig, { global: { plugins: [createPinia(), i18n] } })
  await flushPromises()
  return w
}

test('读配置回填两个输入', async () => {
  const w = await mountCfg()
  const inputs = w.findAll('input[type="number"]')
  expect(inputs.length).toBe(2)
  expect(inputs[0].element.value).toBe('8')
  expect(inputs[1].element.value).toBe('45')
})

test('修改后保存:带当前输入值调 save', async () => {
  const w = await mountCfg()
  const inputs = w.findAll('input[type="number"]')
  await inputs[0].setValue('12')
  await w.find('[data-testid="presence-save"]').trigger('click')
  await flushPromises()
  expect(api.presenceConfig.save).toHaveBeenCalledWith({ maxItems: 12, windowMin: 45 })
})

test('读取失败(非 admin 403)→ 回默认 5/30 不炸', async () => {
  api.presenceConfig.get.mockRejectedValueOnce(new Error('403'))
  const w = await mountCfg()
  const inputs = w.findAll('input[type="number"]')
  expect(inputs[0].element.value).toBe('5')
  expect(inputs[1].element.value).toBe('30')
})
