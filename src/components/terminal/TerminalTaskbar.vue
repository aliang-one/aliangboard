<script setup>
// 底部任务栏(Windows taskbar 式)四分区:终端(pod) | 文件窗口 | SSH 服务器 | 传输。
// 2026-08-29 任务栏化改造:
// - SSH 服务器分区:同服务器多终端聚合成分组 chip(dns 图标 + ×N),chip 身上的
//   「+」随时新开终端(多开入口常驻任务栏);count>1 时点 chip 弹会话菜单。
// - 折叠三层(src/utils/taskbarFit.js 纯函数决策 + runFitLoop 收敛闭环):①名称收窄为
//   截断短名 ②尾部 chip 逐个折进「⋯ n」下拉 ③方向闸门:shrink 锁定/recover 凭增长信号
//   (chip 减少/容器变宽)逐级回收。pod/文件分区保持平铺(量少)。
// - 2026-09-05 振荡修复:旧决策器闭环下 set-icon↔unset-icon 打摆,60 轮上限停在名称态
//   → 名称平铺+尾部被裁+「⋯」永不出现;详见 taskbarFit.js 头注与组合环仿真用例。
// - 2026-08-29 修复:会话菜单原先渲染在 overflow-hidden 折叠行内部且定位在任务栏
//   上方 → 整个被裁切不可见(真机几何实测 menu.top=352 vs wrap 底=491)。现改到
//   任务栏根部渲染(与溢出面板同款不裁切位置),按 chip 锚点 left 定位 + 点击遮罩关闭。
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '@/stores/terminals'
import { useFileBrowserStore } from '@/stores/fileBrowsers'
import { useTransferStore, fmtBytes } from '@/stores/transfers'
import { useSshTerminalStore } from '@/stores/sshTerminals'
import { sshApi } from '@/api/client'
import { runFitLoop } from '@/utils/taskbarFit'
import { Z } from '@/styles/zScale'
import PromptDialog from '@/components/common/PromptDialog.vue'

const { t } = useI18n()
const termStore = useTerminalStore()
const fbStore = useFileBrowserStore()
const trStore = useTransferStore()
const sshStore = useSshTerminalStore()

function onTermClick(item) {
  if (item.status === 'external') {
    if (!termStore.focusExternal(item.id)) termStore.restoreTerminal(item.id)
  } else if (item.status === 'minimized') termStore.restoreTerminal(item.id)
  else termStore.focusTerminal(item.id)
}
// 同 pod 多终端(2026-09-05):pod chip「+」= 显式多开(SSH 分组 chip 同款),恒新建;
// chip 本体点击仍是聚焦/恢复语义。
function onPodNew(chip) {
  termStore.openNewTerminal({ namespace: chip.namespace, podName: chip.podName, container: chip.container })
}
function onFilesClick(b) { b.status === 'minimized' ? fbStore.restoreBrowser(b.id) : fbStore.focusBrowser(b.id) }
function onSshItemClick(w) {
  if (w.status === 'external') { sshStore.focusExternal(w.id); return }
  if (w.status !== 'minimized' && sshStore.isDead(w.id)) {
    // 已打开但会话已被网关回收(2026-09-04 复审 F3):浮窗里的终端停在 Error 态,
    // 单纯 focus 不会重连。强制 minimize→restore 翻转,触发 SshTerminalWindow watcher
    // 的 connectIfIdle 重连——兑现 dead chip「点击重连将开启新会话」的承诺。
    sshStore.minimizeWindow(w.id)
    nextTick(() => sshStore.restoreWindow(w.id))
    return
  }
  w.status === 'minimized' ? sshStore.restoreWindow(w.id) : sshStore.focusWindow(w.id)
}

