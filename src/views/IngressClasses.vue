<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useResourceApply } from '@/composables/useResourceApply'
import { useTableColumns } from '@/composables/useTableColumns'
import { useI18n } from 'vue-i18n'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import DeployIngressControllerDialog from '@/components/common/DeployIngressControllerDialog.vue'

const { t } = useI18n()
const store = useClusterStore()
const { applyYaml } = useResourceApply()
const { tableColumns } = useTableColumns()
const headers = computed(() => tableColumns('ingressClasses'))

const cid = computed(() => (store.currentCluster || 'cluster'))
const ingressClassesQuery = useResourceList({
  key: ['cluster', cid, 'ingressclasses'],
  fetcher: () => store.fetchIngressClasses(),
  options: { refetchInterval: 30000 },
})
const ingressClasses = computed(() => ingressClassesQuery.data.value || [])
const yamlOf = (c) => store.generateYAML('ingressclass', c)

// 部署 Ingress 控制器(applied 后列表由弹窗内 invalidateQueries 自动刷新,共享 key)
const showDeployCtrl = ref(false)

// 创建
const showCreateModal = ref(false)
const createForm = ref({ name: '', controller: '', isDefault: false })
function resetCreate() {
  createForm.value = { name: '', controller: '', isDefault: false }
}
function handleCreate() {
  const f = createForm.value
  store.addIngressClass({
    name: f.name,
    controller: f.controller || 'k8s.io/ingress-nginx',
    isDefault: !!f.isDefault,
  })
  showCreateModal.value = false
  resetCreate()
}

// 删除
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(row) {
  deleteTarget.value = row
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteIngressClass(deleteTarget.value.name)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[{ label: 'IngressClasses' }]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">{{ $t('admin.ingressClasses.title') }}</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ $t('admin.ingressClasses.subtitle', { count: ingressClasses.length }) }}</p>
      </div>
      <div class="flex items-center gap-sm">
        <button data-testid="deploy-controller-btn" @click="showDeployCtrl = true"
          class="flex items-center gap-sm px-md py-sm border border-primary text-primary rounded-lg hover:bg-primary-container transition-all">
          <span class="material-symbols-outlined">rocket_launch</span> {{ $t('ingressController.deployBtn') }}
        </button>
        <button
          @click="showCreateModal = true"
          class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all"
        >
          <span class="material-symbols-outlined">add</span> {{ $t('admin.ingressClasses.createBtn') }}
        </button>
      </div>
    </div>

    <DataTable :headers="headers" :rows="ingressClasses" column-key="ingressClasses" expandable row-key="name">
      <template #name="{ row }">
        <div class="flex items-center gap-sm">
          <span class="material-symbols-outlined text-secondary text-lg">language</span>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #controller="{ row }"><span class="font-mono text-code-sm text-on-surface-variant">{{ row.controller }}</span></template>
      <template #isDefault="{ row }">
        <span v-if="row.isDefault" class="flex items-center gap-xs text-primary"><span class="material-symbols-outlined text-lg">check_circle</span> {{ $t('admin.ingressClasses.yes') }}</span>
        <span v-else class="text-on-surface-variant">—</span>
      </template>
      <template #age="{ row }"><span class="text-body-sm text-on-surface-variant">{{ row.age }}</span></template>
      <template #actions="{ row }">
        <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="$t('admin.ingressClasses.deleteTip')">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </template>
      <template #expanded="{ row }">
        <YamlEditor :model-value="yamlOf(row)" :readonly="false" height="320px" @save="applyYaml" />
      </template>
    </DataTable>
  </section>

  <!-- 创建 Modal -->
  <Modal v-model="showCreateModal" :title="$t('admin.ingressClasses.createTitle')" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('admin.ingressClasses.nameLabel') }}</label>
        <input
          v-model="createForm.name"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary"
          :placeholder="$t('admin.ingressClasses.namePlaceholder')"
        />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">{{ $t('admin.ingressClasses.controllerLabel') }}</label>
        <input
          v-model="createForm.controller"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary"
          :placeholder="$t('admin.ingressClasses.controllerPlaceholder')"
        />
        <p class="text-label-caps text-on-surface-variant mt-xs">{{ $t('admin.ingressClasses.controllerHint') }}</p>
      </div>
      <label class="flex items-center gap-sm cursor-pointer">
        <input v-model="createForm.isDefault" type="checkbox" class="w-4 h-4 accent-primary" />
        <span class="text-body-md text-on-surface">{{ $t('admin.ingressClasses.setDefaultLabel') }}</span>
      </label>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('admin.ingressClasses.cancel') }}</button>
      <button
        @click="handleCreate"
        :disabled="!createForm.name"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40"
      >
        {{ $t('admin.ingressClasses.create') }}
      </button>
    </template>
  </Modal>

  <!-- 删除确认 Modal -->
  <Modal v-model="showDeleteModal" :title="$t('admin.ingressClasses.deleteTitle')" width="max-w-md">
    <p class="text-body-md text-on-surface-variant" v-html="$t('admin.ingressClasses.deleteConfirm', { name: deleteTarget?.name })"></p>
    <p class="text-body-sm text-error mt-sm">{{ $t('admin.ingressClasses.deleteWarning') }}</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">{{ $t('admin.ingressClasses.cancel') }}</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">{{ $t('admin.ingressClasses.delete') }}</button>
    </template>
  </Modal>

  <!-- 部署 Ingress 控制器 -->
  <DeployIngressControllerDialog v-model="showDeployCtrl" />
</template>
