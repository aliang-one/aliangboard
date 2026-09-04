<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import Modal from '@/components/common/Modal.vue'

// 集群级 RuntimeClass 详情页(与 IngressClassDetail 同批同构)。
// 注意:RuntimeClass 无 spec 节——handler/overhead/scheduling 都是顶层字段;
// YAML tab 同样走 useLiveYaml 实时完整对象,不用 generateYAML 有损重建。
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
const cid = computed(() => (store.currentCluster || 'cluster'))

const rcDetail = useResourceDetail({
  key: ['cluster', cid, 'runtimeclasses', route.params.name],
  fetcher: () => store.fetchRuntimeClass(route.params.name),
  options: { refetchInterval: 15000 },
})
const rc = computed(() => rcDetail.data.value)
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/node.k8s.io/v1/runtimeclasses/${encodeURIComponent(route.params.name)}`,
})
const activeTab = ref('overview')

const labelRows = computed(() => Object.entries(rc.value?.labels || {}))
const annRows = computed(() => Object.entries(rc.value?.annotations || {}))
const overheadRows = computed(() => Object.entries(rc.value?.overhead?.podFixed || {}))
const schedulingNodeSelector = computed(() => Object.entries(rc.value?.scheduling?.nodeSelector || {}))
const schedulingTolerations = computed(() => rc.value?.scheduling?.tolerations || [])

const showDeleteModal = ref(false)
async function handleDelete() {
  await store.deleteRuntimeClass(route.params.name)
  router.push('/runtimeclasses')
}
</script>

<template>
  <section class="animate-fade-in" v-if="rc">
    <Breadcrumbs :items="[
      { label: 'RuntimeClasses', route: '/runtimeclasses' },
      { label: rc.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-tertiary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-tertiary-container text-3xl">memory</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ rc.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="text-body-sm text-on-surface-variant font-mono">{{ rc.handler }}</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ rc.age }}</span>
          </div>
        </div>
      </div>
      <div class="flex items-center gap-xs">
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

    <div v-if="activeTab === 'overview'">
      <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card max-w-3xl">
        <h3 class="text-headline-sm mb-lg">{{ t('admin.runtimeClasses.details') }}</h3>
        <div class="grid grid-cols-2 gap-md">
          <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">{{ t('admin.runtimeClasses.handlerLabel') }}</p><p class="font-mono text-code-sm text-on-surface">{{ rc.handler }}</p></div>
          <div class="p-md rounded-lg bg-surface-container-low"><p class="text-label-caps text-on-surface-variant mb-xs">{{ t('admin.runtimeClasses.thAge') }}</p><p class="text-body-md text-on-surface">{{ rc.age }}</p></div>
        </div>

        <div v-if="overheadRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.runtimeClasses.overhead') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in overheadRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>

        <div v-if="schedulingNodeSelector.length || schedulingTolerations.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.runtimeClasses.scheduling') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in schedulingNodeSelector" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
            <div v-for="(tol, i) in schedulingTolerations" :key="'tol' + i" class="flex">
              <span class="text-primary">toleration:</span>
              <span class="ml-sm text-on-surface break-all">{{ [tol.key, tol.operator, tol.value].filter(Boolean).join(' ') }}</span>
            </div>
          </div>
        </div>

        <div v-if="labelRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.runtimeClasses.labels') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in labelRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>

        <div v-if="annRows.length" class="mt-lg">
          <p class="text-label-caps text-on-surface-variant mb-sm">{{ t('admin.runtimeClasses.annotations') }}</p>
          <div class="bg-surface-container-low rounded-lg p-md font-mono text-code-sm">
            <div v-for="[k, v] in annRows" :key="k" class="flex"><span class="text-primary">{{ k }}:</span><span class="ml-sm text-on-surface break-all">{{ v }}</span></div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>

    <!-- 删除确认 Modal -->
    <Modal v-model="showDeleteModal" :title="t('admin.runtimeClasses.deleteTitle')" width="max-w-md">
      <p class="text-body-md text-on-surface-variant" v-html="t('admin.runtimeClasses.deleteConfirm', { name: rc.name })"></p>
      <p class="text-body-sm text-error mt-sm">{{ t('admin.runtimeClasses.deleteWarning') }}</p>
      <template #actions>
        <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ t('admin.runtimeClasses.cancel') }}</button>
        <button data-testid="detail-delete-confirm" @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ t('admin.runtimeClasses.delete') }}</button>
      </template>
    </Modal>
  </section>
  <!-- 首载中不渲染 not-found(避免慢加载时闪错页);仅查询结束仍无对象时呈现 -->
  <section v-else-if="!rcDetail.isLoading.value" class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">{{ t('admin.runtimeClasses.notFound') }}</h2>
    <button data-testid="back-to-list" @click="router.push('/runtimeclasses')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">{{ t('admin.runtimeClasses.backToList') }}</button>
  </section>
</template>
