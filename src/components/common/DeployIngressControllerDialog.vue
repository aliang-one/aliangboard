<script setup>
// src/components/common/DeployIngressControllerDialog.vue
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { api } from '@/api/client'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'applied'])
const { t } = useI18n()
const store = useClusterStore()
const qc = useQueryClient()
const cid = () => store.currentCluster || 'cluster'

const templates = ref([])
const pickedId = ref('')
const yaml = ref('')
const loading = ref(false)

// ===== Task 5: RBAC 预检 + apply 进度 =====
// 9 项 cluster-scoped 资源,部署 Ingress 控制器所需的 create 权限。
const REQUIRED_RBAC = [
  { resource: 'clusterroles' }, { resource: 'clusterrolebindings' },
  { resource: 'roles' }, { resource: 'rolebindings' },
  { resource: 'serviceaccounts' }, { resource: 'deployments' },
  { resource: 'services' }, { resource: 'configmaps' }, { resource: 'ingressclasses' },
].map(r => ({ ...r, verb: 'create', namespace: '' }))

const rbacMissing = ref([])
const rbacChecked = ref(false)
const applying = ref(false)
const result = ref(null)   // { applied, failed, total }

async function checkRbac() {
  const miss = []
  for (const attrs of REQUIRED_RBAC) {
    const r = await store.checkAccessServer(attrs)
    if (!r?.allowed) miss.push(attrs.resource)
  }
  rbacMissing.value = miss
  rbacChecked.value = true
}

async function deploy() {
  applying.value = true
  result.value = null
  try {
    const r = await api.applyYaml(yaml.value)   // 服务端原始 {applied,failed,total}
    result.value = r
    if ((r.applied || []).length) {
      emit('applied')
      qc.invalidateQueries({ queryKey: ['cluster', cid(), 'ingressclasses'] })
    }
  } finally { applying.value = false }
}

watch(() => props.modelValue, async (open) => {
  if (!open || templates.value.length) return
  const r = await api.ingressControllers.catalog()
  templates.value = r.templates || []
}, { immediate: true })

async function pick(tpl) {
  pickedId.value = tpl.id
  loading.value = true
  try { const r = await api.ingressControllers.manifest(tpl.id); yaml.value = r.yaml }
  finally { loading.value = false }
  // 清单载入后立即跑 RBAC 预检(逐项 SelfSubjectAccessReview)
  await checkRbac()
}
function close() { emit('update:modelValue', false) }

// ===== Task 10: 已装检测 =====
// 拉集群当前 IngressClass 列表(30s staleTime,与 useResourceList 默认基座一致);
// 选中模板后,若 defaultClassName 已在列表中,显示幂等提示(非阻塞)。
const { data: ingressClasses } = useResourceList({
  key: ['cluster', cid(), 'ingressclasses'],
  fetcher: () => store.fetchIngressClasses(),
  options: { staleTime: 30_000 },
})
const pickedTpl = computed(() => templates.value.find(t => t.id === pickedId.value) || null)
const alreadyInstalled = computed(() => {
  if (!pickedTpl.value?.defaultClassName) return false
  const names = (ingressClasses.value || []).map(c => c.name)
  return names.includes(pickedTpl.value.defaultClassName)
})
</script>

<template>
  <Modal :model-value="modelValue" @update:model-value="close" :title="t('ingressController.dialogTitle')" width="max-w-3xl">
    <div v-if="!pickedId" class="grid grid-cols-2 gap-md">
      <button v-for="tpl in templates" :key="tpl.id" data-testid="controller-card"
        class="text-left border border-outline-variant rounded-lg p-md hover:border-primary"
        @click="pick(tpl)">
        <div class="font-semibold">{{ t(tpl.labelKey) }}</div>
        <div class="text-xs text-on-surface-variant">{{ tpl.version }} · {{ tpl.variant }}</div>
        <div v-if="tpl.descKey" data-testid="controller-desc" class="text-xs text-on-surface-variant mt-xs">{{ t(tpl.descKey) }}</div>
      </button>
    </div>
    <div v-else>
      <YamlEditor v-model="yaml" />
      <!-- Task 10: 已装检测(非阻塞,server-side apply 幂等) -->
      <div v-if="alreadyInstalled" data-testid="already-installed" class="text-body-sm text-on-surface-variant mt-md">
        {{ t('ingressController.alreadyInstalled') }}
      </div>
      <!-- RBAC 预检结果(i18n 键由 Task 6 补) -->
      <div v-if="rbacChecked" data-testid="rbac-check" class="text-body-sm mt-md">
        <span v-if="!rbacMissing.length">{{ t('ingressController.rbacOk') }}</span>
        <span v-else>{{ t('ingressController.rbacMissing') }}: {{ rbacMissing.join(', ') }}</span>
      </div>
      <!-- apply 进度摘要 + 失败明细 -->
      <div v-if="result" data-testid="deploy-result" class="text-body-sm mt-md">
        <div>{{ (result.applied || []).length }}/{{ result.total }}</div>
        <ul v-if="(result.failed || []).length" class="text-error mt-sm">
          <li v-for="f in result.failed" :key="f.kind + f.name">{{ f.kind }}/{{ f.name }}: {{ f.error }}</li>
        </ul>
      </div>
    </div>
    <!-- Modal #actions slot:部署按钮 -->
    <template v-if="pickedId" #actions>
      <button data-testid="deploy-btn" :disabled="applying || loading"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold disabled:opacity-50"
        @click="deploy">
        {{ applying ? t('common.applying') : t('ingressController.deploy') }}
      </button>
    </template>
  </Modal>
</template>
