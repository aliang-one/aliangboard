// DropdownMenu 菜单「Teleport body + fixed」契约(2026-09-01 下拉遮挡排查):
// NsServices/NsWorkloads 的 #actions slot 把菜单渲染进 <td>,DataTable 根
// overflow-hidden + overflow-x-auto(overflow-y 计算为 auto)会裁切向下弹出的菜单——
// 菜单必须传送出裁切链(配方=PortSelect issue#4,useDropdownPanel 共享 composable)。
import { test, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import DropdownMenu from '../DropdownMenu.vue'

beforeEach(() => { document.body.innerHTML = '' })

const mountMenu = (items) => mount(DropdownMenu, {
  props: { items, triggerLabel: '操作' },
  attachTo: document.body,
})
const bodyPanel = () => document.body.querySelector('[data-testid="dropdown-menu-panel"]')

test('菜单 Teleport 到 body + fixed + Z.popover(脱离 DataTable overflow 裁切链)', async () => {
  const action = vi.fn()
  const w = mountMenu([{ label: '重命名', icon: 'edit', action }])
  await w.find('button').trigger('click')
  await nextTick(); await nextTick()
  const panel = bodyPanel()
  expect(panel, '菜单应传送至 document.body').toBeTruthy()
  expect(w.element.contains(panel)).toBe(false)
  expect(panel.style.position).toBe('fixed')
  expect(panel.style.zIndex).toBe('110')
})

test('点传送后的菜单项:action 执行且菜单收起', async () => {
  const action = vi.fn()
  const w = mountMenu([{ label: '重命名', icon: 'edit', action }])
  await w.find('button').trigger('click')
  await nextTick(); await nextTick()
  const item = [...bodyPanel().querySelectorAll('button')].find(b => b.textContent.includes('重命名'))
  expect(item).toBeTruthy()
  item.click()
  await nextTick(); await nextTick()
  expect(action).toHaveBeenCalledTimes(1)
  expect(bodyPanel()).toBeNull()
})

test('遮罩(点外部)关闭菜单——遮罩仍在宿主子树,.stop 不冒泡宿主(终审 I1 语义保留)', async () => {
  const w = mountMenu([{ label: '删除', icon: 'delete', action: vi.fn(), danger: true }])
  await w.find('button').trigger('click')
  await nextTick(); await nextTick()
  expect(bodyPanel()).toBeTruthy()
  const overlay = w.find('.fixed.inset-0')
  expect(overlay.exists()).toBe(true)
  await overlay.trigger('click')
  await nextTick(); await nextTick()
  expect(bodyPanel()).toBeNull()
})
