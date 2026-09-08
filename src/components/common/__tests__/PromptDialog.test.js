// PromptDialog 契约:普通输入(enter=确认,trim)/输名字确认门(requireText 不匹配禁用确认)/
// esc+遮罩=取消 / 重开重置为 initialValue / selectAll 全选。基于 Modal(桩掉,测自身逻辑)。
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import PromptDialog from '../PromptDialog.vue'

vi.mock('../Modal.vue', () => ({
  default: { name: 'Modal', props: ['modelValue', 'title', 'width'], template: '<div data-test="modal"><slot /><slot name="actions" /></div>' },
}))

function mountDlg(props = {}) {
  return mount(PromptDialog, {
    props: { modelValue: true, title: 'T', ...props },
    global: { plugins: [i18n] },
  })
}

describe('PromptDialog', () => {
  it('输入回车 → emit confirm(trim 后的值)', async () => {
    const w = mountDlg({ initialValue: 'old' })
    await nextTick()
    expect(w.find('[data-testid="prompt-input"]').element.value).toBe('old')
    await w.find('[data-testid="prompt-input"]').setValue('  new name  ')
    await w.find('[data-testid="prompt-input"]').trigger('keydown.enter')
    expect(w.emitted('confirm')).toEqual([['new name']])
  })

  it('requireText:不匹配 → 确认钮禁用;匹配 → 放行且值=所输', async () => {
    const w = mountDlg({ requireText: 'data', danger: true })
    const ok = w.find('[data-testid="prompt-ok"]')
    expect(ok.attributes('disabled')).toBeDefined()
    await w.find('[data-testid="prompt-input"]').setValue('dat')
    expect(ok.attributes('disabled')).toBeDefined()
    await w.find('[data-testid="prompt-input"]').setValue('data')
    expect(ok.attributes('disabled')).toBeUndefined()
    await ok.trigger('click')
    expect(w.emitted('confirm')).toEqual([['data']])
  })

  it('空值(trim 后)→ 确认禁用', async () => {
    const w = mountDlg({})
    expect(w.find('[data-testid="prompt-ok"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="prompt-input"]').setValue('   ')
    expect(w.find('[data-testid="prompt-ok"]').attributes('disabled')).toBeDefined()
  })

  it('esc / 取消钮 → emit cancel + 关窗(modelValue=false)', async () => {
    const w = mountDlg({})
    await w.find('[data-testid="prompt-input"]').trigger('keydown.esc')
    expect(w.emitted('update:modelValue').at(-1)).toEqual([false])
    expect(w.emitted('cancel')).toHaveLength(1)
    await w.find('[data-testid="prompt-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(2)
  })

  it('requireText 提示文案展示要求文本', () => {
    const w = mountDlg({ requireText: 'risk' })
    expect(w.text()).toContain('risk')
  })
})