// —— SSH 分组 chip ——
const sshChips = computed(() => sshStore.groups.map(g => ({
  kind: 'ssh', id: g.serverId, name: g.name, count: g.count,
  status: g.windows.some(w => w.status === 'open') ? 'open' : 'minimized', windows: g.windows,
  dead: g.windows.length > 0 && g.windows.every(w => sshStore.isDead(w.id)),   // 事故④:全部窗口已被网关回收
})))
const menuOpenFor = ref('')   // 打开会话菜单的 serverId(同时最多一个)
const menuLeft = ref(0)       // 菜单锚点(chip 左缘,任务栏根部渲染用)
const anchorEl = ref(null)    // chip 元素,打开时记下位置
function onSshChipClick(chip, evt) {
  if (chip.count === 1) {           // 单窗:直接恢复/聚焦,菜单对单窗是多余一步
    menuOpenFor.value = ''
    return onSshItemClick(chip.windows[0])
  }
  if (menuOpenFor.value === chip.id) { menuOpenFor.value = ''; return }
  anchorEl.value = evt?.currentTarget || null
  // 手机右缘钳制(2026-09-09 Wave5 B7):menuLeft 直用 chip 左缘,右半屏 chip 的
  // min-w-[200px] 菜单右缘会出屏(390px 视口 left≈250+200>390,行内关闭/改名钮不可达)。
  // 右缘留 220px(菜单宽+边距)、左缘不小于 8——对齐 WorkbenchEntryPill 面板钳制配方。
  menuLeft.value = anchorEl.value
    ? Math.max(8, Math.min(anchorEl.value.getBoundingClientRect().left, window.innerWidth - 220))
    : 8
  menuOpenFor.value = chip.id
  overflowOpen.value = false
}
const closeMenus = () => { menuOpenFor.value = ''; overflowOpen.value = false }
const onSshNew = chip => { sshStore.openNew({ id: chip.id, name: chip.name }); menuOpenFor.value = '' }

// —— 会话标签改名(2026-09-08):同服多会话区分。入口=会话菜单行 ✏️;初值=当前有效名
// (label||name,非纯 label——改后缀比重敲省事);清回默认=手输服务器名。 ——
const menuRenameFor = ref('')
const renameTarget = computed(() => sshStore.windows.find(w => w.id === menuRenameFor.value) || null)
const renameInitial = computed(() => renameTarget.value ? (renameTarget.value.label || renameTarget.value.name) : '')
function onRenameConfirm(v) {
  if (menuRenameFor.value) sshStore.renameWindow(menuRenameFor.value, v)
  menuRenameFor.value = ''
}

// —— 网关真值对账(2026-08-29 泄漏审计)——
// 任务栏是 localStorage 视图,网关侧可能存在本地不知情的存活会话(弹窗标签页自建 sid /
// 清过存储 / 换浏览器 / 其他管理员的会话)。30s 轻轮询对账:未跟踪会话显示为警示 chip
// (置首,点击确认后手杀);非 admin(403)或网络失败静默降级为纯本地视图。
// 反向差集(2026-09-04 事故④):本地有而网关无 → 死 chip 置灰提示「已回收,重连=新会话」,
// 替代「点开才知道是空 shell」。判死需连续两轮缺失(新建窗口的 WS 未在网关 ensure 前首轮
// 缺失属建连窗口期);最近本地关闭的跳过;listSessions 失败走 catch 不动判定态(网络抖动不误标)。
const orphans = ref([])
let reconcileTimer = null
let missingOnce = new Set()   // sid:首轮缺失的宽限集合
async function reconcile() {
  try {
    const { sessions } = await sshApi.listSessions()
    const alive = new Set(sessions.map(s => s.sid))
    const known = new Set(sshStore.windows.map(w => w.id))
    // recentlyClosed:自家刚显式关闭、网关尚未 reap(默认 detachedIdle 10min)的会话,
    // 不标红警示——「明明关了还提示开着」的鬼影来源之一
    orphans.value = sessions.filter(s => !known.has(s.sid) && !sshStore.isRecentlyClosed(s.sid))
    const stillMissing = new Set()
    const dead = []
    for (const w of sshStore.windows) {
      if (alive.has(w.id)) { missingOnce.delete(w.id); sshStore.markAliveSid(w.id); continue }
      if (sshStore.isRecentlyClosed(w.id)) continue
      if (missingOnce.has(w.id)) dead.push(w.id)
      stillMissing.add(w.id)
    }
    missingOnce = stillMissing
    sshStore.markDeadSids(dead)
  } catch { orphans.value = [] }
}
async function killOrphan(chip) {
  if (!confirm(t('terminal.orphanKillConfirm'))) return
  try { await sshApi.killSession(chip.id) } catch { /* 404 = 清道夫已收走,照样摘 chip */ }
  orphans.value = orphans.value.filter(x => x.sid !== chip.id)
}
// 孤儿重附(2026-09-06):网关有会话而本地记录已丢——重建记录+弹窗重开同 sid,
// 网关回放环形缓冲,历史找回;不再「点 chip 即杀」(误触不可逆)。
function reattachOrphan(chip) {
  sshStore.reattachOrphan({ id: chip.id, serverId: chip.name, name: chip.name })
  orphans.value = orphans.value.filter(x => x.sid !== chip.id)
}
const orphanChips = computed(() => orphans.value.map(s => ({ kind: 'orphan', id: s.sid, name: s.serverId, user: s.userId, count: 1 })))

