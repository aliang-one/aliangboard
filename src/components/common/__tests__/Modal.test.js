import { test, expect, afterEach, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
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

// ===== 最大化能力(2026-08-29 设计):maximizable 切换 + ESC 先还原 + scoped slot =====
function mountModal(props = {}, slots) {
  return mount(Modal, { props: { modelValue: true, title: 't', ...props }, global: { plugins: [i18n] }, slots })
}
const dialogOf = () => document.querySelector('body div.fixed.inset-0 div.relative')

test('Modal: maximizable=false 无切换钮(回归);true 渲染最大化钮', () => {
  const w1 = mountModal({})
  expect(document.querySelector('[data-testid="modal-maximize-btn"]')).toBe(null)
  w1.unmount()

  const w2 = mountModal({ maximizable: true })
  const btn = document.querySelector('[data-testid="modal-maximize-btn"]')
  expect(btn).toBeTruthy()
  expect(btn.getAttribute('aria-label')).toBe(i18n.global.t('component.modal.maximize'))
  w2.unmount()
})

test('Modal: 点最大化→全屏形态;再点→还原普通形态', async () => {
  const w = mountModal({ maximizable: true, width: 'max-w-4xl' })
  const btn = () => document.querySelector('[data-testid="modal-maximize-btn"], [data-testid="modal-restore-btn"]')
  btn().click(); await nextTick()
  let cls = dialogOf().className
  expect(cls).toContain('w-full'); expect(cls).toContain('h-full'); expect(cls).toContain('rounded-none')
  expect(dialogOf().querySelector('div.flex-1.overflow-y-auto')).toBeTruthy()
  expect(btn().getAttribute('data-testid')).toBe('modal-restore-btn')
  btn().click(); await nextTick()
  cls = dialogOf().className
  expect(cls).toContain('max-h-[90vh]'); expect(cls).toContain('rounded-xl'); expect(cls).toContain('max-w-4xl')
  w.unmount()
})

test('Modal: 重开(modelValue 关→开)重置为普通态', async () => {
  const w = mountModal({ maximizable: true })
  document.querySelector('[data-testid="modal-maximize-btn"]').click(); await nextTick()
  expect(dialogOf().className).toContain('rounded-none')
  await w.setProps({ modelValue: false })
  await w.setProps({ modelValue: true }); await nextTick()
  expect(dialogOf().className).toContain('rounded-xl')
  w.unmount()
})

test('Modal: ESC 先还原不关闭;还原后 ESC 才关闭', async () => {
  const w = mountModal({ maximizable: true })
  document.querySelector('[data-testid="modal-maximize-btn"]').click(); await nextTick()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick()
  expect(dialogOf().className).toContain('rounded-xl')          // 已还原
  expect(document.querySelector('body div.fixed.inset-0')).toBeTruthy() // 未关闭
  expect(w.emitted('update:modelValue')).toBeUndefined()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick()
  expect(w.emitted('update:modelValue')[0]).toEqual([false])     // 第二次 ESC 关闭
  w.unmount()
})

test('Modal: scoped slot 暴露 maximized 两态', async () => {
  const { h } = await import('vue')
  const w = mountModal({ maximizable: true }, {
    default: ({ maximized }) => h('p', { 'data-testid': 'scope-probe' }, String(maximized)),
  })
  expect(document.querySelector('[data-testid="scope-probe"]').textContent).toBe('false')
  document.querySelector('[data-testid="modal-maximize-btn"]').click(); await nextTick()
  expect(document.querySelector('[data-testid="scope-probe"]').textContent).toBe('true')
  w.unmount()
})

// ===== beforeClose 关闭守卫(2026-08-29 QA ISSUE-03):X/遮罩/ESC 关闭前可拦截 =====
test('Modal: beforeClose 返回 false 拦截关闭(X/遮罩/ESC 三路),返回 true 放行', async () => {
  const guard = vi.fn(() => false)
  const w1 = mountModal({ beforeClose: guard })
  // X
  document.querySelector('body div.fixed.inset-0 .p-1').click(); await nextTick()
  expect(guard).toHaveBeenCalledTimes(1)
  expect(document.querySelector('body div.fixed.inset-0')).toBeTruthy()
  expect(w1.emitted('update:modelValue')).toBeUndefined()
  // 遮罩
  document.querySelector('body div.fixed.inset-0 > div.absolute').click(); await nextTick()
  expect(guard).toHaveBeenCalledTimes(2)
  expect(w1.emitted('update:modelValue')).toBeUndefined()
  // ESC
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); await nextTick()
  expect(guard).toHaveBeenCalledTimes(3)
  expect(w1.emitted('update:modelValue')).toBeUndefined()
  w1.unmount()

  // 放行路径
  const w2 = mountModal({ beforeClose: () => true })
  document.querySelector('body div.fixed.inset-0 > div.absolute').click(); await nextTick()
  expect(w2.emitted('update:modelValue')[0]).toEqual([false])
  w2.unmount()
})

test('Modal: 无 beforeClose 行为不变(回归)', async () => {
  const w = mountModal({})
  document.querySelector('body div.fixed.inset-0 > div.absolute').click(); await nextTick()
  expect(w.emitted('update:modelValue')[0]).toEqual([false])
  w.unmount()
})
