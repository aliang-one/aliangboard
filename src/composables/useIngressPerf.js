// Ingress 性能/高级参数：共享给 NsIngress 创建表单与 DeployApp 向导第 5 步。
// 支持多控制器方言（nginx/haproxy/traefik/kong/generic），按 className 自动探测。
// 参数以 <prefix>/<key> 注解写入（留空即用控制器默认值）。
//
// titleKey/fields[].labelKey/建议[].descKey 存 i18n 键（ingressPerf.* 命名空间）——
// 保持模块纯净（不引 @/i18n，scripts/test.mjs 可直 import），消费方渲染时 t(...Key) 翻译。
// test.mjs 只校验 buildIngressAnnotations 的数据形态，不读文案，故存键不影响。

export const INGRESS_DIALECTS = {
  nginx: { prefix: 'nginx.ingress.kubernetes.io', groups: [
    { tab: 'perf', titleKey: 'ingressPerf.groupTimeout', icon: 'schedule', fields: [
      { key: 'proxy-connect-timeout', labelKey: 'ingressPerf.upstreamConnectTimeout', ph: '5', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
      { key: 'proxy-send-timeout', labelKey: 'ingressPerf.sendTimeout', ph: '60', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
      { key: 'proxy-read-timeout', labelKey: 'ingressPerf.readTimeout', ph: '60', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
    ]},
    { tab: 'perf', titleKey: 'ingressPerf.groupBufferBody', icon: 'inventory_2', fields: [
      { key: 'proxy-body-size', labelKey: 'ingressPerf.maxBodySize', ph: '10m', vt: 'size' },
      { key: 'proxy-buffer-size', labelKey: 'ingressPerf.responseBufferSize', ph: '4k', vt: 'size' },
      { key: 'proxy-buffering', labelKey: 'ingressPerf.responseBuffering', options: ['', 'on', 'off'] },
      { key: 'proxy-request-buffering', labelKey: 'ingressPerf.requestBuffering', options: ['', 'on', 'off'] },
    ]},
    { tab: 'perf', titleKey: 'ingressPerf.groupRateLimit', icon: 'speed', fields: [
      { key: 'limit-connections', labelKey: 'ingressPerf.maxConcurrentConnections', ph: '100', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'limit-rps', labelKey: 'ingressPerf.rps', ph: '50', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'limit-burst', labelKey: 'ingressPerf.burst', ph: '100', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'limit-rate', labelKey: 'ingressPerf.rateLimit', ph: '0', vt: 'int', unitKey: 'ingressPerf.unitKbPerSec' },
    ]},
    { tab: 'perf', titleKey: 'ingressPerf.groupLoadBalance', icon: 'sync_alt', fields: [
      { key: 'load-balance', labelKey: 'ingressPerf.loadBalanceStrategy', options: ['', 'round_robin', 'least_conn', 'ip_hash', 'ewma'] },
      { key: 'upstream-keepalive-connections', labelKey: 'ingressPerf.upstreamKeepaliveConnections', ph: '320', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'upstream-keepalive-timeout', labelKey: 'ingressPerf.upstreamKeepaliveTimeout', ph: '60', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
      { key: 'upstream-keepalive-requests', labelKey: 'ingressPerf.upstreamKeepaliveRequests', ph: '10000', vt: 'int', unitKey: 'ingressPerf.unitCount' },
    ]},
    { tab: 'extra', titleKey: 'ingressPerf.groupBackendAffinity', icon: 'share', fields: [
      { key: 'backend-protocol', labelKey: 'ingressPerf.backendProtocol', options: ['', 'HTTP', 'HTTPS', 'GRPC', 'GRPCS', 'AJP', 'FCGI'] },
      { key: 'affinity', labelKey: 'ingressPerf.sessionAffinity', options: ['', 'cookie'] },
      { key: 'affinity-mode', labelKey: 'ingressPerf.affinityMode', options: ['', 'balanced', 'persistent'] },
      { key: 'session-cookie-name', labelKey: 'ingressPerf.sessionCookieName', ph: 'INGRESSCOOKIE', vt: 'free' },
    ]},
    { tab: 'extra', titleKey: 'ingressPerf.groupSecurityTls', icon: 'lock', fields: [
      { key: 'ssl-redirect', labelKey: 'ingressPerf.httpsRedirect', options: ['', 'true', 'false'] },
      { key: 'force-ssl-redirect', labelKey: 'ingressPerf.forceSslRedirect', options: ['', 'true', 'false'] },
      { key: 'hsts', labelKey: 'ingressPerf.enableHsts', options: ['', 'true', 'false'] },
      { key: 'hsts-max-age', labelKey: 'ingressPerf.hstsMaxAge', ph: '31536000', vt: 'int', unitKey: 'ingressPerf.unitSeconds' },
      { key: 'hsts-include-subdomains', labelKey: 'ingressPerf.hstsIncludeSubdomains', options: ['', 'true', 'false'] },
    ]},
    { tab: 'extra', titleKey: 'ingressPerf.groupCompressionCors', icon: 'compress', fields: [
      { key: 'enable-compression', labelKey: 'ingressPerf.enableCompression', options: ['', 'true', 'false'] },
      { key: 'compression-level', labelKey: 'ingressPerf.compressionLevel', ph: '5', vt: 'int', min: 1, max: 9 },
      { key: 'enable-cors', labelKey: 'ingressPerf.enableCors', options: ['', 'true', 'false'] },
      { key: 'cors-allow-origin', labelKey: 'ingressPerf.corsAllowOrigin', ph: 'https://*.example.com', vt: 'free' },
    ]},
    { tab: 'extra', titleKey: 'ingressPerf.groupRewriteMisc', icon: 'edit_note', fields: [
      { key: 'rewrite-target', labelKey: 'ingressPerf.rewriteTarget', ph: '/$1', vt: 'path' },
      { key: 'use-regex', labelKey: 'ingressPerf.useRegex', options: ['', 'true', 'false'] },
      { key: 'app-root', labelKey: 'ingressPerf.appRoot', ph: '/app', vt: 'path' },
      { key: 'custom-http-errors', labelKey: 'ingressPerf.customHttpErrors', ph: '404,503', vt: 'csvInt' },
      { key: 'server-snippet', labelKey: 'ingressPerf.serverSnippet', ph: '# raw nginx server snippet', area: true },
      { key: 'configuration-snippet', labelKey: 'ingressPerf.configurationSnippet', ph: '# raw location snippet', area: true },
    ]},
  ] },
  haproxy: { prefix: 'haproxy-ingress.github.io', groups: [
    { tab: 'perf', titleKey: 'ingressPerf.hpx.groupTimeout', icon: 'schedule', fields: [
      { key: 'timeout-connect', labelKey: 'ingressPerf.hpx.timeoutConnect', ph: '5s', vt: 'hpxTime' },
      { key: 'timeout-server', labelKey: 'ingressPerf.hpx.timeoutServer', ph: '50s', vt: 'hpxTime' },
      { key: 'timeout-http-request', labelKey: 'ingressPerf.hpx.timeoutHttpRequest', ph: '5s', vt: 'hpxTime' },
      { key: 'timeout-queue', labelKey: 'ingressPerf.hpx.timeoutQueue', ph: '5s', vt: 'hpxTime' },
    ] },
    { tab: 'perf', titleKey: 'ingressPerf.hpx.groupConn', icon: 'speed', fields: [
      { key: 'maxconn-server', labelKey: 'ingressPerf.hpx.maxconnServer', ph: '500', vt: 'int', unitKey: 'ingressPerf.unitCount' },
      { key: 'balance-algorithm', labelKey: 'ingressPerf.hpx.balanceAlgorithm', options: ['', 'roundrobin', 'leastconn', 'source', 'uri'] },
    ] },
    { tab: 'extra', titleKey: 'ingressPerf.hpx.groupSecurity', icon: 'lock', fields: [
      { key: 'ssl-redirect', labelKey: 'ingressPerf.hpx.sslRedirect', options: ['', 'true', 'false'] },
      { key: 'hsts', labelKey: 'ingressPerf.hpx.hsts', options: ['', 'true', 'false'] },
    ] },
  ] },
  traefik: { prefix: 'traefik.ingress.kubernetes.io', hintKey: 'ingressPerf.hintTraefik', groups: [
    { tab: 'perf', titleKey: 'ingressPerf.tf.groupRouting', icon: 'alt_route', fields: [
      { key: 'router.entrypoints', labelKey: 'ingressPerf.tf.entrypoints', ph: 'web', vt: 'csv' },
      { key: 'router.middlewares', labelKey: 'ingressPerf.tf.middlewares', ph: 'auth@file,ratelimit@file', vt: 'csv' },
      { key: 'router.tls', labelKey: 'ingressPerf.tf.tls', options: ['', 'true'] },
    ] },
  ] },
  kong: { prefix: 'konghq.com', hintKey: 'ingressPerf.hintKong', groups: [
    { tab: 'perf', titleKey: 'ingressPerf.kong.groupRouting', icon: 'alt_route', fields: [
      { key: 'strip-path', labelKey: 'ingressPerf.kong.stripPath', options: ['', 'true', 'false'] },
      { key: 'regex-priority', labelKey: 'ingressPerf.kong.regexPriority', ph: '100', vt: 'int' },
      { key: 'methods', labelKey: 'ingressPerf.kong.methods', ph: 'GET,POST', vt: 'csv' },
    ] },
  ] },
  generic: { prefix: null, hintKey: 'ingressPerf.hintGeneric', groups: [] },
}

export function detectDialect(className = '') {
  const s = String(className).toLowerCase()
  if (s.includes('traefik')) return 'traefik'
  if (s.includes('haproxy')) return 'haproxy'
  if (s.includes('kong')) return 'kong'
  if (s.includes('nginx')) return 'nginx'
  return 'generic'
}
export function dialectGroups(dialect) { return (INGRESS_DIALECTS[dialect] || INGRESS_DIALECTS.generic).groups }
export function dialectHint(dialect) { return (INGRESS_DIALECTS[dialect] || INGRESS_DIALECTS.generic).hintKey || '' }
export const PERF_GROUPS = INGRESS_DIALECTS.nginx.groups   // 兼容别名

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
export function buildIngressAnnotations(dialect, adv = {}, custom = []) {
  const ann = {}
  const d = INGRESS_DIALECTS[dialect] || INGRESS_DIALECTS.generic
  if (d.prefix) for (const g of d.groups) for (const fld of g.fields) {
    const v = String(adv[fld.key] ?? '').trim()
    if (v) ann[`${d.prefix}/${fld.key}`] = v
  }
  for (const a of custom || []) {
    const k = (a.key || '').trim()
    const val = String(a.value ?? '').trim()
    if (k && val) ann[k] = val   // 键或值任一为空都跳过，避免写入无意义的空注解
  }
  return ann
}

// === 字段值类型(vt):渲染形态 + 校验,单一事实源 ===
// IngressPerfField 按 input 渲染(number=数字框+fld.unitKey 只读后缀、number-unit=数字+单位下拉、
// text=文本/textarea+hint);validateAdvValue 按 re/min/max/options 校验。
// haproxy 时间注释:值原样进 HAProxy 配置,须带单位;nginx 大小裸数字=字节,合法。
export const FIELD_VTS = {
  int:    { input: 'number' },
  size:   { input: 'number-unit', units: ['k', 'm', 'g'], defUnit: 'm', re: /^\d+([kmgKMG])?$/, errKey: 'ingressPerf.errSize', hintKey: 'ingressPerf.hintSize' },
  hpxTime:{ input: 'number-unit', units: ['ms', 's', 'm'], defUnit: 's', re: /^\d+(ms|s|m)$/, errKey: 'ingressPerf.errTime' },
  csvInt: { input: 'text', re: /^\d+(,\d+)*$/, errKey: 'ingressPerf.errCsvInt', hintKey: 'ingressPerf.hintCsvInt' },
  path:   { input: 'text', re: /^\//, errKey: 'ingressPerf.errPath', hintKey: 'ingressPerf.hintPath' },
  csv:    { input: 'text', hintKey: 'ingressPerf.hintCsv' },
  free:   { input: 'text' },
}

// 单字段校验:返回 null(空值=控制器默认,跳过)或错误 i18n key。fld 为上方字段对象。
export function validateAdvValue(fld, raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  if (fld.options) return fld.options.includes(s) ? null : 'ingressPerf.errEnum'
  if (fld.vt === 'int') {
    if (!/^\d+$/.test(s)) return 'ingressPerf.errInt'
    const n = Number(s)
    if ((fld.min != null && n < fld.min) || (fld.max != null && n > fld.max)) return 'ingressPerf.errRange'
    return null
  }
  const vt = FIELD_VTS[fld.vt]
  if (!vt || !vt.re) return null
  return vt.re.test(s) ? null : vt.errKey
}

// 整表校验:方言下全部性能字段。返回 [{ key, labelKey, msgKey }](labelKey 供 toast 指名字段)。
export function validateIngressAdv(dialect, adv = {}) {
  const errs = []
  for (const g of dialectGroups(dialect)) for (const fld of g.fields) {
    const msgKey = validateAdvValue(fld, adv[fld.key])
    if (msgKey) errs.push({ key: fld.key, labelKey: fld.labelKey, msgKey })
  }
  return errs
}

// 注解完整 key(如 nginx.ingress.kubernetes.io/proxy-send-timeout)→ 字段元信息。
// 从 INGRESS_DIALECTS 派生(单一事实源),注解编辑 3 处按 key 提示/校验共用。未知 key → undefined(不限制)。
export function vfmtOfKey(key) {
  const s = String(key || '')
  const i = s.lastIndexOf('/')
  if (i <= 0) return undefined
  const prefix = s.slice(0, i), suffix = s.slice(i + 1)
  for (const d of Object.values(INGRESS_DIALECTS)) {
    if (d.prefix !== prefix) continue
    for (const g of d.groups) for (const f of g.fields) if (f.key === suffix) return f
  }
  return undefined
}

// 已知注解 key 的常显 hint / 示例 placeholder(未知 key 返回 '')
export function hintKeyOfKey(key) { return FIELD_VTS[vfmtOfKey(key)?.vt]?.hintKey || '' }
export function placeholderOfKey(key) { return vfmtOfKey(key)?.ph || '' }

// 自定义注解行校验:key 已知且 value 非空不合格 → 错。返回 [{ index, key, labelKey, msgKey }]
export function validateCustomAnnotations(rows = []) {
  const errs = []
  rows.forEach((a, index) => {
    const fld = vfmtOfKey(a.key)
    if (!fld) return
    const msgKey = validateAdvValue(fld, a.value)
    if (msgKey) errs.push({ index, key: a.key, labelKey: fld.labelKey, msgKey })
  })
  return errs
}
