<script setup>
// 用户管理（admin only）：用户 CRUD + 分配集群
import { ref, onMounted } from 'vue'
import { adminApi, authApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'

const users = ref([])
const allClusters = ref([])
const loading = ref(true)
const showCreateModal = ref(false)
const showAssignModal = ref(false)
const showResetModal = ref(false)
const targetUser = ref(null)
const createForm = ref({ username: '', password: '', role: 'user', displayName: '' })
const resetForm = ref({ newPassword: '' })
const assignClusterIds = ref([])

async function load() {
  loading.value = true
  try {
    const [u, c] = await Promise.all([adminApi.users.list(), adminApi.clusters.list()])
    users.value = u.users || []
    allClusters.value = c.clusters || []
  } catch (e) { notify('error', e.message || '加载失败') }
  finally { loading.value = false }
}
onMounted(load)

async function doCreate() {
  try {
    await adminApi.users.create(createForm.value)
    notify('success', `已创建用户 ${createForm.value.username}`)
    showCreateModal.value = false
    createForm.value = { username: '', password: '', role: 'user', displayName: '' }
    load()
  } catch (e) { notify('error', e.message || '创建失败') }
}
async function doDelete(u) {
  if (!confirm(`删除用户 ${u.username}？`)) return
  try { await adminApi.users.remove(u.id); notify('success', '已删除'); load() }
  catch (e) { notify('error', e.message || '删除失败') }
}
async function toggleDisable(u) {
  try { await adminApi.users.patch(u.id, { disabled: u.disabled ? 0 : 1 }); notify('success', u.disabled ? '已启用' : '已禁用'); load() }
  catch (e) { notify('error', e.message || '操作失败') }
}
function openAssign(u) { targetUser.value = u; assignClusterIds.value = [...(u.clusterIds || [])]; showAssignModal.value = true }
async function doAssign() {
  try { await adminApi.users.assignClusters(targetUser.value.id, assignClusterIds.value); notify('success', '已更新集群分配'); showAssignModal.value = false; load() }
  catch (e) { notify('error', e.message || '分配失败') }
}
function openReset(u) { targetUser.value = u; resetForm.value = { newPassword: '' }; showResetModal.value = true }
async function doReset() {
  try { await adminApi.users.resetPassword(targetUser.value.id, resetForm.value.newPassword); notify('success', '密码已重置'); showResetModal.value = false }
  catch (e) { notify('error', e.message || '重置失败') }
}
function clusterName(id) { return allClusters.value.find(c => c.id === id)?.name || id.slice(0, 8) }
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div><h2 class="text-headline-lg font-bold text-on-surface">用户管理</h2><p class="text-body-sm text-on-surface-variant mt-xs">管理平台用户及其集群访问权限</p></div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
        <span class="material-symbols-outlined text-sm">person_add</span> 添加用户
      </button>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <div v-else class="rounded-xl border border-outline-variant overflow-hidden bg-surface-container-lowest">
      <table class="w-full text-left">
        <thead><tr class="border-b border-outline-variant bg-surface-container-low/50">
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">用户名</th>
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">角色</th>
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">显示名</th>
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">已分配集群</th>
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">状态</th>
          <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant text-right">操作</th>
        </tr></thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="u in users" :key="u.id" class="hover:bg-surface-container-low/30">
            <td class="px-md py-2 font-mono text-body-sm font-medium">{{ u.username }}</td>
            <td class="px-md py-2"><span class="px-1.5 py-0.5 rounded text-body-xs font-medium" :class="u.role === 'admin' ? 'bg-primary/10 text-primary' : 'bg-surface-container text-on-surface-variant'">{{ u.role }}</span></td>
            <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ u.displayName || '—' }}</td>
            <td class="px-md py-2 text-body-xs text-on-surface-variant">{{ (u.clusterIds || []).length }} 个：{{ (u.clusterIds || []).map(clusterName).join(', ') || '无' }}</td>
            <td class="px-md py-2"><span :class="u.disabled ? 'text-error' : 'text-status-running'" class="text-body-xs font-medium">{{ u.disabled ? '禁用' : '正常' }}</span></td>
            <td class="px-md py-2">
              <div class="flex items-center justify-end gap-xs">
                <button @click="openAssign(u)" class="p-1 rounded hover:bg-primary/10 text-on-surface-variant hover:text-primary" title="分配集群"><span class="material-symbols-outlined text-base">share</span></button>
                <button @click="openReset(u)" class="p-1 rounded hover:bg-tertiary-container/10 text-on-surface-variant hover:text-tertiary-container" title="重置密码"><span class="material-symbols-outlined text-base">key</span></button>
                <button @click="toggleDisable(u)" class="p-1 rounded hover:bg-surface-container text-on-surface-variant" :title="u.disabled ? '启用' : '禁用'"><span class="material-symbols-outlined text-base">{{ u.disabled ? 'check_circle' : 'block' }}</span></button>
                <button @click="doDelete(u)" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error" title="删除"><span class="material-symbols-outlined text-base">delete</span></button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 创建用户 Modal -->
    <Modal v-model="showCreateModal" title="添加用户" width="max-w-md">
      <div class="flex flex-col gap-md">
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">用户名</label><input v-model="createForm.username" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">密码</label><input v-model="createForm.password" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">显示名（可选）</label><input v-model="createForm.displayName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm" /></div>
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">角色</label>
          <div class="flex gap-xs">
            <button @click="createForm.role = 'user'" class="px-md py-sm rounded-lg border text-body-sm" :class="createForm.role === 'user' ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'">普通用户</button>
            <button @click="createForm.role = 'admin'" class="px-md py-sm rounded-lg border text-body-sm" :class="createForm.role === 'admin' ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant'">管理员</button>
          </div>
        </div>
      </div>
      <template #actions>
        <button @click="showCreateModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
        <button @click="doCreate" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">创建</button>
      </template>
    </Modal>

    <!-- 分配集群 Modal -->
    <Modal v-model="showAssignModal" :title="`分配集群 — ${targetUser?.username || ''}`" width="max-w-lg">
      <div class="flex flex-col gap-xs">
        <label v-for="c in allClusters" :key="c.id" class="flex items-center gap-sm px-md py-sm rounded-lg border border-outline-variant hover:bg-surface-container-low cursor-pointer">
          <input type="checkbox" :value="c.id" v-model="assignClusterIds" class="h-4 w-4 accent-primary" />
          <span class="font-mono text-body-sm">{{ c.name }}</span>
          <span class="text-body-xs text-on-surface-variant ml-auto">{{ c.version }}</span>
        </label>
        <p v-if="!allClusters.length" class="text-body-sm text-on-surface-variant text-center py-sm">暂无可分配的集群（请先在「集群管理」中添加）</p>
      </div>
      <template #actions>
        <button @click="showAssignModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
        <button @click="doAssign" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">保存分配</button>
      </template>
    </Modal>

    <!-- 重置密码 Modal -->
    <Modal v-model="showResetModal" :title="`重置密码 — ${targetUser?.username || ''}`" width="max-w-sm">
      <input v-model="resetForm.newPassword" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm" placeholder="新密码" />
      <template #actions>
        <button @click="showResetModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
        <button @click="doReset" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">重置</button>
      </template>
    </Modal>
  </section>
</template>
