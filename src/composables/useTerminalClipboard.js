// 终端剪贴板按键接管(2026-10-16「Ctrl+V 粘贴不到」根因修复,pod/SSH 双终端共享):
// xterm 默认把 Ctrl+V 求值为 \x16(quoted-insert)、Ctrl+C 求值为 \x03(SIGINT)发给远端,
// 并 preventDefault 掉浏览器剪贴板动作 —— 用户肌肉记忆的 Ctrl+V 永远粘贴不到、选中后
// Ctrl+C 永远不复制。接管方式:对目标键 return false(xterm 官方约定 = 不再处理该键、
// 不调 preventDefault),浏览器默认把 paste/copy 事件落到 xterm 自带的 textarea+element
// 监听上:paste → onData → WS(与键盘同通路),copy → 写入选中文本。
// 零权限、非 HTTPS 也可用(不经 navigator.clipboard.readText,该 API 需安全上下文)。
// Mac 检测:iPad 桌面级 Safari UA 同含 Mac,一并按 Cmd 习惯处理
const detectMac = () => typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent || '')

// 接管规则:
//  - Ctrl+V(无 shift/alt/meta):一律放行为浏览器粘贴(xterm 对 ctrl 字母组默认产控制码,
//    \x16 对用户无感知价值,放行不损失能力;Ctrl+Shift+V / Cmd+V 原本就通,不受影响)
//  - Ctrl+C:仅「非 Mac 且有选区」时放行为浏览器复制;无选区保持 \x03(SIGINT),
//    Mac 的复制习惯是 Cmd+C(原生已通),Ctrl+C 恒终端语义
export function attachTerminalClipboardKeys(term, { isMac = detectMac() } = {}) {
  term.attachCustomKeyEventHandler(ev => {
    if (ev.type !== 'keydown') return true                    // keypress/keyup 不拦(否则输入路径断流)
    if (!ev.ctrlKey || ev.shiftKey || ev.altKey || ev.metaKey) return true
    if (ev.code === 'KeyV') return false
    if (ev.code === 'KeyC' && !isMac && term.hasSelection()) return false
    return true
  })
}
