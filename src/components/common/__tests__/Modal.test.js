import { test, expect, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import Modal from '@/components/common/Modal.vue'
import { Z } from '@/styles/zScale'
import { i18n } from '@/i18n'

// Modal teleport 到 body;断言失败提前抛出会跳过 wrapper.unmount,统一在此清场
afterEach(() => { document.body.innerHTML = '' })

// issue #3:弹窗层统一消费 Z.modal。遮罩 backdrop-blur 会糊化所有绘制在其下方的
// 元素——这正是 toast 曾被糊化的来源,故 toast(Z.toast)必须恒在本层之上(见
// ApplyToast.test.js 与 zScale 不变式)。
test('Modal: overlay inline zIndex 恒为 Z.modal,遮罩含 backdrop-blur', () => {
  const wrapper = mount(Modal, {
    props: { modelValue: true, title: '标题' },
    global: { plugins: [i18n] },
  })
  const overlay = document.querySelector('body div.fixed.inset-0')
  expect(overlay).toBeTruthy()
  expect(overlay.style.zIndex).toBe(String(Z.modal))
  const backdrop = overlay.querySelector('div.absolute.inset-0')
  expect(backdrop.className).toContain('backdrop-blur')
  wrapper.unmount()
})

test('Modal: 关闭态不渲染 overlay', () => {
  const wrapper = mount(Modal, {
    props: { modelValue: false },
    global: { plugins: [i18n] },
  })
  expect(document.querySelector('body div.fixed.inset-0')).toBe(null)
  wrapper.unmount()
})

test('Modal: fullscreen 态铺满视口+分区滚动;非 fullscreen 原布局不变', () => {
  const w = mount(Modal, {
    props: { modelValue: true, title: 't', fullscreen: true },
    global: { plugins: [i18n] },
    slots: { default: '<p>x</p>', actions: '<button>a</button>' },
  })
  const overlay = document.querySelector('body div.fixed.inset-0')
  const dialog = overlay.querySelector('div.relative')
  expect(dialog.className).toContain('w-full')
  expect(dialog.className).toContain('h-full')
  expect(dialog.className).toContain('rounded-none')
  expect(dialog.querySelector('div.flex-1.overflow-y-auto')).toBeTruthy()  // 内容区独立滚动
  w.unmount()

  const w2 = mount(Modal, { props: { modelValue: true, title: 't' }, global: { plugins: [i18n] } })
  const dialog2 = document.querySelector('body div.fixed.inset-0 div.relative')
  expect(dialog2.className).toContain('max-h-[90vh]')
  expect(dialog2.className).toContain('rounded-xl')
  w2.unmount()
})

// 2026-08-27 modal 审计:priority 弹窗用 Z.modalPriority(150)——阻塞式审批 Modal 必须盖过
// 一切普通 modal(同 Z.modal 按 Teleport DOM 序层叠,后开的悬浮 ChatModal 会盖住先弹的审批),
// 仍低于 toast(200)。
test('Modal: priority 提升到 Z.modalPriority(盖过普通 modal,低于 toast)', () => {
  const w1 = mount(Modal, { props: { modelValue: true }, global: { plugins: [i18n] } })
  expect(document.querySelector('body div.fixed.inset-0').style.zIndex).toBe(String(Z.modal))
  w1.unmount()
  const w2 = mount(Modal, { props: { modelValue: true, priority: true }, global: { plugins: [i18n] } })
  expect(document.querySelector('body div.fixed.inset-0').style.zIndex).toBe(String(Z.modalPriority))
  expect(Z.modalPriority).toBeGreaterThan(Z.modal)
  expect(Z.modalPriority).toBeLessThan(Z.toast)
  w2.unmount()
})
