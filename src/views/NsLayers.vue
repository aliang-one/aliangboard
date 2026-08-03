<script setup>
// Namespace 应用分层：把工作负载 / Service / Ingress 按分层体系归类展示。
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { groupByLayer, LAYER_TAXONOMY, TIER_OPTIONS, classifyResource } from '@/composables/useLayering'
import { notify } from '@/composables/useToast'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import StatusChip from '@/components/common/StatusChip.vue'
import Modal from '@/components/common/Modal.vue'

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

// 就地修改分层：chip 悬停出 layers 按钮 → 选层 → patch layer.aliangboard.io label → 即时重排
const showLayerModal = ref(false)
const layerTarget = ref(null)
const layerSaving = ref(false)
function setLayer(it) { layerTarget.value = it; showLayerModal.value = true }
function currentLayerOf(it) { return it ? classifyResource(it) : '' }
function layerLabel(key) { return TIER_OPTIONS.find(o => o.value === key)?.label || key }
async function applyLayer(key) {
  const it = layerTarget.value
  if (!it) return
  layerSaving.value = true
  try {
    await store.reassignLayer(it.kind, it.name, it.namespace, key)
    notify('success', `${it.name} 已移至「${layerLabel(key)}」`)
    showLayerModal.value = false
    layerTarget.value = null
  } catch (e) {
    notify('error', e.message || '修改分层失败')
  } finally {
    layerSaving.value = false
  }
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
        <h2 class="text-headline-lg text-on-surface font-bold">应用分层</h2>
        <p class="text-on-surface-variant text-body-sm mt-xs">
          命名空间 <span class="text-primary font-medium">{{ route.params.namespace }}</span> 的应用按分层体系归类，共
          <span class="text-primary font-semibold">{{ items.length }}</span> 个资源，已识别
          <span class="text-primary font-semibold">{{ totalClassified }}</span> 个。
        </p>
      </div>
    </div>

    <!-- 归类说明 -->
    <div class="flex items-start gap-sm mb-md p-md rounded-lg bg-surface-container-low border border-outline-variant">
      <span class="material-symbols-outlined text-on-surface-variant text-base shrink-0 mt-0.5">info</span>
      <p class="text-body-xs text-on-surface-variant">
        默认按名称/镜像启发式归类；要精确控制，可给资源打 label <code class="font-mono text-code-xs bg-surface-container px-1 rounded">layer.aliangboard.io</code>
        （值如 <code class="font-mono text-code-xs bg-surface-container px-1 rounded">gateway</code>、<code class="font-mono text-code-xs bg-surface-container px-1 rounded">middleware</code>、<code class="font-mono text-code-xs bg-surface-container px-1 rounded">microservice-business</code>、<code class="font-mono text-code-xs bg-surface-container px-1 rounded">microservice-support</code>、<code class="font-mono text-code-xs bg-surface-container px-1 rounded">microservice-misc</code> 等）。
      </p>
    </div>

    <!-- 分层卡片 -->
    <div v-if="groups.length" class="flex flex-col gap-md">
      <div v-for="g in groups" :key="g.key" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
        <!-- 层头 -->
        <div class="flex items-center gap-sm px-md py-2.5 border-b border-outline-variant/50 bg-surface-container-low/50">
          <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
            <span class="material-symbols-outlined text-base">{{ g.icon }}</span>
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-sm">
              <h3 class="text-body-sm text-on-surface font-bold">{{ g.label }}</h3>
              <span class="px-2 py-0.5 rounded-full bg-primary-container/15 text-primary text-body-xs font-semibold">{{ g.count }}</span>
            </div>
            <p class="text-body-xs text-on-surface-variant truncate">{{ g.desc }}</p>
          </div>
        </div>

        <!-- 微服务层：子层 -->
        <div v-if="g.children" class="divide-y divide-outline-variant/15">
          <div v-for="sub in g.children" :key="sub.key" class="px-md py-2">
            <div class="flex items-center gap-sm mb-xs">
              <span class="material-symbols-outlined text-on-surface-variant text-base">{{ sub.icon }}</span>
              <h4 class="text-body-sm font-semibold text-on-surface">{{ sub.label }}</h4>
              <span class="text-body-xs text-on-surface-variant">{{ sub.items.length }}</span>
              <span class="text-body-xs text-on-surface-variant opacity-70">· {{ sub.desc }}</span>
            </div>
            <div class="flex flex-wrap gap-sm">
              <div v-for="it in sub.items" :key="it._kind + it.name" class="relative group/chip">
                <button @click="goTo(it)"
                  class="group flex items-center gap-sm px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary-container/10 transition-all">
                  <span class="material-symbols-outlined text-on-surface-variant text-base group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                  <span class="font-mono text-code-xs text-on-surface group-hover:text-primary truncate max-w-[220px]">{{ it.name }}</span>
                  <span class="text-body-xs text-on-surface-variant shrink-0">{{ it.kind }}</span>
                </button>
                <button @click.stop="setLayer(it)" title="修改分层"
                  class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-surface-container-lowest border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary opacity-0 group-hover/chip:opacity-100 transition-opacity flex items-center justify-center">
                  <span class="material-symbols-outlined text-xs">layers</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 普通层：资源 chips -->
        <div v-else class="p-md">
          <div class="flex flex-wrap gap-sm">
            <div v-for="it in g.items" :key="it._kind + it.name" class="relative group/chip">
              <button @click="goTo(it)"
                class="group flex items-center gap-sm px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary-container/10 transition-all">
                <span class="material-symbols-outlined text-on-surface-variant text-base group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                <span class="font-mono text-code-xs text-on-surface group-hover:text-primary truncate max-w-[220px]">{{ it.name }}</span>
                <span class="text-body-xs text-on-surface-variant shrink-0">{{ it.kind }}</span>
                <StatusChip v-if="it.status" :status="it.status" size="sm" />
              </button>
              <button @click.stop="setLayer(it)" title="修改分层"
                class="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-surface-container-lowest border border-outline-variant text-on-surface-variant hover:text-primary hover:border-primary opacity-0 group-hover/chip:opacity-100 transition-opacity flex items-center justify-center">
                <span class="material-symbols-outlined text-xs">layers</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-else class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant py-md text-center">
      <span class="material-symbols-outlined text-2xl text-surface-container-high">layers</span>
      <p class="text-on-surface-variant text-body-sm mt-xs">该命名空间下暂无可归类的工作负载 / Service / Ingress</p>
    </div>

    <!-- 体系一览（折叠式说明） -->
    <details class="mt-md rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
      <summary class="cursor-pointer px-md py-2.5 text-body-sm font-semibold text-on-surface flex items-center gap-sm">
        <span class="material-symbols-outlined text-base">layers</span> 分层体系一览（{{ LAYER_TAXONOMY.length }} 层）
      </summary>
      <div class="flex flex-wrap gap-sm p-md border-t border-outline-variant/50">
        <div v-for="n in LAYER_TAXONOMY" :key="n.key" class="flex items-center gap-xs px-sm py-xs bg-surface-container-low rounded-lg">
          <span class="material-symbols-outlined text-on-surface-variant text-sm">{{ n.icon }}</span>
          <span class="text-body-xs font-medium text-on-surface">{{ n.label }}</span>
        </div>
      </div>
    </details>

    <!-- 修改分层 Modal（写 layer.aliangboard.io label，即时重排） -->
    <Modal v-model="showLayerModal" :title="`修改分层 — ${layerTarget?.name || ''}`" width="max-w-lg">
      <p class="text-body-sm text-on-surface-variant mb-sm">
        选择该资源所属的应用分层（写入 label
        <code class="font-mono text-code-sm bg-surface-container px-1 rounded">layer.aliangboard.io</code>，保存后即时重排）。
      </p>
      <div class="flex flex-wrap gap-xs">
        <button v-for="t in TIER_OPTIONS" :key="t.value" @click="applyLayer(t.value)" :disabled="layerSaving"
          class="flex items-center gap-xs px-md py-sm rounded-lg border text-body-sm transition-colors disabled:opacity-50"
          :class="currentLayerOf(layerTarget) === t.value ? 'bg-primary text-on-primary border-primary font-semibold' : 'bg-surface-container-low text-on-surface border-outline-variant hover:border-primary'">
          <span class="material-symbols-outlined text-base">{{ t.icon }}</span>{{ t.label }}
        </button>
      </div>
    </Modal>
  </section>
</template>
