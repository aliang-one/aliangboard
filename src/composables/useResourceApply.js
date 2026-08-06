import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import { i18n } from '@/i18n'

export function useResourceApply() {
  const store = useClusterStore()

  // 解析并应用编辑后的 YAML（kubectl edit 语义），并以 toast 反馈结果
  async function applyYaml(yamlStr) {
    const res = await store.applyResourceYaml(yamlStr)
    if (res.ok) {
      notify('success', i18n.global.t('store.resourceUpdated', { kind: res.kind, name: res.name }))
    } else {
      notify('error', res.error || i18n.global.t('common.applyFailed'))
    }
    return res
  }

  return { applyYaml }
}
