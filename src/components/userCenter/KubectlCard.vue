<script setup>
// kubectl 访问卡(W3 Task 6,2026-09-07):选集群 → 生成 kubeconfig(readonly 展示)
// + 复制/下载 + 失效说明。kubeconfig 的 user.token 即当前平台登录凭据 —— 随平台会话
// 吊销/登出/改密即刻失效;K8s 侧权限与平台会话同源(网关按会话执行 ns 授权门)。
// 独立组件而非并入 SecuritySection:安全卡已超行数预算,此处自持一张卡。
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { authApi } from '@/api/client'
import { notify } from '@/composables/useToast'

const { t } = useI18n()
const clusters = ref([])
const clusterId = ref('')
const config = ref('')
const loading = ref(false)
const error = ref('')

onMounted(async () => {
  try { clusters.value = (await authApi.myClusters()).clusters || [] } catch { /* 拉取失败不阻塞卡片,空态提示 */ }
})

async function generate() {
  if (!clusterId.value) return
  loading.value = true
  error.value = ''
  try {
    config.value = await authApi.myKubeconfig(clusterId.value)
  } catch (e) {
    config.value = ''
    error.value = e.message || t('common.opFailed')
  } finally { loading.value = false }
}

async function copy() {
  try {
    await navigator.clipboard.writeText(config.value)
    notify('success', t('common.copySuccess'))
  } catch { notify('error', t('common.copyFailed')) }
}

function download() {
  const name = clusters.value.find((c) => c.id === clusterId.value)?.name || clusterId.value
  const blob = new Blob([config.value], { type: 'text/yaml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `kubeconfig-aliangboard-${name}.yaml`
  a.click()
  URL.revokeObjectURL(url)
}
</script>

<template>
  <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg">
    <div class="min-w-0">
      <h3 class="text-headline-sm font-bold">{{ $t('userCenter.kubectl.title') }}</h3>
      <p class="text-body-xs text-on-surface-variant mt-xs">{{ $t('userCenter.kubectl.desc') }}</p>
    </div>

    <div class="mt-md flex flex-wrap items-end gap-sm">
      <div class="min-w-48">
        <label class="text-body-xs text-on-surface-variant block mb-xs">{{ $t('userCenter.kubectl.selectCluster') }}</label>
        <select v-model="clusterId" data-testid="kubectl-cluster"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
          <option value="" disabled>{{ $t('userCenter.kubectl.selectCluster') }}</option>
          <option v-for="c in clusters" :key="c.id" :value="c.id">{{ c.name }}</option>
        </select>
      </div>
      <button data-testid="kubectl-generate" :disabled="!clusterId || loading"
        class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold text-body-sm disabled:opacity-50 shrink-0"
        @click="generate">{{ $t('userCenter.kubectl.generate') }}</button>
    </div>
    <p v-if="!clusters.length" class="text-body-xs text-on-surface-variant mt-sm">{{ $t('userCenter.kubectl.noClusters') }}</p>

    <p v-if="error" data-testid="kubectl-error" class="mt-md text-body-sm text-error bg-error/10 rounded-lg px-md py-sm">{{ error }}</p>

    <div v-if="config" class="mt-md flex flex-col gap-sm">
      <textarea readonly data-testid="kubectl-yaml" rows="10" spellcheck="false"
        class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm font-mono text-body-xs leading-relaxed resize-y"
        :value="config" />
      <div class="flex items-center gap-sm">
        <button data-testid="kubectl-copy"
          class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high"
          @click="copy">{{ $t('userCenter.kubectl.copy') }}</button>
        <button data-testid="kubectl-download"
          class="px-md py-sm border border-outline-variant rounded-lg text-body-sm hover:bg-surface-container-high"
          @click="download">{{ $t('userCenter.kubectl.download') }}</button>
      </div>
    </div>

    <p data-testid="kubectl-expiry-hint"
      class="mt-md flex items-start gap-xs text-body-xs text-on-surface-variant bg-surface-container-low rounded-lg px-md py-sm">
      <span class="material-symbols-outlined text-base shrink-0">info</span>{{ $t('userCenter.kubectl.expiryHint') }}
    </p>
  </div>
</template>
