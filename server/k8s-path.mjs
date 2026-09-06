// W2 Phase B (Task 1): K8s API 路径反向解析器。
// 把 K8s API 路径解析回 { clusterScope, namespace, resource, name, subresource },
// 供 k8s-gate 做按 ns 鉴权。返回 null = 无法解析 = 调用方对非 admin fail-closed。
// 识别三类前缀:/api/v1/...、/apis/<group>/<ver>/...、其下的 /namespaces/<ns>/...。
// 规范化(安全优先):逐段 decodeURIComponent 后必须匹配 /^[\w.-]+$/,且 decode 前后不得含
// '%';含 '..'、'\'、'~'、空段('//')的一律 null(防路径穿越/二次编码绕过)。
// resource 匹配权威表 = KIND_API(kind-paths.mjs)prefix 值集合;表外 resource(CRD)仍解析。
import { KIND_API } from './kind-paths.mjs'

const SEG_RE = /^[\w.-]+$/
const SUBRESOURCES = new Set(['exec', 'logs', 'portforward', 'attach', 'log'])

function normalizeSeg(seg) {
  if (!seg || seg.includes('..') || seg.includes('\\') || seg.includes('~') || seg.includes('%')) return null
  let dec
  try { dec = decodeURIComponent(seg) } catch { return null }
  if (dec.includes('%') || dec.includes('..') || dec.includes('\\') || dec.includes('~')) return null
  if (!SEG_RE.test(dec)) return null
  return dec
}

export function parseApiPath(pathname) {
  if (typeof pathname !== 'string' || pathname.includes('//')) return null
  const segs = []
  for (const raw of pathname.split('/')) {
    if (raw === '') continue
    const s = normalizeSeg(raw)
    if (s === null) return null
    segs.push(s)
  }
  if (segs.length === 0) return null

  let rest
  if (segs[0] === 'api' && segs[1] === 'v1') {
    rest = segs.slice(2)
  } else if (segs[0] === 'apis') {
    // /apis/<group>/<ver>/... — group 可含点(通配 CRD),version 段存在即可
    if (segs.length < 4) return null
    rest = segs.slice(3)
  } else {
    return null // 未知完整前缀(非 /api/、非 /apis/)
  }
  if (rest.length === 0) return null

  if (rest[0] === 'namespaces') {
    // /namespaces 集合本身或 /namespaces/<name> → 集群级
    if (rest.length === 1) return { clusterScope: true, namespace: null, resource: 'namespaces', name: null, subresource: null }
    if (rest.length === 2) return { clusterScope: true, namespace: null, resource: 'namespaces', name: rest[1], subresource: null }
    // /namespaces/<ns>/<resource>[/<name>[/<subresource>]]
    const ns = rest[1]
    const tail = rest.slice(2)
    if (tail.length > 3) return null
    if (tail.length === 3 && !SUBRESOURCES.has(tail[2])) return null
    return {
      clusterScope: false,
      namespace: ns,
      resource: tail[0],
      name: tail.length >= 2 ? tail[1] : null,
      subresource: tail.length === 3 ? tail[2] : null,
    }
  }
  // 集群级资源:/<resource>[/<name>[/<subresource>]]
  if (rest.length > 3) return null
  if (rest.length === 3 && !SUBRESOURCES.has(rest[2])) return null
  // KIND_API 表内 ns 型资源不得出现在集群级位置(如 /api/v1/pods)→ 结构非法
  const e = KIND_API[rest[0]]
  if (e && e.ns) return null
  return {
    clusterScope: true,
    namespace: null,
    resource: rest[0],
    name: rest.length >= 2 ? rest[1] : null,
    subresource: rest.length === 3 ? rest[2] : null,
  }
}
