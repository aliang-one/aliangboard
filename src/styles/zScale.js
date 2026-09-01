// 全局浮层 z-index 阶梯——单一事实源。全局 fixed/Teleport 浮层一律从此取值,
// 禁止新增裸 z-[N] 魔数(issue #3: toast 与弹窗同为 z-[100],弹窗 Teleport 到 body
// 后到 DOM 而盖住 toast,再被遮罩 backdrop-blur 糊化,用户看不到错误)。
// 内容级局部层叠(z-10~50 的 Tailwind 类,如 TagInput z-30/DropdownMenu z-40/
// TopNavBar sticky z-50)不在本阶梯管辖——它们处于局部 stacking context 内。
export const Z = {
  nav: 50,         // 顶栏 sticky 层(内容级最高,参照值)
  drawer: 55,      // 手机侧栏抽屉(2026-09-01 手机适配 Wave 1a):高于顶栏 nav=50,低于窗口带
  windowBase: 60,  // 浮动窗口带下限(终端/文件浏览器浮窗、全局 loading bar)
  windowMax: 99,   // 浮动窗口带上限:恒低于 modal
  modal: 100,      // 模态弹窗层(Modal/CreateResourceDialog/ScaleDialog/NodeActions/hover 富卡片)
  popover: 110,    // 传送型下拉弹层(PortSelect combobox,issue #4):弹窗内打开的下拉须盖过
                   // 所在 modal 的表面;仍低于 priority modal(其内暂无下拉消费方)与 toast。
  modalPriority: 150, // 优先模态层(阻塞式审批 Modal,2026-08-27):盖过一切普通 modal(悬浮
                   // ChatModal 后开盖住审批的场景),仍低于 toast(全局错误提示恒最高)。
  toast: 200,      // 全局 toast:恒在一切浮层之上
}

// 浮动窗口 z 分配器:带内单调递增;计数器将越出 windowMax、或 open 窗口里存在
// 带外 z(旧代码遗留)时,先把当前 open 窗口按现序(低→高)重排回带内再分配——
// 修复旧代码两处越界:
// 1) rehydrate 时 nextZ = 100 + loaded.length 直接跳到 modal 层之上;
// 2) ++nextZ 无上界,长会话单调增长穿透窗口带。
export function createWindowZAllocator() {
  let next = Z.windowBase
  return {
    nextZ(openItems) {
      const maxItem = openItems.reduce((m, it) => Math.max(m, it.zIndex || 0), 0)
      if (next >= Z.windowMax || maxItem >= Z.windowMax) this.renumber(openItems)
      return ++next
    },
    renumber(openItems) {
      next = Z.windowBase
      const sorted = [...openItems].sort((a, b) => a.zIndex - b.zIndex)
      for (const it of sorted) it.zIndex = ++next
    },
  }
}
