<script setup>
// 统一的 Pod 卡片：Workload 详情 Pods tab 与 Service 详情 Endpoints 共用同一份展示。
// 富信息：健康度 + 名称(应用名/实例哈希) + 状态 + 容器数 + IP/节点/镜像/重启 + CPU/MEM 进度条 + 生命周期 conditions。
// 通过 props 控制差异：选中态、删除键、生命周期、端点 ready 标记。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import StatusChip from './StatusChip.vue'
import { useTerminalStore } from '@/stores/terminals'
import { useFileBrowserStore } from '@/stores/fileBrowsers'
import { openLogTab } from '@/composables/useLogViewer'
import { imgBase, imgTag, podCpuPct, podMemPct, podHealth, podCardClass, podNameDisplay, podConditions, condChip, podContainers, podReason } from '@/composables/usePod'

const { t } = useI18n()

const props = defineProps({
  pod: { type: Object, required: true },
  // 名称拆分的 base（如 deployment 名）；不传则整名展示
  nameBase: { type: String, default: '' },
  selected: { type: Boolean, default: false },
  clickable: { type: Boolean, default: true },
  // 端点上下文的就绪标记（null=不展示，取 Pod 自身健康度；true/false 展示 Ready/Not Ready）
  ready: { default: null },
  showDelete: { type: Boolean, default: false },
  // 批量选择模式:行1 渲染 checkbox 视觉(pointer-events-none,点击统一走卡片 @click)
  selectable: { type: Boolean, default: false },
  showLifecycle: { type: Boolean, default: true },
  // 集群级上下文（如 Node 详情）下展示命名空间；命名空间级页面无需开启
  showNamespace: { type: Boolean, default: false },
  // 快速入口：终端（exec）/ 文件浏览 / 日志（新标签页）；点击导航到 PodDetail 对应 tab
  showTerminal: { type: Boolean, default: true },
  showFiles: { type: Boolean, default: true },
  showLogs: { type: Boolean, default: true },
})
const emit = defineEmits(['click', 'delete'])

const termStore = useTerminalStore()
const fbStore = useFileBrowserStore()
const pod = computed(() => props.pod || {})
const health = computed(() => podHealth(pod.value))
const nameDisp = computed(() => podNameDisplay(pod.value, props.nameBase))
const containers = computed(() => podContainers(pod.value))
const conds = computed(() => podConditions(pod.value))
const cpuPct = computed(() => podCpuPct(pod.value))
const memPct = computed(() => podMemPct(pod.value))
const hasMetrics = computed(() => pod.value.cpu || pod.value.memory)
// 异常/启动中原因（ImagePullBackOff / CrashLoopBackOff / ContainerCreating …），正常运行为 null
const reason = computed(() => podReason(pod.value))
// exec / 文件浏览依赖容器在运行
const canExec = computed(() => pod.value.status === 'Running')

function onClick() { if (props.clickable) emit('click', pod.value) }
// 文件浏览:弹浮动窗口(复用全局窗口系统:可最小化到任务栏、刷新恢复、状态同步)
function openFiles() {
  if (!canExec.value) return
  const c = containers.value?.[0]
  fbStore.openBrowser({ namespace: pod.value.namespace, podName: pod.value.name, container: (c && (c.name || c)) || 'main' })
}
// 终端：弹浮动窗口（复用全局终端系统：可最小化到任务栏、状态保持、新标签页打开）
function openTerm() {
  if (!canExec.value) return
  const c = containers.value?.[0]
  const container = (c && (c.name || c)) || 'main'
  termStore.openTerminal({ namespace: pod.value.namespace, podName: pod.value.name, container })
}
// 日志：新浏览器标签页打开独立日志页（具名 target 去重复用）。不受 canExec 限制——
// CrashLoopBackOff/Pending 看 previous 日志是刚需，K8s log API 对未运行容器返回错误由日志页内横幅呈现。
function openLogs() {
  const c = containers.value?.[0]
  openLogTab({ namespace: pod.value.namespace, podName: pod.value.name, container: (c && (c.name || c)) || 'main' })
}
</script>

