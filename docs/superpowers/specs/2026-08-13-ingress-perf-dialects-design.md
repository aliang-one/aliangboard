# Ingress 调优模板按控制器方言切换 设计

> 状态:方向 A(方言注册表)已与用户确认。待写实施计划。
> 日期:2026-08-13。分支:`worktree-feat+ingress-perf-dialects`。

## 1. 背景

创建 Ingress 的「网关性能调优」面板(`PERF_GROUPS`,`src/composables/useIngressPerf.js`)只有 nginx 一套字段,注解前缀硬编码 `nginx.ingress.kubernetes.io/*`。className 下拉如今是真实集群类(且平台已能一键部署 nginx/haproxy/traefik/kong 四种控制器),但选中 traefik 等类后调优面板**仍显示 nginx 字段** —— 按它填会写出对所选控制器无效的注解。

两处消费方同构受影响:`DeployApp.vue` 向导(用户投诉场景,`form.ingressAdv`)与 `NsIngress.vue` 创建弹窗(`adv`)。

## 2. 目标 / 非目标

**目标**
- 调优面板随 className 自动切换为对应控制器的**真实注解方言**:nginx / haproxy / traefik / kong。
- 方言切换时旧方言的 adv 值清空(键对新方言无意义);customAnnotations 保留(用户手输自负)。
- 未识别的 className → generic 模式:隐藏调优组、保留自定义注解、显示提示。
- 两处消费方统一行为。

**非目标**
- 不做 traefik IngressRoute / kong KongPlugin 等 CRD 专属配置(thin 方言在 hint 里指路)。
- 不改控制器静态配置(traefik/kong 的性能调优主要在控制器侧,不在 Ingress 注解 —— hint 说明)。
- 不动 Ingress 编辑回显(NsIngressDetail 编辑注解走通用 YAML/注解编辑)。

## 3. 数据模型(useIngressPerf.js 重构,保持零依赖可测)

```js
// 每方言 { groups, prefix, hintKey? } —— groups 沿用现 PERF_GROUPS 的组/字段结构
// { tab: 'perf'|'extra', titleKey, icon, fields: [{ key, labelKey, ph?, options?, area? }] }
export const INGRESS_DIALECTS = {
  nginx:    { groups: <现 PERF_GROUPS 原样迁入>, prefix: 'nginx.ingress.kubernetes.io' },
  haproxy:  { groups: <新建,见 §4>,              prefix: 'haproxy.org' },
  traefik:  { groups: <新建,见 §4>,              prefix: 'traefik.ingress.kubernetes.io', hintKey: 'ingressPerf.hintTraefik' },
  kong:     { groups: <新建,见 §4>,              prefix: 'konghq.com',                    hintKey: 'ingressPerf.hintKong' },
  generic:  { groups: [],                        prefix: null,  hintKey: 'ingressPerf.hintGeneric' },
}
export function detectDialect(className) // 类名含 nginx/haproxy/traefik/kong 子串(不区分大小写)→ 对应方言;否则 'generic'
export function dialectGroups(dialect)   // → INGRESS_DIALECTS[dialect].groups
export function buildIngressAnnotations(dialect, adv = {}, custom = []) // 签名加首参 dialect;generic 时跳过 adv 只拼 custom
```

**兼容**:`PERF_GROUPS` 保留导出 = nginx 组别名(scripts/test.mjs 与潜在引用不破);`buildIngressAnnotations` 签名变化 → 同步更新 scripts/test.mjs 的调用与用例(dialect='nginx' 走原断言)。

## 4. 各方言字段目录(键 = 注解后缀;实现期对照官方文档逐一核实键名)

