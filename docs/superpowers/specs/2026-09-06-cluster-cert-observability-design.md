# 集群证书可观测(Cluster Certificate Observability)设计

- 日期:2026-09-06
- 状态:Approved(brainstorm 结论:MVP = 可观测 + 告警 + CA 失配引导)
- 分支:`feat/cluster-certs`(基于 main@68ca2c6)

## 1. 背景与动机

K8s 集群证书默认一年一换,kubeadm 自建集群「证书过期 → 集群静默死亡」是真实高频事故:apiserver 证书过期后网关握手失败,面板上只显示一个无差别的 Disconnected,用户无从归因。同时面板自身是**靠 CA 信任集群的客户端**——集群轮换 CA / 重建集群后,网关存储的 CA 失配,该集群在面板上失联,当前无任何诊断入口。

本设计交付三层能力(MVP):

1. **证书到期可观测**:API server 服务证书、网关信任的 CA 锚、`kubernetes.io/tls` Secret(cert-manager 管理的自动识别)统一看板,倒计时分级。
2. **告警**:复用顶栏铃铛,证书 30/7/0 天阈值告警。
3. **CA 失配检测引导**:TLS 握手失败按错误码归因(CA 失配/证书过期/主机名失配/网络不可达),admin 集群卡显示归因,证书页给出重信任引导(重贴 kubeconfig),**绝不自动信任新证书**。

## 2. Non-goals(明确不做)

| 项 | 理由 |
|---|---|
| 面板一键整集群轮换证书 | 控制面证书住在节点 `/etc/kubernetes/pki`,K8s API 够不着;须 SSH 到控制面节点执行 `kubeadm certs renew`,爆炸半径大且强绑定发行版(kubeadm/k3s/RKE2/托管各不同)。v2 可做「引导式执行」(SSH 台账 + 审批链),见 §10。 |
| 99 年证书 | 有效期只在签发时定,改它=重建 CA=全集群轮换;kubelet 客户端证书年度轮换是 CSR 机制写死的;安全反模式。面板不应教用户埋雷。 |
| 证书签发/CSR UI | cert-manager 已是该领域标准,面板只读它的状态即可。 |
| 跨集群证书总览 | 铃铛/页面按选中集群聚合(与现有 events 铃铛同口径);跨集群聚合是 admin 域的后续演进。 |
| 自动信任变更后的 CA | 自动信任陌生证书 = 安全洞。检测 + 引导人工重贴 kubeconfig 是信任边界内的正确形态。 |

## 3. 技术事实与现状

- **两个证书世界**:控制面证书(apiserver/etcd/kubelet/front-proxy,节点文件系统)面板**只能观测其服务证书**(TLS 握手可见),不能续期;工作负载证书(TLS Secrets / cert-manager CRD)K8s API 完全可达。
- **网关凭据**:`clusters` 表与 `sessions` 表都持有 `apiServer/authHeader/ca/cert/key/insecure`(PEM 明文,`certMaterial` 解码后入库,`server/index.mjs:543-552`)。`node:crypto` 的 `X509Certificate` 直接吃 PEM/DER,零新依赖。
- **现状缺口**:`server/cluster-probe.mjs` 的 catch 把「坏 CA / 证书过期 / 拒连 / 401」全折叠成 `status:'Disconnected'`,无归因。全仓无任何 X509/tls.connect/getPeerCertificate 使用(三路侦察确认)。
- **先例**:DI 工厂模式 `createClusterProber({ requestFn, ttl, timeout, now })`(cluster-probe.mjs);session 级端点内联读 `req.abSession` + `k8sGate.gateK8sSession` ns 门(index.mjs:2087 起,registry-tags 是集群级 `namespace: null` 先例);TTL 缓存三型(probe 型/version 双 TTL 型/Map+env 型)。
- **前端**:Vue Query `useResourceList` + `cid` ref 入 queryKey;DataTable + `TABLE_CATALOG` 注册即得显隐/排序/列宽;铃铛是纯前端按选中集群聚合 warning events(`AlertBell.vue`),未读台账 `useAlertReadState` 按 `uid` 记忆;K 轨页面规范(dual-track spec,无舞台门面、`meta.module` 不碰)。

## 4. 总体架构

