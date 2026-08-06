import { QueryClient } from '@tanstack/vue-query'

// 全局 QueryClient：服务端状态缓存的默认策略。
// staleTime 15s（15s 内不重拉；命名空间来回切换即时显示缓存 + 后台刷新）；
// refetchOnWindowFocus 重新聚焦窗口时后台重拉（保持新鲜）；
// retry 1（失败重试一次，避免网络抖动误报）；gcTime 5min（离开页面后缓存保留 5min）。
// mock 模式各 query 自行置 staleTime:Infinity（见 useK8sQuery），不触发真实请求。
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
})
