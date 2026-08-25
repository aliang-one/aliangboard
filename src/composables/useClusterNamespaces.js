// 按 key 绑定集群拉真实 ns 列表(ns allowlist 下拉候选源)。fetch 可注入(测试)。
// 纪律:切集群绝不残留上一集群候选(失败/空 id 清空);慢旧响应不得覆盖新结果(seq 守卫)。
import { ref } from 'vue'
import { adminApi } from '@/api/client'

export function useClusterNamespaces(fetchNs = adminApi.clusters.namespaces) {
  const list = ref([])
  const loading = ref(false)
  const error = ref(null)
  let seq = 0
  async function load(clusterId) {
    const my = ++seq
    if (!clusterId) { list.value = []; error.value = null; loading.value = false; return }
    loading.value = true; error.value = null
    try {
      const res = await fetchNs(clusterId)
      if (my !== seq) return
      list.value = Array.isArray(res?.namespaces) ? res.namespaces : []
    } catch (e) {
      if (my !== seq) return
      list.value = []; error.value = e
    } finally {
      if (my === seq) loading.value = false
    }
  }
  return { list, loading, error, load }
}
