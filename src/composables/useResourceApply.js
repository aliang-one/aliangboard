import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
import { i18n } from '@/i18n'

export function useResourceApply() {
  const store = useClusterStore()

  // 解析并应用编辑后的 YAML（kubectl edit 语义），并以 toast 反馈结果
  async function applyYaml(yamlStr, opts = {}) {
    const res = await store.applyResourceYaml(yamlStr, opts)
    if (res.ok) {
      const base = i18n.global.t('store.resourceUpdated', { kind: res.kind, name: res.name })
      // 部分成功(多文档中有资源失败):warning 呈报失败明细,不得报纯 success 掩盖(2026-08-16 线上事故)
      notify(res.partial ? 'warning' : 'success', res.partial ? `${base} · ${res.warning}` : base)
    } else {
      notify('error', res.error || i18n.global.t('common.applyFailed'))
    }
    return res
  }

  return { applyYaml }
}
