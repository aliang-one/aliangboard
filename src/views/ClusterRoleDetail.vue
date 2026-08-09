<script setup>
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { useLiveYaml } from '@/composables/useLiveYaml'
import { useResourceApply } from '@/composables/useResourceApply'
import { useResourceDetail, useResourceList } from '@/composables/useK8sQuery'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
const { applyYaml } = useResourceApply()

const cid = computed(() => (store.currentCluster || 'cluster'))
const roleDetail = useResourceDetail({
  key: ['cluster', cid.value, 'roles', route.params.name],
  fetcher: () => store.fetchClusterRole(route.params.name),
  options: { refetchInterval: 15000 },
})
const role = computed(() => roleDetail.data.value ?? store.getClusterRoleByName(route.params.name))
const clusterRoleBindingsQuery = useResourceList({
  key: ['cluster', cid.value, 'clusterrolebindings'],
  fetcher: () => store.fetchClusterRoleBindings(),
  options: { refetchInterval: 30000 },
})
const { yaml } = useLiveYaml({
  pathFn: () => `/apis/rbac.authorization.k8s.io/v1/clusterroles/${encodeURIComponent(route.params.name)}`,
})
const activeTab = ref('overview')
const bindings = computed(() => (clusterRoleBindingsQuery.data.value || []).filter(b => b.roleName === role.value?.name))
</script>

<template>
  <section class="animate-fade-in" v-if="role">
    <Breadcrumbs :items="[
      { label: 'RBAC', route: '/rbac' },
      { label: 'ClusterRoles' },
      { label: role.name }
    ]" />

    <div class="flex items-center justify-between mt-sm mb-xl">
      <div class="flex items-center gap-lg">
        <div class="w-14 h-14 rounded-xl bg-secondary-container/20 flex items-center justify-center">
          <span class="material-symbols-outlined text-secondary text-3xl">admin_panel_settings</span>
        </div>
        <div>
          <h1 class="text-display-lg text-on-surface">{{ role.name }}</h1>
          <div class="flex items-center gap-md mt-xs">
            <span class="px-2.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded-full font-medium">CLUSTER-WIDE</span>
            <span class="text-body-sm text-on-surface-variant">{{ role.rules?.length || 0 }} rules · {{ bindings.length }} bindings</span>
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
          <h3 class="text-headline-sm mb-lg">Policy Rules</h3>
          <div v-if="role.rules?.length" class="flex flex-col gap-sm">
            <div v-for="(r, i) in role.rules" :key="i" class="p-md bg-surface-container-low rounded-lg">
              <div class="flex flex-wrap gap-xs mb-xs">
                <span v-for="g in r.apiGroups" :key="g" class="px-1.5 py-0.5 bg-primary-container/20 text-primary text-label-caps rounded font-mono">{{ g }}</span>
              </div>
              <div class="flex flex-wrap gap-xs mb-xs">
                <span v-for="res in r.resources" :key="res" class="px-1.5 py-0.5 bg-surface-container text-on-surface-variant text-label-caps rounded border border-outline-variant font-mono">{{ res }}</span>
              </div>
              <div class="flex flex-wrap gap-xs">
                <span v-for="v in r.verbs" :key="v" class="px-1.5 py-0.5 bg-secondary-container/20 text-secondary text-label-caps rounded font-mono">{{ v }}</span>
              </div>
            </div>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant py-md text-center">No rules</p>
        </div>
      </div>
      <div class="lg:col-span-4">
        <div class="bg-surface-container-lowest border border-outline-variant rounded-xl p-lg shadow-card">
          <h3 class="text-headline-sm mb-md">Bindings ({{ bindings.length }})</h3>
          <div v-if="bindings.length" class="flex flex-col gap-sm">
            <button v-for="b in bindings" :key="b.name" @click="router.push({ name: 'ClusterRoleBindingDetail', params: { name: b.name } })"
              class="flex items-center justify-between px-md py-sm bg-surface-container-low rounded-lg hover:bg-primary-container/10 transition-colors">
              <span class="font-mono text-code-sm text-primary">{{ b.name }}</span>
              <span class="text-body-sm text-on-surface-variant">{{ b.subjects?.length || 0 }} subjects</span>
            </button>
          </div>
          <p v-else class="text-body-sm text-on-surface-variant py-md text-center">No bindings</p>
        </div>
      </div>
    </div>

    <div v-if="activeTab === 'yaml'">
      <YamlEditor :model-value="yaml" :readonly="false" height="500px" @save="applyYaml" />
    </div>
  </section>
  <section v-else class="animate-fade-in text-center py-xxl">
    <span class="material-symbols-outlined text-5xl text-surface-container-high">search_off</span>
    <h2 class="text-headline-md text-on-surface mt-md">ClusterRole Not Found</h2>
    <button @click="router.push('/rbac')" class="mt-lg px-lg py-sm bg-primary text-on-primary rounded-lg font-semibold">Back to RBAC</button>
  </section>
</template>
