import { ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { Z } from '@/styles/zScale'

// 下拉弹层「Teleport 到 body + position:fixed 锚定触发元素」共享配方。
// 首创于 PortSelect(issue #4:absolute 就地面板被 overflow 祖先裁切——
// IngressRulesEditor overflow-hidden、Modal overflow-y-auto、DeployApp 向导根
// overflow-hidden、DataTable overflow-x-auto 均在案);2026-09-01 下拉遮挡排查
// (EnvSourceField/TagInput/DataTable 列管理/DropdownMenu 同病)抽为此 composable。
//
// 用法:
//   const trg = ref(null)
//   const open = ref(false)
//   const { panelRef, panelStyle } = useDropdownPanel(trg, open, { align: 'left', matchTriggerWidth: true })
//   <Teleport to="body">
//     <div v-if="open" ref="panelRef" data-testid="..." :style="panelStyle">…视觉面板…</div>
//   </Teleport>
//
// - 定位:触发元素 rect 锚定;align='left' 对齐左缘、'right' 对齐右缘(⋮ 菜单/表头弹层)
// - matchTriggerWidth:面板宽=触发元素宽(等价原 absolute left-0 right-0)
// - 下方放不下且上方放得下 → 向上翻(贴近卡片/弹窗底部时)
// - 右缘越界夹回视口;scroll(capture,scroll 事件不冒泡)+resize 跟随重算
// - 初始 visibility:hidden,placePanel 算出坐标再显示,防首帧闪现 (0,0)
export function useDropdownPanel(triggerRef, open, opts = {}) {
  const { align = 'left', matchTriggerWidth = false } = opts
  const panelRef = ref(null)
  const panelStyle = ref({ position: 'fixed', top: '0px', left: '0px', visibility: 'hidden', zIndex: Z.popover })

  function placePanel() {
    const trg = triggerRef.value
    const panel = panelRef.value
    if (!trg || !panel) return
    const r = trg.getBoundingClientRect()
    const ph = panel.offsetHeight
    const pw = panel.offsetWidth
    let top = r.bottom + 4
    if (top + ph > window.innerHeight - 8 && r.top - ph - 4 >= 8) top = r.top - ph - 4
    let left = align === 'right' ? r.right - pw : r.left
    if (left + pw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - pw - 8)
    panelStyle.value = {
      position: 'fixed',
      top: `${top}px`,
      left: `${left}px`,
      visibility: 'visible',
      zIndex: Z.popover,
      ...(matchTriggerWidth ? { width: `${Math.max(r.width, 32)}px` } : {}),
    }
  }

  // scroll 用 capture:scroll 事件不冒泡,捕获阶段才能捕捉弹窗 overflow-y-auto 容器的滚动
  function onDocScroll() { placePanel() }
  function bindFollow() {
    window.addEventListener('scroll', onDocScroll, { capture: true, passive: true })
    window.addEventListener('resize', onDocScroll, { passive: true })
  }
  function unbindFollow() {
    window.removeEventListener('scroll', onDocScroll, { capture: true })
    window.removeEventListener('resize', onDocScroll)
  }

  watch(open, async v => {
    if (v) {
      await nextTick()
      placePanel()
      bindFollow()
    } else {
      unbindFollow()
    }
  })
  onBeforeUnmount(unbindFollow)

  return { panelRef, panelStyle, placePanel }
}
