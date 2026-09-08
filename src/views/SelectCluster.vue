<script setup>
// 集群选择页（Layer 2）：平台登录后选择要连接的集群。
// admin 无集群时可直接跳转集群管理添加；普通用户无集群时提示联系管理员。
// 免集群通道卡(2026-09-08):全员可见——工作台/个人中心等平台能力不依赖集群
// (路由 requiresCluster:false),未选集群也能进平台,不再只有 admin 的集群管理一条暗路。
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'
import { authApi } from '@/api/client'
import { useI18n } from 'vue-i18n'
import LocaleToggle from '@/components/common/LocaleToggle.vue'

const router = useRouter()
const authStore = useAuthStore()
const clusterStore = useClusterStore()
const { t } = useI18n()
const clusters = ref([])
const loading = ref(true)
const connecting = ref('')
const entering = ref(false)
const errorMsg = ref('')
// 任一入口在途 = 全页忙碌(连接集群 / 进入工作台互斥,防两路导航竞态)
const busy = computed(() => !!connecting.value || entering.value)

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

// 连接反馈(2026-09-08 根治「反复点击卡死在选择页」):
// - 卡片级 pending:点中的卡自己转圈、其余卡置灰禁用,网格不消失(保上下文);
// - connecting 只在失败时清零——成功路径保持到 SPA 跳转发生。旧版 finally 清零 +
//   window.location.href 整页刷新的组合,会让网格在页面真正跳走前复活数秒(冷缓存更久),
//   用户误以为没点上而反复点击,每次点击都重新走一遍服务端探测并重置导航 = 恶性循环;
// - 跳转改 SPA router.push:无整页白屏,AppLayout 顶部进度条 + Overview 自身加载接管
//   (守卫看到 currentCluster 已设,不会重复 api.session 验证)。
async function connect(cluster) {
  if (busy.value) return // in-flight 守卫:disabled 之外的双保险(合成事件可穿透 disabled)
  connecting.value = cluster.id
  errorMsg.value = ''
  try {
    const res = await authStore.connectCluster(cluster.id)
    clusterStore.setConnectedCluster({ apiServer: res.cluster.apiServer.replace(/\/$/, ''), version: res.cluster.version })
    router.push('/cluster')
  } catch (e) {
    connecting.value = ''
    errorMsg.value = e?.message || t('selectCluster.connectFailed')
  }
}

// 进入工作台(round-2 pending 态):/workbench 是懒加载 chunk,且守卫 Layer 2 在无 session
// 时会再跑一次 tryAutoConnect(有记忆/偏好集群时整轮服务端探测,单端点最长 15s)——
// 期间选择页必须可见反馈。await push:被守卫拒绝/失败时恢复可点;成功时组件已卸载,恢复无副作用。
async function goWorkbench() {
  if (busy.value) return
  entering.value = true
  try {
    await router.push('/workbench')
  } finally {
    entering.value = false
  }
}

function goLogout() {
  authStore.logout()
  router.push('/login')
}
</script>

