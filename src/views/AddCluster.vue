<script setup>
// 添加集群独立页(AppLayout 外,与 Login/SelectCluster 同级):
// 创建(adminApi.clusters.create,服务端已探测凭据)→ 自动连接(connectCluster)
// → 整页跳 /cluster Overview(与 SelectCluster.connect 同路径,复用守卫水合)。
// create 成功但 connect 失败:集群已入库不回滚,给重试连接/返回选择页。
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { adminApi } from '@/api/client'
import { useAuthStore } from '@/stores/auth'
import { useClusterStore } from '@/stores/cluster'
import ClusterForm from '@/components/common/ClusterForm.vue'

const router = useRouter()
const authStore = useAuthStore()
const clusterStore = useClusterStore()
const { t } = useI18n()

const form = ref({ name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false })
const submitting = ref(false)      // create 进行中(按钮 loading)
const phase = ref('form')          // form | connecting | connectFailed
const createError = ref('')
const connectError = ref('')
const createdId = ref('')

// 非 admin 手输 URL:守卫不查 requireAdmin,页面自查弹回;服务端 requireAdmin 兜底
onMounted(() => {
  if (!authStore.isAdmin) router.replace({ name: 'SelectCluster' })
})

async function onSubmit() {
  createError.value = ''
  submitting.value = true
  try {
    const res = await adminApi.clusters.create(form.value)
    createdId.value = res.cluster.id
    await connect()
  } catch (e) {
    createError.value = e?.message || t('admin.clusters.addFailed')
  } finally {
    submitting.value = false
  }
}

async function connect() {
  phase.value = 'connecting'
  connectError.value = ''
  try {
    const res = await authStore.connectCluster(createdId.value)
    clusterStore.setConnectedCluster({ apiServer: res.cluster.apiServer.replace(/\/$/, ''), version: res.cluster.version })
    window.location.href = '/cluster' // 整页跳转,走守卫水合(同 SelectCluster.connect)
  } catch (e) {
    connectError.value = e?.message || t('addCluster.connectFailed')
    phase.value = 'connectFailed'
  }
}

function back() { router.push({ name: 'SelectCluster' }) }
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-surface p-xl">
    <div class="w-full max-w-xl">
      <div class="text-center mb-xl">
        <span class="material-symbols-outlined text-5xl text-primary">hub</span>
        <h1 class="text-headline-lg font-bold text-on-surface mt-sm">{{ t('addCluster.title') }}</h1>
        <p class="text-body-sm text-on-surface-variant mt-xs">{{ t('addCluster.subtitle') }}</p>
      </div>

      <p v-if="createError" data-testid="add-cluster-error" class="text-body-sm text-error bg-error-container/10 rounded-lg px-md py-sm flex items-center gap-sm mb-md">
        <span class="material-symbols-outlined text-base">error</span>{{ createError }}
      </p>

      <div v-if="phase === 'connecting'" data-testid="add-cluster-connecting" class="text-center py-xl text-on-surface-variant">
        <span class="material-symbols-outlined animate-spin inline-block text-3xl">progress_activity</span>
        <p class="text-body-sm mt-sm">{{ t('addCluster.connecting') }}</p>
      </div>

      <div v-else-if="phase === 'connectFailed'" data-testid="add-cluster-connect-failed" class="rounded-xl border border-on-surface-variant/40 bg-surface-container-low p-lg text-center">
        <span class="material-symbols-outlined text-3xl text-on-surface-variant">warning</span>
        <p class="text-body-md font-semibold text-on-surface mt-sm">{{ t('addCluster.connectFailedWarning') }}</p>
        <p v-if="connectError" class="font-mono text-xs text-on-surface-variant mt-xs">{{ connectError }}</p>
        <div class="flex justify-center gap-sm mt-md">
          <button data-testid="add-cluster-retry" @click="connect" class="flex items-center gap-xs px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
            <span class="material-symbols-outlined text-sm">refresh</span> {{ t('addCluster.retryConnect') }}
          </button>
          <button @click="back" class="px-lg py-sm border border-outline-variant rounded-lg">{{ t('addCluster.back') }}</button>
        </div>
      </div>

      <ClusterForm v-else :form="form" :submitting="submitting" :cancel-label="t('addCluster.back')" @submit="onSubmit" @cancel="back" />
    </div>
  </div>
</template>
