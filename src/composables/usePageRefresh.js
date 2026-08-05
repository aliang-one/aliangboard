// 全局「刷新当前页」协调信号：模块级单例 ref，AppLayout 用它拼进 router-view 的 :key，
// TopNavBar 的刷新按钮 bump() 后 → 当前视图重新挂载（重跑 onMounted 专属 fetch）。
// 配合 store.hydrateCoreResources() 一起用，既刷新列表型页面、又重跑详情页的定点拉取。
import { ref } from 'vue'

const tick = ref(0)

export function usePageRefresh() {
  return {
    tick,
    bump: () => { tick.value++ },
  }
}
