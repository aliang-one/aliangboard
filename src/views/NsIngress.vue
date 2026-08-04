<script setup>
import { ref, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import Modal from '@/components/common/Modal.vue'
import Pagination from '@/components/common/Pagination.vue'
import { usePagination } from '@/composables/usePagination'
import { INGRESS_CLASSES, PERF_GROUPS, buildIngressAnnotations } from '@/composables/useIngressPerf'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

// 搜索过滤
const searchQuery = ref('')
const filtered = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return store.nsIngress
  return store.nsIngress.filter(i => i.name.toLowerCase().includes(q) || (i.hosts || '').toLowerCase().includes(q))
})

const { currentPage, pageSize, paginated, total } = usePagination(filtered, { resetDeps: [searchQuery] })

// Create Ingress Dialog
const showCreateModal = ref(false)
const createTab = ref('basic')   // basic | perf | extra
const createForm = ref({
  name: '', host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80',
  enableTLS: true, tlsSecret: '', className: 'nginx',
})
// 性能调优参数（→ nginx.ingress.kubernetes.io/<key> 注解，空值不写入）
const adv = ref({})
// 自定义 annotations（键值对，兼容任意控制器）
const customAnnotations = ref([])


function resetCreate() {
  createForm.value = { name: '', host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80', enableTLS: true, tlsSecret: '', className: 'nginx' }
  adv.value = {}
  customAnnotations.value = []
  createTab.value = 'basic'
}
function addCustomAnnotation() { customAnnotations.value.push({ key: '', value: '' }) }
function removeCustomAnnotation(i) { customAnnotations.value.splice(i, 1) }


async function handleCreate() {
  const f = createForm.value
  const r = await store.addIngress({
    name: f.name,
    namespace: route.params.namespace,
    hosts: f.host,
    path: f.path,
    backend: f.serviceName + ':' + f.servicePort,
    tls: f.enableTLS,
    tlsSecret: f.enableTLS ? (f.tlsSecret || f.name + '-tls') : '',
    age: 'Just now',
    className: f.className,
    annotations: buildIngressAnnotations(adv.value, customAnnotations.value),
    rules: [{
      host: f.host,
      http: {
        paths: [{
          path: f.path,
          pathType: f.pathType,
          backend: { serviceName: f.serviceName, servicePort: parseInt(f.servicePort) }
        }]
      }
    }],
  })
  if (r && r.ok === false) return   // 远端创建失败：保留弹窗（错误已由 store notify）
  showCreateModal.value = false
  resetCreate()
}

// Delete
const showDeleteModal = ref(false)
const deleteTarget = ref(null)
function confirmDelete(ing) {
  deleteTarget.value = ing
  showDeleteModal.value = true
}
function handleDelete() {
  if (deleteTarget.value) {
    store.deleteIngress(deleteTarget.value.name, route.params.namespace)
  }
  showDeleteModal.value = false
  deleteTarget.value = null
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: 'Ingress' }
    ]" />
    <div class="flex justify-between items-end mt-sm mb-md">
      <div>
        <h2 class="text-headline-md font-bold text-on-surface">Ingress</h2>
        <p class="text-body-sm text-on-surface-variant mt-1">{{ store.nsIngress.length }} ingress rules in <span class="text-primary font-medium">{{ route.params.namespace }}</span></p>
      </div>
      <button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">
        <span class="material-symbols-outlined">add</span> New Ingress
      </button>
    </div>

    <!-- 搜索框 -->
    <div class="flex items-center gap-md mb-md">
      <div class="relative flex-1 max-w-md">
        <span class="material-symbols-outlined absolute left-md top-1/2 -translate-y-1/2 text-on-surface-variant text-lg pointer-events-none">search</span>
        <input v-model="searchQuery" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg pl-xl pr-md py-sm text-body-md focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all" placeholder="按名称或域名搜索..." />
        <button v-if="searchQuery" @click="searchQuery = ''" class="absolute right-md top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface"><span class="material-symbols-outlined text-lg">close</span></button>
      </div>
      <span class="text-body-sm text-on-surface-variant">{{ filtered.length }} / {{ store.nsIngress.length }}</span>
    </div>

    <div v-if="filtered.length" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <table class="w-full text-left border-collapse">
        <thead>
          <tr class="bg-surface-container-low border-b border-outline-variant">
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Name</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Hosts</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Path</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Backend</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">TLS</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant">Age</th>
            <th class="px-md py-2 text-xs font-medium text-on-surface-variant w-24">Actions</th>
          </tr>
        </thead>
        <tbody class="divide-y divide-outline-variant/15">
          <tr v-for="row in paginated" :key="row.name" class="hover:bg-surface-container-low/40 cursor-pointer transition-colors" @click="router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: row.name } })">
            <td class="px-md py-2">
              <div class="flex items-center gap-sm">
                <span class="material-symbols-outlined text-primary text-lg">language</span>
                <span class="font-semibold text-on-surface text-body-md">{{ row.name }}</span>
              </div>
            </td>
            <td class="px-md py-2"><span class="font-mono text-code-sm text-primary font-semibold">{{ row.hosts }}</span></td>
            <td class="px-md py-2"><span class="font-mono text-code-sm">{{ row.path }}</span></td>
            <td class="px-md py-2"><span class="font-mono text-code-sm text-on-surface-variant">{{ row.backend }}</span></td>
            <td class="px-md py-2">
              <div class="flex items-center gap-xs">
                <span class="material-symbols-outlined text-lg" :class="row.tls ? 'text-primary' : 'text-on-surface-variant'">{{ row.tls ? 'lock' : 'lock_open' }}</span>
                <span class="text-body-sm" :class="row.tls ? 'text-primary' : 'text-on-surface-variant'">{{ row.tls ? 'Enabled' : 'None' }}</span>
              </div>
            </td>
            <td class="px-md py-2 text-body-sm text-on-surface-variant">{{ row.age }}</td>
            <td class="px-md py-2" @click.stop>
              <div class="flex gap-1">
                <button @click="router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: row.name } })" class="p-xs text-on-surface-variant hover:text-primary hover:bg-primary-container/10 rounded-lg" title="View Details">
                  <span class="material-symbols-outlined text-lg">open_in_new</span>
                </button>
                <button @click="confirmDelete(row)" class="p-xs text-on-surface-variant hover:text-error hover:bg-error-container/20 rounded-lg" title="Delete">
                  <span class="material-symbols-outlined text-lg">delete</span>
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="total > pageSize" class="flex items-center justify-between px-md py-md border-t border-outline-variant bg-surface-container-low">
        <Pagination :total="total" :page-size="pageSize" :current-page="currentPage" show-size-selector @page-change="(p) => currentPage = p" @size-change="(s) => { pageSize = s; currentPage = 1 }" />
      </div>
    </div>
    <div v-else class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant p-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">{{ searchQuery ? 'search_off' : 'language' }}</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">{{ searchQuery ? `没有匹配 "${searchQuery}" 的 Ingress` : 'No ingress rules in this namespace' }}</p>
      <button v-if="searchQuery" @click="searchQuery = ''" class="mt-md px-3 py-1.5 text-body-sm font-medium border border-outline-variant rounded-lg hover:bg-surface-container">清除搜索</button>
      <button v-else @click="showCreateModal = true" class="mt-md px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90">Create Ingress</button>
    </div>
  </section>

  <!-- Create Ingress Modal -->
  <Modal v-model="showCreateModal" title="Create Ingress" width="max-w-3xl">
    <!-- 标签栏 -->
    <div class="flex gap-xs border-b border-outline-variant mb-md">
      <button v-for="t in [{k:'basic',l:'基础'},{k:'perf',l:'性能调优'},{k:'extra',l:'安全与其它'}]" :key="t.k" @click="createTab = t.k"
        class="px-md py-sm text-body-sm font-medium border-b-2 -mb-px transition-colors"
        :class="createTab === t.k ? 'border-primary text-primary' : 'border-transparent text-on-surface-variant hover:text-on-surface'">
        {{ t.l }}
      </button>
    </div>

    <!-- 基础 -->
    <div v-if="createTab === 'basic'" class="flex flex-col gap-md">
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Ingress Name *</label>
          <input v-model="createForm.name" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary" placeholder="my-ingress" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Ingress Class</label>
          <select v-model="createForm.className" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option v-for="c in INGRESS_CLASSES" :key="c" :value="c">{{ c }}</option>
          </select>
        </div>
      </div>
      <div>
        <label class="text-label-caps text-on-surface-variant block mb-xs">Host *</label>
        <input v-model="createForm.host" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="app.example.com" />
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Path</label>
          <input v-model="createForm.path" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="/" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Path Type</label>
          <select v-model="createForm.pathType" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md">
            <option>Prefix</option><option>Exact</option><option>ImplementationSpecific</option>
          </select>
        </div>
      </div>
      <div class="grid grid-cols-2 gap-md">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Backend Service *</label>
          <input v-model="createForm.serviceName" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="my-service" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Service Port *</label>
          <input v-model="createForm.servicePort" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="80" />
        </div>
      </div>
      <div class="flex items-center gap-sm">
        <input v-model="createForm.enableTLS" type="checkbox" class="rounded text-primary h-4 w-4" />
        <span class="text-body-md font-medium">Enable TLS</span>
      </div>
      <div v-if="createForm.enableTLS">
        <label class="text-label-caps text-on-surface-variant block mb-xs">TLS Secret Name</label>
        <input v-model="createForm.tlsSecret" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md" placeholder="my-tls-secret (auto-generated if empty)" />
      </div>
    </div>

    <!-- 性能调优 / 安全与其它：参数分组 -->
    <div v-else class="flex flex-col gap-md max-h-[60vh] overflow-y-auto pr-sm">
      <p class="text-xs text-on-surface-variant">参数将以 <code class="font-mono bg-surface-container-low px-1 rounded">nginx.ingress.kubernetes.io/*</code> 注解写入；留空即用控制器默认值。</p>
      <div v-for="g in PERF_GROUPS.filter(x => x.tab === createTab)" :key="g.title" class="border border-outline-variant rounded-lg p-md">
        <div class="flex items-center gap-sm mb-sm">
          <span class="material-symbols-outlined text-primary text-lg">{{ g.icon }}</span>
          <h4 class="text-body-sm font-semibold text-on-surface">{{ g.title }}</h4>
        </div>
        <div class="grid grid-cols-2 gap-sm">
          <div v-for="fld in g.fields" :key="fld.key">
            <label class="text-xs text-on-surface-variant block mb-xs">{{ fld.label }}</label>
            <textarea v-if="fld.area" v-model="adv[fld.key]" rows="2" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="fld.ph"></textarea>
            <select v-else-if="fld.options" v-model="adv[fld.key]" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm">
              <option v-for="o in fld.options" :key="o" :value="o">{{ o || '默认（不设置）' }}</option>
            </select>
            <input v-else v-model="adv[fld.key]" class="w-full bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" :placeholder="fld.ph" />
          </div>
        </div>
      </div>

      <!-- 自定义注解（仅「安全与其它」标签显示）-->
      <div v-if="createTab === 'extra'" class="border border-outline-variant rounded-lg p-md">
        <div class="flex items-center justify-between mb-sm">
          <h4 class="text-body-sm font-semibold text-on-surface">自定义注解（任意 key/value）</h4>
          <button @click="addCustomAnnotation" class="flex items-center gap-xs px-sm py-xs border border-outline-variant rounded-lg text-xs hover:bg-surface-container-low"><span class="material-symbols-outlined text-sm">add</span>新增</button>
        </div>
        <div v-for="(a, i) in customAnnotations" :key="i" class="flex items-center gap-sm mb-xs">
          <input v-model="a.key" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="annotation key" />
          <input v-model="a.value" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="value" />
          <button @click="removeCustomAnnotation(i)" class="p-xs text-on-surface-variant hover:text-error"><span class="material-symbols-outlined text-base">delete</span></button>
        </div>
        <p v-if="!customAnnotations.length" class="text-xs text-on-surface-variant">暂无自定义注解</p>
      </div>
    </div>

    <template #actions>
      <button @click="showCreateModal = false; resetCreate()" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleCreate" :disabled="!createForm.name || !createForm.host || !createForm.serviceName" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40">Create</button>
    </template>
  </Modal>

  <!-- Delete Confirm Modal -->
  <Modal v-model="showDeleteModal" title="Delete Ingress" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">Are you sure you want to delete ingress <span class="text-on-surface font-semibold">{{ deleteTarget?.name }}</span>?</p>
    <p class="text-body-sm text-error mt-sm">This will remove all routing rules. This action cannot be undone.</p>
    <template #actions>
      <button @click="showDeleteModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="handleDelete" class="px-md py-sm bg-error text-on-error rounded-lg text-body-md font-semibold hover:opacity-90">Delete</button>
    </template>
  </Modal>
</template>
