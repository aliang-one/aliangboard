import { test, expect, vi, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import SplitButton from '@/components/common/SplitButton.vue'
import { Z } from '@/styles/zScale'
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
  expect(buttons.length).toBe(2) // 主按钮 + 箭头(菜单项已 Teleport 到 body,不在 wrapper 内)
  await buttons[0].trigger('click')                 // 主按钮
  expect(mainAction).toHaveBeenCalledTimes(1)
  expect(document.body.textContent).not.toContain('从 YAML')     // 菜单未开
  await buttons[1].trigger('click')                 // 箭头
  await nextTick()
  // 菜单已 Teleport 到 body,断言语义不变、查询路径换 document
  expect(document.querySelector('[data-split-menu]')).toBeTruthy()
  expect(document.body.textContent).toContain('从 YAML')
  const yamlBtn = [...document.querySelectorAll('[data-split-menu] [data-menu-item]')]
    .find(b => b.textContent.includes('从 YAML'))
  expect(yamlBtn).toBeTruthy()
  await yamlBtn.click()
  expect(itemAction).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[data-split-menu]')).toBeFalsy() // 点击后收起
  wrapper.unmount(); document.body.innerHTML = ''
})

test('手机档:菜单 Teleport 到 body 的底部面板(zIndex=Z.popover);桌面锚定', async () => {
  mockViewport(true)
  const { wrapper: w } = mountSplit()
  await w.findAll('button')[1].trigger('click')   // 展开箭头钮
  await nextTick()
  const panel = document.querySelector('[data-split-menu]')
  expect(panel).toBeTruthy()
  expect(panel.style.bottom).toBe('0px')
  expect(panel.style.zIndex).toBe(String(Z.popover))
  w.unmount(); document.body.innerHTML = ''

  mockViewport(false)
  const { wrapper: d } = mountSplit()
  await d.findAll('button')[1].trigger('click')
  await nextTick()
  const dp = document.querySelector('[data-split-menu]')
  expect(dp).toBeTruthy()
  expect(dp.style.bottom).toBe('')
  d.unmount(); document.body.innerHTML = ''
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
  await nextTick()
  // 菜单已 Teleport 到 body,须从 document 查询(断言语义不变)
  const item = document.querySelector('[data-split-menu] button')
  expect(item).toBeTruthy()
  expect(item.classList.contains('max-sm:min-h-[40px]')).toBe(true)
  wrapper.unmount(); document.body.innerHTML = ''
})
