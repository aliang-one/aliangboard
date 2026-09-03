import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { api, authApi, saveSession, clearSession, getSessionToken, getStashedSession, clearStashedSession, rekeyApi } from '@/api/client'
import { usePreferencesStore } from '@/stores/preferences'

const LAST_CLUSTER_KEY = 'aliangboard.lastCluster'

// 平台用户认证 store（Layer 1）：登录/登出/当前用户/集群连接
export const useAuthStore = defineStore('auth', () => {
  const token = ref('')           // 平台 session token (X-Platform-Token)
  const user = ref(null)          // {id, username, role, displayName}
  const k8sToken = ref('')        // K8s session token (Authorization: Bearer)

  const isAdmin = computed(() => user.value?.role === 'admin')
  const isAuthenticated = computed(() => !!token.value)

  // 初始化：从 localStorage 恢复
  function init() {
    token.value = localStorage.getItem('aliangboard.platform') || ''
    k8sToken.value = getSessionToken()
  }

  async function login(username, password) {
    const res = await authApi.login({ username, password })
    token.value = res.token
    user.value = res.user
    localStorage.setItem('aliangboard.platform', res.token)
    usePreferencesStore().hydrateFromServer(res.prefs)
    return res
  }

  async function fetchMe() {
    if (!token.value) return null
    try {
      const res = await authApi.me()
      user.value = res.user
      usePreferencesStore().hydrateFromServer(res.prefs)
      return res.user
    } catch (e) {
      // G6(2026-08-29):曾 catch-all 即登出——网关重启/网络抖动也把用户踢回登录页。
      // 仅鉴权失效(401/403)才登出;其余错误保留会话交由调用方提示。
      if (e?.status === 401 || e?.status === 403) { logout(); return null }
      return user.value
    }
  }

  // Layer 2：连接集群 → 获得 K8s session token；记住用户选的集群（下次自动连）
  async function connectCluster(clusterId) {
    const res = await authApi.connectCluster(clusterId)
    const prevCluster = localStorage.getItem(LAST_CLUSTER_KEY) // 须在覆写前捕获(跨集群判定用)
    k8sToken.value = res.token
    saveSession(res.token, true)
    localStorage.setItem(LAST_CLUSTER_KEY, clusterId) // 记住选择
    rekeyWindowRecords(prevCluster, clusterId, res.token)
    return res
  }

  // 会话轮换后的窗口记录迁移(2026-09-03):仅同一集群的重连才迁(换集群时旧记录指向的
  // ns/pod 在新集群不存在,迁过去是幽灵 chip)。fire-and-forget:迁移失败保留 stash,
  // 下次重连再试;不阻塞连接主链路。
  function rekeyWindowRecords(prevCluster, clusterId, newToken) {
    const prev = getStashedSession()
    if (!prev || prev === newToken) return
    if (prevCluster && prevCluster !== clusterId) { clearStashedSession(); return }
    rekeyApi.windowRecords(prev).then(() => clearStashedSession()).catch(() => { /* 保留 stash 重试 */ })
  }

  // 自动连接上次使用的集群（登录后调用）。成功返回 cluster 信息，失败返回 null。
  async function tryAutoConnect() {
    const lastId = localStorage.getItem(LAST_CLUSTER_KEY)
    if (!lastId) return null
    try {
      return await connectCluster(lastId)
    } catch {
      // 上次的集群可能已被删除/凭据失效/权限被收回 → 清除记忆，让用户重新选
      localStorage.removeItem(LAST_CLUSTER_KEY)
      return null
    }
  }

  function logout() {
    // CSO #11:best-effort 回收两侧会话——平台登出(级联 k8s 凭据)+ K8s 会话 DELETE(死码接活)
    if (token.value) { authApi.logout().catch(() => {}) }
    if (k8sToken.value) { api.logout().catch(() => {}) }
    token.value = ''
    user.value = null
    k8sToken.value = ''
    localStorage.removeItem('aliangboard.platform')
    clearSession()
    // 登出不清除 lastCluster——用户下次登录仍自动连上次的集群
  }

  return { token, user, k8sToken, isAdmin, isAuthenticated, init, login, fetchMe, connectCluster, tryAutoConnect, logout }
})
