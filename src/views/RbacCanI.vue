<script setup>
import { ref, computed } from 'vue'
import { useClusterStore } from '@/stores/cluster'
import { notify } from '@/composables/useToast'
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

// 本地 RBAC 规则推演（任意 subject）
function runCheck() {
  result.value = store.checkAccess({
    subjectKind: subjectKind.value,
    subjectName: subjectName.value,
    verb: verb.value,
    resource: resource.value,
    namespace: namespace.value || undefined,
  })
}

// 服务端真值：SelfSubjectAccessReview（仅对当前登录用户）
const serverResult = ref(null)
const serverChecking = ref(false)
async function runServerCheck() {
  serverChecking.value = true
  serverResult.value = await store.checkAccessServer({
    verb: verb.value,
    resource: resource.value,
    namespace: namespace.value || '',
  })
  serverChecking.value = false
  if (!serverResult.value.ok) notify('error', serverResult.value.error)
}
</script>

<template>
  <div class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: 'RBAC', route: '/rbac' },
      { label: '权限模拟 (can-i)' }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-md">
      <div class="flex items-center gap-md">
        <div class="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center shrink-0">
          <span class="material-symbols-outlined text-primary text-2xl">verified_user</span>
        </div>
        <div>
          <h1 class="text-headline-md text-on-surface font-bold">权限模拟</h1>
          <p class="text-xs text-on-surface-variant mt-xs">kubectl auth can-i — 基于 RBAC 规则推演某 subject 能否执行指定操作</p>
        </div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-md">
      <!-- 表单 -->
      <div class="lg:col-span-7">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">checklist</span>
            <span class="text-body-sm font-semibold">检查条件</span>
          </div>
          <div class="p-md">
          <div class="grid grid-cols-2 gap-sm">
            <div>
              <label class="text-xs text-on-surface-variant block mb-xs">Subject Kind</label>
              <select v-model="subjectKind" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary">
                <option>User</option><option>Group</option><option>ServiceAccount</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-on-surface-variant block mb-xs">Subject Name</label>
              <input v-model="subjectName" list="cani-subjects" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="admin@kubezen.io" />
              <datalist id="cani-subjects">
                <option v-for="s in knownSubjects" :key="s" :value="s" />
              </datalist>
            </div>
            <div>
              <label class="text-xs text-on-surface-variant block mb-xs">Verb</label>
              <select v-model="verb" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm focus:ring-2 focus:ring-primary">
                <option v-for="v in verbs" :key="v" :value="v">{{ v }}</option>
              </select>
            </div>
            <div>
              <label class="text-xs text-on-surface-variant block mb-xs">Resource</label>
              <select v-model="resource" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary">
                <option v-for="r in resources" :key="r" :value="r">{{ r }}</option>
              </select>
            </div>
            <div class="col-span-2">
              <label class="text-xs text-on-surface-variant block mb-xs">Namespace（可选，留空表示任意/集群级）</label>
              <input v-model="namespace" list="cani-ns" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" placeholder="production-apps" />
              <datalist id="cani-ns">
                <option v-for="n in store.namespaceList" :key="n.name" :value="n.name" />
              </datalist>
            </div>
          </div>
          <div class="mt-md flex items-center gap-sm flex-wrap">
            <button @click="runCheck" class="flex items-center gap-sm px-3 py-1.5 bg-primary text-on-primary text-body-sm rounded-lg font-semibold hover:opacity-90">
              <span class="material-symbols-outlined text-sm">play_arrow</span> 规则推演
            </button>
            <button @click="runServerCheck" :disabled="serverChecking" class="flex items-center gap-sm px-3 py-1.5 border border-outline-variant text-on-surface text-body-sm rounded-lg font-semibold hover:bg-surface-container-high disabled:opacity-50">
              <span class="material-symbols-outlined text-sm" :class="serverChecking ? 'animate-spin' : ''">verified</span> 服务端 can-i
            </button>
          </div>
          <p class="text-xs text-on-surface-variant mt-xs">「规则推演」为本地 RBAC 推算（可填任意 subject）；「服务端 can-i」走 SelfSubjectAccessReview，仅返回当前登录用户的服务端真值。</p>
          </div>
        </div>
      </div>

      <!-- 结果 -->
      <div class="lg:col-span-5">
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant sticky top-md">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-lg">gavel</span>
            <span class="text-body-sm font-semibold">结果（规则推演）</span>
          </div>
          <div class="p-md">
          <div v-if="!result" class="py-md text-center text-on-surface-variant">
            <span class="material-symbols-outlined text-2xl">help_outline</span>
            <p class="mt-xs text-xs">填写条件后点击「规则推演」</p>
          </div>
          <div v-else>
            <div class="flex items-center gap-sm p-md rounded-lg mb-sm"
              :class="result.allowed ? 'bg-primary-container/10 text-primary' : 'bg-error-container/10 text-error'">
              <span class="material-symbols-outlined text-2xl">{{ result.allowed ? 'check_circle' : 'cancel' }}</span>
              <div>
                <p class="text-body-sm font-bold">{{ result.allowed ? '允许 (yes)' : '拒绝 (no)' }}</p>
                <p class="text-xs font-mono">{{ subjectKind }} <span class="text-on-surface">{{ subjectName || '*' }}</span> 对 <span class="text-on-surface font-mono">{{ resource }}</span> 执行 <span class="text-on-surface font-mono">{{ verb }}</span></p>
              </div>
            </div>
            <div v-if="result.matchedBy" class="text-body-sm">
              <p class="text-xs text-on-surface-variant mb-xs">命中规则</p>
              <p class="font-mono text-xs text-on-surface bg-surface-container-low p-sm rounded-lg break-all">{{ result.matchedBy }}</p>
              <div v-if="result.rule" class="mt-sm">
                <p class="text-xs text-on-surface-variant mb-xs">Rule</p>
                <pre class="font-mono text-xs text-on-surface-variant bg-surface-container-low p-sm rounded-lg overflow-auto">{{ JSON.stringify(result.rule, null, 2) }}</pre>
              </div>
            </div>
            <div v-else class="text-xs text-on-surface-variant">
              <p>未匹配到任何授予该操作的 Role/ClusterRole。</p>
              <p class="mt-xs">提示：尝试 <span class="font-mono">admin@kubezen.io</span>（绑定 admin 集群角色，通配权限）或 <span class="font-mono">developers</span> 组。</p>
            </div>
          </div>
          </div>
        </div>

        <!-- 服务端真值（SelfSubjectAccessReview，仅当前登录用户） -->
        <div class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant mt-md">
          <div class="px-md py-2.5 border-b border-outline-variant/50 flex items-center justify-between">
            <div class="flex items-center gap-sm">
              <span class="material-symbols-outlined text-primary text-lg">dns</span>
              <span class="text-body-sm font-semibold">服务端真值（当前用户）</span>
            </div>
            <span class="text-xs text-on-surface-variant">SelfSubjectAccessReview</span>
          </div>
          <div class="p-md">
          <div v-if="!serverResult" class="py-sm text-center text-on-surface-variant text-xs">
            点击「服务端 can-i」查询当前登录用户的服务端判定（kubectl auth can-i 的服务端语义）。
          </div>
          <div v-else-if="!serverResult.ok" class="text-xs text-error">{{ serverResult.error }}</div>
          <div v-else>
            <div class="flex items-center gap-sm p-sm rounded-lg mb-sm"
              :class="serverResult.allowed ? 'bg-primary-container/10 text-primary' : 'bg-error-container/10 text-error'">
              <span class="material-symbols-outlined text-2xl">{{ serverResult.allowed ? 'check_circle' : 'cancel' }}</span>
              <div>
                <p class="text-body-sm font-bold">{{ serverResult.allowed ? '允许 (yes)' : '拒绝 (no)' }}</p>
                <p class="text-xs font-mono">当前用户 对 <span class="text-on-surface font-mono">{{ resource }}</span> 执行 <span class="text-on-surface font-mono">{{ verb }}</span></p>
              </div>
            </div>
            <p v-if="serverResult.reason" class="text-xs text-on-surface-variant">原因：<span class="font-mono text-xs">{{ serverResult.reason }}</span></p>
            <p v-if="serverResult.evaluationError" class="text-xs text-error mt-xs">评估错误：{{ serverResult.evaluationError }}</p>
          </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
