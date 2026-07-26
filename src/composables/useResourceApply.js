import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'

export function useResourceApply() {
  const store = useClusterStore()

  // 解析并应用编辑后的 YAML（kubectl edit 语义），并以 toast 反馈结果
  async function applyYaml(yamlStr) {
    const res = await store.applyResourceYaml(yamlStr)
    if (res.ok) {
      notify('success', `${res.kind}/${res.name} 已更新`)
    } else {
      notify('error', res.error || '应用失败')
    }
    return res
  }

  return { applyYaml }
}
