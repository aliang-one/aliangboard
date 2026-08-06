<script setup>
// 集群管理（admin only）：集群 CRUD（支持 token / 账密 / kubeconfig 三种凭据）
import { ref, onMounted } from 'vue'
import { adminApi } from '@/api/client'
import { notify } from '@/composables/useToast'
import Modal from '@/components/common/Modal.vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'

const router = useRouter()
const store = useClusterStore()
// 点击集群卡片：切换到该集群并进入集群管理界面（/cluster）
async function openCluster(c) {
  if (c.apiServer && c.apiServer !== store.cluster?.apiServer) await store.switchCluster(c.apiServer)
  router.push('/cluster')
}

const clusters = ref([])
const loading = ref(true)
const showAddModal = ref(false)
const addForm = ref({ name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false })

async function load() {
  loading.value = true
  try { const res = await adminApi.clusters.list(); clusters.value = res.clusters || [] }
  catch (e) { notify('error', e.message || '加载失败') }
  finally { loading.value = false }
}
onMounted(load)

async function doAdd() {
  try {
    await adminApi.clusters.create(addForm.value)
    notify('success', `已添加集群 ${addForm.value.name}`)
    showAddModal.value = false
    addForm.value = { name: '', authMethod: 'kubeconfig', apiServer: '', token: '', username: '', password: '', kubeconfig: '', insecure: false }
    load()
  } catch (e) { notify('error', e.message || '添加失败（凭据无效或无法连接）') }
}
async function doRemove(c) {
  if (!confirm(`删除集群 ${c.name}？所有分配给该集群的用户将失去访问。`)) return
  try { await adminApi.clusters.remove(c.id); notify('success', '已删除'); load() }
  catch (e) { notify('error', e.message || '删除失败') }
}
</script>

<template>
  <section class="animate-fade-in p-md">
    <div class="flex items-center justify-between mb-md">
      <div><h2 class="text-headline-lg font-bold text-on-surface">集群管理</h2><p class="text-body-sm text-on-surface-variant mt-xs">添加/删除集群连接（凭据安全存储在服务端）</p></div>
      <button @click="showAddModal = true" class="flex items-center gap-sm px-md py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
        <span class="material-symbols-outlined text-sm">add</span> 添加集群
      </button>
    </div>

    <div v-if="loading" class="py-xl text-center text-on-surface-variant"><span class="material-symbols-outlined animate-spin inline-block text-2xl">progress_activity</span></div>

    <div v-else-if="clusters.length" class="grid grid-cols-1 md:grid-cols-2 gap-md">
      <div v-for="c in clusters" :key="c.id" @click="openCluster(c)" class="rounded-xl border border-outline-variant bg-surface-container-lowest p-md flex items-center gap-md cursor-pointer hover:border-primary/40 transition-colors">
        <div class="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary text-2xl">dns</span></div>
        <div class="min-w-0 flex-1">
          <p class="text-body-md font-semibold text-on-surface truncate">{{ c.name }}</p>
          <p class="font-mono text-xs text-on-surface-variant truncate">{{ c.apiServer }}</p>
          <div class="flex items-center gap-xs mt-xs">
            <span class="px-1.5 py-0.5 rounded bg-surface-container text-body-xs text-on-surface-variant">{{ c.authMethod }}</span>
            <span class="text-body-xs text-status-running flex items-center gap-0.5"><span class="w-1.5 h-1.5 rounded-full bg-status-running"></span>{{ c.version || '未知' }}</span>
            <span class="text-body-xs text-on-surface-variant/50">by {{ c.createdBy }}</span>
          </div>
        </div>
        <button @click.stop="doRemove(c)" class="p-1 rounded hover:bg-error/10 text-on-surface-variant hover:text-error shrink-0" title="删除"><span class="material-symbols-outlined text-base">delete</span></button>
      </div>
    </div>
    <div v-else class="rounded-xl border border-dashed border-outline-variant/50 py-xl text-center">
      <span class="material-symbols-outlined text-3xl text-surface-container-high">cloud_off</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">暂无集群，点击「添加集群」配置</p>
    </div>

    <!-- 添加集群 Modal -->
    <Modal v-model="showAddModal" title="添加集群" width="max-w-xl">
      <div class="flex flex-col gap-md">
        <div><label class="text-body-xs text-on-surface-variant block mb-xs">集群名称</label><input v-model="addForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="prod-cluster" /></div>
        <!-- 凭据方式切换 -->
        <div class="flex gap-xs">
          <button v-for="m in [{k:'kubeconfig',l:'Kubeconfig'},{k:'token',l:'Token'},{k:'basic',l:'账密'}]" :key="m.k" @click="addForm.authMethod = m.k"
            class="px-sm py-xs rounded-lg border text-body-sm" :class="addForm.authMethod === m.k ? 'bg-primary text-on-primary border-primary font-semibold' : 'border-outline-variant text-on-surface-variant'">{{ m.l }}</button>
        </div>
        <!-- Kubeconfig -->
        <div v-if="addForm.authMethod === 'kubeconfig'">
          <label class="text-body-xs text-on-surface-variant block mb-xs">粘贴 kubeconfig</label>
          <textarea v-model="addForm.kubeconfig" rows="8" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="apiVersion: v1&#10;kind: Config&#10;..."></textarea>
        </div>
        <!-- Token -->
        <div v-if="addForm.authMethod === 'token'" class="flex flex-col gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">API Server</label><input v-model="addForm.apiServer" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://10.0.0.1:6443" /></div>
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">Bearer Token</label><input v-model="addForm.token" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="eyJhb..." /></div>
        </div>
        <!-- Basic -->
        <div v-if="addForm.authMethod === 'basic'" class="flex flex-col gap-sm">
          <div><label class="text-body-xs text-on-surface-variant block mb-xs">API Server</label><input v-model="addForm.apiServer" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="https://10.0.0.1:6443" /></div>
          <div class="grid grid-cols-2 gap-sm">
            <div><label class="text-body-xs text-on-surface-variant block mb-xs">用户名</label><input v-model="addForm.username" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
            <div><label class="text-body-xs text-on-surface-variant block mb-xs">密码</label><input v-model="addForm.password" type="password" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
          </div>
        </div>
        <label class="flex items-center gap-sm text-body-sm cursor-pointer"><input type="checkbox" v-model="addForm.insecure" class="h-4 w-4 accent-primary" /> 跳过 TLS 证书验证（自签集群）</label>
      </div>
      <template #actions>
        <button @click="showAddModal = false" class="px-md py-sm border border-outline-variant rounded-lg">取消</button>
        <button @click="doAdd" class="px-md py-sm bg-primary text-on-primary rounded-lg font-semibold">添加并验证</button>
      </template>
    </Modal>
  </section>
</template>
