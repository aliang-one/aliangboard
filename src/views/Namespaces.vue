<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
	import { useI18n } from 'vue-i18n'
import { useClusterStore } from '@/stores/cluster'
import { useResourceList } from '@/composables/useK8sQuery'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Modal from '@/components/common/Modal.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import { notify } from '@/composables/useToast'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const { t } = useI18n()
const router = useRouter()
const store = useClusterStore()
const { tableColumns } = useTableColumns()

// Namespaces 走 Vue Query：远端按需重拉（staleTime 控制新鲜度）；mock 模式返回种子（不重拉）。
const cid = computed(() => (store.currentCluster || 'cluster'))
const namespacesQuery = useResourceList({
  key: ['cluster', cid.value, 'namespaces'],
  fetcher: () => store.fetchNamespaces(),
})
const namespaces = computed(() => namespacesQuery.data.value || [])

const syncing = computed(() => namespacesQuery.isFetching.value)
async function sync() {
  if (!store.remoteMode) { notify('info', t('ns.namespaces.noSyncNeeded')); return }
  try {
    store.invalidateAllClusterQueries()
    await namespacesQuery.refetch()
    notify('success', t('ns.namespaces.synced'))
  }
  catch (e) { notify('error', t('ns.namespaces.syncFailed', { error: e.message || '' })) }
}

const headers = computed(() => tableColumns('namespaces'))

const { currentPage, pageSize, paginated, total } = usePagination(namespaces)

// 受保护的系统命名空间，禁止t('common.delete')
const PROTECTED_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease', 'default']
function isProtected(name) {
  return PROTECTED_NAMESPACES.includes(name)
}

/* ---------------- t('ns.namespaces.createTitle') ---------------- */
const showCreate = ref(false)
const createName = ref('')
const createLabelsText = ref('')
const createError = ref('')

const canCreate = computed(() => createName.value.trim().length > 0)

function openCreate() {
  createName.value = ''
  createLabelsText.value = ''
  createError.value = ''
  showCreate.value = true
}

function parseLabels(text) {
  const labels = {}
  text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const idx = line.indexOf(':')
      if (idx === -1) return
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (key) labels[key] = value
    })
  return labels
}

async function submitCreate() {
  createError.value = ''
  const name = createName.value.trim()
  if (!name) {
    createError.value = t('ns.namespaces.nameRequired')
    return
  }
  if (store.getNamespaceByName(name)) {
    createError.value = t('ns.namespaces.nameExists', { name })
    return
  }
  const labels = parseLabels(createLabelsText.value)
  const r = await store.addNamespace({ name, labels })
  if (r && r.ok === false) return   // 远端创建失败：保留弹窗（错误已由 store notify）
  showCreate.value = false
  createName.value = ''
  createLabelsText.value = ''
}

/* ---------------- t('common.delete') Namespace ---------------- */
const showDelete = ref(false)
const deleteTarget = ref(null)

const deleteTargetProtected = computed(
  () => deleteTarget.value && isProtected(deleteTarget.value.name)
)

function openDelete(row) {
  deleteTarget.value = row
  showDelete.value = true
}

