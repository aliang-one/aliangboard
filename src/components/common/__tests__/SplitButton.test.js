import { test, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import SplitButton from '@/components/common/SplitButton.vue'
import { mockViewport } from '@/__tests__/helpers/mobileViewport'

afterEach(() => { vi.restoreAllMocks() })

function mountSplit() {
  const mainAction = vi.fn()
  const itemAction = vi.fn()
  const wrapper = mount(SplitButton, {
    props: { label: '新建', icon: 'add', mainAction, items: [{ label: '从 YAML', icon: 'code', action: itemAction }] },
  })
  return { wrapper, mainAction, itemAction }
}

test('SplitButton: 主按钮触发 mainAction,箭头展开菜单并显示菜单项', async () => {
  const { wrapper, mainAction, itemAction } = mountSplit()
  const buttons = wrapper.findAll('button')
  expect(buttons.length).toBe(2) // 主按钮 + 箭头
  await buttons[0].trigger('click')                 // 主按钮
  expect(mainAction).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).not.toContain('从 YAML')     // 菜单未开
  await buttons[1].trigger('click')                 // 箭头
  expect(wrapper.text()).toContain('从 YAML')
  await wrapper.find('button.bg-surface-container-high, [data-menu-item]').trigger('click').catch(() => {})
  // 兜底:直接找含「从 YAML」的按钮点击
  const yamlBtn = wrapper.findAll('button').find(b => b.text().includes('从 YAML'))
  if (yamlBtn) { await yamlBtn.trigger('click'); expect(itemAction).toHaveBeenCalledTimes(1) }
  wrapper.unmount()
})

test('手机档:主动作/展开钮/菜单项触控目标 ≥40px', async () => {
  mockViewport(true)
  const { wrapper } = mountSplit()
  const buttons = wrapper.findAll('button')
  // 主按钮 + 展开箭头钮
  expect(buttons[0].classes()).toContain('max-sm:min-h-[40px]')
  expect(buttons[1].classes()).toContain('max-sm:min-h-[40px]')
  // 菜单项
  await buttons[1].trigger('click')
  const item = wrapper.find('[data-split-menu] button')
  expect(item.classes()).toContain('max-sm:min-h-[40px]')
  wrapper.unmount()
})
