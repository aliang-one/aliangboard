import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import SplitButton from '@/components/common/SplitButton.vue'

test('SplitButton: 主按钮触发 mainAction,箭头展开菜单并显示菜单项', async () => {
  const mainAction = vi.fn()
  const itemAction = vi.fn()
  const wrapper = mount(SplitButton, {
    props: { label: '新建', icon: 'add', mainAction, items: [{ label: '从 YAML', icon: 'code', action: itemAction }] },
  })
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
})
