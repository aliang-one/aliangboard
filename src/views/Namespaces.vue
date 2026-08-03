<script setup>
import { ref, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import DataTable from '@/components/common/DataTable.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Modal from '@/components/common/Modal.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import { useTableColumns } from '@/composables/useTableColumns'
import { notify } from '@/composables/useToast'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const router = useRouter()
const store = useClusterStore()
const { tableColumns } = useTableColumns()

const syncing = ref(false)
async function sync() {
  if (syncing.value) return
  if (!store.remoteMode) { notify('info', '演示数据模式下无需同步'); return }
  syncing.value = true
  try { await store.hydrateCoreResources(); notify('success', '已同步命名空间') }
  catch (e) { notify('error', `同步失败：${e.message || ''}`) }
  finally { syncing.value = false }
}

const headers = computed(() => tableColumns('namespaces'))

const { currentPage, pageSize, paginated, total } = usePagination(computed(() => store.namespaceList))

// 受保护的系统命名空间，禁止删除
const PROTECTED_NAMESPACES = ['kube-system', 'kube-public', 'kube-node-lease', 'default']
function isProtected(name) {
  return PROTECTED_NAMESPACES.includes(name)
}

/* ---------------- 创建 Namespace ---------------- */
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
    createError.value = 'Namespace 名称不能为空'
    return
  }
  if (store.getNamespaceByName(name)) {
    createError.value = `Namespace "${name}" 已存在`
    return
  }
  const labels = parseLabels(createLabelsText.value)
  const r = await store.addNamespace({ name, labels })
  if (r && r.ok === false) return   // 远端创建失败：保留弹窗（错误已由 store notify）
  showCreate.value = false
  createName.value = ''
  createLabelsText.value = ''
}

/* ---------------- 删除 Namespace ---------------- */
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
    <div class="flex flex-col gap-md mb-lg">
      <div class="flex justify-between items-end">
        <div>
          <div class="flex items-center gap-sm text-on-surface-variant mb-sm">
            <span class="material-symbols-outlined text-lg">folder_open</span>
            <span class="text-label-caps uppercase tracking-wider">Namespace Explorer</span>
          </div>
          <h2 class="text-display-lg text-on-surface">Namespaces</h2>
          <p class="text-on-surface-variant text-body-md mt-1">Browse and manage Kubernetes namespaces.</p>
        </div>
        <div class="flex gap-sm">
          <button @click="sync" :disabled="syncing" class="flex items-center gap-sm px-md py-sm bg-surface-container-highest text-on-surface font-semibold rounded-lg border border-outline-variant hover:bg-surface-container transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            <span class="material-symbols-outlined" :class="syncing ? 'animate-spin' : ''">{{ syncing ? 'progress_activity' : 'refresh' }}</span> {{ syncing ? 'Syncing…' : 'Sync' }}
          </button>
          <button
            class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg hover:opacity-90 transition-opacity"
            @click="openCreate"
          >
            <span class="material-symbols-outlined">add</span> New Namespace
          </button>
        </div>
      </div>
    </div>

    <EmptyState v-if="!store.namespaceList.length" icon="folder_open" title="No namespaces" description="集群暂无命名空间。" />
    <DataTable v-else :headers="headers" :rows="paginated" @row-click="(row) => router.push(`/namespaces/${row.name}`)">
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
            :title="isProtected(row.name) ? '系统命名空间，禁止删除' : 'Delete'"
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

    <!-- 创建 Namespace Modal -->
    <Modal v-model="showCreate" title="Create Namespace" width="max-w-lg">
      <div class="flex flex-col gap-md">
        <div class="flex flex-col gap-sm">
          <label class="text-label-caps uppercase tracking-wider text-on-surface-variant">Name <span class="text-error">*</span></label>
          <input
            v-model="createName"
            type="text"
            placeholder="my-namespace"
            class="px-md py-sm bg-surface-container-low border border-outline-variant rounded-lg text-body-md text-on-surface focus:outline-none focus:border-primary"
            @keyup.enter="submitCreate"
          />
        </div>
        <div class="flex flex-col gap-sm">
          <label class="text-label-caps uppercase tracking-wider text-on-surface-variant">Labels <span class="text-on-surface-variant/60 normal-case tracking-normal">(可选，每行 key:value)</span></label>
          <textarea
            v-model="createLabelsText"
            rows="4"
            placeholder="env: prod&#10;team: backend"
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
          Cancel
        </button>
        <button
          class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
          :disabled="!canCreate"
          @click="submitCreate"
        >
          Create
        </button>
      </template>
    </Modal>

    <!-- 删除确认 Modal -->
    <Modal v-model="showDelete" title="Delete Namespace" width="max-w-md">
      <div v-if="deleteTarget" class="flex flex-col gap-md">
        <div class="flex items-start gap-md">
          <div class="w-10 h-10 rounded-full bg-error-container/30 flex items-center justify-center shrink-0">
            <span class="material-symbols-outlined text-error">warning</span>
          </div>
          <div class="flex flex-col gap-xs">
            <p class="text-body-md text-on-surface">
              确定要删除 Namespace
              <span class="font-bold font-mono">{{ deleteTarget.name }}</span>
              吗？
            </p>
            <p class="text-body-sm text-on-surface-variant">
              此操作将永久删除该命名空间及其下的所有资源（Pods、Services、Deployments 等），不可恢复。
            </p>
          </div>
        </div>

        <div v-if="deleteTargetProtected" class="flex items-start gap-sm p-md bg-error-container/20 border border-error/40 rounded-lg">
          <span class="material-symbols-outlined text-error text-lg shrink-0">block</span>
          <p class="text-body-sm text-error">
            <span class="font-bold">{{ deleteTarget.name }}</span> 是系统命名空间，禁止删除。
          </p>
        </div>
      </div>
      <template #actions>
        <button
          class="px-md py-sm border border-outline-variant rounded-lg text-body-md text-on-surface hover:bg-surface-container-high transition-colors"
          @click="showDelete = false"
        >
          Cancel
        </button>
        <button
          v-if="!deleteTargetProtected"
          class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold transition-opacity hover:opacity-90"
          @click="submitDelete"
        >
          Delete
        </button>
      </template>
    </Modal>
  </section>
</template>
