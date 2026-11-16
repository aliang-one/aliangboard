// 中文输入法(IME)组合期按键防线单源(2026-11-16 事故:终端 tab 改名弹窗把「拼音选词
// 回车」当成确认,改到一半的名字被提前提交)。
// 组合期 Enter=确认候选词、Esc=取消组合——都是 IME 的键,不得触发业务动作(确认/取消/发送)。
// 判定两层,同 Chrome 官方指南「IME-safe enter-to-submit」:
// 1) isComposing —— Chrome/Edge/Firefox 组合期 keydown(含提交候选的那次 Enter)恒 true;
// 2) keyCode 229 —— Safari 把 compositionend 先于确认 Enter 派发给脚本(WebCore bug 165004,
//    此时 isComposing 已翻回 false),但该 keydown 仍报 VK_PROCESSKEY(229),第二条拦它;
//    旧实现普遍以 229 标记组合期,双保险。
// 先例:WorkbenchChat.vue 聊天输入框(此防线自此全站单源化,新输入框一律复用)。
export function isImeKeyEvent(e) {
  return e.isComposing || e.keyCode === 229
}

// 「Enter 确认 / Esc 取消」单输入 keydown 工厂——替代 @keydown.enter/.esc 修饰符(修饰符
// 无法表达 IME 防线)。组合期按键既不触发动作也不 preventDefault,原样交还输入法;
// 非组合期 Enter/Esc 才接管(preventDefault 防 input 隐式提交等默认行为)。
export function enterEscKeydown({ onEnter, onEscape } = {}) {
  return function onKeydown(e) {
    if (isImeKeyEvent(e)) return
    if (e.key === 'Enter' && onEnter) { e.preventDefault(); onEnter(e) }
    else if (e.key === 'Escape' && onEscape) { e.preventDefault(); onEscape(e) }
  }
}
