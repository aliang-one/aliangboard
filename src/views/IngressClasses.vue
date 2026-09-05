<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import { useTableColumns } from '@/composables/useTableColumns'
import { useI18n } from 'vue-i18n'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import DataTable from '@/components/common/DataTable.vue'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'
import DeployIngressControllerDialog from '@/components/common/DeployIngressControllerDialog.vue'

const { t } = useI18n()
const store = useClusterStore()
const router = useRouter()
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

// 行点击 → 集群级详情页(无需 namespace 上下文);编辑统一在详情页 live YAML 上做
function openDetail(row) {
  router.push({ name: 'IngressClassDetail', params: { name: row.name } })
}

// 部署 Ingress 控制器(applied 后列表由弹窗内 invalidateQueries 自动刷新,共享 key)
const showDeployCtrl = ref(false)

// 创建
const showCreateModal = ref(false)
const createForm = ref({ name: '', controller: '', isDefault: false })
function resetCreate() {
  createForm.value = { name: '', controller: '', isDefault: false }
}
async function handleCreate() {
  const f = createForm.value
  // 创建即设默认也须走 sweep(防双默认):先以非默认创建,成功后再 promote(sweep→置默认)
  const r = await store.addIngressClass({
    name: f.name,
    controller: f.controller || 'k8s.io/ingress-nginx',
    isDefault: false,
  })
  if (r && r.ok === false) return // 远端创建失败:保留弹窗(错误已由 store notify)
  if (f.isDefault) {
    const p = await store.promoteIngressClassDefault(f.name)
    if (p && p.ok === false) return // promote(sweep)失败:资源已创建但默认未成,保留弹窗(错误已 notify)
  }
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

// 行级设默认(2026-09-05):promote 自带 sweep 摘旧默认,demote 允许回到无默认态(创建入口选项联动置灰)
async function toggleDefault(row) {
  if (row.isDefault) await store.demoteIngressClassDefault(row.name)
  else await store.promoteIngressClassDefault(row.name)
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
          data-testid="ic-create-open"
          @click="showCreateModal = true"
          class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all"
        >
          <span class="material-symbols-outlined">add</span> {{ $t('admin.ingressClasses.createBtn') }}
        </button>
      </div>
    </div>

    <DataTable :headers="headers" :rows="ingressClasses" column-key="ingressClasses" expandable row-key="name" @row-click="openDetail">
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
        <button data-testid="ic-toggle-default" @click.stop="toggleDefault(row)"
          class="p-xs rounded-lg transition-colors"
          :class="row.isDefault ? 'text-primary hover:bg-primary-container/10' : 'text-on-surface-variant hover:text-primary hover:bg-primary-container/10'"
          :title="row.isDefault ? $t('admin.ingressClasses.unsetDefaultTip') : $t('admin.ingressClasses.setDefaultTip')">
          <span class="material-symbols-outlined text-lg">{{ row.isDefault ? 'star' : 'star_outline' }}</span>
        </button>
        <button data-testid="ic-edit" @click.stop="openDetail(row)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" :title="$t('common.edit')">
          <span class="material-symbols-outlined text-lg">edit</span>
        </button>
        <button data-testid="ic-delete" @click.stop="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" :title="$t('admin.ingressClasses.deleteTip')">
          <span class="material-symbols-outlined text-lg">delete</span>
        </button>
      </template>
      <template #expanded="{ row }">
        <!-- 只读快照(generateYAML 有损重建,仅 3 字段):保存会经 force apply 静默剪掉
             真实控制器的 spec.parameters/labels——编辑请进详情页 live YAML(2026-09-04) -->
        <YamlEditor :model-value="yamlOf(row)" :readonly="true" height="320px" />
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
        data-testid="ic-create-submit"
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
