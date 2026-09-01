<script setup>
// Workload 拓扑 Tab(2026-09-01 整修):Ingress → Service → Workload → Pods 四列流水线展示层。
// 数据与动作全部来自 useWorkloadTopology 组合式(topo prop);本组件无查询、无 store 直调以外的副作用。
// 注意:topo 是普通对象包 refs/computeds——模板/脚本读取一律带 .value(plain object 不自动解包);
// epFor/openExpose/saveExpose/openIngressMap/saveIngressMap/repairServiceSelector 是普通函数直接调用。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { podHealth, imgBase, imgTag } from '@/composables/usePod'
import { isRetiredRs } from '@/logic/topology'

const { t } = useI18n()
const router = useRouter()
const props = defineProps({
  topo: { type: Object, required: true },
  workload: { type: Object, required: true },
  canMutate: { type: Boolean, default: true },
  managedPods: { type: Array, default: () => [] },
  podsPending: { type: Boolean, default: false },
  configRefs: { type: Array, default: () => [] },
})
defineEmits(['goto'])

const WL = ['Deployment', 'StatefulSet', 'DaemonSet', 'ReplicaSet', 'Job', 'CronJob']
const REF_ROUTES = { ConfigMap: 'NsConfigMapDetail', Secret: 'NsSecretDetail', PVC: 'NsPVCDetail', imagePullSecrets: 'NsSecretDetail' }
const REF_ICONS = { ConfigMap: 'description', Secret: 'key', imagePullSecrets: 'key', PVC: 'database' }
function go(node) {
  if (WL.includes(node.kind)) router.push({ name: 'NsWorkloadDetail', params: { namespace: node.namespace, type: node.kind.toLowerCase(), name: node.name } })
  else if (node.kind === 'Pod') router.push({ name: 'NsPodDetail', params: { namespace: node.namespace, name: node.name } })
  else if (node.kind === 'Service') router.push({ name: 'NsServiceDetail', params: { namespace: node.namespace, name: node.name } })
}
const gotoRef = ref2 => router.push({ name: REF_ROUTES[ref2.kind] || 'NsSecretDetail', params: { namespace: props.workload.namespace, name: ref2.name } })
const gotoHpa = h => router.push({ name: 'NsHPADetail', params: { namespace: h.namespace || props.workload.namespace, name: h.name } })

// C6:CronJob/Job 卡语义(替代 replicas/image 行)
const cronSchedule = computed(() => props.workload?.raw?.spec?.schedule || '')
const cronSuspended = computed(() => props.workload?.raw?.spec?.suspend === true)
const jobCompletions = computed(() => {
  const s = props.workload?.raw?.status?.succeeded || 0
  const total = props.workload?.raw?.spec?.completions
  return { s, total: total == null ? '*' : total }
})

// A3:Service 列头计数 = 关联 + 失配
const svcTotal = computed(() => props.topo.relatedServices.value.length + props.topo.driftedServices.value.length)

// C3:hover 联动(规则卡 ⇄ Service 卡,按 serviceName 对齐;失配卡同样命中)
const hoveredSvc = ref('')
const isRetired = rs2 => isRetiredRs(rs2, props.topo.latestRs.value)
</script>

