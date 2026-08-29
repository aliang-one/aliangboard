// src/components/common/__tests__/PortSelect.test.js
// issue #4「TLS下拉框被遮盖」:PortSelect 下拉面板此前 absolute 渲染在输入框父级内,
// 被 IngressRulesEditor host 卡片 overflow-hidden / Modal overflow-y-auto 裁切。
// 修复契约:面板 Teleport 到 document.body 且 position:fixed(锚定输入框 rect)。
import { test, expect, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import PortSelect from '@/components/common/PortSelect.vue'

function mountPs(props = {}) {
  return mount(PortSelect, {
    props: { modelValue: '', options: ['tls-a', 'tls-b'], ...props },
    global: { plugins: [i18n] },
    attachTo: document.body,
  })
}

beforeEach(() => { document.body.innerHTML = '' })

async function focusInput(w) {
  await w.find('input').trigger('focus')
  await nextTick()
  await nextTick()
}

function bodyPanel() {
  return document.body.querySelector('[data-testid="port-select-panel"]')
}

test('下拉面板传送至 document.body 且 position:fixed(不被 overflow 祖先裁切)', async () => {
  const w = mountPs()
  await focusInput(w)
  const panel = bodyPanel()
  expect(panel).toBeTruthy()
  // 传送:面板不在组件根元素内(脱离 overflow-hidden 卡片/overflow-y-auto 弹窗的裁切链)
  expect(w.element.contains(panel)).toBe(false)
  expect(document.body.contains(panel)).toBe(true)
  // fixed 定位:坐标系为视口,不受祖先 overflow 裁切
  expect(panel.style.position).toBe('fixed')
})

test('点选传送面板中的候选:更新 modelValue 并收起', async () => {
  const w = mountPs()
  await focusInput(w)
  const opt = bodyPanel().querySelector('button')
  expect(opt.textContent).toContain('tls-a')
  opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  await nextTick()
  expect(w.emitted('update:modelValue')[0]).toEqual(['tls-a'])
  await new Promise(r => setTimeout(r, 200)) // onBlur 延迟收起窗口
  expect(bodyPanel()).toBe(null)
})

test('空态提示面板同样传送至 body(fixed)', async () => {
  const w = mountPs({ options: [], emptyHint: 'no secrets' })
  await focusInput(w)
  const panel = bodyPanel()
  expect(panel).toBeTruthy()
  expect(w.element.contains(panel)).toBe(false)
  expect(panel.style.position).toBe('fixed')
  expect(panel.textContent).toContain('no secrets')
})

test('失焦后 150ms 收起(既有交互不变)', async () => {
  const w = mountPs()
  await focusInput(w)
  expect(bodyPanel()).toBeTruthy()
  await w.find('input').trigger('blur')
  expect(bodyPanel()).toBeTruthy() // 延迟窗口内仍在
  await new Promise(r => setTimeout(r, 200))
  expect(bodyPanel()).toBe(null)
})