// —— 三类 chip 拍平(折叠按此顺序从尾部吃;orphan 置首=警示最晚被折)——
const podChips = computed(() => termStore.terminals.map(t => ({ kind: 'pod', id: t.id, name: t.name, status: t.status, namespace: t.namespace, podName: t.podName, container: t.container })))
const fileChips = computed(() => fbStore.browsers.map(b => ({ kind: 'file', id: b.id, name: b.name, status: b.status })))
const flat = computed(() => [...orphanChips.value, ...podChips.value, ...fileChips.value, ...sshChips.value])
const flatSig = computed(() => flat.value.map(c => `${c.kind}:${c.id}:${c.status}`).join('|'))
// 菜单数据源:当前打开菜单的分组(从 groups 派生,窗口关闭后自动消失)
const menuChip = computed(() => sshChips.value.find(c => c.id === menuOpenFor.value) || null)

// —— 三层折叠(收敛闭环:runFitLoop 测量→决策→应用,方向闸门防振荡)——
// fitDir='shrink' 只收不放、放得下即锁;仅当空间确认富余(chip 总数减少/容器变宽)才放行
// 'recover' 逐级回收。旧版无方向闸门,闭环 set-icon↔unset-icon 打摆 60 轮停在名称态:
// 宽屏多终端=名称平铺+overflow-hidden 裁掉尾部+「⋯」永不出现(2026-09-05 用户报告根因)。
const wrap = ref(null)
const iconMode = ref(false)
const overflowCount = ref(0)
const overflowOpen = ref(false)
const fitDir = ref('shrink')
let prevTotal = 0
let prevWidth = 0
const visible = computed(() => flat.value.slice(0, flat.value.length - overflowCount.value))
const folded = computed(() => flat.value.slice(flat.value.length - overflowCount.value))
let raf = 0
function scheduleRefit() {
  if (raf) cancelAnimationFrame(raf)
  raf = requestAnimationFrame(() => { raf = 0; refit() })
}
async function refit() {
  const el = wrap.value
  if (!el || typeof el.scrollWidth !== 'number') return
  if (flat.value.length < prevTotal || el.clientWidth > prevWidth + 1) fitDir.value = 'recover'
  prevTotal = flat.value.length
  prevWidth = el.clientWidth
  await runFitLoop({
    measure: () => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }),
    getTotal: () => flat.value.length,
    getDirection: () => fitDir.value,
    setDirection: d => { fitDir.value = d },
    getIconMode: () => iconMode.value,
    setIconMode: v => { iconMode.value = v },
    getOverflowCount: () => overflowCount.value,
    setOverflowCount: v => { overflowCount.value = v },
    tick: nextTick,
  })
}
watch(flatSig, () => { overflowOpen.value = false; scheduleRefit() })
watch(overflowCount, () => { overflowOpen.value = false })
watch(iconMode, scheduleRefit)
let ro = null
onMounted(() => {
  scheduleRefit()
  reconcile()
  reconcileTimer = setInterval(reconcile, 30000)
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    ro = new ResizeObserver(() => scheduleRefit())
    ro.observe(wrap.value)
  } else {
    window.addEventListener('resize', scheduleRefit)
  }
})
onUnmounted(() => { if (ro) ro.disconnect(); else window.removeEventListener('resize', scheduleRefit); if (raf) cancelAnimationFrame(raf); if (reconcileTimer) clearInterval(reconcileTimer) })

const sessionCount = computed(() => termStore.terminals.length + fbStore.browsers.length + sshStore.windows.length + orphans.value.length)
const hasAny = computed(() => sessionCount.value > 0 || trStore.tasks.length > 0)
const agg = computed(() => trStore.aggregate)
// 单任务直显名称+%;多任务汇总「done/count · 加权%」
const transferText = computed(() => {
  const a = agg.value
  if (a.count === 1) {
    const tk = trStore.tasks[0]
    const pct = tk.total > 0 ? Math.round((tk.received / tk.total) * 100) + '%' : fmtBytes(tk.received)
    return `${tk.name} ${pct}`
  }
  const pct = a.pct !== null ? ` · ${a.pct}%` : ''
  return `${t('transfers.summaryMulti', { done: a.doneCount, count: a.count })}${pct}`
})

