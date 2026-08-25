import { test, expect } from 'vitest'
import { Z, createWindowZAllocator } from '@/styles/zScale'

test('zScale: 层级不变式 toast > modal > windowMax >= windowBase > nav', () => {
  // issue #3 回归防线:toast 必须恒在 modal(含 backdrop-blur 遮罩)之上,
  // 浮动窗口带必须恒在 modal 之下、内容层之上。
  expect(Z.toast).toBeGreaterThan(Z.modal)
  expect(Z.modal).toBeGreaterThan(Z.windowMax)
  expect(Z.windowMax).toBeGreaterThanOrEqual(Z.windowBase)
  expect(Z.windowBase).toBeGreaterThan(Z.nav)
})

test('zScale: allocator 在窗口带内单调递增', () => {
  const alloc = createWindowZAllocator()
  const first = alloc.nextZ([])
  const second = alloc.nextZ([])
  expect(first).toBeGreaterThan(Z.windowBase - 1)
  expect(first).toBeLessThanOrEqual(Z.windowMax)
  expect(second).toBe(first + 1)
})

test('zScale: 越界时 renumber 把 open 窗口按现序压回带内,后续分配继续带内', () => {
  const alloc = createWindowZAllocator()
  // 构造已越界的现场:3 个窗口 z 已贴着带上限之上(如旧代码 rehydrate 跳变 100+N)
  const items = [{ zIndex: 101 }, { zIndex: 103 }, { zIndex: 102 }]
  const z = alloc.nextZ(items) // 内部应触发 renumber
  expect(z).toBeGreaterThan(Z.windowBase)
  expect(z).toBeLessThanOrEqual(Z.windowMax)
  // 保序:各 item 的相对层叠次序不变(原 101 最低→仍最低,原 103 最高→仍最高)
  const zs = items.map(it => it.zIndex)
  expect(items[0].zIndex).toBe(Math.min(...zs))
  expect(items[2].zIndex).toBeGreaterThan(items[0].zIndex)
  expect(items[1].zIndex).toBe(Math.max(...zs))
  expect(Math.max(...zs)).toBeLessThanOrEqual(Z.windowMax)
  // renumber 后再分配仍在带内
  const again = alloc.nextZ(items)
  expect(again).toBeGreaterThan(z)
  expect(again).toBeLessThanOrEqual(Z.windowMax)
})
