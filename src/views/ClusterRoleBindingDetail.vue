<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()

// 主资源 clusterrolebinding + 关联 role 查找走 Vue Query（15s/30s 轮询）；store CRUD 已接 invalidateResource，编辑后自动刷新。
const cid = computed(() => (store.currentCluster || 'cluster'))
const crbDetail = useResourceDetail({
  key: ['cluster', cid.value, 'clusterrolebindings', route.params.name],
  fetcher: () => store.fetchClusterRoleBinding(route.params.name),
  options: { refetchInterval: 15000 },
})
const crb = computed(() => crbDetail.data.value)
const rolesQuery = useResourceList({
  key: ['cluster', cid.value, 'roles'],
  fetcher: () => store.fetchRoles(),
  options: { refetchInterval: 30000 },
})
const role = computed(() => {
  if (!crb.value?.roleName) return null
  return (rolesQuery.data.value || []).find(r => r.name === crb.value.roleName && r.scope === 'Cluster') || null
})
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/rbac.authorization.k8s.io/v1/clusterrolebindings/${encodeURIComponent(route.params.name)}`,
})
const activeTab = ref('overview')
</script>

<template>
  <section class="animate-fade-in" v-if="crb">
    <Breadcrumbs :items="[
      { label: 'RBAC', route: '/rbac' },
      { label: 'ClusterRoleBindings' },
      { label: crb.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-tertiary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-tertiary-container text-3xl">share</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ crb.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded-full font-medium">CLUSTER-WIDE</span>
            <span class="text-body-sm text-on-surface-variant">{{ crb.subjects?.length || 0 }} subjects</span>
            <span class="text-body-sm text-on-surface-variant">Age: {{ crb.age }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="flex border-b border-outline-variant mb-lg">
      <button v-for="tab in ['overview', 'yaml']" :key="tab" @click="activeTab = tab"
        class="px-xl py-3 border-b-2 text-body-md font-medium capitalize transition-colors"
        :class="activeTab === tab ? 'border-primary text-primary font-bold' : 'border-transparent text-on-surface-variant hover:bg-surface-container'">
        {{ tab }}
      </button>
    </div>

    <div v-if="activeTab === 'overview'" class="grid grid-cols-1 lg:grid-cols-12 gap-lg">
      <div class="lg:col-span-8">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-lg">Subjects</h3>
          <div v-if="crb.subjects?.length" class="flex flex-col gap-sm">
            <div v-for="(s, i) in crb.subjects" :key="i" class="flex items-center gap-md p-md bg-surface-container-low rounded-lg">
              <span class="material-symbols-outlined text-tertiary-container">{{ s.kind === 'ServiceAccount' ? 'person' : (s.kind === 'Group' ? 'group' : 'person') }}</span>
              <span class="px-2 py-0.5 bg-surface-container text-on-surface-variant text-label-caps rounded border border-outline-variant">{{ s.kind }}</span>
              <span class="font-mono text-code-sm text-on-surface font-semibold">{{ s.name }}</span>
              <span v-if="s.namespace" class="text-body-sm text-on-surface-variant ml-auto">{{ s.namespace }}</span>
            </div>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant py-md text-center">No subjects</p>
        </div>
      </div>
      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Role Reference</h3>
          <div class="space-y-md">
            <div class="flex justify-between items-center py-sm border-b border-outline-variant/30">
              <span class="text-body-sm text-on-surface-variant">Kind</span>
              <span class="text-body-md text-on-surface">{{ crb.roleKind }}</span>
            </div>
            <div class="flex justify-between items-center py-sm">
              <span class="text-body-sm text-on-surface-variant">Role</span>
              <button v-if="role" class="text-body-md text-primary font-semibold hover:underline" @click="router.push({ name: 'ClusterRoleDetail', params: { name: crb.roleName } })">{{ crb.roleName }}</button>
              <span v-else class="font-mono text-code-sm text-on-surface">{{ crb.roleName }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </section>
  <section v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">ClusterRoleBinding Not Found</h2>
    <button @click="router.push('/rbac')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to RBAC</button>
  </section>
</template>
