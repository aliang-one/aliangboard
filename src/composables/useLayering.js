// Namespace 应用分层：把工作负载 / Service / Ingress 按一套分层体系归类。
//
// 归类优先级：
//   1) 显式 label `layer.aliangboard.io` 或 annotation（权威，支持 microservice-business 等子层）
//   2) 名称 / 镜像 启发式关键词匹配
//   3) 默认：Job/CronJob → 杂项；其余 → 微服务/业务层

// 分层体系（顺序即展示顺序；microservice 含子层）。color 供 NamespaceOverview 的 tierBg/Text/Chip 复用。
// labelKey/descKey 存 i18n 键（layer.* 命名空间）——保持本模块纯净（不引 @/i18n，scripts/test.mjs 可直 import），
// 消费方（NsLayers/NamespaceOverview/DeployApp/NsWorkloadDetail）渲染时 t(node.labelKey)/t(node.descKey) 翻译。
export const LAYER_TAXONOMY = [
  { key: 'presentation', labelKey: 'layer.presentation', en: 'Presentation', icon: 'desktop_windows', color: 'secondary', column: 'center', descKey: 'layer.presentationDesc' },
  { key: 'gateway', labelKey: 'layer.gateway', en: 'Gateway', icon: 'alt_route', color: 'primary', column: 'center', descKey: 'layer.gatewayDesc' },
  {
    key: 'microservice', labelKey: 'layer.microservice', en: 'Microservice', icon: 'hub', color: 'tertiary', column: 'center', descKey: 'layer.microserviceDesc', children: [
      { key: 'microservice-business', labelKey: 'layer.microserviceBusiness', en: 'Business', icon: 'storefront', color: 'tertiary', descKey: 'layer.microserviceBusinessDesc' },
      { key: 'microservice-support', labelKey: 'layer.microserviceSupport', en: 'Support', icon: 'support_agent', color: 'tertiary', descKey: 'layer.microserviceSupportDesc' },
      { key: 'microservice-misc', labelKey: 'layer.microserviceMisc', en: 'Misc', icon: 'widgets', color: 'surface', descKey: 'layer.microserviceMiscDesc' },
    ],
  },
  { key: 'middleware', labelKey: 'layer.middleware', en: 'Middleware', icon: 'sync_alt', color: 'secondary', column: 'right', descKey: 'layer.middlewareDesc' },
  { key: 'persistence', labelKey: 'layer.persistence', en: 'Database', icon: 'database', color: 'error', column: 'center', descKey: 'layer.persistenceDesc' },
  { key: 'storage', labelKey: 'layer.storage', en: 'Storage', icon: 'storage', color: 'primary', column: 'center', descKey: 'layer.storageDesc' },
  { key: 'monitoring', labelKey: 'layer.monitoring', en: 'Monitor', icon: 'monitoring', color: 'secondary', column: 'left', descKey: 'layer.monitoringDesc' },
  { key: 'unclassified', labelKey: 'layer.unclassified', en: 'Unclassified', icon: 'label', color: 'surface', column: 'center', descKey: 'layer.unclassifiedDesc' },
]

const ALIASES = {
  microservice: 'microservice-business',
  business: 'microservice-business', ms: 'microservice-business',
  support: 'microservice-support', helper: 'microservice-support',
  misc: 'microservice-misc', other: 'microservice-misc', batch: 'microservice-misc',
  // 旧 / 形式向后兼容（K8s label value 不允许 /，已改为 -，但集群里可能有旧值）
  'microservice/business': 'microservice-business',
  'microservice/support': 'microservice-support',
  'microservice/misc': 'microservice-misc',
  // 旧 tier 体系（TIER_META: web/gateway/svc/cloud/db/monitor/default）向后兼容
  web: 'presentation',
  svc: 'microservice-business',
  cloud: 'middleware',
  db: 'persistence',
  monitor: 'monitoring',
  default: 'microservice-business',
}
const KNOWN = new Set([...LAYER_TAXONOMY.flatMap(n => [n.key, ...(n.children || []).map(c => c.key)]), 'unclassified'])

