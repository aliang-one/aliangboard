<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

const typeFilter = ref('All')
const search = ref('')
const typeOptions = computed(() => {
  const types = new Set(store.nsSecrets.map(s => s.type))
  return ['All', ...types]
})

const filtered = computed(() => {
  let list = store.nsSecrets
  if (typeFilter.value !== 'All') {
    list = list.filter(s => s.type === typeFilter.value)
  }
  const q = search.value.trim().toLowerCase()
  if (q) {
    list = list.filter(s => {
      if (s.name.toLowerCase().includes(q)) return true
      return Object.keys(s.data || {}).some(k => k.toLowerCase().includes(q))
    })
  }
  return list
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [typeFilter, search] })

// Create Secret
const showCreateModal = ref(false)
const createForm = ref({
  name: '', type: 'Opaque',
  keys: [{ key: '', value: '' }],
  username: '', password: '',
  registry: '', registryUser: '', registryPassword: '', registryEmail: '',
  tlsCrt: '', tlsKey: '',
  sshKey: '',
})

function resetCreate() {
  createForm.value = {
    name: '', type: 'Opaque',
    keys: [{ key: '', value: '' }],
    username: '', password: '',
    registry: '', registryUser: '', registryPassword: '', registryEmail: '',
    tlsCrt: '', tlsKey: '',
    sshKey: '',
  }
}
function addCreateKey() {
  createForm.value.keys.push({ key: '', value: '' })
}
function removeCreateKey(idx) {
  createForm.value.keys.splice(idx, 1)
}

// 按 Secret 类型校验必填字段（避免提交后被 K8s 拒绝，如 tls 缺 crt/key）
const canCreateSecret = computed(() => {
  const f = createForm.value
  if (!f.name) return false
  switch (f.type) {
    case 'kubernetes.io/basic-auth': return !!(f.username && f.password)
    case 'kubernetes.io/dockerconfigjson': return !!(f.registry && f.registryUser && f.registryPassword)
    case 'kubernetes.io/tls': return !!(f.tlsCrt && f.tlsKey)
    case 'kubernetes.io/ssh-auth': return !!f.sshKey
    default: return f.keys.some(k => k.key)   // Opaque：至少 1 个有效 key
  }
})

