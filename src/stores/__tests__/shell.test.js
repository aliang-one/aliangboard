import { test, expect, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useShellStore } from '../shell'

beforeEach(() => { setActivePinia(createPinia()) })

test('shell store:toggleDrawer 开合,closeDrawer 幂等关闭', () => {
  const shell = useShellStore()
  expect(shell.drawerOpen).toBe(false)
  shell.toggleDrawer()
  expect(shell.drawerOpen).toBe(true)
  shell.toggleDrawer()
  expect(shell.drawerOpen).toBe(false)
  shell.closeDrawer()
  expect(shell.drawerOpen).toBe(false)
})

test('requestClusterSelect:tick 自增(跨组件打开集群选择器的通道)', () => {
  const shell = useShellStore()
  const before = shell.clusterSelectTick
  shell.requestClusterSelect()
  expect(shell.clusterSelectTick).toBe(before + 1)
})
