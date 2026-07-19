<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const store = useClusterStore()

// 系统级 PriorityClass（不可删除）
const SYSTEM_PRIORITY_CLASSES = ['system-node-critical', 'system-cluster-critical']
const isSystem = (name) => SYSTEM_PRIORITY_CLASSES.includes(name)

// 搜索
const searchQuery = ref('')
const filtered = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const list = q
    ? store.priorityClassList.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.description || '').toLowerCase().includes(q)
      )
    : [...store.priorityClassList]
  // 按 value 降序
  return list.sort((a, b) => b.value - a.value)
})

// 可展开行
const expandedName = ref(null)
function toggleExpand(name) {
  expandedName.value = expandedName.value === name ? null : name
}
function yamlFor(pc) {
  return store.generateExtraYAML('priorityclass', pc)
}

// 创建
const showCreateModal = ref(false)
const createForm = ref({ name: '', value: 100000, globalDefault: false, description: '' })
function resetCreate() {
  createForm.value = { name: '', value: 100000, globalDefault: false, description: '' }
}
function handleCreate() {
  const f = createForm.value
  store.addPriorityClass({
    name: f.name,
    value: parseInt(f.value, 10) || 0,
    globalDefault: !!f.globalDefault,
    description: f.description,
  })
  showCreateModal.value = false
  resetCreate()
}

