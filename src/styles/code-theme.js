// 暗底代码/终端主题色板（单一来源）。
// 代码查看器(CodeViewer/YamlEditor)、日志(PodDetail)、差异(NsWorkloadDetail)、终端(InteractiveTerminal/TerminalPopup)
// 全部走这套配色。tailwind.config.js 的 colors 与 xterm/prism 等需要原始 hex 的 JS 主题对象都引用此处，
// 避免在 12+ 个文件里散落硬编码（此前 #0b1c30/#cfe3ff 各出现十几次）。
export const codeTheme = {
  surface: '#0b1c30',    // 代码/日志/终端块底色 → bg-code-surface
  onSurface: '#cfe3ff',  // 代码块文字（含 FileBrowserBody 此前的 #dbe7f7 已并入此处统一）→ text-on-code-surface
  selection: '#1f3b5e',  // 选区/差异高亮底色 → bg-code-surface-selection
  dim: '#1a1c1e',        // 终端标题条（比 surface 更暗的中性色）→ bg-code-surface-dim
}
