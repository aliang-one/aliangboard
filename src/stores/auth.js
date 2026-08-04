import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { authApi, saveSession, clearSession, getSessionToken } from '@/api/client'

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
    return res
  }

  async function fetchMe() {
    if (!token.value) return null
    try {
      const res = await authApi.me()
      user.value = res.user
      return res.user
    } catch {
      logout()
      return null
    }
  }

  // Layer 2：连接集群 → 获得 K8s session token
  async function connectCluster(clusterId) {
    const res = await authApi.connectCluster(clusterId)
    k8sToken.value = res.token
    saveSession(res.token, true) // 存 localStorage（跨标签页共享，终端弹窗需要）
    return res
  }

  function logout() {
    if (token.value) { authApi.logout().catch(() => {}) }
    token.value = ''
    user.value = null
    k8sToken.value = ''
    localStorage.removeItem('aliangboard.platform')
    clearSession()
  }

  return { token, user, k8sToken, isAdmin, isAuthenticated, init, login, fetchMe, connectCluster, logout }
})
