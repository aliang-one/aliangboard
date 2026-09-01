// 壳层 UI 状态(2026-09-01 手机适配 Wave 1a):侧栏抽屉开合。
// TopNavBar 汉堡(toggle)、SideNavBar(路由跳转/Esc 关闭)、AppLayout 遮罩(close)三消费方。
import { defineStore } from 'pinia'
import { ref } from 'vue'

export const useShellStore = defineStore('shell', () => {
  const drawerOpen = ref(false)
  function toggleDrawer() { drawerOpen.value = !drawerOpen.value }
  function closeDrawer() { drawerOpen.value = false }
  return { drawerOpen, toggleDrawer, closeDrawer }
})
