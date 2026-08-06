// 详情页 YAML 统一拉取：远端模式 GET 真实对象（去 managedFields / status）后 yamlDump；
// mock / 演示模式用 mockFn（通常是 store.generateYAML）合成。
// 进入页面即拉取，切到同类型其它资源（pathFn 返回值变化）自动重拉。
// 远端请求带超时（默认 20s）—— 集群请求挂起时不会永远卡在「加载中」，而是转为可重试的错误。
//
// 用法：
//   const { yaml, yamlLoading, error, reload } = useLiveYaml({
//     pathFn: () => `/api/v1/namespaces/${encodeURIComponent(route.params.namespace)}/pods/${encodeURIComponent(route.params.name)}`,
//     mockFn: () => store.generateYAML('pod', pod.value),
//   })
import { ref, watch } from 'vue'
import { dump as yamlDump } from 'js-yaml'
import { api } from '@/api/client'
import { useClusterStore } from '@/stores/cluster'
import { i18n } from '@/i18n'

export function useLiveYaml({ pathFn, mockFn, timeoutMs = 20000 }) {
  const store = useClusterStore()
  const yaml = ref('')
  const yamlLoading = ref(false)
  const error = ref('')
  let ctrl = null

  async function load() {
    if (!store.remoteMode) { yaml.value = mockFn ? mockFn() : ''; error.value = ''; return }
    ctrl?.abort()                       // 取消上一次（切资源时避免竞态）
    ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    yamlLoading.value = true
    error.value = ''
    try {
      const obj = await api.k8s(pathFn(), { signal: ctrl.signal })
      const clone = JSON.parse(JSON.stringify(obj))
      if (clone?.metadata) delete clone.metadata.managedFields   // 去冗长 managedFields，便于阅读
      if (clone?.status) delete clone.status                     // status 服务端管理，编辑不回写
      yaml.value = yamlDump(clone)
    } catch (e) {
      const aborted = e?.name === 'AbortError' || /aborted/i.test(e?.message || '')
      error.value = aborted ? i18n.global.t('store.loadTimeout', { timeout: Math.round(timeoutMs / 1000) }) : (e?.message || i18n.global.t('store.loadFailed'))
      yaml.value = `# ${error.value}`                            // 兜底：未接 error UI 的页面也在编辑器里显示原因
    } finally {
      clearTimeout(timer)
      yamlLoading.value = false
    }
  }

  // pathFn 返回值变化（切到同类型其它资源）→ 重拉；首次进入也拉
  watch(() => pathFn(), () => load(), { immediate: true })

  return { yaml, yamlLoading, error, reload: load }
}
