<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'

const store = useClusterStore()

const subjectKind = ref('User')
const subjectName = ref('admin@kubezen.io')
const verb = ref('get')
const resource = ref('pods')
const namespace = ref('')
const result = ref(null)

const verbs = ['get', 'list', 'watch', 'create', 'update', 'patch', 'delete', 'deletecollection', 'exec', '*']
const resources = ['pods', 'pods/log', 'services', 'configmaps', 'secrets', 'deployments', 'statefulsets', 'daemonsets', 'ingresses', 'networkpolicies', 'roles', 'rolebindings', 'clusterroles', 'clusterrolebindings', 'serviceaccounts', 'persistentvolumeclaims', 'jobs', 'cronjobs', 'nodes', 'namespaces']

// 从现有绑定中提取 subject，供 datalist 自动补全
const knownSubjects = computed(() => {
  const set = new Set()
  ;[...store.roleBindingList, ...store.clusterRoleBindingList].forEach(b => {
    (b.subjects || []).forEach(s => set.add(s.name))
  })
  return Array.from(set)
})

function runCheck() {
  result.value = store.checkAccess({
    subjectKind: subjectKind.value,
    subjectName: subjectName.value,
    verb: verb.value,
    resource: resource.value,
    namespace: namespace.value || undefined,
  })
}
</script>

<template>
  <div class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'RBAC', route: '/rbac' },
      { label: '权限模拟 (can-i)' }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-primary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-primary text-3xl">verified_user</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">权限模拟</h1>
          <p class="text-body-sm text-on-surface-variant mt-xs">kubectl auth can-i — 基于 RBAC 规则推演某 subject 能否执行指定操作</p>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <!-- 表单 -->
      <div class="lg:col-span-7">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">检查条件</h3>
          <div class="grid grid-cols-2 gap-md">
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Subject Kind</label>
              <select v-model="subjectKind" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
                <option>User</option><option>Group</option><option>ServiceAccount</option>
              </select>
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Subject Name</label>
              <input v-model="subjectName" list="cani-subjects" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="admin@kubezen.io" />
              <datalist id="cani-subjects">
                <option v-for="s in knownSubjects" :key="s" :value="s" />
              </datalist>
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Verb</label>
              <select v-model="verb" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md focus:ring-2 focus:ring-primary">
                <option v-for="v in verbs" :key="v" :value="v">{{ v }}</option>
              </select>
            </div>
            <div>
              <label class="text-label-caps text-on-surface-variant block mb-xs">Resource</label>
              <select v-model="resource" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary">
                <option v-for="r in resources" :key="r" :value="r">{{ r }}</option>
              </select>
            </div>
            <div class="col-span-2">
              <label class="text-label-caps text-on-surface-variant block mb-xs">Namespace（可选，留空表示任意/集群级）</label>
              <input v-model="namespace" list="cani-ns" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-md font-mono focus:ring-2 focus:ring-primary" placeholder="production-apps" />
              <datalist id="cani-ns">
                <option v-for="n in store.namespaceList" :key="n.name" :value="n.name" />
              </datalist>
            </div>
          </div>
          <button @click="runCheck" class="mt-lg flex items-center gap-sm px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold hover:opacity-90">
            <span class="material-symbols-outlined">play_arrow</span> 检查权限
          </button>
        </div>
      </div>

      <!-- 结果 -->
      <div class="lg:col-span-5">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card sticky top-md">
          <h3 class="text-headline-sm mb-md">结果</h3>
          <div v-if="!result" class="py-xl text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-4xl">help_outline</span>
            <p class="mt-sm text-body-sm">填写条件后点击「检查权限」</p>
          </div>
          <div v-else>
            <div class="flex items-center gap-md p-lg rounded-lg mb-md"
              :class="result.allowed ? 'bg-primary-container/10 text-primary' : 'bg-error-container/10 text-error'">
              <span class="material-symbols-outlined text-4xl">{{ result.allowed ? 'check_circle' : 'cancel' }}</span>
              <div>
                <p class="text-headline-sm font-bold">{{ result.allowed ? '允许 (yes)' : '拒绝 (no)' }}</p>
                <p class="text-body-sm font-mono">{{ subjectKind }} <span class="text-on-surface">{{ subjectName || '*' }}</span> 对 <span class="text-on-surface font-mono">{{ resource }}</span> 执行 <span class="text-on-surface font-mono">{{ verb }}</span></p>
              </div>
            </div>
            <div v-if="result.matchedBy" class="text-body-sm">
              <p class="text-label-caps text-on-surface-variant mb-xs">命中规则</p>
              <p class="font-mono text-code-sm text-on-surface bg-surface-container-low p-md rounded-lg break-all">{{ result.matchedBy }}</p>
              <div v-if="result.rule" class="mt-md">
                <p class="text-label-caps text-on-surface-variant mb-xs">Rule</p>
                <pre class="font-mono text-code-sm text-on-surface-variant bg-surface-container-low p-md rounded-lg overflow-auto">{{ JSON.stringify(result.rule, null, 2) }}</pre>
              </div>
            </div>
            <div v-else class="text-body-sm text-on-surface-variant">
              <p>未匹配到任何授予该操作的 Role/ClusterRole。</p>
              <p class="mt-xs">提示：尝试 <span class="font-mono">admin@kubezen.io</span>（绑定 admin 集群角色，通配权限）或 <span class="font-mono">developers</span> 组。</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
