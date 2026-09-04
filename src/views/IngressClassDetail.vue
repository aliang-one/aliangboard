<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

// 集群级 IngressClass 详情页(与 StorageClassDetail 同构):
// YAML tab 用 useLiveYaml 拉「实时完整对象」而非 generateYAML 的有损重建——
// 后者只产出 name/is-default/controller 三字段,force apply 会把真实控制器的
// spec.parameters、labels/annotations 静默剪掉(SSA fieldManager 语义)。
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
const cid = computed(() => (store.currentCluster || 'cluster'))

const icDetail = useResourceDetail({
  key: ['cluster', cid, 'ingressclasses', route.params.name],
  fetcher: () => store.fetchIngressClass(route.params.name),
  options: { refetchInterval: 15000 },
})
const ic = computed(() => icDetail.data.value)
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/networking.k8s.io/v1/ingressclasses/${encodeURIComponent(route.params.name)}`,
})
const activeTab = ref('overview')

// 集群级 Ingress 列表 → 过滤 className 引用本类的关联 Ingress(Network.vue 同款 key/轮询)
const ingressesQ = useResourceList({
  key: ['cluster', cid, 'ingresses'],
  fetcher: () => store.fetchIngresses(),
  options: { refetchInterval: 30000 },
})
const related = computed(() => (ingressesQ.data.value || []).filter(i => i.className === ic.value?.name))
// 后端摘要:defaultBackend 映射形 {serviceName,servicePort};rules 内是原生 K8s 形 service:{name,port:{number|name}}
function backendSummary(ing) {
  if (ing.defaultBackend?.serviceName) return `${ing.defaultBackend.serviceName}:${ing.defaultBackend.servicePort}`
  for (const r of ing.rules || []) {
    const s = r?.http?.paths?.[0]?.backend?.service
    if (s?.name) { const p = s.port?.number ?? s.port?.name ?? ''; return p ? `${s.name}:${p}` : s.name }
  }
  return ''
}
async function toggleDefault() {
  if (ic.value.isDefault) await store.demoteIngressClassDefault(ic.value.name)
  else await store.promoteIngressClassDefault(ic.value.name)
}

const labelRows = computed(() => Object.entries(ic.value?.labels || {}))
const annRows = computed(() => Object.entries(ic.value?.annotations || {}))
const paramRows = computed(() => Object.entries(ic.value?.parameters || {}))

const showDeleteModal = ref(false)
async function handleDelete() {
  await store.deleteIngressClass(route.params.name)
  router.push('/ingressclasses')
}
</script>

<template>
  <section class="animate-fade-in" v-if="ic">
    <Breadcrumbs :items="[
      { label: 'IngressClasses', route: '/ingressclasses' },
      { label: ic.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">language</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ ic.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="text-body-sm text-on-surface-variant font-mono">{{ ic.controller }}</span>
            <span v-if="ic.isDefault" class="px-2.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded-full font-medium">DEFAULT</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ ic.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs">
        <button data-testid="promote-default-btn" v-if="!ic.isDefault" @click="toggleDefault" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold border border-primary/40 text-primary rounded-lg hover:bg-primary-container/10 transition-colors">
          <span class="material-symbols-outlined text-sm">star</span> {{ t('common.setAsDefault') }}
        </button>
        <button data-testid="demote-default-btn" v-else @click="toggleDefault" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface-variant rounded-lg hover:bg-surface-container transition-colors">
          <span class="material-symbols-outlined text-sm">star</span> {{ t('common.unsetDefault') }}
        </button>
        <button data-testid="detail-delete-btn" @click="showDeleteModal = true" class="px-3 py-1.5 text-body-sm font-medium border border-error/30 text-error rounded-lg hover:bg-error/5 transition-colors">{{ t('common.delete') }}</button>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
        <h3 class="text-headline-sm mb-lg">{{ t('admin.ingressClasses.details') }}</h3>
        <div class="grid grid-cols-2 gap-md">
          <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">{{ t('admin.ingressClasses.thController') }}</p><p class="font-mono text-code-sm text-on-surface">{{ ic.controller }}</p></div>
          <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">{{ t('admin.ingressClasses.thDefault') }}</p><p class="text-body-md text-on-surface">{{ ic.isDefault ? t('admin.ingressClasses.yes') : '—' }}</p></div>
        </div>

        <div v-if="paramRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.ingressClasses.parameters') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in paramRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>

        <div v-if="labelRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.ingressClasses.labels') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in labelRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>

        <div v-if="annRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.ingressClasses.annotations') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in annRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>
      </div>
      </div>
      <div class="lg:col-span-4" data-testid="related-ingresses">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">{{ t('admin.ingressClasses.relatedIngresses') }} ({{ related.length }})</h3>
          <div v-if="related.length" class="flex flex-col gap-sm">
            <button v-for="ing in related" :key="ing.namespace + '/' + ing.name" @click="router.push({ name: 'NsIngressDetail', params: { namespace: ing.namespace, name: ing.name } })"
              class="flex flex-col items-start gap-xs px-md py-sm bg-surface-container-low rounded-lg hover:bg-primary-container/10 transition-colors text-left">
              <span class="font-mono text-code-sm text-primary truncate max-w-full">{{ ing.namespace }}/{{ ing.name }}</span>
              <span class="text-body-sm text-on-surface-variant truncate max-w-full">{{ ing.hosts || '—' }}</span>
              <span class="flex items-center gap-xs text-label-caps text-on-surface-variant">
                <span v-if="ing.tls" class="flex items-center gap-xs text-secondary"><span class="material-symbols-outlined text-sm">lock</span>443</span>
                <span v-if="backendSummary(ing)" class="font-mono">{{ backendSummary(ing) }}</span>
              </span>
            </button>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant py-md text-center">{{ t('admin.ingressClasses.relatedEmpty') }}</p>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>

    <!-- 删除确认 Modal -->
    <Modal v-model="showDeleteModal" :title="t('admin.ingressClasses.deleteTitle')" width="max-w-md">
      <p class="text-body-md text-on-surface-variant" v-html="t('admin.ingressClasses.deleteConfirm', { name: ic.name })"></p>
      <p class="text-body-sm text-error mt-sm">{{ t('admin.ingressClasses.deleteWarning') }}</p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('admin.ingressClasses.cancel') }}</button>
        <button data-testid="detail-delete-confirm" @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('admin.ingressClasses.delete') }}</button>
      </template>
    </Modal>
  </section>
  <!-- 首载中不渲染 not-found(避免慢加载时闪错页);仅查询结束仍无对象时呈现 -->
  <section v-else-if="!icDetail.isLoading.value" class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">{{ t('admin.ingressClasses.notFound') }}</h2>
    <button data-testid="back-to-list" @click="router.push('/ingressclasses')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('admin.ingressClasses.backToList') }}</button>
  </section>
</template>
