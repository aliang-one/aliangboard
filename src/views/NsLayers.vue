<script setup>
// Namespace 应用分层：把工作负载 / Service / Ingress 按分层体系归类展示。
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { groupByLayer, LAYER_TAXONOMY } from '@/composables/useLayering'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

// 聚合本命名空间下可归类的资源（带 _kind 用于跳转与默认归类）
const items = computed(() => {
  const list = []
  for (const w of store.nsWorkloads) list.push({ _kind: 'workload', kind: w.type, type: w.type, name: w.name, namespace: w.namespace, image: w.image, status: w.status, labels: w.labels, annotations: w.annotations })
  for (const s of store.nsServices) list.push({ _kind: 'service', kind: 'Service', name: s.name, namespace: s.namespace, status: s.status, labels: s.labels, annotations: s.annotations })
  for (const ing of store.nsIngress) list.push({ _kind: 'ingress', kind: 'Ingress', name: ing.name, namespace: ing.namespace, labels: ing.labels, annotations: ing.annotations })
  return list
})

const groups = computed(() => groupByLayer(items.value))
const totalClassified = computed(() => items.value.length - (groups.value.find(g => g.key === 'unclassified')?.count || 0))

const KIND_ICON = { Deployment: 'work', StatefulSet: 'work', DaemonSet: 'work', ReplicaSet: 'work', Job: 'schedule', CronJob: 'schedule', Service: 'share', Ingress: 'alt_route' }

function goTo(it) {
  if (it._kind === 'workload') router.push({ name: 'NsWorkloadDetail', params: { namespace: it.namespace, type: String(it.kind).toLowerCase(), name: it.name } })
  else if (it._kind === 'service') router.push({ name: 'NsServiceDetail', params: { namespace: it.namespace, name: it.name } })
  else if (it._kind === 'ingress') router.push({ name: 'NsIngressDetail', params: { namespace: it.namespace, name: it.name } })
}
</script>

<template>
  <section class="animate-fade-in">
    <Breadcrumbs :items="[
      { label: route.params.namespace, route: `/ns/${route.params.namespace}` },
      { label: '应用分层' }
    ]" />

    <div class="flex justify-between items-end mt-sm mb-sm">
      <div>
        <h2 class="text-display-lg text-on-surface">应用分层</h2>
        <p class="text-on-surface-variant text-body-md mt-1">
          命名空间 <span class="text-primary font-medium">{{ route.params.namespace }}</span> 的应用按分层体系归类，共
          <span class="text-primary font-semibold">{{ items.length }}</span> 个资源，已识别
          <span class="text-primary font-semibold">{{ totalClassified }}</span> 个。
        </p>
      </div>
    </div>

    <!-- 归类说明 -->
    <div class="flex items-start gap-sm mb-lg p-md rounded-lg bg-surface-container-low border border-outline-variant">
      <span class="material-symbols-outlined text-on-surface-variant text-lg shrink-0 mt-0.5">info</span>
      <p class="text-body-sm text-on-surface-variant">
        默认按名称/镜像启发式归类；要精确控制，可给资源打 label <code class="font-mono text-code-sm bg-surface-container px-1 rounded">layer.aliangboard.io</code>
        （值如 <code class="font-mono text-code-sm bg-surface-container px-1 rounded">gateway</code>、<code class="font-mono text-code-sm bg-surface-container px-1 rounded">middleware</code>、<code class="font-mono text-code-sm bg-surface-container px-1 rounded">microservice/business</code>、<code class="font-mono text-code-sm bg-surface-container px-1 rounded">microservice/support</code>、<code class="font-mono text-code-sm bg-surface-container px-1 rounded">microservice/misc</code> 等）。
      </p>
    </div>

    <!-- 分层卡片 -->
    <div v-if="groups.length" class="space-y-lg">
      <div v-for="g in groups" :key="g.key" class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card overflow-hidden">
        <!-- 层头 -->
        <div class="flex items-center gap-md px-lg py-md bg-surface-container-low border-b border-outline-variant">
          <div class="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
            <span class="material-symbols-outlined">{{ g.icon }}</span>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-sm">
              <h3 class="text-headline-sm text-on-surface font-bold">{{ g.label }}</h3>
              <span class="px-2 py-0.5 rounded-full bg-primary-container/15 text-primary text-body-xs font-semibold">{{ g.count }}</span>
            </div>
            <p class="text-body-xs text-on-surface-variant truncate">{{ g.desc }}</p>
          </div>
        </div>

        <!-- 微服务层：子层 -->
        <div v-if="g.children" class="divide-y divide-outline-variant/40">
          <div v-for="sub in g.children" :key="sub.key" class="px-lg py-md">
            <div class="flex items-center gap-sm mb-sm">
              <span class="material-symbols-outlined text-on-surface-variant text-lg">{{ sub.icon }}</span>
              <h4 class="text-body-md font-semibold text-on-surface">{{ sub.label }}</h4>
              <span class="text-body-xs text-on-surface-variant">{{ sub.items.length }}</span>
              <span class="text-body-xs text-on-surface-variant opacity-70">· {{ sub.desc }}</span>
            </div>
            <div class="flex flex-wrap gap-sm">
              <button v-for="it in sub.items" :key="it._kind + it.name" @click="goTo(it)"
                class="group flex items-center gap-sm px-md py-sm rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary-container/10 transition-all">
                <span class="material-symbols-outlined text-on-surface-variant text-lg group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                <span class="font-mono text-code-sm text-on-surface group-hover:text-primary truncate max-w-[220px]">{{ it.name }}</span>
                <span class="text-body-xs text-on-surface-variant shrink-0">{{ it.kind }}</span>
              </button>
            </div>
          </div>
        </div>

        <!-- 普通层：资源 chips -->
        <div v-else class="p-lg">
          <div class="flex flex-wrap gap-sm">
            <button v-for="it in g.items" :key="it._kind + it.name" @click="goTo(it)"
              class="group flex items-center gap-sm px-md py-sm rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary-container/10 transition-all">
              <span class="material-symbols-outlined text-on-surface-variant text-lg group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
              <span class="font-mono text-code-sm text-on-surface group-hover:text-primary truncate max-w-[220px]">{{ it.name }}</span>
              <span class="text-body-xs text-on-surface-variant shrink-0">{{ it.kind }}</span>
              <StatusChip v-if="it.status" :status="it.status" size="sm" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="bg-surface-container-lowest border border-outline-variant rounded-xl shadow-card p-xl text-center">
      <span class="material-symbols-outlined text-4xl text-surface-container-high">layers</span>
      <p class="text-on-surface-variant mt-md">该命名空间下暂无可归类的工作负载 / Service / Ingress</p>
    </div>

    <!-- 体系一览（折叠式说明） -->
    <details class="mt-lg bg-surface-container-lowest border border-outline-variant rounded-xl p-md">
      <summary class="cursor-pointer text-body-sm font-semibold text-on-surface flex items-center gap-sm">
        <span class="material-symbols-outlined text-lg">layers</span> 分层体系一览（{{ LAYER_TAXONOMY.length }} 层）
      </summary>
      <div class="flex flex-wrap gap-md mt-md">
        <div v-for="n in LAYER_TAXONOMY" :key="n.key" class="flex items-center gap-xs px-md py-sm bg-surface-container-low rounded-lg">
          <span class="material-symbols-outlined text-on-surface-variant text-base">{{ n.icon }}</span>
          <span class="text-body-sm font-medium text-on-surface">{{ n.label }}</span>
        </div>
      </div>
    </details>
  </section>
</template>
