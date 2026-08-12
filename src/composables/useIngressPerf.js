// Ingress 性能/高级参数：共享给 NsIngress 创建表单与 DeployApp 向导第 5 步。
// 参数以 nginx.ingress.kubernetes.io/<key> 注解写入（留空即用控制器默认值）。
//
// titleKey/fields[].labelKey/建议[].descKey 存 i18n 键（ingressPerf.* 命名空间）——
// 保持模块纯净（不引 @/i18n，scripts/test.mjs 可直 import），消费方渲染时 t(...Key) 翻译。
// test.mjs 只校验 buildIngressAnnotations 的数据形态，不读文案，故存键不影响。

// 分组：tab = perf(性能调优) | extra(安全与其它)；field.key 即注解后缀；options→下拉，area→多行
export const PERF_GROUPS = [
  { tab: 'perf', titleKey: 'ingressPerf.groupTimeout', icon: 'schedule', fields: [
    { key: 'proxy-connect-timeout', labelKey: 'ingressPerf.upstreamConnectTimeout', ph: '5' },
    { key: 'proxy-send-timeout', labelKey: 'ingressPerf.sendTimeout', ph: '60' },
    { key: 'proxy-read-timeout', labelKey: 'ingressPerf.readTimeout', ph: '60' },
  ]},
  { tab: 'perf', titleKey: 'ingressPerf.groupBufferBody', icon: 'inventory_2', fields: [
    { key: 'proxy-body-size', labelKey: 'ingressPerf.maxBodySize', ph: '10m' },
    { key: 'proxy-buffer-size', labelKey: 'ingressPerf.responseBufferSize', ph: '4k' },
    { key: 'proxy-buffering', labelKey: 'ingressPerf.responseBuffering', options: ['', 'on', 'off'] },
    { key: 'proxy-request-buffering', labelKey: 'ingressPerf.requestBuffering', options: ['', 'on', 'off'] },
  ]},
  { tab: 'perf', titleKey: 'ingressPerf.groupRateLimit', icon: 'speed', fields: [
    { key: 'limit-connections', labelKey: 'ingressPerf.maxConcurrentConnections', ph: '100' },
    { key: 'limit-rps', labelKey: 'ingressPerf.rps', ph: '50' },
    { key: 'limit-burst', labelKey: 'ingressPerf.burst', ph: '100' },
    { key: 'limit-rate', labelKey: 'ingressPerf.rateLimit', ph: '0' },
  ]},
  { tab: 'perf', titleKey: 'ingressPerf.groupLoadBalance', icon: 'sync_alt', fields: [
    { key: 'load-balance', labelKey: 'ingressPerf.loadBalanceStrategy', options: ['', 'round_robin', 'least_conn', 'ip_hash', 'ewma'] },
    { key: 'upstream-keepalive-connections', labelKey: 'ingressPerf.upstreamKeepaliveConnections', ph: '320' },
    { key: 'upstream-keepalive-timeout', labelKey: 'ingressPerf.upstreamKeepaliveTimeout', ph: '60' },
    { key: 'upstream-keepalive-requests', labelKey: 'ingressPerf.upstreamKeepaliveRequests', ph: '10000' },
  ]},
  { tab: 'extra', titleKey: 'ingressPerf.groupBackendAffinity', icon: 'share', fields: [
    { key: 'backend-protocol', labelKey: 'ingressPerf.backendProtocol', options: ['', 'HTTP', 'HTTPS', 'GRPC', 'GRPCS', 'AJP', 'FCGI'] },
    { key: 'affinity', labelKey: 'ingressPerf.sessionAffinity', options: ['', 'cookie'] },
    { key: 'affinity-mode', labelKey: 'ingressPerf.affinityMode', options: ['', 'balanced', 'persistent'] },
    { key: 'session-cookie-name', labelKey: 'ingressPerf.sessionCookieName', ph: 'INGRESSCOOKIE' },
  ]},
  { tab: 'extra', titleKey: 'ingressPerf.groupSecurityTls', icon: 'lock', fields: [
    { key: 'ssl-redirect', labelKey: 'ingressPerf.httpsRedirect', options: ['', 'true', 'false'] },
    { key: 'force-ssl-redirect', labelKey: 'ingressPerf.forceSslRedirect', options: ['', 'true', 'false'] },
    { key: 'hsts', labelKey: 'ingressPerf.enableHsts', options: ['', 'true', 'false'] },
    { key: 'hsts-max-age', labelKey: 'ingressPerf.hstsMaxAge', ph: '31536000' },
    { key: 'hsts-include-subdomains', labelKey: 'ingressPerf.hstsIncludeSubdomains', options: ['', 'true', 'false'] },
  ]},
  { tab: 'extra', titleKey: 'ingressPerf.groupCompressionCors', icon: 'compress', fields: [
    { key: 'enable-compression', labelKey: 'ingressPerf.enableCompression', options: ['', 'true', 'false'] },
    { key: 'compression-level', labelKey: 'ingressPerf.compressionLevel', ph: '5' },
    { key: 'enable-cors', labelKey: 'ingressPerf.enableCors', options: ['', 'true', 'false'] },
    { key: 'cors-allow-origin', labelKey: 'ingressPerf.corsAllowOrigin', ph: 'https://*.example.com' },
  ]},
  { tab: 'extra', titleKey: 'ingressPerf.groupRewriteMisc', icon: 'edit_note', fields: [
    { key: 'rewrite-target', labelKey: 'ingressPerf.rewriteTarget', ph: '/$1' },
    { key: 'use-regex', labelKey: 'ingressPerf.useRegex', options: ['', 'true', 'false'] },
    { key: 'app-root', labelKey: 'ingressPerf.appRoot', ph: '/app' },
    { key: 'custom-http-errors', labelKey: 'ingressPerf.customHttpErrors', ph: '404,503' },
    { key: 'server-snippet', labelKey: 'ingressPerf.serverSnippet', ph: '# raw nginx server snippet', area: true },
    { key: 'configuration-snippet', labelKey: 'ingressPerf.configurationSnippet', ph: '# raw location snippet', area: true },
  ]},
]

