// W2 Phase B (Task 1): K8s API 路径反向解析器。
// 把 K8s API 路径解析回 { clusterScope, namespace, allNamespaces, resource, name, subresource },
// 供 k8s-gate 做按 ns 鉴权。返回 null = 无法解析 = 调用方对非 admin fail-closed。
// 识别三类前缀:/api/v1/...、/apis/<group>/<ver>/...、其下的 /namespaces/<ns>/...。
// 规范化(安全优先):逐段 decodeURIComponent 后必须匹配 /^[\w.-]+$/,且 decode 前后不得含
// '%';含 '..'、'\'、'~'、空段('//')的一律 null(防路径穿越/二次编码绕过)。
// resource 匹配权威表 = KIND_API(kind-paths.mjs)prefix 值集合;表外 resource(CRD)仍解析。
//
// final-review 修订(2026-09-06):
//   C1 — ns 型 kind 出现在集群级位置(如 /api/v1/pods 全 ns list)不再 null,改判
//        allNamespaces=true / namespace=null(流入 null-ns 门:open/legacy/admin 过,
//        allowlist 非 admin 拒,spec §2.4 集群级/全 ns 读 = admin-only);
//   C2 — SUBRESOURCES 扩容(scale/eviction/status/ephemeralcontainers/token/approval/
//        finalizers/proxy/log),多段尾巴(proxy 子路径)取首段为 subresource 不再 null;
//   I2b — /api/v1/namespaces/<name> 单对象按 namespace=<name> 的 ns 门(view 读)。
import { KIND_API } from './kind-paths.mjs'

const SEG_RE = /^[\w.-]+$/
const SUBRESOURCES = new Set([
  'exec', 'logs', 'portforward', 'attach', 'log',
  'scale', 'eviction', 'status', 'ephemeralcontainers', 'token',
  'approval', 'finalizers', 'proxy',
])

function normalizeSeg(seg) {
  if (!seg || seg.includes('..') || seg.includes('\\') || seg.includes('~') || seg.includes('%')) return null
  let dec
  try { dec = decodeURIComponent(seg) } catch { return null }
  if (dec.includes('%') || dec.includes('..') || dec.includes('\\') || dec.includes('~')) return null
  if (!SEG_RE.test(dec)) return null
  return dec
}

// tail = [resource, name?, subresource?, ...subPath?]:
//   首段 resource;第 2 段 name;第 3 段须 ∈ SUBRESOURCES 作为 subresource 根,其后
//   任意段为该 subresource 的自有路径(proxy 子路径等)——只取首段为 subresource。
function parseTail(tail) {
  if (tail.length > 2 && !SUBRESOURCES.has(tail[2])) return null
  return {
    resource: tail[0],
    name: tail.length >= 2 ? tail[1] : null,
    subresource: tail.length > 2 ? tail[2] : null,
  }
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
    // /namespaces 集合本身 → 集群级
    if (rest.length === 1) return { clusterScope: true, namespace: null, allNamespaces: false, resource: 'namespaces', name: null, subresource: null }
    // I2b:/namespaces/<name> 单对象 → 按 namespace=<name> 的 ns 门(view 读该 ns;
    // DELETE/PATCH 走 operate)。name 同步保留供审计/展示。
    if (rest.length === 2) return { clusterScope: false, namespace: rest[1], allNamespaces: false, resource: 'namespaces', name: rest[1], subresource: null }
    // /namespaces/<ns>/<resource>[/<name>[/<subresource>[/<sub-path>...]]]
    const tail = parseTail(rest.slice(2))
    if (!tail) return null
    return {
      clusterScope: false,
      namespace: rest[1],
      allNamespaces: false,
      ...tail,
    }
  }
  // 集群级位置:/<resource>[/<name>[/<subresource>[/<sub-path>...]]]
  const tail = parseTail(rest)
  if (!tail) return null
  // C1:KIND_API 表内 ns 型资源出现在集群级位置(如 /api/v1/pods 全 ns list)→
  // 合法形态:allNamespaces=true / namespace=null(流入 null-ns 门,spec §2.4)。
  const e = KIND_API[tail.resource]
  if (e && e.ns) {
    return {
      clusterScope: false,
      namespace: null,
      allNamespaces: true,
      ...tail,
    }
  }
  return {
    clusterScope: true,
    namespace: null,
    allNamespaces: false,
    ...tail,
  }
}
