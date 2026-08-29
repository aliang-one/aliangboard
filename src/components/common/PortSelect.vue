<script setup>
// 端口选择器（可输可选 combobox）：下拉从已知端口选，也允许手输兜底（命名端口/跨ns/无候选）。
// - 平铺模式（默认）：options 为数字/字符串或 {label,value} 数组，简单下拉。
// - 分组模式（传 groups）：groups 为 [{name,type,ports:[{port,container,name}]}]，
//   下拉左侧出现 workload 筛选（全部 + 各工作负载），右侧列出该工作负载端口（含容器/来源），
//   priorityGroup 指定的工作负载置顶并默认选中——用于「Service 优先展示其绑定 Deployment 的端口」。
// inputClass 透传输入框样式以贴合各表单原有视觉。
// 下拉面板 Teleport 到 body + position:fixed（issue #4）：此前 absolute 渲染在输入框父级内，
// 被 overflow 裁切链剪掉（IngressRulesEditor host 卡片 overflow-hidden、Modal overflow-y-auto）。
import { ref, computed, watch, nextTick, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { Z } from '@/styles/zScale'

const { t } = useI18n()

const props = defineProps({
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  // 分组：[{name, type, ports:[{port, container, name}]}]
  groups: { type: Array, default: () => [] },
  // 优先工作负载名：置顶 + 默认选中其端口
  priorityGroup: { type: String, default: '' },
  // 全部绑定工作负载名（多 workload Service）：在左侧列表中标记为已绑定（push_pin 图标）
  priorityGroups: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  inputClass: { type: String, default: '' },
  emptyHint: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'pick'])

const text = ref(String(props.modelValue ?? ''))
const focused = ref(false)
// 分组模式下当前选中的 workload（'' = 全部）
const selectedGroup = ref('')

watch(() => props.modelValue, v => {
  if (String(v ?? '') !== text.value) text.value = String(v ?? '')
})
// priorityGroup 变化（如切换 Service）→ 默认选中该绑定工作负载
watch(() => props.priorityGroup, v => {
  selectedGroup.value = v && props.groups.some(g => g.name === v) ? v : ''
}, { immediate: true })

// === 平铺模式 ===
const hasGroups = computed(() => (props.groups || []).length > 0)
const normalized = computed(() =>
  (props.options || []).map(o => (o && typeof o === 'object' ? { label: String(o.label), value: o.value } : { label: String(o), value: o })))
const filtered = computed(() => {
  const q = text.value.trim().toLowerCase()
  if (!q) return normalized.value
  return normalized.value.filter(o => String(o.value).toLowerCase().includes(q) || o.label.toLowerCase().includes(q))
})

// === 分组模式 ===
// 绑定集合（priorityGroups 全部 + priorityGroup 首个）：在左侧标记 push_pin 并置顶
const prioSet = computed(() => {
  const s = new Set(props.priorityGroups || [])
  if (props.priorityGroup) s.add(props.priorityGroup)
  return s
})
const isPrio = name => prioSet.value.has(name)
// 左侧 workload 顺序：所有绑定项置顶（priorityGroup 再首位），其余按端口数降序
const groupOrder = computed(() => {
  const prio = prioSet.value
  return [...(props.groups || [])].sort((a, b) => {
    const ap = prio.has(a.name), bp = prio.has(b.name)
    if (ap !== bp) return ap ? -1 : 1
    if (a.name === props.priorityGroup) return -1
    if (b.name === props.priorityGroup) return 1
    return b.ports.length - a.ports.length
  })
})
const allPortCount = computed(() => (props.groups || []).reduce((n, g) => n + g.ports.length, 0))
// 当前可见端口（扁平，带 workload 来源），按 selectedGroup 过滤 + 输入框文本过滤
const shownPorts = computed(() => {
  const q = text.value.trim().toLowerCase()
  const out = []
  for (const g of (props.groups || [])) {
    if (selectedGroup.value && g.name !== selectedGroup.value) continue
    for (const p of g.ports) {
      if (q && !String(p.port).includes(q) && !String(p.name).toLowerCase().includes(q)) continue
      out.push({ port: p.port, container: p.container, name: p.name, workload: g.name, type: g.type })
    }
  }
  // 端口号升序
  return out.sort((a, b) => a.port - b.port)
})

function onInput(e) {
  text.value = e.target.value
  emit('update:modelValue', text.value)
}
function pick(o) {
  text.value = String(o.value)
  emit('update:modelValue', o.value)
  focused.value = false
}
function pickPort(p) {
  text.value = String(p.port)
  emit('update:modelValue', p.port)
  emit('pick', p)  // 携带来源 workload，供父组件判断是否需要并入后端
  focused.value = false
}
function onBlur() {
  // 延迟关闭，确保 mousedown 点击候选先于失焦
  setTimeout(() => { focused.value = false }, 150)
}

// === 下拉传送定位（issue #4）===
// 面板 Teleport 到 body、fixed 锚定输入框视口 rect，脱离 overflow 祖先的裁切。
// 初始 visibility:hidden，placePanel 计算坐标后再显示，防首帧闪现在 (0,0)。
const inputRef = ref(null)
const panelRef = ref(null)
const panelStyle = ref({ position: 'fixed', top: '0px', left: '0px', visibility: 'hidden', zIndex: Z.popover })

function placePanel() {
  const inp = inputRef.value, panel = panelRef.value
  if (!inp || !panel) return
  const r = inp.getBoundingClientRect()
  const ph = panel.offsetHeight, pw = panel.offsetWidth
  // 下方空间不足且上方放得下 → 向上翻（如 TLS 行贴近卡片/弹窗底部）
  let top = r.bottom + 4
  if (top + ph > window.innerHeight - 8 && r.top - ph - 4 >= 8) top = r.top - ph - 4
  let left = r.left
  if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8)
  panelStyle.value = {
    position: 'fixed',
    top: `${top}px`,
    left: `${left}px`,
    visibility: 'visible',
    zIndex: Z.popover,
    // 平铺模式面板宽随输入框（原 absolute left-0 right-0 的等价）；分组模式固定 460px 由类承载
    ...(hasGroups.value ? {} : { width: `${Math.max(r.width, 32)}px` }),
  }
}