// 自定义注解 key 的补全建议（输入时弹出，可快速选也可手输）。nginx-ingress 为主 + cert-manager/acme。
export const INGRESS_ANNOTATION_SUGGESTIONS = [
  { value: 'nginx.ingress.kubernetes.io/rewrite-target', descKey: 'ingressPerf.annRewriteTarget' },
  { value: 'nginx.ingress.kubernetes.io/use-regex', descKey: 'ingressPerf.annUseRegex' },
  { value: 'nginx.ingress.kubernetes.io/app-root', descKey: 'ingressPerf.annAppRoot' },
  { value: 'nginx.ingress.kubernetes.io/permanent-redirect-code', descKey: 'ingressPerf.annPermanentRedirectCode' },
  { value: 'nginx.ingress.kubernetes.io/proxy-body-size', descKey: 'ingressPerf.annProxyBodySize' },
  { value: 'nginx.ingress.kubernetes.io/proxy-connect-timeout', descKey: 'ingressPerf.annProxyConnectTimeout' },
  { value: 'nginx.ingress.kubernetes.io/proxy-send-timeout', descKey: 'ingressPerf.annProxySendTimeout' },
  { value: 'nginx.ingress.kubernetes.io/proxy-read-timeout', descKey: 'ingressPerf.annProxyReadTimeout' },
  { value: 'nginx.ingress.kubernetes.io/proxy-buffering', descKey: 'ingressPerf.annProxyBuffering' },
  { value: 'nginx.ingress.kubernetes.io/proxy-buffer-size', descKey: 'ingressPerf.annProxyBufferSize' },
  { value: 'nginx.ingress.kubernetes.io/limit-rps', descKey: 'ingressPerf.annLimitRps' },
  { value: 'nginx.ingress.kubernetes.io/limit-connections', descKey: 'ingressPerf.annLimitConnections' },
  { value: 'nginx.ingress.kubernetes.io/limit-rate', descKey: 'ingressPerf.annLimitRate' },
  { value: 'nginx.ingress.kubernetes.io/whitelist-source-range', descKey: 'ingressPerf.annWhitelistSourceRange' },
  { value: 'nginx.ingress.kubernetes.io/ssl-redirect', descKey: 'ingressPerf.annSslRedirect' },
  { value: 'nginx.ingress.kubernetes.io/force-ssl-redirect', descKey: 'ingressPerf.annForceSslRedirect' },
  { value: 'nginx.ingress.kubernetes.io/hsts', descKey: 'ingressPerf.annHsts' },
  { value: 'nginx.ingress.kubernetes.io/hsts-max-age', descKey: 'ingressPerf.annHstsMaxAge' },
  { value: 'nginx.ingress.kubernetes.io/backend-protocol', descKey: 'ingressPerf.annBackendProtocol' },
  { value: 'nginx.ingress.kubernetes.io/affinity', descKey: 'ingressPerf.annAffinity' },
  { value: 'nginx.ingress.kubernetes.io/session-cookie-name', descKey: 'ingressPerf.annSessionCookieName' },
  { value: 'nginx.ingress.kubernetes.io/enable-cors', descKey: 'ingressPerf.annEnableCors' },
  { value: 'nginx.ingress.kubernetes.io/cors-allow-origin', descKey: 'ingressPerf.annCorsAllowOrigin' },
  { value: 'nginx.ingress.kubernetes.io/enable-compression', descKey: 'ingressPerf.annEnableCompression' },
  { value: 'nginx.ingress.kubernetes.io/compression-level', descKey: 'ingressPerf.annCompressionLevel' },
  { value: 'nginx.ingress.kubernetes.io/load-balance', descKey: 'ingressPerf.annLoadBalance' },
  { value: 'nginx.ingress.kubernetes.io/upstream-keepalive-connections', descKey: 'ingressPerf.annUpstreamKeepaliveConnections' },
  { value: 'nginx.ingress.kubernetes.io/auth-type', descKey: 'ingressPerf.annAuthType' },
  { value: 'nginx.ingress.kubernetes.io/auth-secret', descKey: 'ingressPerf.annAuthSecret' },
  { value: 'nginx.ingress.kubernetes.io/auth-realm', descKey: 'ingressPerf.annAuthRealm' },
  { value: 'nginx.ingress.kubernetes.io/custom-http-errors', descKey: 'ingressPerf.annCustomHttpErrors' },
  { value: 'nginx.ingress.kubernetes.io/server-snippet', descKey: 'ingressPerf.annServerSnippet' },
  { value: 'nginx.ingress.kubernetes.io/configuration-snippet', descKey: 'ingressPerf.annConfigurationSnippet' },
  { value: 'nginx.ingress.kubernetes.io/canary', descKey: 'ingressPerf.annCanary' },
  { value: 'nginx.ingress.kubernetes.io/canary-weight', descKey: 'ingressPerf.annCanaryWeight' },
  { value: 'cert-manager.io/cluster-issuer', descKey: 'ingressPerf.annClusterIssuer' },
  { value: 'cert-manager.io/issuer', descKey: 'ingressPerf.annIssuer' },
  { value: 'acme.cert-manager.io/http01-edit-in-place', descKey: 'ingressPerf.annAcmeHttp01' },
  { value: 'traefik.ingress.kubernetes.io/router.entrypoints', descKey: 'ingressPerf.annTraefikEntrypoints' },
  { value: 'traefik.ingress.kubernetes.io/router.middlewares', descKey: 'ingressPerf.annTraefikMiddlewares' },
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
    const val = String(a.value ?? '').trim()
    if (k && val) ann[k] = val   // 键或值任一为空都跳过，避免写入无意义的空注解
  }
  return ann
}
