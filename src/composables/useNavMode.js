import { computed } from 'vue'
import { useRoute } from 'vue-router'

// 模式 = 当前路由的 scope。'namespace' = 下层(ns 内);否则 = 上层(集群态)。
// 单一真相源 = 路由,不依赖 currentNamespace(避免 persist ns 造成模式错位)。
export function useNavMode() {
  const route = useRoute()
  const navMode = computed(() => route.meta?.scope === 'namespace' ? 'namespace' : 'cluster')
  return {
    navMode,
    isNsMode: computed(() => navMode.value === 'namespace'),
    isClusterMode: computed(() => navMode.value === 'cluster'),
  }
}
