import { ref } from 'vue'

// 全局轻量 toast：模块级共享单例，store 与各 composable/组件共用同一份状态。
// App.vue 渲染的 <ApplyToast /> 负责展示。
const toast = ref(null) // { type: 'success' | 'error', message }
let timer = null

export function notify(type, message) {
  toast.value = { type, message }
  if (timer) clearTimeout(timer)
  // 错误停留更久，方便用户阅读
  timer = setTimeout(() => { toast.value = null }, type === 'error' ? 6000 : 2500)
}

export function dismissToast() {
  toast.value = null
  if (timer) clearTimeout(timer)
}

export function useToast() {
  return { toast, notify, dismissToast }
}
