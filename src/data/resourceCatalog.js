/**
 * resourceCatalog.js — K8s 资源属性目录 + getPath 纯函数
 *
 * Catalog 驱动:每种 kind 定义属性列表,通用渲染器(ResourceCard)读 catalog +
 * 资源对象 → 卡片。加 kind 只需加配置,不改代码。
 *
 * 5 种属性 type: text / badge / chips / age / code
 * getPath: dot-notation 路径提取(scalar / array+extract / reduce='sum' / extract='key')
 */

/**
 * 6 个常见 K8s kind 的属性定义。
 * 按 spec: 2026-08-09-workbench-v2-p4-attribute-system-design.md
 */
export const RESOURCE_CATALOG = {
  Pod: {
    icon: 'podcasts',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', labelKey: 'common.namespace', label: 'Namespace' },
      { key: 'status', path: 'status.phase', type: 'badge', labelKey: 'common.status', label: 'Status', badgeMap: { Running: 'ok', Pending: 'warn', Failed: 'err', Succeeded: 'ok' } },
      { key: 'node', path: 'spec.nodeName', type: 'text', labelKey: 'component.resourceCard.node', label: 'Node' },
      { key: 'podIP', path: 'status.podIP', type: 'code', labelKey: 'component.resourceCard.podIP', label: 'Pod IP' },
      { key: 'images', path: 'spec.containers', type: 'chips', extract: 'image', labelKey: 'component.resourceCard.images', label: 'Images' },
      { key: 'restarts', path: 'status.containerStatuses', type: 'text', extract: 'restartCount', reduce: 'sum', labelKey: 'component.resourceCard.restarts', label: 'Restarts' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', labelKey: 'common.age', label: 'Age' },
    ],
  },
  Deployment: {
    icon: 'deployed_code',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', labelKey: 'common.namespace', label: 'Namespace' },
      { key: 'replicas', path: 'spec.replicas', type: 'text', labelKey: 'component.resourceCard.desired', label: 'Desired' },
      { key: 'ready', path: 'status.readyReplicas', type: 'text', labelKey: 'component.resourceCard.ready', label: 'Ready' },
      { key: 'updated', path: 'status.updatedReplicas', type: 'text', labelKey: 'component.resourceCard.updated', label: 'Updated' },
      { key: 'images', path: 'spec.template.spec.containers', type: 'chips', extract: 'image', labelKey: 'component.resourceCard.images', label: 'Images' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', labelKey: 'common.age', label: 'Age' },
    ],
  },
  Service: {
    icon: 'hub',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', labelKey: 'common.namespace', label: 'Namespace' },
      { key: 'type', path: 'spec.type', type: 'badge', labelKey: 'common.type', label: 'Type' },
      { key: 'clusterIP', path: 'spec.clusterIP', type: 'code', labelKey: 'component.resourceCard.clusterIP', label: 'Cluster IP' },
      { key: 'ports', path: 'spec.ports', type: 'chips', extract: 'port', labelKey: 'component.resourceCard.ports', label: 'Ports' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', labelKey: 'common.age', label: 'Age' },
    ],
  },
  Namespace: {
    icon: 'folder',
    attributes: [
      { key: 'status', path: 'status.phase', type: 'badge', labelKey: 'common.status', label: 'Status', badgeMap: { Active: 'ok', Terminating: 'warn' } },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', labelKey: 'common.age', label: 'Age' },
    ],
  },
  Ingress: {
    icon: 'dns',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', labelKey: 'common.namespace', label: 'Namespace' },
      { key: 'hosts', path: 'spec.rules', type: 'chips', extract: 'host', labelKey: 'component.resourceCard.hosts', label: 'Hosts' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', labelKey: 'common.age', label: 'Age' },
    ],
  },
  ConfigMap: {
    icon: 'description',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', labelKey: 'common.namespace', label: 'Namespace' },
      { key: 'keys', path: 'data', type: 'chips', extract: 'key', labelKey: 'component.resourceCard.dataKeys', label: 'Data Keys' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', labelKey: 'common.age', label: 'Age' },
    ],
  },
}

/**
 * 无 catalog 的 kind 的 fallback 定义。
 */
export const FALLBACK_SPEC = {
  icon: 'extension',
  attributes: [
    { key: 'kind', path: 'kind', type: 'text', labelKey: 'component.resourceCard.kind', label: 'Kind' },
    { key: 'namespace', path: 'metadata.namespace', type: 'text', labelKey: 'common.namespace', label: 'Namespace' },
    { key: 'age', path: 'metadata.creationTimestamp', type: 'age', labelKey: 'common.age', label: 'Age' },
  ],
}

/**
 * 按 dot-notation path 从对象中提取值。
 *
 * @param {Object} obj - K8s API 对象
 * @param {Object} attr - 属性定义 { path, extract?, reduce? }
 * @param {string} attr.path - dot notation 路径 (e.g. 'metadata.name')
 * @param {string} [attr.extract] - 数组元素的提取字段名; 'key' → Object.keys()
 * @param {string} [attr.reduce] - 'sum' → 对提取的数字数组求和
 * @returns {string|number|Array|undefined} scalar 或 array;路径不存在 → undefined
 */
export function getPath(obj, attr) {
  if (!obj || !attr || !attr.path) return undefined

  // dot notation 逐层取值
  const segments = attr.path.split('.')
  let value = obj
  for (const seg of segments) {
    if (value == null) return undefined
    value = value[seg]
  }
  if (value == null) return undefined

  // array + extract: 取每个元素的指定字段
  if (Array.isArray(value) && attr.extract) {
    if (attr.extract === 'key') {
      // extract='key' 仅用于 object(取键名),但若 value 是 array of objects
      // 退化为每个元素的 keys — 按 spec, 'key' 用于 object 的 data 字段
      value = value.flatMap((item) => (item && typeof item === 'object' ? Object.keys(item) : []))
    } else {
      value = value.map((item) => (item != null ? item[attr.extract] : undefined)).filter((v) => v != null)
    }
  } else if (!Array.isArray(value) && attr.extract === 'key' && value && typeof value === 'object') {
    // object + extract='key': 取键名(ConfigMap data keys)
    value = Object.keys(value)
  }

  // reduce='sum': 数字数组求和
  if (attr.reduce === 'sum' && Array.isArray(value)) {
    return value.reduce((acc, v) => acc + (Number(v) || 0), 0)
  }

  return value
}

/**
 * 按 kind 取 catalog spec;未知 kind 返回 FALLBACK_SPEC。
 * @param {string} kind - K8s 资源 kind (e.g. 'Pod')
 * @returns {Object} catalog spec { icon, attributes }
 */
export function getCardSpec(kind) {
  return RESOURCE_CATALOG[kind] || FALLBACK_SPEC
}
