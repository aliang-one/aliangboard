<script setup>
// Ingress 路由规则共享编辑器:host 分组卡片 + 每 path(path/pathType/serviceName/servicePort 双下拉)。
// 从 NsIngressDetail「Edit Rules」等价抽取,①向导/③独立创建/④规则编辑 三处消费(②保持轻量弹窗不使用)。
// 契约(详见 docs/superpowers/specs/2026-08-16-ingress-path-mapping-design.md §3.2):
// - 字段编辑直接 v-model 行对象(父级持有同一响应式数组,对象引用共享——与被抽取前行为一致);
// - 结构性增/删/移/复制 emit update:modelValue 携带新数组;
// - 校验(行级空值/斜杠/重复 path + defaultBackend)内置,经 validation 事件抛出供父级汇总/禁保存。
// i18n 复用 ns.ingressDetail.* 既有键(等价迁移,避免键漂移);新增仅 tlsRow* 与 virtualSvcBadge。
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import PortSelect from '@/components/common/PortSelect.vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  services: { type: Array, default: () => [] },
  withTls: { type: Boolean, default: false },
  withDefaultBackend: { type: Boolean, default: false },
  defaultBackend: { type: Object, default: () => ({ enabled: false, serviceName: '', servicePort: '' }) },
  defaultServiceName: { type: String, default: '' },
  withClearAll: { type: Boolean, default: false },
  secrets: { type: Array, default: () => [] },  // TLS Secret 候选名(父级已按 kubernetes.io/tls + 当前 ns 过滤)
})
const emit = defineEmits(['update:modelValue', 'update:defaultBackend', 'validation', 'clear-all'])

const { t } = useI18n()
const pathTypeOptions = ['Prefix', 'Exact', 'ImplementationSpecific']

// serviceName 候选(平铺;label 可选,向导虚拟 Service 标记「本向导创建」)
const svcOptions = computed(() => props.services.map(s => (s.label ? { label: s.label, value: s.name } : s.name)))
const svcByName = name => props.services.find(s => s.name === name)
const portsFor = name => (svcByName(name)?.ports || [])

function newPath() { return { path: '/', pathType: 'Prefix', serviceName: props.defaultServiceName, servicePort: '' } }
function setHosts(hosts) { emit('update:modelValue', hosts) }
function addHost() { setHosts([...props.modelValue, { host: '', tls: false, tlsSecret: '', paths: [newPath()] }]) }
function removeHost(hi) { setHosts(props.modelValue.filter((_, i) => i !== hi)) }
function duplicateHost(hi) {
  const h = props.modelValue[hi]
  const copy = { host: h.host ? h.host + '-copy' : '', tls: false, tlsSecret: '', paths: h.paths.map(p => ({ ...p })) }
  setHosts([...props.modelValue.slice(0, hi + 1), copy, ...props.modelValue.slice(hi + 1)])
}
function moveHost(hi, dir) {
  const j = hi + dir
  if (j < 0 || j >= props.modelValue.length) return
  const a = [...props.modelValue]; const tmp = a[hi]; a[hi] = a[j]; a[j] = tmp
  setHosts(a)
}
function addPath(hi) { setHosts(props.modelValue.map((h, i) => (i === hi ? { ...h, paths: [...h.paths, newPath()] } : h))) }
function removePath(hi, pi) { setHosts(props.modelValue.map((h, i) => (i === hi ? { ...h, paths: h.paths.filter((_, j) => j !== pi) } : h))) }
function duplicatePath(hi, pi) {
  setHosts(props.modelValue.map((h, i) => (i === hi ? { ...h, paths: [...h.paths.slice(0, pi + 1), { ...h.paths[pi] }, ...h.paths.slice(pi + 1)] } : h)))
}
function movePath(hi, pi, dir) {
  setHosts(props.modelValue.map((h, i) => {
    if (i !== hi) return h
    const j = pi + dir
    if (j < 0 || j >= h.paths.length) return h
    const paths = [...h.paths]; const tmp = paths[pi]; paths[pi] = paths[j]; paths[j] = tmp
    return { ...h, paths }
  }))
}
function setDb(patch) { emit('update:defaultBackend', { ...props.defaultBackend, ...patch }) }