<template>
  <div class="relative min-h-screen flex items-center justify-center bg-surface p-xl">
    <!-- 独立页语言切换:无应用壳,用户菜单不可达 -->
    <div class="absolute top-md right-md"><LocaleToggle /></div>
    <div class="w-full max-w-3xl">
      <div class="text-center mb-xl">
        <img src="/aliang-logo.svg" alt="AliangBoard" class="w-12 h-auto mx-auto" width="48" height="44" />
        <h1 class="text-headline-lg font-bold text-on-surface mt-sm">{{ t('selectCluster.title') }}</h1>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('selectCluster.subtitle', { user: authStore.user?.displayName || authStore.user?.username }) }}</p>
      </div>

      <p v-if="errorMsg" class="text-body-sm text-error bg-error-container/10 rounded-lg px-md py-sm flex items-center gap-sm mb-md">
        <span class="material-symbols-outlined text-base">error</span>{{ errorMsg }}
      </p>

      <div v-if="loading" class="text-center py-xl text-on-surface-variant">
        <span class="material-symbols-outlined animate-spin inline-block text-3xl">progress_activity</span>
      </div>

      <div v-else-if="clusters.length" class="grid grid-cols-1 md:grid-cols-2 gap-md">
        <button v-for="c in clusters" :key="c.id" data-testid="select-cluster-card"
          :disabled="busy" @click="connect(c)"
          class="text-left p-lg rounded-xl border-2 bg-surface-container-lowest transition-all group"
          :class="connecting === c.id
            ? 'border-primary cursor-progress'
            : (busy ? 'border-outline-variant opacity-40' : 'border-outline-variant hover:border-primary cursor-pointer')">
          <div class="flex items-center gap-md">
            <div class="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
              :class="connecting === c.id ? 'bg-primary/20' : 'bg-primary/10'">
              <span v-if="connecting === c.id" class="material-symbols-outlined text-primary text-2xl animate-spin">progress_activity</span>
              <span v-else class="material-symbols-outlined text-primary text-2xl">dns</span>
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-body-md font-semibold text-on-surface truncate" :class="{ 'group-hover:text-primary': !busy }">{{ c.name }}</p>
              <p class="font-mono text-xs text-on-surface-variant truncate">{{ c.apiServer }}</p>
              <p class="text-body-xs mt-xs" :class="connecting === c.id ? 'text-primary font-medium' : 'text-on-surface-variant/60'">
                {{ connecting === c.id ? `${t('selectCluster.connecting')} ${c.name}…` : (c.version || t('selectCluster.versionUnknown')) }}
              </p>
            </div>
          </div>
        </button>
      </div>

      <!-- 无集群 -->
      <div v-else class="text-center py-xl">
        <span class="material-symbols-outlined text-4xl text-surface-container-high">cloud_off</span>
        <p class="text-body-sm text-on-surface-variant mt-sm">{{ t('selectCluster.noClusters') }}</p>
        <!-- admin 可以直接去添加 -->
        <button v-if="authStore.isAdmin" data-testid="select-cluster-add" @click="router.push('/add-cluster')"
          class="mt-md inline-flex items-center gap-xs px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-base">add</span> {{ t('selectCluster.addCluster') }}
        </button>
        <p v-else class="text-body-xs text-on-surface-variant/60 mt-xs">{{ t('selectCluster.contactAdmin') }}</p>
      </div>

      <!-- 免集群通道卡:全员可见(工作台不依赖集群);虚线描边与实卡区分——它是通道,不是集群 -->
      <div v-if="!loading" class="mt-lg rounded-xl border-2 border-dashed p-md flex items-center gap-md transition-colors"
        :class="busy ? 'border-outline-variant opacity-50' : 'border-outline-variant hover:border-primary/60'">
        <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-primary text-xl">workspaces</span>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-body-md font-semibold text-on-surface">{{ t('selectCluster.skipClusterTitle') }}</p>
          <p class="text-body-xs text-on-surface-variant truncate">{{ t('selectCluster.skipClusterDesc') }}</p>
        </div>
        <button data-testid="select-cluster-workbench-entry" :disabled="busy" @click="goWorkbench"
          class="shrink-0 inline-flex items-center gap-xs px-md py-sm rounded-lg border border-primary/50 text-primary text-body-sm font-semibold hover:bg-primary/10 transition-colors disabled:opacity-50 disabled:pointer-events-none">
          <span v-if="entering" class="material-symbols-outlined text-sm animate-spin" aria-hidden="true">progress_activity</span>
          <span>{{ entering ? t('selectCluster.entering') : t('selectCluster.skipClusterCta') }}</span>
          <span v-if="!entering" class="material-symbols-outlined text-sm" aria-hidden="true">arrow_forward</span>
        </button>
      </div>

      <div class="flex items-center justify-center gap-md mt-xl">
        <button v-if="authStore.isAdmin && clusters.length" data-testid="select-cluster-add-persistent" @click="router.push('/add-cluster')" class="text-body-sm text-on-surface-variant hover:text-primary flex items-center gap-xs">
          <span class="material-symbols-outlined text-sm">add</span> {{ t('selectCluster.addCluster') }}
        </button>
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