<template>
  <div
    class="text-left rounded-lg border bg-surface-container-lowest px-sm py-2 transition-all"
    :class="[podCardClass(pod), selected ? 'ring-2 ring-primary border-primary/50' : '', clickable ? 'cursor-pointer' : '']"
    @click="onClick"
  >
    <!-- 行1：健康度点 + 名称 + 状态 + 容器数 + 端点就绪 + 健康标签 + 年龄 + 删除 -->
    <div class="flex items-center gap-sm">
      <span v-if="selectable" data-test="batch-checkbox" class="material-symbols-outlined text-base text-primary select-none pointer-events-none shrink-0">{{ selected ? 'check_box' : 'check_box_outline_blank' }}</span>
      <span class="w-2 h-2 rounded-full shrink-0" :class="[health.dot, pod.status === 'Running' ? 'animate-pulse-status' : '']"></span>
      <span class="font-mono text-xs font-medium text-on-surface truncate flex-1 min-w-0" :title="pod.name">{{ nameDisp.base }}<span class="text-on-surface-variant/40 font-normal">{{ nameDisp.suffix }}</span></span>
      <StatusChip :status="pod.status" size="sm" />
      <span v-if="containers.length > 1" class="text-[10px] text-on-surface-variant/60 flex items-center gap-0.5 shrink-0" :title="t('component.podCard.containers', { n: containers.length })"><span class="material-symbols-outlined" style="font-size:11px">inventory_2</span>{{ containers.length }}</span>
      <span v-if="showNamespace && pod.namespace" class="text-[10px] px-1 rounded font-medium shrink-0 bg-secondary/10 text-secondary" :title="t('component.podCard.namespaceTitle', { ns: pod.namespace })">{{ pod.namespace }}</span>
      <span v-if="ready !== null" class="text-[10px] px-1 rounded font-medium shrink-0" :class="ready ? 'bg-primary-container/15 text-primary' : 'bg-tertiary-container/15 text-tertiary-container'">{{ ready ? t('component.podCard.ready') : t('component.podCard.notReady') }}</span>
      <span class="text-xs shrink-0" :class="health.text">{{ health.label }}</span>
      <span class="text-[11px] text-on-surface-variant ml-auto shrink-0">{{ pod.age }}</span>
      <slot name="actions" />
      <button v-if="showTerminal" @click.stop="openTerm" :disabled="!canExec" :title="canExec ? t('component.podCard.terminalTitle') : t('component.podCard.terminalDisabled')" class="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant/50 hover:text-primary transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-on-surface-variant/50"><span class="material-symbols-outlined text-sm">terminal</span></button>
      <button v-if="showFiles" @click.stop="openFiles" :disabled="!canExec" :title="canExec ? t('component.podCard.filesTitle') : t('component.podCard.filesDisabled')" class="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant/50 hover:text-primary transition-colors shrink-0 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-on-surface-variant/50"><span class="material-symbols-outlined text-sm">folder_open</span></button>
      <button v-if="showLogs" @click.stop="openLogs" :title="t('component.podCard.logsTitle')" data-testid="podcard-logs" class="p-0.5 rounded hover:bg-primary/10 text-on-surface-variant/50 hover:text-primary transition-colors shrink-0"><span class="material-symbols-outlined text-sm">subject</span></button>
      <button v-if="showDelete" @click.stop="emit('delete', pod)" class="p-0.5 rounded hover:bg-error/10 text-on-surface-variant/50 hover:text-error transition-colors shrink-0" :title="t('component.podCard.deleteTitle')"><span class="material-symbols-outlined text-sm">delete</span></button>
    </div>

    <!-- 行2：状态 + 重启 + IP + 节点 + 镜像 -->
    <div class="flex items-center gap-1.5 mt-1 text-[11px] text-on-surface-variant/70 flex-wrap">
      <span class="flex items-center gap-0.5" :class="health.text"><span class="w-1 h-1 rounded-full" :class="health.dot"></span>{{ pod.status }}</span>
      <span v-if="pod.restarts > 0" class="flex items-center gap-0.5" :class="pod.restarts > 3 ? 'text-error' : 'text-tertiary-container'" :title="t('component.podCard.restartsTitle', { n: pod.restarts })"><span class="material-symbols-outlined" style="font-size:12px">restart_alt</span>{{ pod.restarts }}</span>
      <span v-if="pod.ip" class="font-mono text-primary">{{ pod.ip }}</span>
      <span class="inline-flex items-center gap-0.5"><span class="material-symbols-outlined" style="font-size:12px">dns</span><span class="font-mono truncate max-w-[110px]" :title="pod.node">{{ pod.node || '—' }}</span></span>
      <template v-if="pod.image">
        <span class="text-on-surface-variant/40">·</span>
        <span class="font-mono truncate max-w-[180px]" :title="pod.image">{{ imgBase(pod.image) }}<span class="text-primary">:{{ imgTag(pod.image) || 'latest' }}</span></span>
      </template>
    </div>

    <!-- 异常/启动中原因（ImagePullBackOff / CrashLoopBackOff / ContainerCreating …）-->
    <div v-if="reason" class="flex items-center gap-1 mt-1 text-[11px]" :class="reason.kind === 'terminated' ? 'text-error' : 'text-tertiary-container'">
      <span class="material-symbols-outlined shrink-0" style="font-size:13px">{{ reason.kind === 'terminated' ? 'dangerous' : 'error' }}</span>
      <span class="font-semibold shrink-0">{{ reason.reason }}</span>
      <span v-if="reason.message" class="text-on-surface-variant/55 truncate min-w-0" :title="reason.message">{{ reason.message }}</span>
    </div>

    <!-- 行3：CPU / MEM 进度条 -->
    <div v-if="hasMetrics" class="flex items-center gap-md text-[11px] mt-1">
      <div v-if="pod.cpu" class="flex items-center gap-1">
        <span class="text-on-surface-variant/50 w-6">CPU</span>
        <div class="w-14 h-1 bg-outline-variant/25 rounded-full overflow-hidden"><div class="h-full rounded-full" :class="cpuPct > 80 ? 'bg-error' : cpuPct > 60 ? 'bg-tertiary-container' : 'bg-primary'" :style="{ width: cpuPct + '%' }"></div></div>
        <span class="font-mono text-on-surface-variant/70">{{ pod.cpu }}</span>
      </div>
      <div v-if="pod.memory" class="flex items-center gap-1">
        <span class="text-on-surface-variant/50 w-6">MEM</span>
        <div class="w-14 h-1 bg-outline-variant/25 rounded-full overflow-hidden"><div class="h-full rounded-full" :class="memPct > 80 ? 'bg-error' : memPct > 60 ? 'bg-tertiary-container' : 'bg-secondary'" :style="{ width: memPct + '%' }"></div></div>
        <span class="font-mono text-on-surface-variant/70">{{ pod.memory }}</span>
      </div>
    </div>

    <!-- 行4：生命周期 conditions（调度/初始化/容器/就绪）-->
    <div v-if="showLifecycle && conds" class="flex items-center gap-1 mt-1">
      <template v-for="ck in [{ k: 'scheduled', l: t('component.podCard.lifecycleScheduled') }, { k: 'initialized', l: t('component.podCard.lifecycleInitialized') }, { k: 'containersReady', l: t('component.podCard.lifecycleContainers') }, { k: 'podReady', l: t('component.podCard.lifecycleReady') }]" :key="ck.k">
        <span class="flex items-center gap-0.5 text-[10px]" :class="condChip(conds[ck.k]).ok ? 'text-primary' : 'text-on-surface-variant/35'">
          <span class="material-symbols-outlined" style="font-size:11px">{{ condChip(conds[ck.k]).ok ? 'check_circle' : 'radio_button_unchecked' }}</span>{{ ck.l }}
        </span>
      </template>
    </div>
  </div>
</template>