async function handleCreate() {
  const f = createForm.value
  let data = {}
  if (f.type === 'Opaque') {
    f.keys.forEach(k => { if (k.key) data[k.key] = k.value })
  } else if (f.type === 'kubernetes.io/basic-auth') {
    data = { username: f.username, password: f.password }
  } else if (f.type === 'kubernetes.io/dockerconfigjson') {
    let auth = ''
    try { auth = btoa(`${f.registryUser}:${f.registryPassword}`) } catch (e) { auth = `${f.registryUser}:${f.registryPassword}` }
    const cfg = { auths: { [f.registry]: { username: f.registryUser, password: f.registryPassword, email: f.registryEmail, auth } } }
    data = { '.dockerconfigjson': JSON.stringify(cfg) }
  } else if (f.type === 'kubernetes.io/tls') {
    data = { 'tls.crt': f.tlsCrt, 'tls.key': f.tlsKey }
  } else if (f.type === 'kubernetes.io/ssh-auth') {
    data = { 'ssh-privatekey': f.sshKey }
  }
  const r = await store.addSecret({
    name: f.name,
    namespace: route.params.namespace,
    type: f.type,
    keys: Object.keys(data).length,
    data,
  })
  if (r && r.ok === false) return   // 远端创建失败：保留弹窗（错误已由 store notify）
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(sec) {
  deleteTarget.value = sec
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteSecret(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}

const typeColor = (type) => {
  if (type.includes('tls')) return 'bg-primary-container/10 text-primary border-primary/20'
  if (type.includes('docker')) return 'bg-secondary-container/10 text-secondary border-secondary/20'
  if (type.includes('service-account')) return 'bg-tertiary-container/10 text-tertiary border-tertiary/20'
  return 'bg-surface-container text-on-surface-variant border-outline-variant'
}

// 批量选择
const selected = ref(new Set())
function toggleSelect(name) {
  const s = new Set(selected.value)
  if (s.has(name)) s.delete(name); else s.add(name)
  selected.value = s
}
const isAllSelected = computed(() => filtered.value.length > 0 && filtered.value.every(r => selected.value.has(r.name)))
function toggleSelectAll() {
  selected.value = isAllSelected.value ? new Set() : new Set(filtered.value.map(r => r.name))
}
const showBatchModal = ref(false)
function confirmBatchDelete() { if (selected.value.size) showBatchModal.value = true }
function handleBatchDelete() {
  selected.value.forEach(name => store.deleteSecret(name, route.params.namespace))
  selected.value = new Set()
  showBatchModal.value = false
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Secrets' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-lg text-on-surface font-bold">Secrets</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">{{ store.nsSecrets.length }} secrets in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary font-semibold rounded-lg text-body-sm hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">add</span> New Secret
      </button>
    </div>

    <!-- Type Filter + Search -->
    <div class="flex flex-wrap items-center gap-sm mb-md">
      <div class="flex flex-wrap gap-xs">
        <button v-for="opt in typeOptions" :key="opt" @click="typeFilter = opt"
          class="px-md py-xs rounded-full text-body-xs font-medium border transition-all"
          :class="typeFilter === opt ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant hover:border-primary'">
          {{ opt }}
        </button>
      </div>
      <div class="relative flex-1 min-w-[200px] max-w-md ml-auto">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="search" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-1.5 text-body-sm focus:ring-2 focus:ring-primary focus:border-primary" placeholder="按名称或数据 key 搜索..." />
        <button v-if="search" @click="search = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface">
          <span class="material-symbols-outlined text-lg">close</span>
        </button>
      </div>
      <span class="text-body-xs text-on-surface-variant">{{ filtered.length }} / {{ store.nsSecrets.length }}</span>
      <div v-if="selected.size" class="flex items-center gap-sm ml-auto px-md py-xs bg-primary-container/10 border border-primary/20 rounded-lg">
        <span class="text-body-xs font-medium text-primary">已选 {{ selected.size }} 项</span>
        <button @click="confirmBatchDelete" class="flex items-center gap-xs px-sm py-xs bg-error text-on-error rounded text-body-xs font-semibold hover:opacity-90">
          <span class="material-symbols-outlined text-sm">delete</span>批量删除
        </button>
        <button @click="selected = new Set()" class="text-body-xs text-on-surface-variant hover:text-on-surface">取消</button>
      </div>
    </div>

    <div v-if="filtered.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-2 w-10">
              <input type="checkbox" :checked="isAllSelected" @change="toggleSelectAll" class="rounded text-primary focus:ring-primary h-4 w-4" />
            </th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Name</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Type</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Keys</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Data Preview</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant">Age</th>
            <th class="px-md py-2 text-body-xs font-medium text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsSecretDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-md py-2" @click.stop>
              <input type="checkbox" :checked="selected.has(row.name)" @change="toggleSelect(row.name)" class="rounded text-primary focus:ring-primary h-4 w-4" />
            </td>
            <td class="px-md py-2">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-tertiary text-sm">key</span>
                <span class="font-semibold text-on-surface text-body-sm">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-md py-2">
              <span class="px-2 py-0.5 rounded text-body-xs border" :class="typeColor(row.type)">{{ row.type }}</span>
            </td>
            <td class="px-md py-2"><span class="inline-flex items-center justify-center w-6 h-6 rounded-full bg-surface-container text-body-xs font-bold text-on-surface-variant border border-outline-variant">{{ row.keys }}</span></td>
            <td class="px-md py-2">
              <div class="flex flex-wrap gap-xs max-w-xs">
                <span v-for="k in Object.keys(row.data || {}).slice(0, 3)" :key="k" class="px-1.5 py-0.5 bg-surface-container text-body-xs text-on-surface-variant rounded border border-outline-variant">{{ k }}</span>
                <span v-if="Object.keys(row.data || {}).length > 3" class="text-body-xs text-on-surface-variant">+{{ Object.keys(row.data).length - 3 }}</span>
              </div>
            </td>
            <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-md py-2" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsSecretDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg"><span class="material-symbols-outlined text-sm">open_in_new</span></button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg"><span class="material-symbols-outlined text-sm">delete</span></button>
              </div>
            </td>
          </tr>
          <tr v-if="!filtered.length">
            <td :colspan="7" class="px-md py-md text-center">
              <span class="material-symbols-outlined text-2xl text-surface-container-high block mb-sm">inbox</span>
              <p class="text-on-surface-variant text-body-sm">暂无数据</p>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-2 border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">{{ (search || typeFilter !== 'All') ? 'search_off' : 'key' }}</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">{{ (search || typeFilter !== 'All') ? '没有匹配的 Secret' : 'No secrets in this namespace' }}</p>
      <button v-if="search || typeFilter !== 'All'" @click="search = ''; typeFilter = 'All'" class="mt-xs px-3 py-1.5 border border-outline-variant rounded-lg text-body-sm font-medium hover:bg-surface-container-high">清除筛选</button>
      <button v-else @click="showCreateModal = true" class="mt-xs px-3 py-1.5 bg-primary text-on-primary rounded-lg text-body-sm font-semibold hover:opacity-90">Create Secret</button>
    </div>
  </section>

  <!-- Create Secret Modal -->
  <Modal v-model="showCreateModal" title="Create Secret" width="max-w-lg">
    <div class="flex flex-col gap-md">
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Secret Name *</label>
        <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-secret" />
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Type</label>
        <select v-model="createForm.type" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
          <option value="Opaque">Opaque — 通用键值</option>
          <option value="kubernetes.io/basic-auth">Basic Auth — 用户名/密码</option>
          <option value="kubernetes.io/dockerconfigjson">Docker Registry — 镜像仓库凭证</option>
          <option value="kubernetes.io/tls">TLS — 证书/私钥</option>
          <option value="kubernetes.io/ssh-auth">SSH Auth — SSH 私钥</option>
        </select>
      </div>

      <!-- Opaque：自由 key-value -->
      <div v-if="createForm.type === 'Opaque'">
        <label class="text-label-caps text-on-surface-variant block mb-sm">Data Keys</label>
        <div class="flex flex-col gap-sm">
          <div v-for="(kv, idx) in createForm.keys" :key="idx" class="flex gap-sm items-center">
            <input v-model="kv.key" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="KEY" />
            <input v-model="kv.value" type="password" class="flex-1 bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="value" />
            <button v-if="createForm.keys.length > 1" @click="removeCreateKey(idx)" class="p-xs text-on-surface-variant hover:text-error rounded-lg"><span class="material-symbols-outlined text-lg">delete</span></button>
          </div>
          <button @click="addCreateKey" class="self-start flex items-center gap-sm px-md py-xs text-primary font-medium text-body-sm hover:bg-primary-container/10 rounded-lg">
            <span class="material-symbols-outlined">add</span> Add Key
          </button>
        </div>
      </div>

      <!-- basic-auth -->
      <div v-else-if="createForm.type === 'kubernetes.io/basic-auth'" class="flex flex-col gap-sm">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">用户名 (username)</label>
          <input v-model="createForm.username" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="admin" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">密码 (password)</label>
          <input v-model="createForm.password" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="••••••" />
        </div>
        <p class="text-body-xs text-on-surface-variant flex items-center gap-xs"><span class="material-symbols-outlined text-sm">info</span>将自动生成 username / password 两个键</p>
      </div>

      <!-- dockerconfigjson -->
      <div v-else-if="createForm.type === 'kubernetes.io/dockerconfigjson'" class="flex flex-col gap-sm">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Registry 地址</label>
          <input v-model="createForm.registry" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" placeholder="registry.example.com" />
        </div>
        <div class="grid grid-cols-2 gap-sm">
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">用户名</label>
            <input v-model="createForm.registryUser" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" />
          </div>
          <div>
            <label class="text-label-caps text-on-surface-variant block mb-xs">密码</label>
            <input v-model="createForm.registryPassword" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono" />
          </div>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">邮箱（可选）</label>
          <input v-model="createForm.registryEmail" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="user@example.com" />
        </div>
        <p class="text-body-xs text-on-surface-variant flex items-center gap-xs"><span class="material-symbols-outlined text-sm">info</span>将自动生成 .dockerconfigjson（含 base64 认证）</p>
      </div>

      <!-- tls -->
      <div v-else-if="createForm.type === 'kubernetes.io/tls'" class="flex flex-col gap-sm">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">TLS 证书 (tls.crt)</label>
          <textarea v-model="createForm.tlsCrt" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono h-24 resize-y" placeholder="-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----"></textarea>
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">TLS 私钥 (tls.key)</label>
          <textarea v-model="createForm.tlsKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono h-24 resize-y" placeholder="-----BEGIN PRIVATE KEY-----&#10;...&#10;-----END PRIVATE KEY-----"></textarea>
        </div>
      </div>

      <!-- ssh-auth -->
      <div v-else-if="createForm.type === 'kubernetes.io/ssh-auth'" class="flex flex-col gap-sm">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">SSH 私钥 (ssh-privatekey)</label>
          <textarea v-model="createForm.sshKey" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono h-32 resize-y" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----"></textarea>
        </div>
      </div>
    </div>
    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!canCreateSecret" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Modal -->
  <Modal v-model="showDeleteModal" title="Delete Secret" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete secret <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">Pods using this Secret will fail. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>

  <!-- Batch Delete Modal -->
  <Modal v-model="showBatchModal" title="批量删除 Secret" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">确定要删除选中的 <span class="text-on-surface font-semibold">{{ selected.size }}</span> 个 Secret 吗？</p>
    <p class="text-body-sm text-error mt-sm">引用这些 Secret 的 Pod 将无法启动。此操作不可撤销。</p>
    <template #actions>
      <button @click="showBatchModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="handleBatchDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">全部删除</button>
    </template>
  </Modal>
</template>