<template>
  <div class="flex flex-col gap-md">
    <div class="flex items-stretch gap-sm overflow-x-auto pb-sm">
      <!-- 应用路由 / Ingress -->
      <div class="flex-1 min-w-[200px] rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col">
        <div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-base">alt_route</span>
          <span class="text-body-sm font-semibold">{{ $t('workload.topology.ingress') }}</span>
          <span class="text-xs text-on-surface-variant ml-auto">{{ $t('workload.topology.countRoutes', { n: topo.ingressBreakdown.value.ownRules.length }) }}</span>
        </div>
        <div class="p-sm flex flex-col gap-xs flex-1">
          <template v-if="topo.states.value.servicesPending || topo.states.value.ingressesPending">
            <div v-for="i in 2" :key="i" class="h-9 rounded-lg bg-surface-container-low animate-pulse"></div>
          </template>
          <template v-else>
            <button v-for="(r, i) in topo.ingressBreakdown.value.ownRules" :key="i" type="button"
              @click="router.push({ name: 'NsIngressDetail', params: { namespace: workload.namespace, name: r.ingress } })"
              @mouseenter="hoveredSvc = r.serviceName" @mouseleave="hoveredSvc = ''"
              :class="['text-left cursor-pointer rounded-lg border border-outline-variant/60 px-sm py-1.5 hover:border-primary hover:bg-primary/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors',
                hoveredSvc === r.serviceName ? 'ring-2 ring-primary' : '']">
              <p class="font-mono text-xs text-primary font-semibold truncate">{{ r.host }}<span class="text-on-surface-variant font-normal">{{ r.path }}</span></p>
              <p class="text-[11px] text-on-surface-variant truncate">→ {{ r.serviceName }}<span v-if="r.port">:{{ r.port }}</span></p>
            </button>
            <!-- A1:共享 Ingress 的他人路由,合并计数入口(不冒充本负载流量) -->
            <button v-for="o in topo.ingressBreakdown.value.others" :key="'o-' + o.name" type="button"
              @click="router.push({ name: 'NsIngressDetail', params: { namespace: workload.namespace, name: o.name } })"
              class="text-left text-[11px] text-on-surface-variant/70 hover:text-primary rounded-lg px-sm py-1 border border-dashed border-outline-variant/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
              <span class="material-symbols-outlined text-xs align-middle">alt_route</span>
              {{ o.name }} · {{ $t('workload.topology.otherRoutes', { count: o.count }) }}
            </button>
            <div v-if="!topo.ingressBreakdown.value.ownRules.length && !topo.ingressBreakdown.value.others.length" class="flex-1 flex flex-col items-center justify-center text-center text-xs text-on-surface-variant/50 py-md">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">block</span>{{ $t('workload.topology.noIngress') }}
            </div>
          </template>
        </div>
      </div>

      <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

      <!-- Service -->
      <div class="flex-1 min-w-[200px] relative">
        <button @click="topo.openIngressMap()" :disabled="!canMutate || !topo.relatedServices.value.length" :title="!topo.relatedServices.value.length ? $t('workload.topology.noService') : !canMutate ? $t('workload.noUpdatePerm') : ''" class="absolute -left-3 top-1/2 -translate-y-1/2 z-20 w-6 h-6 rounded-full bg-primary text-on-primary shadow-lg ring-2 ring-surface-container-lowest flex items-center justify-center hover:scale-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100">
          <span class="material-symbols-outlined text-base">add</span>
        </button>
        <div class="rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col h-full">
          <div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">hub</span>
            <span class="text-body-sm font-semibold">{{ $t('workload.topology.service') }}</span>
            <span class="text-xs text-on-surface-variant ml-auto">{{ $t('workload.topology.countServices', { n: svcTotal }) }}
              <span v-if="topo.driftedServices.value.length" class="text-error">+{{ topo.driftedServices.value.length }}⚠</span>
            </span>
          </div>
          <div class="p-sm flex flex-col gap-xs flex-1">
            <template v-if="topo.states.value.servicesPending">
              <div v-for="i in 2" :key="i" class="h-9 rounded-lg bg-surface-container-low animate-pulse"></div>
            </template>
            <template v-else>
              <!-- C3:hover 高亮:focus 用 ring(无 -2 后缀,避免与 hover ring-2 类名歧义) -->
              <button v-for="s in topo.relatedServices.value" :key="s.name" type="button"
                @click="router.push({ name: 'NsServiceDetail', params: { namespace: workload.namespace, name: s.name } })"
                @mouseenter="hoveredSvc = s.name" @mouseleave="hoveredSvc = ''"
                :class="['text-left cursor-pointer rounded-lg border border-outline-variant/60 px-sm py-1.5 hover:border-primary hover:bg-primary/5 focus:outline-none focus-visible:ring focus-visible:ring-primary transition-colors',
                  hoveredSvc === s.name ? 'ring-2 ring-primary' : '']">
                <p class="font-mono text-xs text-on-surface font-semibold truncate">
                  <span v-if="s.name === topo.governingSvcName.value" class="px-1 rounded bg-primary/15 text-primary text-[10px]">{{ $t('workload.topology.governing') }}</span>
                  {{ s.name }}
                </p>
                <p class="text-[11px] text-on-surface-variant truncate"><span class="px-1 rounded bg-surface-container">{{ s.type }}</span> {{ s.ports }}</p>
                <!-- C4:Endpoints 端点行(ready=0 显红) -->
                <p v-if="topo.epFor(s.name)" class="text-[11px] truncate" :class="topo.epFor(s.name).ready === 0 ? 'text-error' : 'text-on-surface-variant'">
                  {{ $t('workload.topology.endpoints', { ready: topo.epFor(s.name).ready, total: topo.epFor(s.name).total }) }}
                </p>
              </button>
              <!-- 失配 Service:selector ⊄ 当前 Pod labels(Endpoints 空,经 Ingress 访问 503)——显性化 + 一键修复 -->
              <div v-for="s in topo.driftedServices.value" :key="'drift-' + s.name" class="rounded-lg border px-sm py-1.5"
                @mouseenter="hoveredSvc = s.name" @mouseleave="hoveredSvc = ''"
                :class="[s.drift === 'broken' ? 'border-error/50 bg-error/5' : 'border-tertiary-container/40 bg-tertiary-container/5',
                  hoveredSvc === s.name ? (s.drift ? 'ring-2 ring-error' : 'ring-2 ring-primary') : '']">
                <div class="flex items-center gap-xs">
                  <span class="material-symbols-outlined text-sm shrink-0" :class="s.drift === 'broken' ? 'text-error' : 'text-tertiary-container'">warning</span>
                  <p class="font-mono text-xs font-semibold truncate flex-1" :class="s.drift === 'broken' ? 'text-error' : 'text-tertiary-container'">{{ s.name }}</p>
                  <button @click.stop="topo.repairServiceSelector(s.name)" :disabled="!canMutate || !!topo.repairingSvc.value || !Object.keys(topo.identitySel.value).length" :title="[!Object.keys(topo.identitySel.value).length ? $t('workload.expose.identityRequired') : '', !canMutate ? $t('workload.noUpdatePerm') : '', $t('workload.topology.driftHeuristic')].filter(Boolean).join(' · ')" class="text-[11px] px-1.5 py-0.5 rounded-md font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity shrink-0" :class="s.drift === 'broken' ? 'bg-error text-on-error' : 'bg-tertiary-container text-on-tertiary-container'">{{ $t('workload.topology.repairSelector') }}</button>
                </div>
                <p class="text-[11px] mt-0.5" :class="s.drift === 'broken' ? 'text-error/80' : 'text-tertiary-container'">
                  {{ s.drift === 'broken' ? $t('workload.topology.driftBroken') : $t('workload.topology.driftPending') }}
                </p>
              </div>
              <!-- C2:标签消费者(PDB/NetPol)——selector 选的是 Pod 而非 Service,集中挂列尾避免错误归属暗示 -->
              <div v-if="topo.labelConsumers.value.length" class="mt-1 pt-1 border-t border-outline-variant/30">
                <p class="text-[10px] text-on-surface-variant/60 mb-0.5">{{ $t('workload.topology.labelConsumers') }}</p>
                <div class="flex flex-wrap gap-0.5">
                  <button v-for="c in topo.labelConsumers.value" :key="c.kind + '/' + c.name" type="button"
                    @click="router.push({ name: c.kind === 'PDB' ? 'NsPDBDetail' : 'NsNetworkPolicyDetail', params: { namespace: workload.namespace, name: c.name } })"
                    :class="['inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[10px] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      c.disruptive ? 'bg-error/10 text-error' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container']">
                    <span class="material-symbols-outlined" style="font-size:11px">{{ c.kind === 'PDB' ? 'shield' : 'security' }}</span>{{ c.name }}
                  </button>
                </div>
              </div>
              <div v-if="!topo.relatedServices.value.length && !topo.driftedServices.value.length" class="flex-1 flex flex-col items-center justify-center text-center text-xs text-on-surface-variant/50 py-md">
                <span class="material-symbols-outlined text-2xl text-surface-container-high">block</span>{{ $t('workload.topology.noService') }}
                <p class="text-[10px] text-on-surface-variant/40 mt-1">{{ $t('workload.topology.noSelectorHint') }}</p>
              </div>
            </template>
          </div>
        </div>
      </div>

      <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

      <!-- Workload (self) -->
      <div class="flex-1 min-w-[200px] relative">
        <button @click="topo.openExpose()" :disabled="!canMutate" :title="!canMutate ? $t('workload.noUpdatePerm') : ''" class="absolute -left-3 top-1/2 -translate-y-1/2 z-20 w-6 h-6 rounded-full bg-primary text-on-primary shadow-lg ring-2 ring-surface-container-lowest flex items-center justify-center hover:scale-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100">
          <span class="material-symbols-outlined text-base">add</span>
        </button>
        <div class="rounded-xl bg-primary/5 border-2 border-primary/40 overflow-hidden flex flex-col h-full">
          <div class="px-md py-2 border-b border-primary/30 bg-primary/10 flex items-center gap-sm">
            <span class="material-symbols-outlined text-primary text-base">workspaces</span>
            <span class="text-body-sm font-semibold text-primary">{{ workload.type }}</span>
          </div>
          <div class="p-sm flex flex-col gap-xs">
            <div class="rounded-lg border border-primary/30 bg-surface-container-lowest px-sm py-1.5">
              <p class="font-mono text-xs text-on-surface font-semibold truncate">{{ workload.name }}</p>
              <!-- C6:CronJob/Job 卡语义(替代 replicas/image 两行) -->
              <template v-if="workload.type === 'CronJob'">
                <p class="font-mono text-[11px] text-on-surface truncate">{{ cronSchedule }}
                  <span v-if="cronSuspended" class="px-1 rounded bg-tertiary-container/20 text-tertiary-container text-[10px]">{{ $t('workload.topology.suspended') }}</span>
                </p>
                <p class="text-[10px] text-on-surface-variant/60">{{ $t('workload.topology.schedule') }}</p>
              </template>
              <template v-else-if="workload.type === 'Job'">
                <p class="text-[11px] text-on-surface-variant font-mono">{{ $t('workload.topology.completions', { succeeded: jobCompletions.s, total: jobCompletions.total }) }}</p>
              </template>
              <template v-else>
                <p class="text-[11px] text-on-surface-variant">{{ $t('workload.topology.replicasCount', { replicas: workload.replicas, age: workload.age }) }}</p>
                <p class="font-mono text-[11px] text-on-surface-variant truncate mt-0.5">{{ imgBase(workload.image) }}<span class="text-primary font-semibold">:{{ imgTag(workload.image) || 'latest' }}</span></p>
              </template>
            </div>
            <!-- C2:HPA chip(目标为本负载) -->
            <div v-if="topo.workloadHpas.value.length" class="flex flex-wrap gap-0.5 mt-1">
              <button v-for="h in topo.workloadHpas.value" :key="h.name" type="button" @click="gotoHpa(h)"
                class="inline-flex items-center gap-0.5 px-1 py-0.5 rounded bg-surface-container-low text-[10px] font-mono hover:bg-surface-container focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                <span class="material-symbols-outlined" style="font-size:11px">speed</span>{{ h.name }} {{ h.minReplicas }}→{{ h.maxReplicas }}
              </button>
            </div>
            <!-- C1:RS chips(当前版高亮,淘汰置灰) -->
            <div v-if="workload.type === 'Deployment' && topo.replicaSets.value.length" class="flex flex-wrap gap-0.5 mt-1">
              <button v-for="rs2 in topo.replicaSets.value" :key="rs2.name" type="button"
                @click="$emit('goto', 'revisions')"
                :class="['font-mono text-[10px] px-1 py-0.5 rounded border focus:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors',
                  isRetired(rs2) ? 'border-outline-variant/40 text-on-surface-variant/50 opacity-60' : 'border-primary/30 bg-primary/5 text-primary']">
                rs/{{ rs2.name }} {{ rs2.ready }}/{{ rs2.desired }}
              </button>
            </div>
            <div v-if="configRefs.length" class="mt-1">
              <p class="text-[10px] text-on-surface-variant/60 uppercase tracking-wider mb-0.5">{{ $t('workload.bottomBar.mountConfig') }}</p>
              <div class="flex flex-wrap gap-0.5">
                <!-- D2:配置引用可点击跳转(支持 PVC/IPS),图标按 Kind 映射 -->
                <button v-for="(ref, idx) in configRefs" :key="idx" type="button" @click.stop="gotoRef(ref)"
                  class="cursor-pointer inline-flex items-center gap-0.5 px-1 py-0.5 bg-surface-container-low rounded text-[11px] hover:bg-surface-container focus:outline-none focus-visible:ring-2 focus-visible:ring-primary">
                  <span class="material-symbols-outlined" style="font-size:11px">{{ REF_ICONS[ref.kind] || 'key' }}</span>{{ ref.name }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="flex items-center text-on-surface-variant/30 shrink-0"><span class="material-symbols-outlined">arrow_forward</span></div>

      <!-- Pods -->
      <div class="flex-1 min-w-[220px] rounded-xl bg-surface-container-lowest border border-outline-variant overflow-hidden flex flex-col">
        <div class="px-md py-2 border-b border-outline-variant/40 bg-surface-container-low/40 flex items-center gap-sm">
          <span class="material-symbols-outlined text-primary text-base">view_in_ar</span>
          <span class="text-body-sm font-semibold">{{ $t('workload.topology.pods') }}</span>
          <span class="text-xs text-on-surface-variant ml-auto">{{ $t('workload.topology.countPods', { n: managedPods.length }) }}</span>
        </div>
        <div class="p-sm flex flex-col gap-xs flex-1 max-h-[340px] overflow-y-auto">
          <template v-if="podsPending">
            <div v-for="i in 3" :key="i" class="h-7 rounded-lg bg-surface-container-low animate-pulse"></div>
          </template>
          <template v-else>
            <!-- C1:Pods 列按 RS 分组(组头 rs/name ready/desired,淘汰组置灰) -->
            <template v-for="g in topo.podsGrouped.value.groups" :key="g.rsName">
              <p class="text-[10px] text-on-surface-variant/60 font-mono flex items-center gap-1 px-0.5">
                rs/{{ g.rsName }} <span class="opacity-70">{{ g.ready }}/{{ g.desired }}</span>
                <span v-if="isRetired({ name: g.rsName, desired: g.desired, ready: g.ready })" class="w-full border-t border-outline-variant/20"></span>
              </p>
              <div v-for="p in g.pods" :key="p.name"
                :class="['cursor-pointer flex items-center gap-xs rounded-lg border border-outline-variant/60 px-sm py-1 hover:border-primary hover:bg-primary/5 transition-colors text-left',
                  isRetired({ name: g.rsName, desired: g.desired, ready: g.ready }) ? 'opacity-60' : '']"
                role="button" tabindex="0"
                @click="router.push({ name: 'NsPodDetail', params: { namespace: workload.namespace, name: p.name } })"
                @keydown.enter="router.push({ name: 'NsPodDetail', params: { namespace: workload.namespace, name: p.name } })">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="podHealth(p).dot"></span>
                <span class="font-mono text-[11px] text-on-surface truncate flex-1">{{ p.name }}</span>
                <span class="text-[11px] shrink-0" :class="podHealth(p).text">{{ podHealth(p).label }}</span>
              </div>
            </template>
            <template v-if="topo.podsGrouped.value.ungrouped.length">
              <p class="text-[10px] text-on-surface-variant/60 px-0.5">{{ $t('workload.topology.rsUngrouped') }}</p>
              <div v-for="p in topo.podsGrouped.value.ungrouped" :key="p.name"
                class="cursor-pointer flex items-center gap-xs rounded-lg border border-outline-variant/60 px-sm py-1 hover:border-primary hover:bg-primary/5 transition-colors text-left"
                role="button" tabindex="0"
                @click="router.push({ name: 'NsPodDetail', params: { namespace: workload.namespace, name: p.name } })"
                @keydown.enter="router.push({ name: 'NsPodDetail', params: { namespace: workload.namespace, name: p.name } })">
                <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="podHealth(p).dot"></span>
                <span class="font-mono text-[11px] text-on-surface truncate flex-1">{{ p.name }}</span>
                <span class="text-[11px] shrink-0" :class="podHealth(p).text">{{ podHealth(p).label }}</span>
              </div>
            </template>
            <div v-if="!topo.podsGrouped.value.groups.length && !topo.podsGrouped.value.ungrouped.length" class="flex-1 flex flex-col items-center justify-center text-center text-xs text-on-surface-variant/50 py-md">
              <span class="material-symbols-outlined text-2xl text-surface-container-high">deployed_code</span>{{ $t('workload.topology.noPods') }}
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 流量说明 -->
    <div class="rounded-xl bg-surface-container-low border border-outline-variant/60 p-md flex items-start gap-sm">
      <span class="material-symbols-outlined text-on-surface-variant text-base mt-0.5">info</span>
      <p class="text-xs text-on-surface-variant">
        {{ $t('workload.topology.flowPath') }}{{ $t('workload.topology.flowPathDesc', { type: workload.type }) }}
        <span v-if="!topo.relatedServices.value.length" class="text-tertiary-container">{{ $t('workload.topology.noServiceHint') }}</span>
        <span v-else class="text-on-surface-variant/70">{{ $t('workload.topology.addHint') }}</span>
      </p>
    </div>
  </div>
</template>