function normalizeLayerKey(v) {
  const k = String(v || '').trim().toLowerCase()
  if (ALIASES[k]) return ALIASES[k]
  return KNOWN.has(k) ? k : 'unclassified'
}

// 启发式关键词（小写子串匹配 name+image）
const KEYWORDS = {
  gateway: ['gateway', '-gw', 'ingress', 'traefik', 'kong', 'envoy', 'zuul', 'apisix', 'istio-ingress', 'nginx-ingress', 'microgateway'],
  middleware: ['redis', 'kafka', 'rabbitmq', 'rocketmq', 'nats', 'emqx', 'zookeeper', 'memcached', 'consul', 'etcd', 'pulsar', 'activemq', 'mosquitto', 'vernemq'],
  persistence: ['mysql', 'postgres', 'postgresql', 'mongo', 'mongodb', 'elasticsearch', 'clickhouse', 'tidb', 'mariadb', 'oracle', 'cassandra', 'neo4j', 'cockroach', 'polardb', 'opensearch'],
  storage: ['minio', 'ceph', 'rook', 'seaweedfs', 'juicefs', 'fastdfs', 'oss-', '-s3'],
  monitoring: ['prometheus', 'grafana', 'loki', 'tempo', 'jaeger', 'zipkin', 'otel', 'opentelemetry', 'skywalking', 'alertmanager', 'thanos', 'node-exporter', 'fluentd', 'fluent-bit', 'vector', 'victoriametrics'],
  presentation: ['frontend', 'web-ui', 'webui', 'portal', 'h5', 'mobile', 'static-site', 'nextjs', 'nuxt', 'storybook', 'admin-ui', 'admin-web', 'console-ui'],
}

export function classifyResource(res) {
  const labels = res.labels || {}
  const ann = res.annotations || {}
  const explicit = labels['aliangboard.io/layer'] || labels['layer.aliangboard.io'] || ann['layer.aliangboard.io'] || labels['layer'] || ann['aliangboard.io/layer'] || labels['tier'] || ann['tier']
  if (explicit) return normalizeLayerKey(explicit)
  const hay = `${res.name || ''} ${res.image || ''}`.toLowerCase()
  for (const [key, words] of Object.entries(KEYWORDS)) {
    if (words.some(w => hay.includes(w))) return key
  }
  if (res.type === 'Job' || res.type === 'CronJob' || res.kind === 'Job' || res.kind === 'CronJob') return 'microservice-misc'
  return 'microservice-business'
}

// 按分层体系分组（仅返回有资源的层；microservice 展开为子层；附带 column 信息供 3 列布局）
export function groupByLayer(items) {
  const buckets = {}
  for (const it of items) {
    const key = classifyResource(it)
    ;(buckets[key] ||= []).push(it)
  }
  const result = []
  for (const node of LAYER_TAXONOMY) {
    if (node.children) {
      const subs = node.children
        .map(sub => ({ ...sub, items: buckets[sub.key] || [] }))
        .filter(s => s.items.length)
      const count = subs.reduce((n, s) => n + s.items.length, 0)
      if (count) result.push({ ...node, items: [], children: subs, count, column: node.column || 'center' })
    } else {
      const its = buckets[node.key] || []
      if (its.length) result.push({ ...node, items: its, count: its.length, column: node.column || 'center' })
    }
  }
  return result
}

// 分层选择器选项（扁平化；microservice 子层带父前缀；排除「未分类」——用户不会主动指派它）
// labelKey 用「父 / 子」复合键（消费方 t() 时分别翻译父层与子层再拼接，见 NsLayers/DeployApp）；
// 这里存父/子两个键 + 一个分隔标识，由消费方组合渲染（避免在模块顶层拼翻译串）。
export const TIER_OPTIONS = LAYER_TAXONOMY
  .flatMap(n => n.children ? n.children.map(c => ({ value: c.key, parentLabelKey: n.labelKey, labelKey: c.labelKey, icon: c.icon, descKey: c.descKey })) : [{ value: n.key, labelKey: n.labelKey, icon: n.icon, descKey: n.descKey }])
  .filter(o => o.value !== 'unclassified')