// 删除
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(pc) {
  if (isSystem(pc.name)) return
  deleteTarget.value = pc
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deletePriorityClass(deleteTarget.value.name)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'Cluster', route: '/cluster' },
      { label: 'PriorityClasses' }
    ]" />

    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">优先级类 (PriorityClasses)</h2>
        <p class="text-on-surface-variant text-body-md mt-1">
          共 {{ store.priorityClassList.length }} 个 PriorityClass — 控制 Pod 调度与抢占优先级，value 越大优先级越高
        </p>
      </div>
      <button
        @click="showCreateModal = true"
        class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all"
      >
        <span class="material-symbols-outlined">add</span> Create PriorityClass
      </button>
    </div>

    <!-- 搜索框 -->
    <div class="mb-md">
      <div class="relative max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant">search</span>
        <input
          v-model="searchQuery"
          class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary"
          placeholder="按名称或 description 搜索"
        />
      </div>
    </div>

    <!-- 列表表格 -->
    <div v-if="filtered.length" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-md text-label-caps text-on-surface-variant w-8"></th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Value</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Global Default</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Description</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-32 text-right">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <template v-for="row in filtered" :key="row.name">
            <!-- 主行 -->
            <tr
              class="hover:bg-surface-container-low/50 cursor-pointer transition-colors"
              :class="{ 'bg-primary-container/5': expandedName === row.name }"
              @click="toggleExpand(row.name)"
            >
              <td class="px-md py-md text-on-surface-variant">
                <span class="material-symbols-outlined text-lg transition-transform" :class="{ 'rotate-90': expandedName === row.name }">chevron_right</span>
              </td>
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm flex-wrap">
                  <span class="material-symbols-outlined text-lg" :class="isSystem(row.name) ? 'text-error' : 'text-secondary'">flag</span>
                  <span class="font-semibold text-on-surface text-body-md font-mono">{{ row.name }}</span>
                  <span v-if="isSystem(row.name)" class="px-2 py-0.5 bg-error-container/30 text-error text-label-caps rounded-full border border-error/30">SYSTEM</span>
                </div>
              </td>
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span
                    class="font-mono font-bold text-code-lg"
                    :class="isSystem(row.name) ? 'text-error' : row.value >= 1000000 ? 'text-primary' : 'text-on-surface'"
                  >{{ row.value.toLocaleString() }}</span>
                  <span v-if="row.globalDefault" class="px-1.5 py-0.5 bg-primary-container/30 text-primary text-label-caps rounded font-semibold">DEFAULT</span>
                </div>
              </td>
              <td class="px-lg py-md">
                <span v-if="row.globalDefault" class="material-symbols-outlined text-success">check_circle</span>
                <span v-else class="material-symbols-outlined text-on-surface-variant opacity-50">cancel</span>
              </td>
              <td class="px-lg py-md">
                <span class="text-body-sm text-on-surface-variant line-clamp-1">{{ row.description || '—' }}</span>
              </td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
              <td class="px-lg py-md text-right" @click.stop>
                <div class="flex justify-end gap-1">
                  <button
                    @click="$router.push({ name: 'PriorityClassDetail', params: { name: row.name } })"
                    class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"
                    title="详情"
                  >
                    <span class="material-symbols-outlined text-lg">open_in_new</span>
                  </button>
                  <button
                    @click="toggleExpand(row.name)"
                    class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"
                    title="查看 YAML"
                  >
                    <span class="material-symbols-outlined text-lg">code</span>
                  </button>
                  <button
                    @click="confirmDelete(row)"
                    :disabled="isSystem(row.name)"
                    class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-on-surface-variant"
                    :title="isSystem(row.name) ? '系统级，不可删除' : '删除'"
                  >
                    <span class="material-symbols-outlined text-lg">delete</span>
                  </button>
                </div>
              </td>
            </tr>
            <!-- 展开详情行 -->
            <tr v-if="expandedName === row.name">
              <td colspan="7" class="p-lg bg-surface-container-lowest">
                <div class="grid grid-cols-1 lg:grid-cols-3 gap-lg">
                  <!-- YAML -->
                  <div class="lg:col-span-2">
                    <div class="flex items-center gap-sm mb-sm">
                      <span class="material-symbols-outlined text-on-surface-variant text-lg">code</span>
                      <h4 class="text-label-caps text-on-surface-variant">YAML</h4>
                    </div>
                    <div class="border border-outline-variant rounded-lg overflow-hidden">
                      <YamlEditor :model-value="yamlFor(row)" readonly height="260px" />
                    </div>
                  </div>
                  <!-- 详情 -->
                  <div>
                    <div class="flex items-center gap-sm mb-md">
                      <span class="material-symbols-outlined text-on-surface-variant text-lg">info</span>
                      <h4 class="text-label-caps text-on-surface-variant">详情</h4>
                    </div>
                    <dl class="flex flex-col gap-md">
                      <div>
                        <dt class="text-label-caps text-on-surface-variant">Name</dt>
                        <dd class="text-body-sm text-on-surface font-mono break-all">{{ row.name }}</dd>
                      </div>
                      <div>
                        <dt class="text-label-caps text-on-surface-variant">Value</dt>
                        <dd class="text-body-sm text-on-surface font-mono font-bold">{{ row.value.toLocaleString() }}</dd>
                      </div>
                      <div>
                        <dt class="text-label-caps text-on-surface-variant">Global Default</dt>
                        <dd>
                          <span v-if="row.globalDefault" class="px-2 py-0.5 bg-success-container/30 text-success text-label-caps rounded-full">true</span>
                          <span v-else class="px-2 py-0.5 bg-surface-container text-on-surface-variant text-label-caps rounded-full">false</span>
                        </dd>
                      </div>
                      <div>
                        <dt class="text-label-caps text-on-surface-variant">Description</dt>
                        <dd class="text-body-sm text-on-surface">{{ row.description || '—' }}</dd>
                      </div>
                    </dl>
                  </div>
                </div>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>

    <!-- 空状态 -->
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">flag</span>
      <p class="text-on-surface-variant mt-md">
        {{ searchQuery ? '未找到匹配的 PriorityClass' : '当前集群没有 PriorityClass' }}
      </p>
      <button v-if="!searchQuery" @click="showCreateModal = true" class="mt-md px-md py-sm bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">
        Create PriorityClass
      </button>
    </div>
  </section>

  <!-- 创建 Modal -->
  <Modal v-model="showCreateModal" title="Create PriorityClass" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Name *</label>
        <input
          v-model="createForm.name"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary"
          placeholder="prod-high"
        />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Value *</label>
        <input
          v-model.number="createForm.value"
          type="number"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary"
          placeholder="1000000"
        />
        <p class="text-label-caps text-on-surface-variant mt-xs">数值越大优先级越高（系统级通常为 10 位数）</p>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Description</label>
        <input
          v-model="createForm.description"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary"
          placeholder="生产环境高优先级应用"
        />
      </div>
      <label class="flex items-center gap-sm cursor-pointer">
        <input v-model="createForm.globalDefault" type="checkbox" class="w-4 h-4 accent-primary" />
        <span class="text-body-md text-on-surface">设为 Global Default（仅可有一个）</span>
      </label>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button
        @click="handleCreate"
        :disabled="!createForm.name || createForm.value === '' || createForm.value === null"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40"
      >
        Create
      </button>
    </template>
  </Modal>

  <!-- 删除确认 Modal -->
  <Modal v-model="showDeleteModal" title="Delete PriorityClass" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">
      确认删除 PriorityClass <span class="text-on-surface font-semibold font-mono">{{ deleteTarget?.name }}</span>？
    </p>
    <p class="text-body-sm text-error mt-sm">该优先级类将被移除，引用它的 Pod 将失去对应优先级。此操作不可撤销。</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
