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

// 3 列布局：left=监控 | center=主应用流 | right=中间件
const leftGroups = computed(() => groups.value.filter(g => g.column === 'left'))
const centerGroups = computed(() => groups.value.filter(g => g.column === 'center'))
const rightGroups = computed(() => groups.value.filter(g => g.column === 'right'))

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

    <!-- 3 列分层布局：左=监控 | 中=主应用流 | 右=中间件 -->
    <div v-if="groups.length" class="grid grid-cols-1 xl:grid-cols-[220px_1fr_220px] gap-md">
      <!-- 左列：监控层 -->
      <div v-if="leftGroups.length" class="flex flex-col gap-sm">
        <div v-for="g in leftGroups" :key="g.key" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="flex items-center gap-sm px-md py-2 border-b border-outline-variant/40">
            <div class="w-7 h-7 rounded-lg bg-secondary/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-secondary text-base">{{ g.icon }}</span></div>
            <h3 class="text-body-sm text-on-surface font-bold">{{ g.label }}</h3>
            <span class="text-body-xs text-on-surface-variant ml-auto">{{ g.count }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs">
            <div v-for="it in g.items" :key="it._kind + it.name" class="relative group/chip">
              <button @click="goTo(it)" class="group w-full flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary transition-all">
                <span class="material-symbols-outlined text-on-surface-variant text-sm group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                <span class="font-mono text-xs text-on-surface group-hover:text-primary truncate text-left flex-1">{{ it.name }}</span>
              </button>
              <button @click.stop="setLayer(it)" title="修改分层" class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface-container-lowest border border-outline-variant text-on-surface-variant hover:text-primary opacity-0 group-hover/chip:opacity-100 transition-opacity flex items-center justify-center"><span class="material-symbols-outlined" style="font-size:10px">layers</span></button>
            </div>
          </div>
        </div>
      </div>
      <!-- 空左列占位 -->
      <div v-else class="hidden xl:block"></div>

      <!-- 中列：主应用流 -->
      <div class="flex flex-col gap-sm">
        <div v-for="g in centerGroups" :key="g.key" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <!-- 层头 -->
          <div class="flex items-center gap-sm px-md py-2.5 border-b border-outline-variant/40 bg-surface-container-low/40">
            <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-primary text-base">{{ g.icon }}</span></div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-xs"><h3 class="text-body-sm text-on-surface font-bold">{{ g.label }}</h3><span class="px-1.5 py-0.5 rounded bg-primary-container/15 text-primary text-body-xs font-semibold">{{ g.count }}</span></div>
              <p class="text-body-xs text-on-surface-variant truncate">{{ g.desc }}</p>
            </div>
          </div>
          <!-- 微服务子层 -->
          <div v-if="g.children" class="divide-y divide-outline-variant/10">
            <div v-for="sub in g.children" :key="sub.key" class="px-md py-2">
              <div class="flex items-center gap-xs mb-xs">
                <span class="material-symbols-outlined text-on-surface-variant text-sm">{{ sub.icon }}</span>
                <h4 class="text-body-xs font-semibold text-on-surface">{{ sub.label }}</h4>
                <span class="text-body-xs text-on-surface-variant">{{ sub.items.length }}</span>
              </div>
              <div class="flex flex-wrap gap-xs">
                <div v-for="it in sub.items" :key="it._kind + it.name" class="relative group/chip">
                  <button @click="goTo(it)" class="group flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary-container/5 transition-all">
                    <span class="material-symbols-outlined text-on-surface-variant text-sm group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                    <span class="font-mono text-xs text-on-surface group-hover:text-primary truncate max-w-[180px]">{{ it.name }}</span>
                    <span class="text-body-xs text-on-surface-variant/60 shrink-0">{{ it.kind }}</span>
                  </button>
                  <button @click.stop="setLayer(it)" title="修改分层" class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface-container-lowest border border-outline-variant text-on-surface-variant hover:text-primary opacity-0 group-hover/chip:opacity-100 transition-opacity flex items-center justify-center"><span class="material-symbols-outlined" style="font-size:10px">layers</span></button>
                </div>
              </div>
            </div>
          </div>
          <!-- 普通层 chips -->
          <div v-else class="p-md">
            <div class="flex flex-wrap gap-xs">
              <div v-for="it in g.items" :key="it._kind + it.name" class="relative group/chip">
                <button @click="goTo(it)" class="group flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary-container/5 transition-all">
                  <span class="material-symbols-outlined text-on-surface-variant text-sm group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                  <span class="font-mono text-xs text-on-surface group-hover:text-primary truncate max-w-[180px]">{{ it.name }}</span>
                  <span class="text-body-xs text-on-surface-variant/60 shrink-0">{{ it.kind }}</span>
                  <StatusChip v-if="it.status" :status="it.status" size="sm" />
                </button>
                <button @click.stop="setLayer(it)" title="修改分层" class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface-container-lowest border border-outline-variant text-on-surface-variant hover:text-primary opacity-0 group-hover/chip:opacity-100 transition-opacity flex items-center justify-center"><span class="material-symbols-outlined" style="font-size:10px">layers</span></button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 右列：中间件 -->
      <div v-if="rightGroups.length" class="flex flex-col gap-sm">
        <div v-for="g in rightGroups" :key="g.key" class="rounded-xl overflow-hidden bg-surface-container-lowest border border-outline-variant">
          <div class="flex items-center gap-sm px-md py-2 border-b border-outline-variant/40">
            <div class="w-7 h-7 rounded-lg bg-secondary/10 flex items-center justify-center shrink-0"><span class="material-symbols-outlined text-secondary text-base">{{ g.icon }}</span></div>
            <h3 class="text-body-sm text-on-surface font-bold">{{ g.label }}</h3>
            <span class="text-body-xs text-on-surface-variant ml-auto">{{ g.count }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs">
            <div v-for="it in g.items" :key="it._kind + it.name" class="relative group/chip">
              <button @click="goTo(it)" class="group w-full flex items-center gap-xs px-sm py-xs rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary transition-all">
                <span class="material-symbols-outlined text-on-surface-variant text-sm group-hover:text-primary">{{ KIND_ICON[it.kind] || 'circle' }}</span>
                <span class="font-mono text-xs text-on-surface group-hover:text-primary truncate text-left flex-1">{{ it.name }}</span>
              </button>
              <button @click.stop="setLayer(it)" title="修改分层" class="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-surface-container-lowest border border-outline-variant text-on-surface-variant hover:text-primary opacity-0 group-hover/chip:opacity-100 transition-opacity flex items-center justify-center"><span class="material-symbols-outlined" style="font-size:10px">layers</span></button>
            </div>
          </div>
        </div>
      </div>
      <!-- 空右列占位 -->
      <div v-else class="hidden xl:block"></div>
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
