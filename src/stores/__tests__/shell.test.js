import { test, expect } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useShellStore } from '../shell'

test('shell store:toggleDrawer 开合,closeDrawer 幂等关闭', () => {
  setActivePinia(createPinia())
  const shell = useShellStore()
  expect(shell.drawerOpen).toBe(false)
  shell.toggleDrawer()
  expect(shell.drawerOpen).toBe(true)
  shell.toggleDrawer()
  expect(shell.drawerOpen).toBe(false)
  shell.closeDrawer()
  expect(shell.drawerOpen).toBe(false)
})