- **nginx**(现 PERF_GROUPS 原样):proxy-connect/send/read-timeout、body-size、buffer*、limit-*、load-balance、keepalive*、backend-protocol、affinity*、ssl-redirect、hsts*、compression、cors*、rewrite-target、use-regex、app-root、custom-http-errors、snippets。
- **haproxy**(新建,注解丰富,完整调优):
  - perf 组:timeout-connect(ph 5s)、timeout-server(60s)、timeout-http-request(5s)、timeout-queue(5s)、maxconn(ph 2000)、balance-algorithm(options: '', roundrobin, leastconn, source, uri)、buffer-size(16kB)。
  - extra 组:ssl-redirect(options '', true, false)、hsts-enable(options '', true, false)。每字段 labelKey 占 `ingressPerf.hpx.<key>`;目录以 haproxy-ingress 官方注解文档为准(§9)。
- **traefik**(thin,路由向):router.entrypoints(ph web)、router.middlewares(ph auth@file)、router.tls(options '', true)。hintKey:「Traefik 的性能调优主要在控制器静态配置(entryPoint/超时等),非 Ingress 注解;此处仅暴露其支持的每-Ingress 路由注解」。
- **kong**(thin):strip-path(options '', true, false)、regex-priority(ph 100)、methods(ph GET,POST)。hintKey 同理指路 KongPlugin。
- **generic**:groups 空,只留自定义注解槽位;hint「未识别的 IngressClass,已隐藏调优模板;可用下方自定义注解」。

> 字段 label/hint 全走 i18n:nginx 沿用现 `ingressPerf.*` 键;新方言占 `ingressPerf.hpx.*` / `ingressPerf.tf.*` / `ingressPerf.kong.*` + 3 个 hint 键,zh/en 同步键对齐。

## 5. 消费方接线(两处同构)

`DeployApp.vue` 与 `NsIngress.vue`:
1. `const dialect = computed(() => detectDialect(<className 绑定值>))`。
2. 模板:`v-for="g in dialectGroups(dialect)"` 替换 `v-for="g in PERF_GROUPS"`(NsIngress 现有 `.filter(x => x.tab === createTab)` 保留叠加);方言 hint 显示在调优区顶部。
3. `watch(dialect)`:变化时重置 adv(`form.ingressAdv = {}` / `adv.value = {}`);customAnnotations 不动。
4. 提交:`buildIngressAnnotations(dialect, adv, custom)`(DeployApp 生成 yaml 处、NsIngress handleCreate 处)。

## 6. 数据流

选 className → detectDialect → 面板组即时切换 + adv 清空(若方言变了)→ 用户按新方言填写 → 提交时按该方言 prefix 拼 `prefix/key: value`,空值跳过;custom 键值原样并入。generic 方言 → 无调优组 + hint,提交只含 custom。

## 7. 错误处理

- 未知类:不做猜测,explicit generic + hint(避免写出无效注解 —— 本功能的出发点)。
- adv 残留:切方言即清空,结构上杜绝旧键混入;buildIngressAnnotations 只认当前方言 groups 的字段键,天然过滤。
- 空 className(默认「集群默认」):detectDialect('') → generic + hint(诚实:未知默认类指向哪个控制器)。

## 8. 测试

- **契约(scripts/test.mjs,零依赖可 import)**:每方言 groups 字段键 × prefix 拼接正确、空值不写、custom 并入;detectDialect 用例表(nginx-ingress/nginx/ingress-nginx→nginx;traefik/kong/haproxy 及大小写、未知串、'' → generic);generic 时 adv 被忽略;PERF_GROUPS 别名 = nginx 组。
- **vitest(两消费方各一)**:mock 类列表,选 traefik → 调优区出现 router.entrypoints 字段且不再有 proxy-body-size;从 nginx 切 traefik 后 adv 清空(填过 nginx 值再切,提交注解不含 nginx 键);提交注解前缀 = `traefik.ingress.kubernetes.io/`。
- 门禁:`npm run i18n:check` / `typecheck` / `npm test` 全绿。

## 9. 约束

- 不新增依赖;useIngressPerf.js 保持无 Vue 依赖(scripts/test.mjs 直 import)。
- haproxy/traefik/kong 注解键名以官方文档为准,实现期逐一核实(spec §4 目录为准绳,不符即修目录并记录)。
