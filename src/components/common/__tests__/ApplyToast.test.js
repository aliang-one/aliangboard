import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ApplyToast from '@/components/common/ApplyToast.vue'
import { useToast } from '@/composables/useToast'
import { Z } from '@/styles/zScale'
import { i18n } from '@/i18n'

// issue #3 回归:toast 曾与弹窗同为 z-[100],弹窗 Teleport 到 body 后到 DOM
// 而盖住 toast,并被遮罩 backdrop-blur 糊化。toast 必须消费 Z.toast 恒在顶层。
test('ApplyToast: inline zIndex 恒为 Z.toast(高于 modal 层)', async () => {
  const { notify } = useToast()
  notify('error', 'boom')
  const wrapper = mount(ApplyToast, { global: { plugins: [i18n] } })
  const root = wrapper.find('div[role="status"]')
  expect(root.exists()).toBe(true)
  expect(root.element.style.zIndex).toBe(String(Z.toast))
  expect(Z.toast).toBeGreaterThan(Z.modal)
  expect(root.text()).toContain('boom')
})

test('ApplyToast: 无 toast 时不渲染', () => {
  const { dismissToast } = useToast()
  dismissToast()
  const wrapper = mount(ApplyToast, { global: { plugins: [i18n] } })
  expect(wrapper.find('div[role="status"]').exists()).toBe(false)
})
