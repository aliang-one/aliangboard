<script setup>
// 集群凭据表单(共享组件):AddCluster 独立页与集群管理页 modal 共用。
// 职责:字段渲染 + 必填校验;不发 API(提交/取消由父组件处理)。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

const props = defineProps({
  form: { type: Object, required: true },
  submitting: { type: Boolean, default: false },
  cancelLabel: { type: String, default: '' },
})
const emit = defineEmits(['submit', 'cancel'])
const { t } = useI18n()
const errors = ref({})

function validate() {
  const e = {}
  const f = props.form
  if (!f.name?.trim()) e.name = t('admin.clusters.nameRequired')
  if (f.authMethod === 'kubeconfig' && !f.kubeconfig?.trim()) e.kubeconfig = t('admin.clusters.kubeconfigRequired')
  if (f.authMethod !== 'kubeconfig' && !f.apiServer?.trim()) e.apiServer = t('admin.clusters.apiServerRequired')
  if (f.authMethod === 'token' && !f.token?.trim()) e.token = t('admin.clusters.tokenRequired')
  if (f.authMethod === 'basic' && !f.username?.trim()) e.username = t('admin.clusters.usernameRequired')
  return e
}

function onSubmit() {
  errors.value = validate()
  if (Object.keys(errors.value).length) return
  emit('submit')
}
</script>

<template>
  <div class="flex flex-col gap-md">
    <div>
      <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('admin.clusters.clusterName') }}</label>
      <input v-model="form.name" data-testid="cluster-form-name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="prod-cluster" />
      <p v-if="errors.name" data-testid="cluster-form-error-name" class="text-body-xs text-error mt-xs">{{ errors.name }}</p>
    </div>
    <!-- 凭据方式切换 -->
    <div class="flex gap-xs">
      <button v-for="m in [{k:'kubeconfig',l:t('admin.clusters.authKubeconfig')},{k:'token',l:t('admin.clusters.authToken')},{k:'basic',l:t('admin.clusters.authBasic')}]" :key="m.k" :data-testid="`cluster-form-auth-${m.k}`" @click="form.authMethod = m.k"
        class="px-sm py-xs rounded-lg border text-body-sm" :class="form.authMethod === m.k ? 'bg-primary text-on-primary border-primary font-semibold' : 'border-outline-variant text-on-surface-variant'">{{ m.l }}</button>
    </div>
    <!-- Kubeconfig -->
    <div v-if="form.authMethod === 'kubeconfig'">
      <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('admin.clusters.pasteKubeconfig') }}</label>
      <textarea v-model="form.kubeconfig" data-testid="cluster-form-kubeconfig" rows="8" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="apiVersion: v1&#10;kind: Config&#10;..."></textarea>
      <p v-if="errors.kubeconfig" data-testid="cluster-form-error-kubeconfig" class="text-body-xs text-error mt-xs">{{ errors.kubeconfig }}</p>
    </div>
    <!-- Token -->
    <div v-if="form.authMethod === 'token'" class="flex flex-col gap-sm">
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">API Server</label>
        <input v-model="form.apiServer" data-testid="cluster-form-apiserver" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://10.0.0.1:6443" />
        <p v-if="errors.apiServer" data-testid="cluster-form-error-apiServer" class="text-body-xs text-error mt-xs">{{ errors.apiServer }}</p>
      </div>
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">Bearer Token</label>
        <input v-model="form.token" data-testid="cluster-form-token" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="eyJhb..." />
        <p v-if="errors.token" data-testid="cluster-form-error-token" class="text-body-xs text-error mt-xs">{{ errors.token }}</p>
      </div>
    </div>
    <!-- Basic -->
    <div v-if="form.authMethod === 'basic'" class="flex flex-col gap-sm">
      <div>
        <label class="text-body-xs text-on-surface-variant block mb-xs">API Server</label>
        <input v-model="form.apiServer" data-testid="cluster-form-apiserver" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://10.0.0.1:6443" />
        <p v-if="errors.apiServer" data-testid="cluster-form-error-apiServer" class="text-body-xs text-error mt-xs">{{ errors.apiServer }}</p>
      </div>
      <div class="grid grid-cols-2 gap-sm">
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('admin.clusters.username') }}</label>
          <input v-model="form.username" data-testid="cluster-form-username" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
          <p v-if="errors.username" data-testid="cluster-form-error-username" class="text-body-xs text-error mt-xs">{{ errors.username }}</p>
        </div>
        <div>
          <label class="text-body-xs text-on-surface-variant block mb-xs">{{ t('admin.clusters.password') }}</label>
          <input v-model="form.password" data-testid="cluster-form-password" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" />
        </div>
      </div>
    </div>
    <label class="flex items-center gap-sm text-body-sm cursor-pointer"><input type="checkbox" v-model="form.insecure" class="h-4 w-4 accent-primary" /> {{ t('admin.clusters.insecureTls') }}</label>

    <!-- 操作行 -->
    <div class="flex justify-end gap-sm pt-xs">
      <button data-testid="cluster-form-cancel" @click="emit('cancel')" class="px-md py-sm border border-outline-variant rounded-lg">{{ cancelLabel || t('common.cancel') }}</button>
      <button data-testid="cluster-form-submit" :disabled="submitting" @click="onSubmit" class="flex items-center gap-xs px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed">
        <span v-if="submitting" class="material-symbols-outlined text-sm animate-spin">progress_activity</span>
        {{ t('admin.clusters.addAndVerify') }}
      </button>
    </div>
  </div>
</template>
