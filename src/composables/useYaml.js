import { dump } from 'js-yaml'

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

// 把 K8s 原始对象转成「干净 YAML」：深拷贝后剔除 metadata.managedFields（冗长），
// 默认保留 status；stripStatus:true 时一并剔除 status（只读/派生）。
// 供详情页「查看 YAML」复用——避免每个详情页各自 api.k8s 再拉一遍同一对象。
export function dumpResourceYaml(raw, { stripStatus = false } = {}) {
  if (!raw) return ''
  const clone = JSON.parse(JSON.stringify(raw))
  if (clone?.metadata) delete clone.metadata.managedFields
  if (stripStatus && clone?.status) delete clone.status
  return dump(clone)
}