// 校验:与 ④ 抽取前逻辑等价(空值/斜杠/重复 path/端口数字 + defaultBackend)
const errors = computed(() => {
  const errs = []
  props.modelValue.forEach((h, hi) => {
    if (!h.paths.length) { errs.push({ loc: `host[${hi}]`, field: 'path', msg: t('ns.ingressDetail.valPathRequired') }); return }
    const seen = {}
    h.paths.forEach((p, i) => {
      const loc = `host[${hi}].path[${i}]`
      if (!p.path) errs.push({ loc, field: 'path', msg: t('ns.ingressDetail.valPathRequired') })
      else if (!p.path.startsWith('/')) errs.push({ loc, field: 'path', msg: t('ns.ingressDetail.valPathSlash', { val: p.path }) })
      else {
        if (seen[p.path]) errs.push({ loc: `host[${hi}]`, field: 'path', msg: t('ns.ingressDetail.valPathDup', { val: p.path }) })
        seen[p.path] = true
      }
      if (!p.serviceName) errs.push({ loc, field: 'serviceName', msg: t('ns.ingressDetail.valSvcRequired') })
      if (!p.servicePort) errs.push({ loc, field: 'servicePort', msg: t('ns.ingressDetail.valPortRequired') })
      else if (isNaN(Number(p.servicePort))) errs.push({ loc, field: 'servicePort', msg: t('ns.ingressDetail.valPortNumber', { val: p.servicePort }) })
    })
  })
  if (props.withDefaultBackend && props.defaultBackend.enabled) {
    const db = props.defaultBackend
    if (!db.serviceName) errs.push({ loc: 'defaultBackend', field: 'serviceName', msg: t('ns.ingressDetail.valDefaultSvcRequired') })
    if (!db.servicePort) errs.push({ loc: 'defaultBackend', field: 'servicePort', msg: t('ns.ingressDetail.valDefaultPortRequired') })
    else if (isNaN(Number(db.servicePort))) errs.push({ loc: 'defaultBackend', field: 'servicePort', msg: t('ns.ingressDetail.valDefaultPortNumber') })
  }
  return errs
})
watch(errors, v => emit('validation', v), { immediate: true })
function fieldError(hi, pi, field) { return errors.value.find(e => e.loc === `host[${hi}].path[${pi}]` && e.field === field) }
</script>

