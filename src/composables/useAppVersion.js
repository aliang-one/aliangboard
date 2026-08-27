// 平台自身版本 + 更新检测(2026-08-27 版本机制设计)。
// 服务端已有 1h 缓存兜底,前端 staleTime 30min 即可;queryKey 统一 ['app-version'],
// UpdateBanner 与 Settings 关于 tab 各自调用同 key 自动去重共享缓存。
// current/latest 均为去 v 前缀规范形(服务端归一);hasUpdate 由服务端裁决(dev 恒 false)。
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { api } from '@/api/client'

export function useAppVersion() {
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: ['app-version'],
    queryFn: () => api.getVersion(),
    staleTime: 30 * 60_000,
  })
  const checkNow = async () => {
    await api.checkVersion()
    await queryClient.invalidateQueries({ queryKey: ['app-version'] })
  }
  return { query, checkNow }
}
