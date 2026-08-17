import { dump } from 'js-yaml'

// YAML 标量序列化：把任意字符串值安全地编进 YAML（用于 metadata.annotations / labels 等键值）。
// 含换行走 block scalar(|-)，含特殊字符或会被 YAML 隐式类型化的值走双引号转义，否则裸值。
//
// block scalar 内容固定缩进 6 空格——对应 metadata 下 4 空格缩进的键（annotations/labels）。
// 单一事实源：cluster.js 的 generateYAML 与 DeployApp 向导的手写 YAML 都用本函数，
// 避免「多行 server-snippet / 反斜杠 / 双引号」等值损坏 YAML（曾导致 Ingress apply 失败）。
//
// 隐式类型化防线（2026-08-16 Ingress 注解线上事故）：annotations/labels/ConfigMap data/
// Secret stringData 的 K8s 目标类型都是 map[string]string，而 apiserver 以 YAML 1.1 语义
// （sigs.k8s.io/yaml→yaml.v2）解析 apply-patch——裸 3600/true/~/2026-08-16 会被解析成
// int/bool/null/timestamp：int/bool 直接被拒（expected string, got valueUnstructured），
// timestamp 更遭静默改写成 RFC3339。故凡 1.1 真相表内会变成非字符串的值，一律加引号。

// yaml.v2 的 bool/null 全家（YAML 1.1 语义，比 1.2 多 y/n/yes/no/on/off 系——js-yaml 按 1.2
// 解析这些会得到字符串，不能拿它当裁判，须按 K8s 实际语义硬编码真相表）。
const YAML11_NULL = new Set(['~', 'null', 'Null', 'NULL'])
const YAML11_BOOL = new Set([
  'y', 'Y', 'yes', 'Yes', 'YES', 'n', 'N', 'no', 'No', 'NO',
  'true', 'True', 'TRUE', 'false', 'False', 'FALSE', 'on', 'On', 'ON', 'off', 'Off', 'OFF',
])
function yaml11NonString(s) {
  return YAML11_NULL.has(s) || YAML11_BOOL.has(s)
    || /^[-+]?(?:[\d_]+|0[xXoObB][0-9a-fA-F_]+)$/.test(s)               // int（十进制/下划线 1_000/0x 0b 0o，0755 为八进制）
    || /^[-+]?(\d[\d_]*(\.[\d_]*)?|\.\d[\d_]*)([eE][-+]?\d+)?$/.test(s) // float/科学计数（含 int，冗余无害）
    || /^[-+]?\.(?:inf|Inf|INF)$/.test(s) || /^\.(?:nan|NaN|NAN)$/.test(s)
    || /^\d{4}-\d{1,2}-\d{1,2}([Tt ].*)?$/.test(s)                      // timestamp（yaml.v2 解析后转 JSON 会改写值）
}
export function yamlScalar(v) {
  const s = String(v ?? '')
  if (s.includes('\n')) return '|-\n' + s.split('\n').map(l => '      ' + l).join('\n')
  if (s === '' || /^\s|\s$/.test(s) || /[:#{}\[\],&*?|<>=!%@`"']/.test(s) || yaml11NonString(s)) {
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }
  return s
}

// K8s 校验：Service 端口数 > 1 时每个 port 都必须有 name（spec.ports[i].name: Required value）。
// 空名时自动补 port-<端口号>（重号追加序号去重）；单端口保持匿名无损。
// 单一事实源：cluster.js 的 generateYAML 与 DeployApp 向导自拼的 Service 段共用——
// 曾只在 store 层修过、向导漏掉，多端口 Service 被 K8s 拒（2026-08-17 系统审计 P1-A）。
// 返回全新数组/对象，不改动调用方 portList（防 Vue Query 缓存对象被污染）。
export function ensureServicePortNames(ports) {
  if (!Array.isArray(ports) || ports.length < 2) return ports
  const used = new Set(ports.filter(p => p.name).map(p => p.name))
  return ports.map(p => {
    if (p.name) return p
    let name = `port-${p.port}`, n = 1
    while (used.has(name)) name = `port-${p.port}-${++n}`
    used.add(name)
    return { ...p, name }
  })
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