```
                     ┌─ GET /api/cluster-certs (session + k8sGate namespace:null view)
浏览器 ──────────────┤    └─ server/routes/cluster-certs.mjs
  /cluster/certs 页 ─┤         └─ server/cluster-certs.mjs (createClusterCerts service)
  AlertBell 铃铛 ────┤              ├─ probeTls:  node:tls 双拨(严/宽)→ peer 证书 + trust 归因
  (同一 queryKey     │              ├─ CA 锚解析: session.ca PEM 链 → X509 描述符
   共享缓存)         │              ├─ scanSecrets: requestKubernetes(session) 列 tls Secret + base64 解链
                     │              └─ cert-manager: /apis/cert-manager.io/v1/certificates(404→未安装)
                     │                 [模块级 TTL 缓存 60s,injectable now]
                     │
admin 集群列表 ──────┘─ GET /api/admin/clusters(既有)→ probeAll 后对 Disconnected 行追加 disconnectReason
                                          └─ clusterCerts.classifyFromRow(clusters 行凭据,独立缓存)
```

## 5. 网关设计

### 5.1 `server/cluster-certs.mjs`(新模块,纯函数 + DI 服务)

```
createClusterCerts({ tlsConnect, requestFn, now, ttlMs, timeoutMs })
```

- `tlsConnect` 默认 `node:tls.connect`(可注入,单测不必真拨号);`requestFn` 即 `requestKubernetes`;`now` 可注入(测 TTL/天数)。
- **证书描述符**(所有出口的唯一证书形态,**绝不含 PEM/DER**):
  `{ subject, issuer, validFrom(ms), validTo(ms), daysLeft, sans[], fingerprint256, isCA }`
  - `daysLeft = Math.ceil((validTo - now)/86400_000)`(负数=已过期)。
  - `parseCertChain(pem)`:按 `-----END CERTIFICATE-----` 切链,逐个 `new X509Certificate`;`subjectAltName` 字符串(`DNS:x, IP:y`)拆数组;`parseCertDate(str)` 解析证书时间格式,失败时用月份名映射兜底(不依赖 V8 对非 ISO 日期的宽容解析)。
