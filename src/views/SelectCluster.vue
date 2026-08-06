<script setup>
// 集群选择页（Layer 2）：平台登录后选择要连接的集群。
// admin 无集群时可直接跳转集群管理添加；普通用户无集群时提示联系管理员。
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'
import { authApi } from '@/api/client'

const router = useRouter()
const authStore = useAuthStore()
const clusterStore = useClusterStore()
const clusters = ref([])
const loading = ref(true)
const connecting = ref('')
const errorMsg = ref('')

async function loadClusters() {
  loading.value = true
  errorMsg.value = ''
  try {
    const res = await authApi.myClusters()
    clusters.value = res.clusters || []
  } catch (e) {
    errorMsg.value = e?.message || t('selectCluster.loadFailed')
  } finally { loading.value = false }
}
onMounted(loadClusters)

async function connect(cluster) {
  connecting.value = cluster.id
  errorMsg.value = ''
  try {
    const res = await authStore.connectCluster(cluster.id)
    clusterStore.setConnectedCluster({ apiServer: res.cluster.apiServer.replace(/\/$/, ''), version: res.cluster.version })
    // 不在这里全量水合——改为进入 AppLayout 后后台加载（避免阻塞，用户先看到页面）
    window.location.href = '/cluster'
  } catch (e) {
    errorMsg.value = e?.message || t('selectCluster.connectFailed')
  } finally { connecting.value = '' }
}

function goLogout() {
  authStore.logout()
  router.push('/login')
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-surface p-xl">
    <div class="w-full max-w-3xl">
      <div class="text-center mb-xl">
        <span class="material-symbols-outlined text-5xl text-primary">hub</span>
        <h1 class="text-headline-lg font-bold text-on-surface mt-sm">{{ t('selectCluster.title') }}</h1>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('selectCluster.subtitle', { user: authStore.user?.displayName || authStore.user?.username }) }}</p>
      </div>

      <p v-if="errorMsg" class="text-body-sm text-error bg-error-container/10 rounded-lg px-md py-sm flex items-center gap-sm mb-md">
        <span class="material-symbols-outlined text-base">error</span>{{ errorMsg }}
      </p>

      <div v-if="loading" class="text-center py-xl text-on-surface-variant">
        <span class="material-symbols-outlined animate-spin inline-block text-3xl">progress_activity</span>
      </div>

      <div v-else-if="connecting" class="text-center py-md text-on-surface-variant text-body-sm flex items-center justify-center gap-sm">
        <span class="material-symbols-outlined animate-spin">progress_activity</span> {{ t('selectCluster.connecting') }} {{ clusters.find(c => c.id === connecting)?.name }}…
      </div>

      <div v-else-if="clusters.length" class="grid grid-cols-1 md:grid-cols-2 gap-md">
        <button v-for="c in clusters" :key="c.id" @click="connect(c)"
          class="text-left p-lg rounded-xl border-2 border-outline-variant hover:border-primary bg-surface-container-lowest transition-all group">
          <div class="flex items-center gap-md">
            <div class="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <span class="material-symbols-outlined text-primary text-2xl">dns</span>
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-body-md font-semibold text-on-surface truncate group-hover:text-primary transition-colors">{{ c.name }}</p>
              <p class="font-mono text-xs text-on-surface-variant truncate">{{ c.apiServer }}</p>
              <p class="text-body-xs text-on-surface-variant/60 mt-xs">{{ c.version || t('selectCluster.versionUnknown') }}</p>
            </div>
          </div>
        </button>
      </div>

      <!-- 无集群 -->
      <div v-else class="text-center py-xl">
        <span class="material-symbols-outlined text-4xl text-surface-container-high">cloud_off</span>
        <p class="text-body-sm text-on-surface-variant mt-sm">{{ t('selectCluster.noClusters') }}</p>
        <!-- admin 可以直接去添加 -->
        <button v-if="authStore.isAdmin" @click="router.push('/admin/clusters')"
          class="mt-md inline-flex items-center gap-xs px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-base">add</span> {{ t('selectCluster.addCluster') }}
        </button>
        <p v-else class="text-body-xs text-on-surface-variant/60 mt-xs">{{ t('selectCluster.contactAdmin') }}</p>
      </div>

      <div class="flex items-center justify-center gap-md mt-xl">
        <button v-if="authStore.isAdmin" @click="router.push('/admin/clusters')" class="text-body-sm text-on-surface-variant hover:text-primary flex items-center gap-xs">
          <span class="material-symbols-outlined text-sm">settings</span> {{ t('selectCluster.clusterManagement') }}
        </button>
        <button @click="goLogout" class="text-body-sm text-on-surface-variant hover:text-primary flex items-center gap-xs">
          <span class="material-symbols-outlined text-sm">logout</span> {{ t('selectCluster.logout') }}
        </button>
      </div>
    </div>
  </div>
</template>
