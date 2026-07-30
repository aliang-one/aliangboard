// Ingress 性能/高级参数：共享给 NsIngress 创建表单与 DeployApp 向导第 5 步。
// 参数以 nginx.ingress.kubernetes.io/<key> 注解写入（留空即用控制器默认值）。

export const INGRESS_CLASSES = ['nginx', 'traefik', 'kong', 'haproxy', 'nginx-ingress', 'istio', 'gce', 'aliyun-alb']

// 分组：tab = perf(性能调优) | extra(安全与其它)；field.key 即注解后缀；options→下拉，area→多行
export const PERF_GROUPS = [
  { tab: 'perf', title: '超时', icon: 'schedule', fields: [
    { key: 'proxy-connect-timeout', label: '上游连接超时 (秒)', ph: '5' },
    { key: 'proxy-send-timeout', label: '发送超时 (秒)', ph: '60' },
    { key: 'proxy-read-timeout', label: '读取超时 (秒)', ph: '60' },
  ]},
  { tab: 'perf', title: '缓冲与请求体', icon: 'inventory_2', fields: [
    { key: 'proxy-body-size', label: '最大请求体', ph: '10m' },
    { key: 'proxy-buffer-size', label: '响应缓冲区大小', ph: '4k' },
    { key: 'proxy-buffering', label: '响应缓冲', options: ['', 'on', 'off'] },
    { key: 'proxy-request-buffering', label: '请求缓冲', options: ['', 'on', 'off'] },
  ]},
  { tab: 'perf', title: '限流', icon: 'speed', fields: [
    { key: 'limit-connections', label: '最大并发连接', ph: '100' },
    { key: 'limit-rps', label: '每秒请求数 (RPS)', ph: '50' },
    { key: 'limit-burst', label: '突发', ph: '100' },
    { key: 'limit-rate', label: '限速 (字节/秒)', ph: '0' },
  ]},
  { tab: 'perf', title: '负载均衡与连接复用', icon: 'sync_alt', fields: [
    { key: 'load-balance', label: '负载均衡策略', options: ['', 'round_robin', 'least_conn', 'ip_hash', 'ewma'] },
    { key: 'upstream-keepalive-connections', label: '上游 keepalive 连接数', ph: '320' },
    { key: 'upstream-keepalive-timeout', label: '上游 keepalive 超时 (秒)', ph: '60' },
    { key: 'upstream-keepalive-requests', label: '上游 keepalive 请求数', ph: '10000' },
  ]},
  { tab: 'extra', title: '后端协议与会话亲和', icon: 'share', fields: [
    { key: 'backend-protocol', label: '后端协议', options: ['', 'HTTP', 'HTTPS', 'GRPC', 'GRPCS', 'AJP', 'FCGI'] },
    { key: 'affinity', label: '会话亲和', options: ['', 'cookie'] },
    { key: 'affinity-mode', label: '亲和模式', options: ['', 'balanced', 'persistent'] },
    { key: 'session-cookie-name', label: '会话 Cookie 名', ph: 'INGRESSCOOKIE' },
  ]},
  { tab: 'extra', title: '安全 / TLS', icon: 'lock', fields: [
    { key: 'ssl-redirect', label: 'HTTPS 跳转', options: ['', 'true', 'false'] },
    { key: 'force-ssl-redirect', label: '强制 SSL 跳转', options: ['', 'true', 'false'] },
    { key: 'hsts', label: '启用 HSTS', options: ['', 'true', 'false'] },
    { key: 'hsts-max-age', label: 'HSTS 最大年龄 (秒)', ph: '31536000' },
    { key: 'hsts-include-subdomains', label: 'HSTS 含子域', options: ['', 'true', 'false'] },
  ]},
  { tab: 'extra', title: '压缩与 CORS', icon: 'compress', fields: [
    { key: 'enable-compression', label: '启用压缩', options: ['', 'true', 'false'] },
    { key: 'compression-level', label: '压缩级别 (1-9)', ph: '5' },
    { key: 'enable-cors', label: '启用 CORS', options: ['', 'true', 'false'] },
    { key: 'cors-allow-origin', label: 'CORS 允许来源', ph: 'https://*.example.com' },
  ]},
  { tab: 'extra', title: '重写与其它', icon: 'edit_note', fields: [
    { key: 'rewrite-target', label: '重写目标', ph: '/$1' },
    { key: 'use-regex', label: '路径使用正则', options: ['', 'true', 'false'] },
    { key: 'app-root', label: '应用根路径', ph: '/app' },
    { key: 'custom-http-errors', label: '自定义错误页码', ph: '404,503' },
    { key: 'server-snippet', label: 'Server Snippet（原始·高级）', ph: '# raw nginx server snippet', area: true },
    { key: 'configuration-snippet', label: 'Configuration Snippet（原始·高级）', ph: '# raw location snippet', area: true },
  ]},
]

// 由性能参数 + 自定义键值对汇总成 Ingress 注解（非空才写入）
export function buildIngressAnnotations(adv = {}, custom = []) {
  const ann = {}
  for (const g of PERF_GROUPS) for (const fld of g.fields) {
    const v = String(adv[fld.key] ?? '').trim()
    if (v) ann[`nginx.ingress.kubernetes.io/${fld.key}`] = v
  }
  for (const a of custom || []) {
    const k = (a.key || '').trim()
    if (k) ann[k] = String(a.value || '').trim()
  }
  return ann
}
