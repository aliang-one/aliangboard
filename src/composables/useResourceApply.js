import { ref } from 'vue'
import { useClusterStore } from '@/stores/cluster'

// 模块级共享状态：YAML「应用」结果的轻量级 toast 反馈（全局单例）
const toast = ref(null) // { type: 'success' | 'error', message }
let timer = null

function notify(type, message) {
  toast.value = { type, message }
  if (timer) clearTimeout(timer)
  // 错误停留更久，方便用户阅读
  timer = setTimeout(() => { toast.value = null }, type === 'error' ? 6000 : 2500)
}

export function useResourceApply() {
  const store = useClusterStore()

  // 解析并应用编辑后的 YAML（kubectl edit 语义），并以 toast 反馈结果
  function applyYaml(yamlStr) {
    const res = store.applyResourceYaml(yamlStr)
    if (res.ok) {
      notify('success', `${res.kind}/${res.name} 已更新`)
    } else {
      notify('error', res.error || '应用失败')
    }
    return res
  }

  function dismissToast() {
    toast.value = null
    if (timer) clearTimeout(timer)
  }

  return { applyYaml, toast, dismissToast }
}