// scroll 用 capture：scroll 事件不冒泡，捕获阶段才能捕捉弹窗 overflow-y-auto 容器的滚动
function onDocScroll() { placePanel() }
function bindFollow() {
  window.addEventListener('scroll', onDocScroll, { capture: true, passive: true })
  window.addEventListener('resize', onDocScroll, { passive: true })
}
function unbindFollow() {
  window.removeEventListener('scroll', onDocScroll, { capture: true })
  window.removeEventListener('resize', onDocScroll)
}
watch(focused, async v => {
  if (v) {
    await nextTick()
    placePanel()
    bindFollow()
  } else {
    unbindFollow()
  }
})
onBeforeUnmount(unbindFollow)
</script>

<template>
  <div class="relative">
    <input
      ref="inputRef"
      :value="text"
      :placeholder="placeholder"
      @input="onInput"
      @focus="focused = true"
      @blur="onBlur"
      :class="['outline-none', inputClass]"
    />

    <!-- 下拉面板：Teleport body + fixed 定位（issue #4，见脚本注释）。
         外层壳只承载定位；视觉（背景/边框/阴影/滚动）在内部各面板上。 -->
    <Teleport to="body">
      <div v-if="focused" ref="panelRef" data-testid="port-select-panel" :style="panelStyle">
        <!-- 平铺模式 -->
        <template v-if="!hasGroups">
          <div
            v-if="filtered.length"
            class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg max-h-48 overflow-auto"
          >
            <button
              v-for="o in filtered"
              :key="String(o.value)"
              type="button"
              @mousedown.prevent="pick(o)"
              class="w-full flex items-center justify-between gap-sm px-md py-sm text-body-sm hover:bg-primary-container/20 transition-colors text-left"
            >
              <span class="font-medium font-mono">{{ o.value }}</span>
              <span v-if="o.label !== String(o.value)" class="text-[10px] text-on-surface-variant shrink-0">{{ o.label }}</span>
            </button>
          </div>
          <div
            v-else-if="!normalized.length"
            class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg px-md py-sm text-body-sm text-on-surface-variant"
          >
            {{ emptyHint || t('component.portSelect.emptyHint') }}
          </div>
        </template>

        <!-- 分组模式：左 workload 筛选 | 右端口列表 -->
        <div
          v-else
          class="bg-surface-container-lowest border border-outline-variant rounded-lg shadow-lg flex w-[460px] max-w-[92vw]"
        >
      <!-- 左：workload 筛选 -->
      <div class="w-44 shrink-0 border-r border-outline-variant/50 max-h-60 overflow-y-auto py-xs">
        <button
          type="button"
          @mousedown.prevent="selectedGroup = ''"
          class="w-full flex items-center justify-between gap-xs px-sm py-1.5 text-left text-body-sm transition-colors"
          :class="selectedGroup === '' ? 'bg-primary-container/20 text-primary font-semibold' : 'text-on-surface hover:bg-surface-container-low'"
        >
          <span class="flex items-center gap-xs truncate"><span class="material-symbols-outlined text-base">apps</span>{{ t('common.all') }}</span>
          <span class="text-[10px] text-on-surface-variant shrink-0">{{ allPortCount }}</span>
        </button>
        <button
          v-for="g in groupOrder"
          :key="g.name"
          type="button"
          @mousedown.prevent="selectedGroup = g.name"
          class="w-full flex items-center justify-between gap-xs px-sm py-1.5 text-left text-body-sm transition-colors"
          :class="selectedGroup === g.name ? 'bg-primary-container/20 text-primary font-semibold' : 'text-on-surface hover:bg-surface-container-low'"
        >
          <span class="flex items-center gap-xs min-w-0">
            <span class="material-symbols-outlined text-base shrink-0" :class="isPrio(g.name) ? 'text-primary' : 'text-on-surface-variant'">{{ isPrio(g.name) ? 'push_pin' : 'work' }}</span>
            <span class="truncate" :title="g.name">{{ g.name }}</span>
          </span>
          <span class="text-[10px] text-on-surface-variant shrink-0">{{ g.ports.length }}</span>
        </button>
      </div>
      <!-- 右：端口列表 -->
      <div class="flex-1 max-h-60 overflow-y-auto">
        <button
          v-for="p in shownPorts"
          :key="p.workload + ':' + p.port + ':' + p.container"
          type="button"
          @mousedown.prevent="pickPort(p)"
          class="w-full flex items-center gap-sm px-md py-1.5 text-left text-body-sm hover:bg-primary-container/20 transition-colors"
        >
          <span class="font-mono font-semibold text-primary shrink-0">{{ p.port }}</span>
          <span class="text-[10px] text-on-surface-variant truncate">{{ p.container || '—' }}<span v-if="p.name"> · {{ p.name }}</span></span>
          <span v-if="!selectedGroup" class="ml-auto text-[10px] text-on-surface-variant/60 shrink-0 truncate max-w-[90px]" :title="p.workload">{{ p.workload }}</span>
        </button>
        <p v-if="!shownPorts.length" class="px-md py-sm text-body-sm text-on-surface-variant">{{ text ? t('component.portSelect.noMatchHint') : t('component.portSelect.noPortsHint') }}</p>
      </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