<template>
  <div class="flex flex-col gap-sm">
    <!-- 默认后端(④ 专用,开关式卡片) -->
    <div v-if="withDefaultBackend" class="rounded-lg border border-outline-variant p-sm mb-sm">
      <label class="flex items-center gap-sm cursor-pointer">
        <input v-model="defaultBackend.enabled" type="checkbox" class="h-4 w-4 accent-primary" @change="setDb({ enabled: defaultBackend.enabled })" />
        <span class="text-body-sm font-medium">{{ t('ns.ingressDetail.enableDefaultBackend') }} <code class="font-mono text-xs text-on-surface-variant">spec.defaultBackend</code></span>
      </label>
      <div v-if="defaultBackend.enabled" class="grid grid-cols-2 gap-sm mt-sm">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Service</label>
          <PortSelect :model-value="defaultBackend.serviceName" :options="svcOptions" placeholder="my-svc" :empty-hint="t('ns.ingressDetail.defaultBackendSvcHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-sm font-mono" @update:model-value="v => setDb({ serviceName: v })" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Port</label>
          <PortSelect :model-value="defaultBackend.servicePort" :options="portsFor(defaultBackend.serviceName)" placeholder="80" :empty-hint="t('ns.ingressDetail.defaultBackendPortHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-sm font-mono" @update:model-value="v => setDb({ servicePort: v })" />
        </div>
      </div>
    </div>

    <!-- host 分组卡片 -->
    <div v-for="(h, hi) in modelValue" :key="hi" class="rounded-lg border border-outline-variant overflow-hidden">
      <div class="px-sm py-1.5 bg-surface-container-low flex items-center gap-xs">
        <span class="material-symbols-outlined text-primary text-base">language</span>
        <input v-model="h.host" class="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded px-sm py-1 text-sm font-mono" :placeholder="t('ns.ingressDetail.hostPlaceholder')" />
        <span class="text-[10px] text-on-surface-variant shrink-0">{{ t('ns.ingressDetail.pathCount', { n: h.paths.length }) }}</span>
        <div class="flex items-center gap-0.5 shrink-0">
          <button @click="moveHost(hi, -1)" :disabled="hi === 0" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded max-sm:p-1.5 max-sm:-m-1.5" :title="t('ns.ingressDetail.moveUpHost')"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
          <button @click="moveHost(hi, 1)" :disabled="hi === modelValue.length - 1" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded max-sm:p-1.5 max-sm:-m-1.5" :title="t('ns.ingressDetail.moveDownHost')"><span class="material-symbols-outlined text-base">arrow_downward</span></button>
          <button @click="duplicateHost(hi)" class="p-0.5 text-on-surface-variant hover:text-primary rounded max-sm:p-1.5 max-sm:-m-1.5" :title="t('ns.ingressDetail.dupHost')"><span class="material-symbols-outlined text-base">content_copy</span></button>
          <button @click="removeHost(hi)" class="p-0.5 text-on-surface-variant hover:text-error rounded max-sm:p-1.5 max-sm:-m-1.5" :title="t('ns.ingressDetail.removeHost')"><span class="material-symbols-outlined text-base">delete</span></button>
        </div>
      </div>
      <div class="p-sm flex flex-col gap-xs">
        <div v-for="(p, i) in h.paths" :key="i" class="flex gap-xs items-center flex-wrap">
          <input v-model="p.path" :class="['w-28 bg-surface-container-low border rounded px-sm py-1 text-sm font-mono', fieldError(hi, i, 'path') ? 'border-error' : 'border-outline-variant']" placeholder="/" />
          <select v-model="p.pathType" class="bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-sm">
            <option v-for="pt in pathTypeOptions" :key="pt" :value="pt">{{ pt }}</option>
          </select>
          <PortSelect v-model="p.serviceName" :options="svcOptions" placeholder="my-svc" :empty-hint="t('ns.ingressDetail.noService')" :input-class="['w-32 bg-surface-container-low border rounded px-sm py-1 text-sm font-mono', fieldError(hi, i, 'serviceName') ? 'border-error' : 'border-outline-variant'].join(' ')" />
          <PortSelect v-model="p.servicePort" :options="portsFor(p.serviceName)" placeholder="80" :empty-hint="t('ns.ingressDetail.selectServiceForPort')" :input-class="['w-20 bg-surface-container-low border rounded px-sm py-1 text-sm font-mono', fieldError(hi, i, 'servicePort') ? 'border-error' : 'border-outline-variant'].join(' ')" />
          <div class="flex items-center gap-0.5 shrink-0">
            <button @click="movePath(hi, i, -1)" :disabled="i === 0" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded max-sm:p-1.5 max-sm:-m-1.5" :title="t('ns.ingressDetail.moveUpPath')"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
            <button @click="movePath(hi, i, 1)" :disabled="i === h.paths.length - 1" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded max-sm:p-1.5 max-sm:-m-1.5" :title="t('ns.ingressDetail.moveDownPath')"><span class="material-symbols-outlined text-base">arrow_downward</span></button>
            <button @click="duplicatePath(hi, i)" class="p-0.5 text-on-surface-variant hover:text-primary rounded max-sm:p-1.5 max-sm:-m-1.5" :title="t('ns.ingressDetail.dupPath')"><span class="material-symbols-outlined text-base">content_copy</span></button>
            <button @click="removePath(hi, i)" class="p-0.5 text-on-surface-variant hover:text-error rounded max-sm:p-1.5 max-sm:-m-1.5" :title="t('ns.ingressDetail.removePath')"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
        </div>
        <button @click="addPath(hi)" class="self-start flex items-center gap-xs px-sm py-xs text-sm text-primary hover:bg-primary-container/10 rounded">
          <span class="material-symbols-outlined text-sm">add</span> {{ t('ns.ingressDetail.addPath') }}
        </button>
        <!-- per-host TLS(①③;④ 的 TLS 走详情页单独编辑,不开) -->
        <label v-if="withTls" class="flex items-center gap-sm cursor-pointer mt-xs">
          <input type="checkbox" v-model="h.tls" class="rounded text-primary h-4 w-4" />
          <span class="text-xs">{{ t('ns.ingressDetail.tlsRowLabel') }}</span>
          <PortSelect v-if="h.tls" v-model="h.tlsSecret" :options="secrets" :placeholder="t('ns.ingressDetail.tlsRowSecretPlaceholder')" :empty-hint="t('ns.ingressDetail.noTlsSecretsHint')" input-class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" />
        </label>
      </div>
    </div>
    <div v-if="!modelValue.length" class="text-center text-on-surface-variant text-sm py-md">{{ t('ns.ingressDetail.noHost') }}</div>

    <div class="flex items-center gap-sm mt-sm">
      <button @click="addHost" class="flex items-center gap-xs px-sm py-xs border border-dashed border-outline-variant rounded-lg text-sm text-on-surface-variant hover:bg-surface-container-low">
        <span class="material-symbols-outlined text-sm">add</span> {{ t('ns.ingressDetail.addHost') }}
      </button>
      <button v-if="withClearAll" @click="emit('clear-all')" :disabled="!modelValue.length && !(withDefaultBackend && defaultBackend.enabled)" class="ml-auto flex items-center gap-xs px-sm py-xs text-sm text-error hover:bg-error-container/10 rounded disabled:opacity-40">
        <span class="material-symbols-outlined text-sm">delete_sweep</span> {{ t('ns.ingressDetail.clearAll') }}
      </button>
    </div>
  </div>
</template>