- **`probeTls({ host, port, servername, ca, insecure, timeoutMs })` 双拨**:
  1. **宽拨** `rejectUnauthorized:false` → 拿 `getPeerCertificate()`(leaf)+ `getPeerCertificate(true)` 的 issuer 链,逐个 `new X509Certificate(cert.raw)` 解析;失败(网络错误码)→ `trust:'unreachable'`。
  2. **严拨**(仅当 `session.ca` 存在且 `!insecure`):`rejectUnauthorized:true, ca:存储的 CA` → 成功 = `trust:'trusted'`;失败按 §5.2 错误码表归因。
  3. `insecure` 会话无 CA 校验语义 → `trust:'unverified'`(仍报 peer 证书与到期)。
  - 用 `node:tls` 直拨而非 undici dispatcher:与 `getDispatcher` 的 sig 缓存/K8S_INSECURE_SKIP_TLS_VERIFY 环境变量解耦(侦察报告风险 #3),自带短超时(默认 5s),用后 `destroy()`。
- **`scanSecrets(session, now)`**:`requestKubernetes(session, '/api/v1/secrets?fieldSelector=<type=kubernetes.io/tls>&limit=500')`;逐 item base64 解 `tls.crt` → `parseCertChain` → leaf 描述符 + `chainCount`;返回按 `daysLeft` 升序。上游 403 → `{ items:[], error:'forbidden' }`(其余 section 不受影响)。**Secret 的 key 永不触碰**。
- **cert-manager 合并**:GET `/apis/cert-manager.io/v1/certificates?limit=500`;404 → `certManagerInstalled:false` 静默降级;命中 `spec.secretName`+namespace 的 Secret 标 `managedBy:'cert-manager'` 并带 `{ ready, renewalTime }`(status.conditions Ready + status.renewalTime)。
- **服务层 `getCertsReport(session)`**:组装 `{ connection, caAnchors, secrets, certManagerInstalled, fetchedAt }`,模块级 `Map<clusterKey, {data, at}>` TTL 缓存(默认 60s;`invalidate()`/`_cacheSizeForTest()` 对标 cluster-probe)。cache key 用 `session.apiServer` origin(会话表 ca 与集群行 ca 可能不同,按会话口径缓存)。

### 5.2 TLS 错误归因表(`classifyTlsError(code)`)

| error.code | trust |
|---|---|
| (严拨成功) | `trusted` |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `SELF_SIGNED_CERT_IN_CHAIN` / `DEPTH_ZERO_SELF_SIGNED_CERT` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` | `ca-mismatch`(服务端链不被存储 CA 锚定) |
| `CERT_HAS_EXPIRED` | `cert-expired` |
| `ERR_TLS_CERT_ALTNAME_INVALID` | `hostname-mismatch`(apiServer 地址与证书 SAN 失配) |
| 宽拨 `ECONNREFUSED/ETIMEDOUT/ENOTFOUND/EAI_AGAIN/EHOSTUNREACH/ENETUNREACH/ECONNRESET` | `unreachable` |
| 其余 | `error`(保留 `reasonCode` 原码) |

每态附带安全 reason 字符串(错误 message,已无敏感凭据)。

### 5.3 路由与鉴权

- 新 `server/routes/cluster-certs.mjs`,`createClusterCertsRoutes({ sendJson, msg, clusterCerts, k8sGate, levelForRequest })` → `{ handle }`,挂进 index.mjs 的模块分发链(adminRoutes 之后)。handler 内再调一次门(纵深防御,version.mjs 惯例)。
- `ROUTE_AUTH` 新增一行:`{ method: 'GET', pattern: '/api/cluster-certs', auth: 'session' }`;handler 用 `url.pathname === '/api/cluster-certs'` 字面量(守卫测试正则可见)。
- ns 门:对齐 registry-tags 先例——`k8sGate.gateK8sSession(session, { namespace: null, level: levelForRequest(req.method), path, method })`,不通过 → 403 `api.nsForbidden`。open 模式全员可见;allowlist 模式按集群授权(admin 短路)。
- 200 响应即 `getCertsReport` 结果(读端点无 `{ok}` 包裹,集群数据 GET 惯例);500/502 上游错误 `{ message }`。

### 5.4 admin 断连归因

- `routes/admin.mjs` 的 `GET /api/admin/clusters`:`probeAll` 之后,对 `status==='Disconnected'` 的行调 `clusterCerts.classifyFromRow(row)`(用 clusters 行凭据做一次严拨,独立 TTL 缓存 60s;Healthy 行零开销),行上追加 `disconnectReason: 'ca-mismatch' | 'cert-expired' | 'hostname-mismatch' | 'unreachable' | 'error'`。
- `clusters` GET 出口白名单**显式加这一个字段**(凭据列照旧绝不外泄;归因结果非敏感)。
- ClusterCard 消费:Disconnected 时显示归因 chip(证书失配/证书过期/主机名失配/网络不可达),缺字段向后兼容不渲染。

## 6. 前端设计

### 6.1 路由 / 侧栏 / 搜索

- 路由:`path: 'cluster/certs'`,name `ClusterCerts`,`meta: { titleKey: 'nav.certs', icon: 'verified', scope: 'global' }`(不设 `module`/`requiresCluster`,clusterGate 默认要求选中集群;titleKey 落 `nav.certs` 而非 `route.clusterCerts`——随 ClusterEvents 用 `nav.events` 的先例)。
- 侧栏:`clusterResourcesNav` 追加 `{ icon: 'verified', labelKey: 'nav.certs', route: '/cluster/certs' }`。
- 全局搜索:`globalSearch.js` PAGE_ENTRIES 追加(含 keywords),中文同义词进 `nav.searchPageSynonyms['cluster/certs']`(zh.json)。

### 6.2 `src/views/ClusterCerts.vue`(Nodes.vue 骨架,K 轨)

- 数据:`useResourceList({ key: ['cluster', cid, 'certs'], fetcher: () => store.fetchClusterCerts(), options: { staleTime: 60_000, refetchInterval: 300_000 } })`——与铃铛共用同一 queryKey(去重)。`fetchClusterCerts` 落在 `stores/cluster.js` 内联(随 `fetchEvents` 先例,调 `api.clusterCerts()` 新 client 方法;`_allViewsMount` 真实 store 挂载下 Proxy api 兜底)。取数失败(ns 门 403/上游 5xx)显示 error 横幅(`certs-load-error`),不静默空白。
- **A 段「集群连接证书」**(少量异构行,自定义卡片而非 DataTable):
  - 状态 banner:`trusted` 绿/默认无;`ca-mismatch`/`cert-expired`/`hostname-mismatch` error banner(归因文案 + 「管理员重新导入 kubeconfig」引导,链接 /clusters);`unverified` tertiary 提示(insecure 接入未校验链);`unreachable` error。
  - API server 服务证书卡:subject/issuer/到期日/daysLeft 分级 pill/SANs(`max-w` + `truncate` + `:title`,遵守 overflow 守卫)。
  - CA 锚列表(存储的 CA 链,各带到期/daysLeft/fingerprint256 短码)。
- **B 段「TLS 证书 Secret」**:DataTable,catalog key `clusterCerts`,行 = secrets scan 结果。列:name / namespace / cn(leaf subject)/ issuer / sans(截断)/ expires(日期)/ daysLeft(分级 pill)/ certManager(✓ Ready / RenewalTime / —)。过滤 chips:全部 / 30 天内 / 已过期 + 名称搜索。`secrets.error==='forbidden'` 时 B 段显示权限提示条,A 段照常。
- 分级色(无 warning token,用 tertiary):`expired`/`≤7d` → `bg-error-container/30 text-error`(透明度必须 5 的倍数);`≤30d` → `bg-tertiary-container/20 text-tertiary-container`;正常 → `bg-primary/10 text-primary`。倒计时纯函数进 `src/logic/certExpiry.js`。

### 6.3 TABLE_CATALOG

```js
{ key: 'clusterCerts', labelKey: 'certs.title', label: 'Cluster Certificates', icon: 'verified', columns: [
  { key: 'name', labelKey: 'certs.thName', label: 'Secret' },
  { key: 'namespace', labelKey: 'cols._c.namespace', label: 'Namespace' },
  { key: 'cn', labelKey: 'certs.thCn', label: 'Common Name' },
  { key: 'issuer', labelKey: 'certs.thIssuer', label: 'Issuer' },
  { key: 'sans', labelKey: 'certs.thSans', label: 'SANs' },
  { key: 'expires', labelKey: 'certs.thExpires', label: 'Expires' },
  { key: 'daysLeft', labelKey: 'certs.thDaysLeft', label: 'Days Left' },
  { key: 'certManager', labelKey: 'certs.thCertManager', label: 'cert-manager' },
] }
```

无需迁移(reconcileColumns 对未知列追加尾部)。

### 6.4 铃铛合并(AlertBell)

- 新增第二个 query(同 key `['cluster', cid, 'certs']`,`refetchInterval: 300_000`,`enabled` 同 events)——与页面共享缓存,不新增全局轮询负担(events 的 60s 轮询/watch 互斥逻辑不动)。
- 伪事件构造(纯函数入 `src/logic/certExpiry.js`,i18n 经 `t` 参数注入):`daysLeft ≤ 30` 或已过期的 leaf → `{ uid: 'cert:' + fingerprint256(稳定,跨天不漂移), type: 'warning', reason: t('nav.certAlertReason'|'nav.certAlertReasonExpired')(铃铛加粗行文案), age: t('nav.certAlertExpiringAge'|'nav.certAlertExpiredAge', { days })(右侧时间位), icon: 'key', color: 'tertiary'|'error', relatedKind: 'Certificate', relatedName, relatedNamespace, _ts: now() }`(铃铛只渲染 reason/relatedKind/relatedName/age,无 message 字段)。
- 面板合并:`[...warningEvents(按 _ts desc), ...certAlerts(按 daysLeft asc)]` 取前 30;未读台账复用 `eventKey`(uid 稳定 → 标记已读后不复活)。
- 点击导航:`src/logic/resourceNavigation.js` 的 `routeForResource` 增加 `Certificate` kind → `{ name: 'ClusterCerts' }`。

### 6.5 i18n 键清单(zh/en 双侧,`certs.*` 顶级命名空间 + `nav.*`/`route.*`)

`certs.title/subtitle/sectionConnection/sectionSecrets/banners(...)  /thName/thCn/thIssuer/thSans/thExpires/thDaysLeft/thCertManager/filterAll/filterExpiring/filterExpired/searchPlaceholder/forbidden/insecureHint/cmReady/cmRenew/cmNone/…`;`route.clusterCerts`;`nav.certs`;`nav.certAlertExpiring/certAlertExpired`;`nav.searchPageSynonyms['cluster/certs']`(zh)。注意 `|`/`@` 转义规则;服务端 `api.*`/`admin.*` 新键(server/messages)同步补 zh+en(messages.test 全键双语断言)。

## 7. 错误处理矩阵

| 故障 | 端点行为 | UI |
|---|---|---|
| 集群不可达 | connection.trust='unreachable'(宽拨失败) | A 段 error banner;B 段若 scan 也失败 → secrets.error |
| CA 失配 | trust='ca-mismatch' + reasonCode | error banner + 重贴 kubeconfig 引导;admin 卡归因 chip |
| 证书过期 | trust='cert-expired' | 同上(引导:kubeadm certs renew / cert-manager 排查) |
| 主机名失配 | trust='hostname-mismatch' | banner 指出 apiServer URL 与 SAN 不符 |
| Secret 无权限 | secrets.error='forbidden' | B 段提示条,A 段照常 |
| cert-manager 未装 | certManagerInstalled=false | B 段列显示 — |
| session 失效 | 401(k8sHttp 既有回跳逻辑) | 既有登录回跳 |
| ns 门拒绝(allowlist) | 403 api.nsForbidden | 页面 error 态 |

## 8. 安全考量

- **绝不回传 PEM/DER/私钥**:出口只有派生描述符;路由测试断言 payload 无 `BEGIN`(含 base64 变体不涉及——描述符全为字符串/数字)。
- **绝不自动信任**:失配只归因 + 引导人工重贴 kubeconfig。
- tls 直拨目标是存储的 apiServer(非用户输入),无 SSRF 面;宽拨 `rejectUnauthorized:false` 只作用于该 host 的单次握手。
- ns 门/会话门复用既有 k8sGate;admin 面归因仅 admin 可见。
- 读端点不写审计(与既有 GET 惯例一致);无新依赖(`node:tls`/`node:crypto`)。

## 9. 测试计划

**夹具**(新 `server/test-fixtures/certs/`):openssl 生成 ca1/leaf1(ca1 签发,SANs 含 DNS)/ca2(异 CA)/leaf-selfsigned;`gen.sh` + README 记录再生成方式。测试断言**从解析结果推导**期望(不硬编码绝对日期,`now` 可注入);「过期证书」路径靠 classifier 单测覆盖(openssl 3.0 无显式 not_after 时不再强求 retro-date 实拨)。

| 文件 | 覆盖 |
|---|---|
| `server/cluster-certs.test.mjs`(node --test,自动入链) | parseCertChain(链/SANs/isCA/fingerprint)、parseCertDate 兜底、daysLeft、classifyTlsError 全表、scanSecrets(mock requestFn:正常/403/坏 base64)、cert-manager 合并(200/404)、service TTL/invalidate(injectable now)、**出口无 PEM 断言** |
| `server/cluster-certs-tls.test.mjs` | 真 `tls.createServer`+fixture:严拨对 CA→trusted;错 CA→ca-mismatch;SAN 失配(servername 换名)→hostname-mismatch;拒连端口→unreachable;宽拨 peer 链解析 |
| `server/routes/cluster-certs.test.mjs` | DI harness(admin-cluster-namespaces 模式):200 形状、ns 门 403(mock k8sGate)、上游 500→{message}、authClassFor('GET','/api/cluster-certs') 有 class |
| `server/admin-cluster-disconnect-reason.test.mjs` | Disconnected 行追加归因/Healthy 行零调用/白名单外泄回归 |
| `src/logic/certExpiry.test.mjs`(node runner,**须手动加进 test:server 链**) | severity 分档/伪事件构造(uid 稳定性/阈值边界 30/7/0) |
| `src/views/__tests__/ClusterCerts.view.test.js`(vitest) | 挂载渲染两段/days pill 分级类名/过滤 chips/banner 各态/forbidden 提示 |
| AlertBell.test.js 扩展 | cert 数据合并入面板/未读计数/uid 稳定/既有 events 用例不回归 |
| ClusterCard 测试扩展 | disconnectReason chip |

门禁:`npm test`(含 route-auth 守卫/overflow-guard/ui-language-guard)+ `npm run i18n:check` + `npm run typecheck` + `npm run build`;`_allViewsMount`/`_allModulesImport`/missing-value/await-race 自动继承。

## 10. 风险与开放问题

- **opensl 显式日期**:`-not_after` 在 3.0.5+ 才有(本机 3.0.15 待验证);不支持则过期态走 classifier 单测,不影响交付面。
- **宽拨拿不到完整链**(部分服务端只发 leaf):描述符仍以 leaf 为准,CA 锚来自本地存储,功能不依赖服务端链完整。
- **k3s/托管集群**:apiserver 证书由平台自动轮换,页面对「即将到期」的告警在 cert-manager 管理的 Secret 上有 `managedBy` 标注缓解告警疲劳;控制面证书到期提示托管集群用户可忽略(banner 文案不区分发行版——过度设计,记为开放问题)。
- **v2 路线**(不在本批):SSH 台账登记控制面节点后,按发行版生成轮换手册 + 带审批的引导式执行(复用 SSH job + 审批链);到期前 N 天的主动通知(而非被动铃铛)。
