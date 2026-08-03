// Namespace 应用分层：把工作负载 / Service / Ingress 按一套分层体系归类。
//
// 归类优先级：
//   1) 显式 label `layer.aliangboard.io` 或 annotation（权威，支持 microservice/business 等子层）
//   2) 名称 / 镜像 启发式关键词匹配
//   3) 默认：Job/CronJob → 杂项；其余 → 微服务/业务层

// 分层体系（顺序即展示顺序；microservice 含子层）。color 供 NamespaceOverview 的 tierBg/Text/Chip 复用。
export const LAYER_TAXONOMY = [
  { key: 'presentation', label: '展现层', en: 'Presentation', icon: 'desktop_windows', color: 'secondary', desc: '前端 / UI / 静态站点' },
  { key: 'gateway', label: '网关', en: 'Gateway', icon: 'alt_route', color: 'primary', desc: 'API 网关 / 入口代理 / Ingress 控制器' },
  {
    key: 'microservice', label: '微服务层', en: 'Microservice', icon: 'hub', color: 'tertiary', desc: '微服务应用', children: [
      { key: 'microservice/business', label: '业务层', en: 'Business', icon: 'storefront', color: 'tertiary', desc: '核心业务服务' },
      { key: 'microservice/support', label: '支持服务', en: 'Support', icon: 'support_agent', color: 'tertiary', desc: '鉴权 / 配置 / 调度等支撑服务' },
      { key: 'microservice/misc', label: '杂项', en: 'Misc', icon: 'widgets', color: 'surface', desc: '批处理任务 / 其它' },
    ],
  },
  { key: 'middleware', label: '中间件', en: 'Middleware', icon: 'sync_alt', color: 'secondary', desc: '消息队列 / 缓存 / 注册中心' },
  { key: 'persistence', label: '持久层', en: 'Database', icon: 'database', color: 'error', desc: '关系型 / 文档型 / 搜索数据库' },
  { key: 'storage', label: '存储', en: 'Storage', icon: 'storage', color: 'primary', desc: '对象 / 文件存储' },
  { key: 'monitoring', label: '监控层', en: 'Monitor', icon: 'monitoring', color: 'secondary', desc: '指标 / 日志 / 链路追踪' },
  { key: 'unclassified', label: '未分类', en: 'Unclassified', icon: 'label', color: 'surface', desc: '未能自动识别——可用 label layer.aliangboard.io 显式归类' },
]

const ALIASES = {
  microservice: 'microservice/business',
  business: 'microservice/business', ms: 'microservice/business',
  support: 'microservice/support', helper: 'microservice/support',
  misc: 'microservice/misc', other: 'microservice/misc', batch: 'microservice/misc',
  // 旧 tier 体系（TIER_META: web/gateway/svc/cloud/db/monitor/default）向后兼容
  web: 'presentation',
  svc: 'microservice/business',
  cloud: 'middleware',
  db: 'persistence',
  monitor: 'monitoring',
  default: 'microservice/business',
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
  if (res.type === 'Job' || res.type === 'CronJob' || res.kind === 'Job' || res.kind === 'CronJob') return 'microservice/misc'
  return 'microservice/business'
}

// 按分层体系分组（仅返回有资源的层；microservice 展开为子层）
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
      if (count) result.push({ ...node, items: [], children: subs, count })
    } else {
      const its = buckets[node.key] || []
      if (its.length) result.push({ ...node, items: its, count: its.length })
    }
  }
  return result
}

// 分层选择器选项（扁平化；microservice 子层带父前缀；排除「未分类」——用户不会主动指派它）
export const TIER_OPTIONS = LAYER_TAXONOMY
  .flatMap(n => n.children ? n.children.map(c => ({ value: c.key, label: `${n.label} / ${c.label}`, icon: c.icon, desc: c.desc })) : [{ value: n.key, label: n.label, icon: n.icon, desc: n.desc }])
  .filter(o => o.value !== 'unclassified')