function closeAll() {
  if (!sessionCount.value) return
  if (confirm(t('transfers.closeAllConfirm', { count: sessionCount.value }))) {
    [...termStore.terminals].forEach(item => termStore.closeTerminal(item.id))
    ;[...fbStore.browsers].forEach(b => fbStore.closeBrowser(b.id))
    ;[...sshStore.windows].forEach(w => sshStore.closeWindow(w.id))
  }
}
</script>

<template>
  <div v-if="hasAny" class="relative flex items-center gap-xs px-md bg-surface-container-highest border-t border-outline-variant shadow-lg shrink-0" style="height: 32px">
    <button v-if="sessionCount" @click="closeAll" class="flex items-center gap-xs px-sm py-0.5 rounded-md text-body-xs bg-error/10 text-error hover:bg-error/20 border border-error/20 transition-colors shrink-0 max-sm:min-h-[40px] max-sm:min-w-[40px]" :title="t('terminal.closeAllTitle')">
      <span class="material-symbols-outlined text-sm">delete_sweep</span>{{ t('terminal.closeAll') }}
    </button>
    <span v-if="sessionCount" class="w-px h-4 bg-outline-variant/40 shrink-0"></span>
    <!-- 可折叠区:pod 终端 | 文件窗口 | SSH 服务器分组 chip -->
    <div ref="wrap" class="flex-1 flex items-center gap-xs overflow-hidden min-w-0">
      <template v-for="chip in visible" :key="chip.kind + '-' + chip.id">
        <!-- 未跟踪会话警示 chip(error 色系,置首):网关有而本地无的存活会话——点击重附
             (重建记录+弹窗重开同 sid,回放历史),× 确认后终止(2026-09-06:不再点即杀) -->
        <button v-if="chip.kind === 'orphan'" data-test="orphan-chip" @click="reattachOrphan(chip)"
          class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0 bg-error/10 text-error border border-error/30 hover:bg-error/20 max-sm:min-h-[40px] max-sm:min-w-[40px]"
          :title="t('terminal.orphanChipTitle', { serverId: chip.name, user: chip.user })">
          <span class="material-symbols-outlined text-sm">link_off</span>
          <span class="truncate font-mono" :class="iconMode ? 'max-w-[64px]' : ''">{{ chip.name }}</span>
          <span @click.stop="killOrphan(chip)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-error/60 hover:text-error transition-colors opacity-0 group-hover:opacity-100 max-sm:opacity-100 max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center" :title="t('terminal.closeThisTitle')">
            <span class="material-symbols-outlined" style="font-size:13px">close</span>
          </span>
        </button>
        <!-- pod 终端(「+」=同 pod 再开一个,与 SSH 分组 chip 同款;chip 本体点击=聚焦/恢复) -->
        <button v-if="chip.kind === 'pod'" :data-test="'pod-chip-' + chip.id" @click="onTermClick(termStore.terminals.find(x => x.id === chip.id))"
          class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0 max-sm:min-h-[40px] max-sm:min-w-[40px]"
          :class="chip.status === 'open' ? 'bg-primary/15 text-primary border border-primary/30' : chip.status === 'external' ? 'bg-secondary/10 text-secondary border border-secondary/30' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent'"
          :title="`${chip.name}（${chip.status === 'open' ? t('terminal.statusFloating') : chip.status === 'external' ? t('terminal.statusExternal') : t('terminal.statusMinimized')}）`">
          <span class="material-symbols-outlined text-sm">{{ chip.status === 'open' ? 'terminal' : chip.status === 'external' ? 'open_in_new' : 'hide_source' }}</span>
          <span class="truncate" :class="iconMode ? 'max-w-[64px]' : ''">{{ chip.name }}</span>
          <span v-if="!iconMode" @click.stop="onPodNew(chip)" class="ml-0.5 px-1 rounded hover:bg-primary/30 text-primary leading-4 max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center" :title="t('terminal.podNewTerminal')">+</span>
          <span @click.stop="termStore.closeTerminal(chip.id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100 max-sm:opacity-100 max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center" :title="t('terminal.closeThisTitle')">
            <span class="material-symbols-outlined" style="font-size:13px">close</span>
          </span>
        </button>
        <!-- 文件窗口 -->
        <button v-else-if="chip.kind === 'file'" @click="onFilesClick(fbStore.browsers.find(x => x.id === chip.id))"
          class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0 max-sm:min-h-[40px] max-sm:min-w-[40px]"
          :class="chip.status === 'open' ? 'bg-tertiary-container/15 text-tertiary-container border border-tertiary-container/30' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent'"
          :title="`${chip.name}（${chip.status === 'open' ? t('terminal.statusFloating') : t('terminal.statusMinimized')}）`">
          <span class="material-symbols-outlined text-sm">{{ chip.status === 'open' ? 'folder_open' : 'hide_source' }}</span>
          <span class="truncate" :class="iconMode ? 'max-w-[64px]' : ''">{{ chip.name }}</span>
          <span @click.stop="fbStore.closeBrowser(chip.id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100 max-sm:opacity-100 max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center" :title="t('terminal.closeThisTitle')">
            <span class="material-symbols-outlined" style="font-size:13px">close</span>
          </span>
        </button>
        <!-- SSH 服务器分组 chip(secondary 色系,与 pod/files 三色分明);dead=网关已回收全部窗口(事故④):置灰+警示 -->
        <button v-else-if="chip.kind === 'ssh'" :data-test="'ssh-chip-' + chip.id" @click="onSshChipClick(chip, $event)"
          class="group flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs transition-all max-w-[220px] shrink-0 max-sm:min-h-[40px] max-sm:min-w-[40px]"
          :class="[chip.status === 'open' ? 'bg-secondary-container/25 text-secondary border border-secondary/40' : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent', chip.dead ? 'border border-dashed border-error/50 opacity-80' : '']"
          :title="`${chip.name} · SSH（${chip.count === 1 ? t('terminal.statusFloating') : t('terminal.sshSessions', { n: chip.count })}）${chip.dead ? ' · ' + t('terminal.sessionReapedTitle') : ''}`">
          <span class="material-symbols-outlined text-sm" :class="chip.dead ? 'text-error' : ''">{{ chip.dead ? 'link_off' : 'dns' }}</span>
          <span class="truncate" :class="iconMode ? 'max-w-[64px]' : ''">{{ chip.name }}</span>
          <span v-if="chip.count > 1" class="text-[10px] font-mono px-1 rounded bg-secondary/20">×{{ chip.count }}</span>
          <span v-if="!iconMode || chip.count > 1" @click.stop="onSshNew(chip)" class="ml-0.5 px-1 rounded hover:bg-secondary/30 text-secondary leading-4 max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center" :title="t('terminal.sshNewTerminal')">+</span>
          <span @click.stop="sshStore.closeWindow(chip.windows[chip.windows.length - 1].id)" class="ml-xs p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error transition-colors opacity-0 group-hover:opacity-100 max-sm:opacity-100 max-sm:min-h-[40px] max-sm:min-w-[40px] max-sm:inline-flex max-sm:items-center max-sm:justify-center" :title="t('terminal.closeThisTitle')">
            <span class="material-symbols-outlined" style="font-size:13px">close</span>
          </span>
        </button>
      </template>
      <!-- 溢出收纳「⋯ n」:折进来的 chip 点即恢复(SSH 分组恢复/弹菜单按原语义) -->
      <button v-if="folded.length" data-test="overflow-more" @click="overflowOpen = !overflowOpen; menuOpenFor = ''"
        class="flex items-center gap-xs px-sm py-0.5 rounded-md text-body-xs shrink-0 bg-surface-container-low text-on-surface-variant hover:bg-surface-container border border-transparent max-sm:min-h-[40px]"
        :title="t('terminal.overflowMore', { n: folded.length })">
        <span class="material-symbols-outlined text-sm">more_horiz</span>{{ folded.length }}
      </button>
    </div>
    <!-- 分区:传输(百分比) -->
    <button v-if="trStore.tasks.length" @click="trStore.openPanel()"
      class="flex items-center gap-xs pl-sm pr-xs py-0.5 rounded-md text-body-xs shrink-0 transition-all max-w-[260px] max-sm:min-h-[40px]"
      :class="agg.activeCount ? 'bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20' : 'bg-surface-container-low text-on-surface-variant border border-transparent hover:bg-surface-container'"
      :title="t('transfers.openPanelTitle')">
      <span class="material-symbols-outlined text-sm" :class="agg.activeCount ? 'animate-spin' : ''">{{ agg.count > 1 ? 'swap_vert' : (trStore.tasks[0].kind === 'download' ? 'download' : 'upload') }}</span>
      <span class="truncate">{{ transferText }}</span>
      <span v-if="!agg.activeCount" class="material-symbols-outlined text-sm">check_circle</span>
    </button>
    <span class="ml-auto text-body-xs text-on-surface-variant/40 shrink-0">{{ t('transfers.sessionsCount', { count: sessionCount }) }}</span>

    <!-- 点击遮罩:点任意处关闭菜单/下拉(透明,恒在弹层之下) -->
    <div v-if="menuChip || overflowOpen" class="fixed inset-0" :style="{ zIndex: Z.modal }" @click="closeMenus"></div>

    <!-- 会话标签改名弹窗(Modal Teleport body,恒在菜单之上) -->
    <PromptDialog
      v-if="menuRenameFor"
      :model-value="true"
      :title="t('ssh.renameSession')"
      :message="renameTarget ? `ssh://${renameTarget.name}` : ''"
      :label="t('ssh.sessionLabel')"
      :initial-value="renameInitial"
      select-all
      @confirm="onRenameConfirm"
      @cancel="menuRenameFor = ''"
    />

    <!-- SSH 会话菜单:任务栏根部渲染(overflow-hidden 裁切修复),按 chip 锚点定位。
         会话标签(2026-09-08):行名 label||name——同服多会话不再全同名;✏️ 改名(PromptDialog) -->
    <div v-if="menuChip" data-test="ssh-session-menu" class="absolute bottom-full mb-xs min-w-[200px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-xl p-xs" :style="{ left: menuLeft + 'px', zIndex: Z.modal + 1 }">
      <button v-for="(w, i) in menuChip.windows" :key="w.id" @click="onSshItemClick(w); menuOpenFor = ''"
        class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs hover:bg-surface-container text-left max-sm:min-h-[40px]">
        <span class="material-symbols-outlined text-sm" :class="w.status === 'open' ? 'text-secondary' : 'text-on-surface-variant/50'">{{ w.status === 'open' ? 'terminal' : 'hide_source' }}</span>
        <span class="truncate flex-1 font-mono min-w-0">#{{ i + 1 }} · {{ w.label || w.name }}</span>
        <span class="text-on-surface-variant/50 shrink-0">{{ w.status === 'open' ? t('terminal.statusFloating') : t('terminal.statusMinimized') }}</span>
        <span @click.stop="menuRenameFor = w.id" class="p-0.5 rounded hover:bg-surface-container text-on-surface-variant/50 hover:text-primary relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']" :title="t('ssh.renameSession')">
          <span class="material-symbols-outlined" style="font-size:13px">edit</span>
        </span>
        <span @click.stop="sshStore.closeWindow(w.id)" class="p-0.5 rounded hover:bg-error/20 text-on-surface-variant/50 hover:text-error relative max-sm:after:absolute max-sm:after:-inset-2 max-sm:after:content-['']">
          <span class="material-symbols-outlined" style="font-size:13px">close</span>
        </span>
      </button>
      <button @click="onSshNew(menuChip)" class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs text-secondary hover:bg-secondary/10 border-t border-outline-variant/40 mt-xs pt-sm max-sm:min-h-[40px]">
        <span class="material-symbols-outlined text-sm">add</span>{{ t('terminal.sshNewTerminal') }}
      </button>
    </div>

    <!-- 溢出下拉面板(根部渲染,同款不裁切) -->
    <div v-if="overflowOpen && folded.length" class="absolute bottom-full right-md mb-xs min-w-[220px] bg-surface-container-lowest border border-outline-variant rounded-lg shadow-xl p-xs" :style="{ zIndex: Z.modal + 1 }">
      <button v-for="chip in folded" :key="'ov-' + chip.kind + '-' + chip.id" @click="overflowOpen = false; chip.kind === 'orphan' ? reattachOrphan(chip) : chip.kind === 'pod' ? onTermClick(termStore.terminals.find(x => x.id === chip.id)) : chip.kind === 'file' ? onFilesClick(fbStore.browsers.find(x => x.id === chip.id)) : onSshChipClick(chip, $event)"
        class="w-full flex items-center gap-xs px-sm py-xs rounded-md text-body-xs hover:bg-surface-container text-left max-sm:min-h-[40px]">
        <span class="material-symbols-outlined text-sm" :class="chip.kind === 'orphan' ? 'text-error' : chip.kind === 'ssh' ? 'text-secondary' : chip.kind === 'file' ? 'text-tertiary-container' : 'text-primary'">{{ chip.kind === 'orphan' ? 'link_off' : chip.kind === 'ssh' ? 'dns' : chip.kind === 'file' ? 'folder_open' : 'terminal' }}</span>
        <span class="truncate flex-1">{{ chip.name }}<span v-if="chip.count > 1" class="text-on-surface-variant/60 ml-xs">×{{ chip.count }}</span></span>
      </button>
    </div>
  </div>
</template>
