<script setup>
// Namespace Overview：按分层体系展示 Deployment 卡片（全层展示；监控/中间件/持久层可折叠）。
// 关联 Service/Ingress 仅以标签呈现，hover 弹出富信息卡片（teleport 至 body，不被卡片裁切）。
import { computed, ref, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import Breadcrumbs from '@/components/common/Breadcrumbs.vue'
import { classifyResource, LAYER_TAXONOMY } from '@/composables/useLayering'
import { readMeta, imageTag } from '@/composables/useBusinessMeta'

const route = useRoute()
const router = useRouter()
const store = useClusterStore()
store.setNamespace(route.params.namespace)

// 仅 Deployment
const deployments = computed(() => store.nsWorkloads.filter(w => w.type === 'Deployment'))

// 监控层→左列、中间件→右列、其余→中列；监控/中间件/持久层可折叠。
// 折叠态：用户显式选择优先（持久化到 localStorage），否则空层默认折叠、有内容默认展开。
const COLLAPSIBLE = new Set(['monitoring', 'middleware', 'persistence'])
const COLLAPSE_PREF_KEY = 'aliangboard.nsOverview.layerCollapse'
function loadCollapsePrefs() { try { return JSON.parse(localStorage.getItem(COLLAPSE_PREF_KEY) || '{}') } catch { return {} } }
function saveCollapsePrefs(obj) { try { localStorage.setItem(COLLAPSE_PREF_KEY, JSON.stringify(obj)) } catch { /* 隐私模式禁用 */ } }
const collapsePref = ref(loadCollapsePrefs())
function isLayerCollapsed(section) {
  const p = collapsePref.value[section.key]
  if (p === 'collapsed') return true
  if (p === 'expanded') return false
  return (section.items || []).length === 0 // 无显式偏好：空层默认折叠
}
function toggleLayer(section) {
  const cur = isLayerCollapsed(section)
  collapsePref.value = { ...collapsePref.value, [section.key]: cur ? 'expanded' : 'collapsed' }
  saveCollapsePrefs(collapsePref.value)
}

// 按分层分组：全层展示（含空层），microservice 展开为子层；保留 taxonomy 顺序；每项预绑关联资源
function associations(dep) {
  const ns = route.params.namespace
  const labels = dep?.raw?.spec?.template?.metadata?.labels || dep?.labels || {}
  const services = (store.serviceList || []).filter(s =>
    s.namespace === ns && s.selector && Object.keys(s.selector).length &&
    Object.entries(s.selector).every(([k, v]) => labels[k] === v))
  const svcNames = new Set(services.map(s => s.name))
  const ingressRules = []
  for (const ing of (store.ingressList || [])) {
    if (ing.namespace !== ns) continue
    for (const r of (ing.rules || [])) {
      for (const p of (r.http?.paths || [])) {
        const be = p.backend?.service || p.backend
        if (!svcNames.has(be?.name)) continue
        ingressRules.push({
          ingName: ing.name, host: r.host || '*', path: p.path || '/', pathType: p.pathType || 'Prefix',
          serviceName: be?.name, servicePort: be?.port?.number || be?.port?.name || '',
          tls: ing.tls, tlsSecret: ing.tlsSecret, className: ing.className, age: ing.age,
        })
      }
    }
  }
  return { services, ingressRules }
}

const layerSections = computed(() => {
  const buckets = {}
  for (const d of deployments.value) {
    const key = classifyResource({ name: d.name, image: d.image, labels: d.labels, annotations: d.annotations, type: d.type, kind: d.type })
    ;(buckets[key] ||= []).push(d)
  }
  const sections = []
  for (const node of LAYER_TAXONOMY) {
    if (node.children) {
      for (const sub of node.children) {
        sections.push({ key: sub.key, label: sub.label, icon: sub.icon, desc: sub.desc, color: sub.color, column: node.column, collapsible: COLLAPSIBLE.has(sub.key), items: (buckets[sub.key] || []).map(d => ({ dep: d, assoc: associations(d) })) })
      }
    } else {
      sections.push({ key: node.key, label: node.label, icon: node.icon, desc: node.desc, color: node.color, column: node.column, collapsible: COLLAPSIBLE.has(node.key), items: (buckets[node.key] || []).map(d => ({ dep: d, assoc: associations(d) })) })
    }
  }
  return sections
})
const leftSections = computed(() => layerSections.value.filter(s => s.column === 'left'))
const rightSections = computed(() => layerSections.value.filter(s => s.column === 'right'))
const centerSections = computed(() => layerSections.value.filter(s => s.column === 'center'))
const monitoringSection = computed(() => layerSections.value.find(s => s.key === 'monitoring'))
const middlewareSection = computed(() => layerSections.value.find(s => s.key === 'middleware'))

const LAYER_COLOR = {
  primary: 'bg-primary/10 text-primary',
  secondary: 'bg-secondary/10 text-secondary',
  tertiary: 'bg-tertiary/10 text-tertiary',
  error: 'bg-error/10 text-error',
  surface: 'bg-surface-container text-on-surface-variant',
}

function imgBase(image) {
  if (!image) return ''
  const noDigest = image.split('@')[0]
  const i = noDigest.lastIndexOf(':')
  return i > noDigest.lastIndexOf('/') ? noDigest.slice(0, i) : noDigest
}
const metaCache = new WeakMap()
function metaOf(w) { if (!w) return {}; if (!metaCache.has(w)) metaCache.set(w, readMeta(w)); return metaCache.get(w) }
function fmtSelector(sel) { return Object.entries(sel || {}).map(([k, v]) => `${k}=${v}`).join(', ') }

const HEALTH_META = {
  healthy: { dot: 'bg-status-running', text: 'text-status-running', label: '正常', spin: false, accent: 'border-l-status-running' },
  updating: { dot: 'bg-status-succeeded', text: 'text-status-succeeded', label: '更新中', spin: true, accent: 'border-l-status-succeeded' },
  warning: { dot: 'bg-status-pending', text: 'text-status-pending', label: '部分就绪', spin: false, accent: 'border-l-status-pending' },
  failed: { dot: 'bg-status-failed', text: 'text-status-failed', label: '异常', spin: false, accent: 'border-l-status-failed' },
}
function healthOf(dep) {
  const st = dep?.raw?.status || {}
  const spec = dep?.raw?.spec || {}
  const desired = spec.replicas ?? 1
  const updated = st.updatedReplicas ?? 0
  const ready = st.readyReplicas ?? 0
  const total = st.replicas ?? ready
  const conds = st.conditions || []
  const rf = conds.find(c => c.type === 'ReplicaFailure')
  let level = 'healthy'
  if (rf?.status === 'True') level = 'failed'
  else if (desired > 0 && ready === 0 && total > 0) level = 'failed'
  else if (desired === 0) level = 'warning'
  else if (updated < desired) level = 'updating'
  else if (ready < desired) level = 'warning'
  return { desired, ready, ...HEALTH_META[level] }
}

// === hover 富信息卡片（teleport 至 body，避免被卡片 overflow 裁切）===
const hover = ref(null) // { type:'svc'|'ing', items:[], top, right }
let leaveTimer = null
function onEnterAssoc(e, type, assoc) {
  clearTimeout(leaveTimer)
  const items = type === 'svc' ? assoc.services : assoc.ingressRules
  if (!items.length) return
  const r = e.currentTarget.getBoundingClientRect()
  hover.value = { type, items, top: r.bottom + 6, right: document.documentElement.clientWidth - r.right }
}
function onLeaveAssoc() { leaveTimer = setTimeout(() => { hover.value = null }, 120) }
function onPopoverEnter() { clearTimeout(leaveTimer) }
onUnmounted(() => clearTimeout(leaveTimer))

// 导航
function goDeploy(dep) { router.push({ name: 'NsWorkloadDetail', params: { namespace: route.params.namespace, type: 'deployment', name: dep.name } }) }
function goSvc(s) { router.push({ name: 'NsServiceDetail', params: { namespace: route.params.namespace, name: s.name } }) }
function goIng(rule) { router.push({ name: 'NsIngressDetail', params: { namespace: route.params.namespace, name: rule.ingName } }) }
</script>

<template>
  <div class="animate-fade-in">
    <!-- Header -->
    <div class="flex flex-col gap-sm mb-md">
      <Breadcrumbs :items="[{ label: 'Cluster', route: '/cluster' }, { label: route.params.namespace }]" />
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-md">
          <div class="w-12 h-12 rounded-xl bg-primary-container/20 flex items-center justify-center">
            <span class="material-symbols-outlined text-primary text-2xl">folder_open</span>
          </div>
          <div>
            <h1 class="text-headline-md font-bold text-on-surface">{{ route.params.namespace }}</h1>
            <p class="text-body-sm text-on-surface-variant mt-xs">
              <span class="text-primary font-semibold">{{ deployments.length }}</span> 个 Deployment ·
              <span class="text-on-surface-variant">{{ layerSections.filter(s => s.items.length).length }} 个分层有实例</span>
            </p>
          </div>
        </div>
        <div class="flex items-center gap-xs">
          <button @click="router.push({ name: 'NsLayers', params: { namespace: route.params.namespace } })" class="flex items-center gap-xs px-3 py-1.5 text-body-sm font-medium border border-outline-variant text-on-surface rounded-lg hover:bg-surface-container transition-colors" title="调整应用分层（监控/业务/中间件…）">
            <span class="material-symbols-outlined text-sm">layers</span><span class="hidden sm:inline">调整分组</span>
          </button>
          <button @click="router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })" class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
            <span class="material-symbols-outlined text-sm">add</span> Deploy
          </button>
        </div>
      </div>
    </div>

    <!-- 3 区分层：左=监控层 | 中=业务/持久/存储等 | 右=中间件层。侧列整列可折叠（→ 细轨），腾出中列空间 -->
    <div v-if="deployments.length" class="flex flex-col xl:flex-row gap-md items-start">
      <!-- ============ 左：监控层（整列可折叠） ============ -->
      <template v-if="monitoringSection">
        <!-- 展开：完整列 -->
        <div v-if="!isLayerCollapsed(monitoringSection)" class="w-full xl:w-[200px] shrink-0 flex flex-col gap-sm xl:sticky xl:top-2 xl:max-h-[calc(100vh-160px)] xl:overflow-y-auto">
          <div class="flex items-center gap-xs px-xs py-xs rounded-lg cursor-pointer select-none hover:bg-surface-container-low/50 transition-colors" @click="toggleLayer(monitoringSection)" title="收起整列">
            <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" :class="LAYER_COLOR[monitoringSection.color] || LAYER_COLOR.surface"><span class="material-symbols-outlined text-base">{{ monitoringSection.icon }}</span></div>
            <h3 class="text-body-sm font-bold text-on-surface">{{ monitoringSection.label }}</h3>
            <span class="text-xs text-on-surface-variant ml-auto">{{ monitoringSection.items.length }}</span>
            <span class="material-symbols-outlined text-on-surface-variant text-base">chevron_left</span>
          </div>
          <div v-if="monitoringSection.items.length" class="flex flex-col gap-xs">
            <div v-for="it in monitoringSection.items" :key="it.dep.name" @click="goDeploy(it.dep)"
                 class="rounded-lg bg-surface-container-lowest border border-outline-variant border-l-4 p-sm cursor-pointer hover:border-primary hover:shadow-sm transition-all"
                 :class="healthOf(it.dep).accent">
              <div class="flex items-center gap-xs">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="[healthOf(it.dep).dot, healthOf(it.dep).spin ? 'animate-pulse-status' : '']"></span>
                <p class="font-mono text-xs font-semibold text-on-surface truncate">{{ it.dep.name }}</p>
              </div>
              <p class="font-mono text-[11px] truncate mt-0.5"><span class="text-on-surface-variant">{{ imgBase(it.dep.image) }}</span><span class="text-primary font-semibold">:{{ imageTag(it.dep.image) || 'latest' }}</span></p>
              <div class="flex items-center justify-between mt-1 text-[11px]">
                <span class="font-mono text-on-surface">{{ healthOf(it.dep).ready }}/{{ healthOf(it.dep).desired }}</span>
                <span :class="healthOf(it.dep).text">{{ healthOf(it.dep).label }}</span>
              </div>
            </div>
          </div>
          <div v-else class="rounded-lg border border-dashed border-outline-variant/40 py-sm text-center">
            <span class="material-symbols-outlined text-lg text-surface-container-high">{{ monitoringSection.icon }}</span>
            <p class="text-[10px] text-on-surface-variant/50 mt-0.5">本命名空间暂无</p>
          </div>
        </div>
        <!-- 折叠：细轨（点击展开） -->
        <button v-else @click="toggleLayer(monitoringSection)" :title="`监控层 · ${monitoringSection.items.length} 个 · 点击展开`"
                class="w-full xl:w-9 shrink-0 flex xl:flex-col items-center justify-center gap-xs xl:gap-sm py-sm xl:py-md rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary/5 transition-colors group">
          <span class="material-symbols-outlined text-base" :class="(LAYER_COLOR[monitoringSection.color] || LAYER_COLOR.surface).split(' ').find(c => c.startsWith('text-'))">monitoring</span>
          <span class="text-xs font-bold text-on-surface">{{ monitoringSection.items.length }}</span>
          <span class="hidden xl:inline text-[9px] text-on-surface-variant/60 [writing-mode:vertical-rl] group-hover:text-primary">监控层</span>
        </button>
      </template>

      <!-- ============ 中：业务/持久/存储等（弹性占满剩余） ============ -->
      <div class="flex-1 min-w-0 w-full flex flex-col gap-md">
        <section v-for="section in centerSections" :key="section.key">
          <!-- 层头（持久层可折叠） -->
          <div class="flex items-center gap-sm mb-sm"
               :class="section.collapsible ? 'cursor-pointer select-none hover:bg-surface-container-low/40 -mx-sm px-sm py-xs rounded-lg transition-colors' : ''"
               @click="section.collapsible && toggleLayer(section)">
            <div class="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" :class="LAYER_COLOR[section.color] || LAYER_COLOR.surface">
              <span class="material-symbols-outlined text-base">{{ section.icon }}</span>
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-xs">
                <h2 class="text-body-md font-bold text-on-surface">{{ section.label }}</h2>
                <span v-if="section.collapsible" class="px-1 py-0.5 rounded bg-surface-container text-[10px] text-on-surface-variant">可折叠</span>
              </div>
              <p class="text-xs text-on-surface-variant truncate">{{ section.desc }}</p>
            </div>
            <span class="px-1.5 py-0.5 rounded-full bg-surface-container text-xs text-on-surface-variant font-medium">{{ section.items.length }}</span>
            <span v-if="section.collapsible" class="material-symbols-outlined text-on-surface-variant text-base">{{ isLayerCollapsed(section) ? 'chevron_right' : 'expand_more' }}</span>
          </div>
          <!-- 层体 -->
          <div v-if="!section.collapsible || !isLayerCollapsed(section)">
            <div v-if="section.items.length" class="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-md">
              <div v-for="it in section.items" :key="it.dep.name"
                   class="rounded-xl bg-surface-container-lowest border border-outline-variant border-l-4 hover:shadow-md hover:-translate-y-0.5 hover:border-primary/30 transition-all flex cursor-pointer group"
                   :class="healthOf(it.dep).accent"
                   @click="goDeploy(it.dep)">
                <!-- 左：部署信息 -->
                <div class="flex-1 min-w-0 p-md flex flex-col">
                  <div class="flex items-center gap-xs">
                    <span class="w-2 h-2 rounded-full shrink-0" :class="[healthOf(it.dep).dot, healthOf(it.dep).spin ? 'animate-pulse-status' : '']"></span>
                    <p class="text-body-md font-semibold text-on-surface truncate group-hover:text-primary transition-colors">{{ metaOf(it.dep).title || it.dep.name }}</p>
                  </div>
                  <p v-if="metaOf(it.dep).title" class="font-mono text-xs text-on-surface-variant truncate mt-0.5">{{ it.dep.name }}</p>
                  <p class="font-mono text-xs truncate mt-xs">
                    <span class="text-on-surface-variant">{{ imgBase(it.dep.image) }}</span><span class="text-primary font-semibold">:{{ imageTag(it.dep.image) || 'latest' }}</span>
                  </p>
                  <div class="mt-auto pt-sm grid grid-cols-3 gap-xs">
                    <div><p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide">num</p><p class="text-body-sm font-mono font-semibold text-on-surface">{{ healthOf(it.dep).ready }}/{{ healthOf(it.dep).desired }}</p></div>
                    <div><p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide">live</p><p class="text-body-sm text-on-surface-variant">{{ it.dep.age }}</p></div>
                    <div><p class="text-[10px] text-on-surface-variant/50 uppercase tracking-wide">status</p><p class="text-body-sm font-medium" :class="healthOf(it.dep).text">{{ healthOf(it.dep).label }}</p></div>
                  </div>
                </div>
                <!-- 右：关联标签（仅文字；hover 富卡片 / 点击跳转；无则不展示） -->
                <div v-if="it.assoc.services.length || it.assoc.ingressRules.length"
                     class="shrink-0 w-[116px] border-l border-outline-variant/40 bg-surface-container-low/40 p-sm flex flex-col gap-xs justify-center">
                  <button v-if="it.assoc.services.length"
                          @click.stop="goSvc(it.assoc.services[0])"
                          @mouseenter="onEnterAssoc($event, 'svc', it.assoc)" @mouseleave="onLeaveAssoc()"
                          class="flex items-center justify-center gap-1 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-xs text-on-surface-variant hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors cursor-pointer">
                    <span class="material-symbols-outlined" style="font-size:14px">hub</span> Service
                    <span v-if="it.assoc.services.length > 1" class="font-semibold text-primary">{{ it.assoc.services.length }}</span>
                  </button>
                  <button v-if="it.assoc.ingressRules.length"
                          @click.stop="goIng(it.assoc.ingressRules[0])"
                          @mouseenter="onEnterAssoc($event, 'ing', it.assoc)" @mouseleave="onLeaveAssoc()"
                          class="flex items-center justify-center gap-1 px-sm py-1 rounded-md border border-outline-variant bg-surface-container-lowest text-xs text-on-surface-variant hover:border-primary hover:text-primary hover:bg-primary/5 transition-colors cursor-pointer">
                    <span class="material-symbols-outlined" style="font-size:14px">alt_route</span> Ingress
                    <span v-if="it.assoc.ingressRules.length > 1" class="font-semibold text-primary">{{ it.assoc.ingressRules.length }}</span>
                  </button>
                </div>
              </div>
            </div>
            <p v-else class="text-xs text-on-surface-variant/40 py-sm pl-sm">该层暂无 Deployment</p>
          </div>
        </section>
      </div>

      <!-- ============ 右：中间件层（整列可折叠） ============ -->
      <template v-if="middlewareSection">
        <!-- 展开：完整列 -->
        <div v-if="!isLayerCollapsed(middlewareSection)" class="w-full xl:w-[200px] shrink-0 flex flex-col gap-sm xl:sticky xl:top-2 xl:max-h-[calc(100vh-160px)] xl:overflow-y-auto">
          <div class="flex items-center gap-xs px-xs py-xs rounded-lg cursor-pointer select-none hover:bg-surface-container-low/50 transition-colors" @click="toggleLayer(middlewareSection)" title="收起整列">
            <span class="material-symbols-outlined text-on-surface-variant text-base">chevron_right</span>
            <div class="w-7 h-7 rounded-lg flex items-center justify-center shrink-0" :class="LAYER_COLOR[middlewareSection.color] || LAYER_COLOR.surface"><span class="material-symbols-outlined text-base">{{ middlewareSection.icon }}</span></div>
            <h3 class="text-body-sm font-bold text-on-surface">{{ middlewareSection.label }}</h3>
            <span class="text-xs text-on-surface-variant ml-auto">{{ middlewareSection.items.length }}</span>
          </div>
          <div v-if="middlewareSection.items.length" class="flex flex-col gap-xs">
            <div v-for="it in middlewareSection.items" :key="it.dep.name" @click="goDeploy(it.dep)"
                 class="rounded-lg bg-surface-container-lowest border border-outline-variant border-l-4 p-sm cursor-pointer hover:border-primary hover:shadow-sm transition-all"
                 :class="healthOf(it.dep).accent">
              <div class="flex items-center gap-xs">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="[healthOf(it.dep).dot, healthOf(it.dep).spin ? 'animate-pulse-status' : '']"></span>
                <p class="font-mono text-xs font-semibold text-on-surface truncate">{{ it.dep.name }}</p>
              </div>
              <p class="font-mono text-[11px] truncate mt-0.5"><span class="text-on-surface-variant">{{ imgBase(it.dep.image) }}</span><span class="text-primary font-semibold">:{{ imageTag(it.dep.image) || 'latest' }}</span></p>
              <div class="flex items-center justify-between mt-1 text-[11px]">
                <span class="font-mono text-on-surface">{{ healthOf(it.dep).ready }}/{{ healthOf(it.dep).desired }}</span>
                <span :class="healthOf(it.dep).text">{{ healthOf(it.dep).label }}</span>
              </div>
            </div>
          </div>
          <div v-else class="rounded-lg border border-dashed border-outline-variant/40 py-sm text-center">
            <span class="material-symbols-outlined text-lg text-surface-container-high">{{ middlewareSection.icon }}</span>
            <p class="text-[10px] text-on-surface-variant/50 mt-0.5">本命名空间暂无</p>
          </div>
        </div>
        <!-- 折叠：细轨（点击展开） -->
        <button v-else @click="toggleLayer(middlewareSection)" :title="`中间件层 · ${middlewareSection.items.length} 个 · 点击展开`"
                class="w-full xl:w-9 shrink-0 flex xl:flex-col items-center justify-center gap-xs xl:gap-sm py-sm xl:py-md rounded-lg border border-outline-variant bg-surface-container-lowest hover:border-primary hover:bg-primary/5 transition-colors group">
          <span class="material-symbols-outlined text-base" :class="(LAYER_COLOR[middlewareSection.color] || LAYER_COLOR.surface).split(' ').find(c => c.startsWith('text-'))">sync_alt</span>
          <span class="text-xs font-bold text-on-surface">{{ middlewareSection.items.length }}</span>
          <span class="hidden xl:inline text-[9px] text-on-surface-variant/60 [writing-mode:vertical-rl] group-hover:text-primary">中间件</span>
        </button>
      </template>
    </div>

    <!-- 空状态 -->
    <div v-else class="rounded-xl border border-dashed border-outline-variant/50 py-xl text-center">
      <span class="material-symbols-outlined text-3xl text-surface-container-high">workspaces</span>
      <p class="text-body-sm text-on-surface-variant mt-xs">该命名空间暂无 Deployment</p>
      <button @click="router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })" class="mt-md inline-flex items-center gap-xs px-md py-sm text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity">
        <span class="material-symbols-outlined text-sm">rocket_launch</span> 部署应用
      </button>
    </div>

    <!-- hover 富信息卡片（teleport 至 body） -->
    <Teleport to="body">
      <div v-if="hover"
           class="fixed z-[100] w-80 rounded-xl bg-surface-container-lowest border border-outline-variant shadow-2xl overflow-hidden animate-fade-in"
           :style="{ top: hover.top + 'px', right: hover.right + 'px' }"
           @mouseenter="onPopoverEnter" @mouseleave="onLeaveAssoc">
        <!-- 头 -->
        <div class="px-md py-1.5 border-b border-outline-variant/40 flex items-center gap-xs"
             :class="hover.type === 'svc' ? 'bg-primary/5' : 'bg-secondary/5'">
          <span class="material-symbols-outlined text-base" :class="hover.type === 'svc' ? 'text-primary' : 'text-secondary'">{{ hover.type === 'svc' ? 'hub' : 'alt_route' }}</span>
          <span class="text-body-sm font-semibold text-on-surface">{{ hover.type === 'svc' ? '关联 Service' : '关联 Ingress' }}</span>
          <span class="text-xs text-on-surface-variant ml-auto">{{ hover.items.length }}</span>
        </div>
        <!-- Service 列表 -->
        <div v-if="hover.type === 'svc'" class="p-sm flex flex-col gap-sm max-h-72 overflow-y-auto">
          <div v-for="s in hover.items" :key="s.name" class="flex flex-col gap-0.5">
            <div class="flex items-center gap-xs">
              <span class="font-mono text-xs font-semibold text-on-surface truncate">{{ s.name }}</span>
              <span class="ml-auto shrink-0 px-1 py-0.5 rounded bg-surface-container text-[10px] text-on-surface-variant">{{ s.type }}</span>
            </div>
            <p class="font-mono text-[11px] text-on-surface-variant truncate"><span class="text-on-surface-variant/50">ClusterIP</span> <span class="text-on-surface">{{ s.clusterIP }}</span></p>
            <p v-if="s.externalIP && s.externalIP !== '-'" class="font-mono text-[11px] text-on-surface-variant truncate"><span class="text-on-surface-variant/50">External</span> <span class="text-secondary">{{ s.externalIP }}</span></p>
            <p class="font-mono text-[11px] truncate"><span class="text-on-surface-variant/50">端口</span> <span class="text-primary">{{ s.ports || '—' }}</span></p>
            <p v-if="fmtSelector(s.selector)" class="text-[11px] text-on-surface-variant truncate"><span class="text-on-surface-variant/50">Selector</span> {{ fmtSelector(s.selector) }}</p>
            <p class="text-[11px] text-on-surface-variant/50">创建于 {{ s.age }}</p>
          </div>
        </div>
        <!-- Ingress 列表 -->
        <div v-else class="p-sm flex flex-col gap-sm max-h-72 overflow-y-auto">
          <div v-for="(r, i) in hover.items" :key="r.ingName + i" class="flex flex-col gap-0.5">
            <div class="flex items-center gap-xs">
              <span class="font-mono text-xs font-semibold text-secondary truncate">{{ r.host }}<span class="text-on-surface-variant font-normal">{{ r.path }}</span></span>
              <span v-if="r.tls" class="ml-auto shrink-0 px-1 py-0.5 rounded bg-status-running/10 text-status-running text-[10px] flex items-center gap-0.5"><span class="material-symbols-outlined" style="font-size:11px">lock</span>TLS</span>
            </div>
            <p class="font-mono text-[11px] truncate"><span class="text-on-surface-variant/50">后端</span> <span class="text-primary">{{ r.serviceName }}{{ r.servicePort ? ':' + r.servicePort : '' }}</span></p>
            <p class="text-[11px] text-on-surface-variant truncate"><span class="text-on-surface-variant/50">Ingress</span> {{ r.ingName }}<span v-if="r.className"> · {{ r.className }}</span></p>
            <p v-if="r.tlsSecret" class="text-[11px] text-on-surface-variant truncate"><span class="text-on-surface-variant/50">TLS Secret</span> {{ r.tlsSecret }}</p>
            <p class="text-[11px] text-on-surface-variant/50">创建于 {{ r.age }}</p>
          </div>
        </div>
        <div class="px-md py-1 border-t border-outline-variant/40 text-[10px] text-on-surface-variant/50 text-center">点击标签进入详情页</div>
      </div>
    </Teleport>
  </div>
</template>
