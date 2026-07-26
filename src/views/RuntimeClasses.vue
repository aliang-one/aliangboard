<script setup>
import { ref } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const store = useClusterStore()
const { applyYaml } = useResourceApply()
const expanded = ref(null)
function toggleExpand(name) { expanded.value = expanded.value === name ? null : name }
const yamlOf = (r) => store.generateYAML('runtimeclass', r)

// 创建
const showCreateModal = ref(false)
const createForm = ref({ name: '', handler: '' })
function resetCreate() {
  createForm.value = { name: '', handler: '' }
}
function handleCreate() {
  const f = createForm.value
  store.addRuntimeClass({
    name: f.name,
    handler: f.handler || 'runc',
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
    store.deleteRuntimeClass(deleteTarget.value.name)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[{ label: 'RuntimeClasses' }]" />
    <div class="flex justify-between items-end mt-sm mb-lg">
      <div>
        <h2 class="text-display-lg text-on-surface">RuntimeClasses</h2>
        <p class="text-on-surface-variant text-body-md mt-1">{{ store.runtimeClassList.length }} 个 RuntimeClass — 定义容器运行时（runc / kata / gvisor）</p>
      </div>
      <button
        @click="showCreateModal = true"
        class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary font-semibold rounded-lg shadow-sm hover:opacity-90 active:scale-95 transition-all"
      >
        <span class="material-symbols-outlined">add</span> Create RuntimeClass
      </button>
    </div>

    <div class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Name</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Handler</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant">Age</th>
            <th class="px-lg py-md text-label-caps text-on-surface-variant w-20">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/30">
          <template v-for="row in store.runtimeClassList" :key="row.name">
            <tr class="hover:bg-surface-container-low/50 transition-colors">
              <td class="px-lg py-md">
                <div class="flex items-center gap-sm">
                  <span class="material-symbols-outlined text-tertiary-container text-lg">memory</span>
                  <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
                </div>
              </td>
              <td class="px-lg py-md font-mono text-code-sm text-on-surface-variant">{{ row.handler }}</td>
              <td class="px-lg py-md text-body-sm text-on-surface-variant">{{ row.age }}</td>
              <td class="px-lg py-md" @click.stop>
                <div class="flex gap-1">
                  <button @click="toggleExpand(row.name)" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="查看 / 编辑 YAML">
                    <span class="material-symbols-outlined text-lg" :class="expanded === row.name ? 'rotate-180' : ''">expand_more</span>
                  </button>
                  <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="删除">
                    <span class="material-symbols-outlined text-lg">delete</span>
                  </button>
                </div>
              </td>
            </tr>
            <tr v-if="expanded === row.name">
              <td colspan="4" class="px-lg py-md bg-surface-container-low">
                <YamlEditor :model-value="yamlOf(row)" :readonly="false" height="300px" @save="applyYaml" />
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </section>

  <!-- 创建 Modal -->
  <Modal v-model="showCreateModal" title="Create RuntimeClass" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Name *</label>
        <input
          v-model="createForm.name"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary"
          placeholder="kata"
        />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Handler *</label>
        <input
          v-model="createForm.handler"
          class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary"
          placeholder="runc"
        />
        <p class="text-label-caps text-on-surface-variant mt-xs">引用的容器运行时，如 runc / kata-containers / gvisor</p>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button
        @click="handleCreate"
        :disabled="!createForm.name"
        class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40"
      >
        Create
      </button>
    </template>
  </Modal>

  <!-- 删除确认 Modal -->
  <Modal v-model="showDeleteModal" title="Delete RuntimeClass" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">
      确认删除 RuntimeClass <span class="text-on-surface font-semibold font-mono">{{ deleteTarget?.name }}</span>？
    </p>
    <p class="text-body-sm text-error mt-sm">该 RuntimeClass 将被移除，引用它的 Pod 将无法调度。此操作不可撤销。</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
