// YAML 标量序列化：把任意字符串值安全地编进 YAML（用于 metadata.annotations / labels 等键值）。
// 含换行走 block scalar(|-)，含特殊字符走双引号转义，否则裸值。
//
// block scalar 内容固定缩进 6 空格——对应 metadata 下 4 空格缩进的键（annotations/labels）。
// 单一事实源：cluster.js 的 generateYAML 与 DeployApp 向导的手写 YAML 都用本函数，
// 避免「多行 server-snippet / 反斜杠 / 双引号」等值损坏 YAML（曾导致 Ingress apply 失败）。
export function yamlScalar(v) {
  const s = String(v ?? '')
  if (s.includes('\n')) return '|-\n' + s.split('\n').map(l => '      ' + l).join('\n')
  if (s === '' || /^\s|\s$/.test(s) || /[:#{}\[\],&*?|<>=!%@`"']/.test(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }
  return s
}