function submitDelete() {
  if (!deleteTarget.value || deleteTargetProtected.value) return
  store.deleteNamespace(deleteTarget.value.name)
  showDelete.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <div class="flex flex-col gap-md mb-md">
      <div class="flex justify-between items-end">
        <div>
          <div class="flex items-center gap-xs text-on-surface-variant mb-xs">
            <span class="material-symbols-outlined text-base">folder_open</span>
            <span class="text-xs uppercase tracking-wider">Namespace Explorer</span>
          </div>
          <h2 class="text-headline-md text-on-surface font-bold">Namespaces</h2>
          <p class="text-on-surface-variant text-body-sm mt-xs">Browse and manage Kubernetes namespaces.</p>
        </div>
        <div class="flex gap-sm">
          <button @click="sync" :disabled="syncing" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            <span class="material-symbols-outlined text-base" :class="syncing ? 'animate-spin' : ''">{{ syncing ? 'progress_activity' : 'refresh' }}</span> {{ syncing ? 'Syncing…' : 'Sync' }}
          </button>
          <button
            class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity"
            @click="openCreate"
          >
            <span class="material-symbols-outlined text-base">add</span> New Namespace
          </button>
        </div>
      </div>
    </div>

    <EmptyState v-if="!namespaces.length" icon="folder_open" title="No namespaces" description="No namespaces in the cluster." />
    <DataTable v-else :headers="headers" :rows="paginated" column-key="namespaces" @row-click="(row) => router.push(`/namespaces/${row.name}`)">
      <template #name="{ row }">
        <div class="flex items-center gap-md">
          <div class="w-8 h-8 rounded-lg bg-primary-container/20 flex items-center justify-center">
            <span class="material-symbols-outlined text-primary text-lg">folder</span>
          </div>
          <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
        </div>
      </template>
      <template #status="{ row }">
        <StatusChip :status="row.status" />
      </template>
      <template #pods="{ row }">
        <span class="font-mono text-code-sm font-bold">{{ row.pods }}</span>
      </template>
      <template #services="{ row }">
        <span class="font-mono text-code-sm font-bold">{{ row.services }}</span>
      </template>
      <template #actions="{ row }">
        <div class="flex justify-end gap-1">
          <button @click.stop="router.push(`/namespaces/${row.name}`)" class="p-sm text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg transition-all" title="View">
            <span class="material-symbols-outlined text-lg">edit</span>
          </button>
          <button
            class="p-sm text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
            :class="{ 'opacity-40 cursor-not-allowed': isProtected(row.name) }"
            :title="isProtected(row.name) ? t('ns.namespaces.systemNamespace') : 'Delete'"
            :disabled="isProtected(row.name)"
            @click.stop="openDelete(row)"
          >
            <span class="material-symbols-outlined text-lg">delete</span>
          </button>
        </div>
      </template>
      <template #pagination>
        <Pagination v-if="total > pageSize" :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </template>
    </DataTable>

    <!-- t('ns.namespaces.createTitle') Modal -->
    <Modal v-model="showCreate" :title="t('ns.namespaces.createTitle')" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div class="flex flex-col gap-sm">
          <label class="text-label-caps uppercase tracking-wider text-on-surface-variant">{{ t('ns.namespaces.nameLabel') }} <span class="text-error">*</span></label>
          <input
            v-model="createName"
            type="text"
            :placeholder="t('ns.namespaces.namePlaceholder')"
            class="px-md py-sm bg-surface-container-low border border-outline-variant rounded-lg text-body-md text-on-surface focus:outline-none focus:border-primary"
            @keyup.enter="submitCreate"
          />
        </div>
        <div class="flex flex-col gap-sm">
          <label class="text-label-caps uppercase tracking-wider text-on-surface-variant">{{ t('ns.namespaces.labelsLabel') }} <span class="text-on-surface-variant/60 normal-case tracking-normal">{{ t('ns.namespaces.labelsHint') }}</span></label>
          <textarea
            v-model="createLabelsText"
            rows="4"
            :placeholder="t('ns.namespaces.labelsPlaceholder')"
            class="px-md py-sm bg-surface-container-low border border-outline-variant rounded-lg text-body-md text-on-surface font-mono focus:outline-none focus:border-primary resize-y"
          ></textarea>
        </div>
        <p v-if="createError" class="text-body-sm text-error flex items-center gap-xs">
          <span class="material-symbols-outlined text-base">error</span>
          {{ createError }}
        </p>
      </div>
      <template #actions>
        <button
          class="px-md py-sm border border-outline-variant rounded-lg text-body-md text-on-surface hover:bg-surface-container-high transition-colors"
          @click="showCreate = false"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!canCreate"
          @click="submitCreate"
        >
          {{ t('common.create') }}
        </button>
      </template>
    </Modal>

    <!-- t('common.delete')确认 Modal -->
    <Modal v-model="showDelete" :title="t('ns.namespaces.deleteTitle')" width="max-w-md">
      <div v-if="deleteTarget" class="flex flex-col gap-md">
        <div class="flex items-start gap-md">
          <div class="w-10 h-10 rounded-full bg-error-container/30 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-error">warning</span>
          </div>
          <div class="flex flex-col gap-xs">
            <p class="text-body-md text-on-surface">
              {{ t('ns.namespaces.deleteConfirm') }} <span class="font-bold font-mono">{{ deleteTarget.name }}</span>{{ t('ns.namespaces.deleteSuffix') }}
            </p>
            <p class="text-body-sm text-on-surface-variant">
              {{ t('ns.namespaces.deleteWarning') }}
            </p>
          </div>
        </div>

        <div v-if="deleteTargetProtected" class="flex items-start gap-sm p-md bg-error-container/20 border border-error/40 rounded-lg">
          <span class="material-symbols-outlined text-error text-lg shrink-0">block</span>
          <p class="text-body-sm text-error">
            <span class="font-bold">{{ deleteTarget.name }}</span> {{ t('ns.namespaces.isSystemNamespace') }}
          </p>
        </div>
      </div>
      <template #actions>
        <button
          class="px-md py-sm border border-outline-variant rounded-lg text-body-md text-on-surface hover:bg-surface-container-high transition-colors"
          @click="showDelete = false"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          v-if="!deleteTargetProtected"
          class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold transition-opacity hover:opacity-90"
          @click="submitDelete"
        >
          {{ t('common.delete') }}
        </button>
      </template>
    </Modal>
  </section>
</template>
