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
    await w.find('[data-testid="prompt-input"]').trigger('keydown', { key: 'Enter' })
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
    await w.find('[data-testid="prompt-input"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('update:modelValue').at(-1)).toEqual([false])
    expect(w.emitted('cancel')).toHaveLength(1)
    await w.find('[data-testid="prompt-cancel"]').trigger('click')
    expect(w.emitted('cancel')).toHaveLength(2)
  })

  it('requireText 提示文案展示要求文本', () => {
    const w = mountDlg({ requireText: 'risk' })
    expect(w.text()).toContain('risk')
  })

  // 中文输入法组合期(2026-11-16 事故:拼音选词回车被当成确认):组合期 Enter/Esc 属 IME,
  // 不得确认/取消。Chrome 形态=isComposing+keyCode 229。
  it('IME 组合期 Enter 不确认不关窗', async () => {
    const w = mountDlg({ initialValue: '生产' })
    await nextTick()
    await w.find('[data-testid="prompt-input"]').trigger('keydown', { key: 'Enter', isComposing: true, keyCode: 229 })
    expect(w.emitted('confirm')).toBeUndefined()
    expect(w.emitted('cancel')).toBeUndefined()
    // 组合结束后正常回车仍确认
    await w.find('[data-testid="prompt-input"]').trigger('keydown', { key: 'Enter' })
    expect(w.emitted('confirm')).toEqual([['生产']])
  })

  // Safari 乱序形态(WebCore bug 165004):compositionend 先派发,确认 Enter 的 keydown
  // isComposing 已翻回 false,但 keyCode 仍报 VK_PROCESSKEY(229)——第二条判定拦它。
  it('Safari 乱序确认 Enter(keyCode 229、isComposing=false)不确认', async () => {
    const w = mountDlg({ initialValue: '生产' })
    await nextTick()
    await w.find('[data-testid="prompt-input"]').trigger('keydown', { key: 'Enter', isComposing: false, keyCode: 229 })
    expect(w.emitted('confirm')).toBeUndefined()
    expect(w.emitted('cancel')).toBeUndefined()
  })

  it('IME 组合期 Esc 不取消不关窗(取消候选≠取消弹窗)', async () => {
    const w = mountDlg({ initialValue: '生产' })
    await nextTick()
    await w.find('[data-testid="prompt-input"]').trigger('keydown', { key: 'Escape', isComposing: true, keyCode: 229 })
    expect(w.emitted('cancel')).toBeUndefined()
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })
})
