# Ingress 调优方言切换 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 创建 Ingress 的「网关性能调优」面板随 className 自动切换为所选控制器的真实注解方言(nginx/haproxy/traefik/kong,未知类退化为仅自定义注解)。

**Architecture:** `useIngressPerf.js` 重构为方言注册表 `INGRESS_DIALECTS`(每方言 groups+prefix+hintKey),新增 `detectDialect/dialectGroups/dialectHint`,`buildIngressAnnotations` 加 dialect 首参;`DeployApp.vue` 与 `NsIngress.vue` 两处消费方按 dialect 渲染组、切换时清空 adv、提交时按方言前缀拼注解。

**Tech Stack:** Vue 3 + vitest;`scripts/test.mjs` 零依赖契约测试;i18n zh/en。

## Global Constraints

- 不新增依赖;`useIngressPerf.js` 保持**无 Vue 依赖**(`scripts/test.mjs` 直 import)。
- haproxy(`haproxy.org/*`)/traefik(`traefik.ingress.kubernetes.io/router.*`)/kong(`konghq.com/*`)的注解键名**以官方文档为准** —— Task 1 有逐键核实步骤,发现不符即改字段 key 并在报告记录。
- i18n zh/en 同步、键对齐;门禁 `npm run i18n:check` + `npm run typecheck` + `npm test`。
- 组件测试断言**稳定信号**(placeholder/调用参数),不断言翻译串(i18n 回退坑,见 ledger)。
- spec:`docs/superpowers/specs/2026-08-13-ingress-perf-dialects-design.md`(437fa01)。

---

## 文件结构

**修改**
- `src/composables/useIngressPerf.js` — 方言注册表 + 新函数(T1)。
- `scripts/test.mjs:142-175` — 契约测试升级(dialect 首参 + 新用例)(T1)。
- `src/locales/zh.json` + `en.json` — `ingressPerf.hpx.*` / `tf.*` / `kong.*` + 3 个 hint(T2)。
- `src/views/DeployApp.vue` — dialect 接线(T3)。
- `src/views/NsIngress.vue` — dialect 接线(T4)。

**新增测试**
- `src/views/__tests__/DeployApp.ingressDialect.test.js`(T3)
- `src/views/__tests__/NsIngress.dialect.test.js`(T4)

---

## Task 1: 方言注册表重构 + 契约测试

**Files:**
- Modify: `src/composables/useIngressPerf.js`(全文件重构;现 `PERF_GROUPS` 数组**原样**成为 `INGRESS_DIALECTS.nginx.groups`)
- Modify: `scripts/test.mjs:142-175`

**Interfaces (Produces):**
- `INGRESS_DIALECTS`(对象);`detectDialect(className='') → 'nginx'|'haproxy'|'traefik'|'kong'|'generic'`;`dialectGroups(d) → 字段组数组`;`dialectHint(d) → hintKey|''`;`buildIngressAnnotations(dialect, adv={}, custom=[]) → 注解对象`;`PERF_GROUPS`(兼容别名 = nginx 组)。

- [ ] **Step 1: 核实新方言注解键名(官方文档)**

用 web 工具核实以下键确实存在于各官方文档,不符即替换(spec §9 约束,改动记入报告):
- haproxy-ingress(haproxy-ingress.github.io 注解文档):`haproxy.org/timeout-connect`、`timeout-server`、`timeout-http-request`、`timeout-queue`、`maxconn`、`balance-algorithm`、`buffer-size`、`ssl-redirect`、`hsts-enable`。
- Traefik v3(Kubernetes Ingress provider):`traefik.ingress.kubernetes.io/router.entrypoints`、`router.middlewares`、`router.tls`。
- KIC(Kong):`konghq.com/strip-path`、`regex-priority`、`methods`。

- [ ] **Step 2: 写失败测试(scripts/test.mjs,替换 142-175 两处调用 + 追加新用例)**

现有两处 `buildIngressAnnotations(` 调用(行 144、159)改为首参 `'nginx'`(断言不变)。追加:

```js
// --- 调优方言:detectDialect 用例表 ---
test('detectDialect: 类名子串识别,未知/空 → generic', () => {
  assert.equal(detectDialect('nginx'), 'nginx')
  assert.equal(detectDialect('ingress-nginx'), 'nginx')
  assert.equal(detectDialect('Traefik'), 'traefik')   // 大小写不敏感
  assert.equal(detectDialect('my-haproxy'), 'haproxy')
  assert.equal(detectDialect('kong'), 'kong')
  assert.equal(detectDialect('istio'), 'generic')
  assert.equal(detectDialect(''), 'generic')
})

test('buildIngressAnnotations: haproxy/traefik/kong 各按自己的前缀拼键', () => {
  const h = buildIngressAnnotations('haproxy', { 'timeout-connect': '5s' }, [])
  assert.equal(h['haproxy.org/timeout-connect'], '5s')
  const tf = buildIngressAnnotations('traefik', { 'router.entrypoints': 'web' }, [])
  assert.equal(tf['traefik.ingress.kubernetes.io/router.entrypoints'], 'web')
  const k = buildIngressAnnotations('kong', { 'strip-path': 'true' }, [])
  assert.equal(k['konghq.com/strip-path'], 'true')
})

test('buildIngressAnnotations: generic 忽略 adv 只拼 custom;未知 dialect 同 generic', () => {
  const g = buildIngressAnnotations('generic', { anything: 'x' }, [{ key: 'a/b', value: '1' }])
  assert.deepEqual(g, { 'a/b': '1' })
  const u = buildIngressAnnotations('no-such', { anything: 'x' }, [])
  assert.deepEqual(u, {})
})

test('方言注册表: PERF_GROUPS 别名=nginx 组;traefik/kong 带 hint,nginx/haproxy 无', () => {
  assert.equal(PERF_GROUPS, INGRESS_DIALECTS.nginx.groups)
  assert.ok(INGRESS_DIALECTS.traefik.hintKey && INGRESS_DIALECTS.kong.hintKey && INGRESS_DIALECTS.generic.hintKey)
  assert.ok(!INGRESS_DIALECTS.nginx.hintKey && !INGRESS_DIALECTS.haproxy.hintKey)
  assert.ok(dialectGroups('traefik').length >= 1 && dialectGroups('generic').length === 0)
  assert.ok(dialectHint('nginx') === '' && dialectHint('traefik') !== '')
})
```

import 行同步:`import { buildIngressAnnotations, detectDialect, dialectGroups, dialectHint, INGRESS_DIALECTS, PERF_GROUPS } from '../src/composables/useIngressPerf.js'`

- [ ] **Step 3: 跑测试确认失败**

`node scripts/test.mjs`(经 `npm test` 或直接)→ 新用例 FAIL(detectDialect 未定义)。

- [ ] **Step 4: 重构 useIngressPerf.js**

保留文件头注释与 `INGRESS_ANNOTATION_SUGGESTIONS` 不动;`PERF_GROUPS` 的 `export const PERF_GROUPS = [...]` 改为注册表结构(数组内容原样移入 nginx.groups),并新增:

```js
export const INGRESS_DIALECTS = {
  nginx: { prefix: 'nginx.ingress.kubernetes.io', groups: [ /* 现 PERF_GROUPS 数组原样 */ ] },
  haproxy: { prefix: 'haproxy.org', groups: [
    { tab: 'perf', titleKey: 'ingressPerf.hpx.groupTimeout', icon: 'schedule', fields: [
      { key: 'timeout-connect', labelKey: 'ingressPerf.hpx.timeoutConnect', ph: '5s' },
      { key: 'timeout-server', labelKey: 'ingressPerf.hpx.timeoutServer', ph: '60s' },
      { key: 'timeout-http-request', labelKey: 'ingressPerf.hpx.timeoutHttpRequest', ph: '5s' },
      { key: 'timeout-queue', labelKey: 'ingressPerf.hpx.timeoutQueue', ph: '5s' },
    ] },
    { tab: 'perf', titleKey: 'ingressPerf.hpx.groupConn', icon: 'speed', fields: [
      { key: 'maxconn', labelKey: 'ingressPerf.hpx.maxconn', ph: '2000' },
      { key: 'balance-algorithm', labelKey: 'ingressPerf.hpx.balanceAlgorithm', options: ['', 'roundrobin', 'leastconn', 'source', 'uri'] },
      { key: 'buffer-size', labelKey: 'ingressPerf.hpx.bufferSize', ph: '16kB' },
    ] },
    { tab: 'extra', titleKey: 'ingressPerf.hpx.groupSecurity', icon: 'lock', fields: [
      { key: 'ssl-redirect', labelKey: 'ingressPerf.hpx.sslRedirect', options: ['', 'true', 'false'] },
      { key: 'hsts-enable', labelKey: 'ingressPerf.hpx.hstsEnable', options: ['', 'true', 'false'] },
    ] },
  ] },
  traefik: { prefix: 'traefik.ingress.kubernetes.io', hintKey: 'ingressPerf.hintTraefik', groups: [
    { tab: 'perf', titleKey: 'ingressPerf.tf.groupRouting', icon: 'alt_route', fields: [
      { key: 'router.entrypoints', labelKey: 'ingressPerf.tf.entrypoints', ph: 'web' },
      { key: 'router.middlewares', labelKey: 'ingressPerf.tf.middlewares', ph: 'auth@file,ratelimit@file' },
      { key: 'router.tls', labelKey: 'ingressPerf.tf.tls', options: ['', 'true'] },
    ] },
  ] },
  kong: { prefix: 'konghq.com', hintKey: 'ingressPerf.hintKong', groups: [
    { tab: 'perf', titleKey: 'ingressPerf.kong.groupRouting', icon: 'alt_route', fields: [
      { key: 'strip-path', labelKey: 'ingressPerf.kong.stripPath', options: ['', 'true', 'false'] },
      { key: 'regex-priority', labelKey: 'ingressPerf.kong.regexPriority', ph: '100' },
      { key: 'methods', labelKey: 'ingressPerf.kong.methods', ph: 'GET,POST' },
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
```

- [ ] **Step 5: 跑测试确认通过 + 门禁**

`node scripts/test.mjs` 全过;`npm run typecheck` ✓。

- [ ] **Step 6: Commit**

`git add src/composables/useIngressPerf.js scripts/test.mjs && git commit -m "refactor(ingress-perf): 方言注册表 —— nginx/haproxy/traefik/kong/generic + detectDialect + 契约测试"`

---

## Task 2: i18n 键(hpx / tf / kong + 3 hints)

**Files:**
- Modify: `src/locales/zh.json` + `en.json`(ingressPerf 命名空间内,两文件同位插入、行对齐)

**Interfaces:** 供 T3/T4 渲染的 `t(<titleKey/labelKey/hintKey>)`;键清单与 T1 注册表**逐一对应**。

- [ ] **Step 1: 两文件 ingressPerf 块末尾追加**(zh / en)

```jsonc
// zh.json "ingressPerf": { ...现有键..., }
"hpx": { "groupTimeout": "超时", "timeoutConnect": "连接超时", "timeoutServer": "服务端超时", "timeoutHttpRequest": "HTTP 请求超时", "timeoutQueue": "排队超时", "groupConn": "连接与负载", "maxconn": "最大并发连接", "balanceAlgorithm": "负载均衡算法", "bufferSize": "缓冲大小", "groupSecurity": "安全", "sslRedirect": "HTTPS 跳转", "hstsEnable": "启用 HSTS" },
"tf": { "groupRouting": "路由选项", "entrypoints": "入口点 (entrypoints)", "middlewares": "中间件 (middlewares)", "tls": "启用 TLS" },
"kong": { "groupRouting": "路由选项", "stripPath": "剥离路径 (strip-path)", "regexPriority": "正则优先级", "methods": "HTTP 方法限制" },
"hintTraefik": "Traefik 的性能调优主要在控制器静态配置(entryPoint/超时等),非 Ingress 注解;此处仅其支持的每-Ingress 路由注解",
"hintKong": "Kong 的高级能力(限流/认证等)走 KongPlugin CRD,非 Ingress 注解;此处仅常用路由注解",
"hintGeneric": "未识别的 IngressClass:已隐藏调优模板,可使用下方自定义注解"
```

```jsonc
// en.json
"hpx": { "groupTimeout": "Timeouts", "timeoutConnect": "Connect timeout", "timeoutServer": "Server timeout", "timeoutHttpRequest": "HTTP request timeout", "timeoutQueue": "Queue timeout", "groupConn": "Connections & balancing", "maxconn": "Max connections", "balanceAlgorithm": "Balance algorithm", "bufferSize": "Buffer size", "groupSecurity": "Security", "sslRedirect": "SSL redirect", "hstsEnable": "Enable HSTS" },
"tf": { "groupRouting": "Routing options", "entrypoints": "Entrypoints", "middlewares": "Middlewares", "tls": "Enable TLS" },
"kong": { "groupRouting": "Routing options", "stripPath": "Strip path", "regexPriority": "Regex priority", "methods": "HTTP methods" },
"hintTraefik": "Traefik performance tuning lives in the controller's static config (entryPoints/timeouts), not Ingress annotations; only its per-Ingress routing annotations are shown",
"hintKong": "Kong advanced features (rate limiting/auth) use KongPlugin CRDs, not Ingress annotations; only common routing annotations are shown",
"hintGeneric": "Unrecognized IngressClass: tuning templates hidden — use custom annotations below"
```

- [ ] **Step 2: 门禁**

`npm run i18n:check`(键对齐 ✓ / 引用缺失 0 —— 引用发生在 T3/T4 的模板,此时尚未引用,不缺)。

- [ ] **Step 3: Commit**

`git add src/locales/zh.json src/locales/en.json && git commit -m "i18n(ingress-perf): hpx/tf/kong 方言字段 + 3 hint 键"`

---

## Task 3: DeployApp 接线(用户投诉场景)

**Files:**
- Modify: `src/views/DeployApp.vue`(import 行 9;script 增 computed+watch;模板 1412 行 `v-for="g in PERF_GROUPS"`;622 行 buildIngressAnnotations 调用;className select 1362 行加 testid)
- Test: `src/views/__tests__/DeployApp.ingressDialect.test.js`(新)

**Interfaces:** Consumes T1 全部导出 + T2 i18n 键。

- [ ] **Step 1: 写失败测试**

```js
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchIngressClasses: vi.fn(async () => [{ name: 'traefik', controller: 'x' }]), fetchNamespaces: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []), fetchPriorityClasses: vi.fn(async () => []), fetchServices: vi.fn(async () => []), fetchConfigMaps: vi.fn(async () => []), fetchSecrets: vi.fn(async () => []), fetchPVCs: vi.fn(async () => []), setNamespace: () => {} }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployApp from '../../DeployApp.vue'

function mountApp() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployApp, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true, Breadcrumbs: true, PortSelect: true, EnvSourceField: true, VolumeMountCard: true, TagInput: true, AnnotationKeySelect: true } } })
}

test('选 traefik 类 → 调优面板出现 traefik 字段(placeholder=web),nginx 字段消失', async () => {
  const w = mountApp()
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('traefik')
  await flushPromises()
  expect(w.find('[data-testid="gateway-perf"] input[placeholder="web"]').exists()).toBe(true)
  expect(w.find('[data-testid="gateway-perf"] input[placeholder="60"]').exists()).toBe(false)   // nginx read-timeout
})

test('方言切换清空 adv:填 nginx 值 → 切 traefik → 切回,值已清', async () => {
  const w = mountApp()
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  await flushPromises()
  const nginxInput = w.find('[data-testid="gateway-perf"] input[placeholder="60"]')
  await nginxInput.setValue('90')
  await w.find('[data-testid="ingress-class-select"]').setValue('traefik')
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('nginx')
  await flushPromises()
  expect(w.find('[data-testid="gateway-perf"] input[placeholder="60"]').element.value).toBe('')
})
```

- [ ] **Step 2: 跑测试确认 FAIL**(找不到 testid)

- [ ] **Step 3: 接线**

```js
// import 行 9 改:
import { dialectGroups, dialectHint, detectDialect, buildIngressAnnotations } from '@/composables/useIngressPerf'
// script 增:
const ingressDialect = computed(() => detectDialect(form.ingressClassName))
watch(ingressDialect, () => { form.ingressAdv = {} })   // 旧方言键对新方言无意义
```
(若 `watch` 未 import 则加入 vue import。)

模板:1362 行 select 加 `data-testid="ingress-class-select"`;调优 `<details>`(1406 行)加 `data-testid="gateway-perf"`,其 hint 段后加:

```vue
<p v-if="dialectHint(ingressDialect)" class="text-xs text-on-surface-variant mt-sm mb-xs">{{ $t(dialectHint(ingressDialect)) }}</p>
```

1412 行 `v-for="g in PERF_GROUPS"` → `v-for="g in dialectGroups(ingressDialect)"`;622 行:

```js
const ingressAnn = buildIngressAnnotations(ingressDialect.value, f.ingressAdv, f.ingressCustomAnnotations)
```

- [ ] **Step 4: 跑测试确认 PASS + 门禁**(`npx vitest run src/views/__tests__/DeployApp.ingressDialect.test.js`;`npm run i18n:check`;`npm run typecheck`;`npx vitest run src/views/__tests__/_allViewsMount.test.js -t "DeployApp.vue"`)

- [ ] **Step 5: Commit**

`git add src/views/DeployApp.vue src/views/__tests__/DeployApp.ingressDialect.test.js && git commit -m "feat(ingress-perf): DeployApp 调优面板随 className 切方言 + adv 清空"`

---

## Task 4: NsIngress 接线 + 提交前缀验证

**Files:**
- Modify: `src/views/NsIngress.vue`(import 行 16;`adv` 相关;模板 246 行 select 加 testid、291 行 v-for;`handleCreate` 116 行)
- Test: `src/views/__tests__/NsIngress.dialect.test.js`(新)

**Interfaces:** Consumes T1 导出 + T2 键。提交路径验证注解前缀(补 T3 未覆盖的 submit 级)。

- [ ] **Step 1: 写失败测试**

```js
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

const addIngress = vi.fn(async () => ({ ok: true }))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', nsServices: [], fetchServices: vi.fn(async () => []), fetchIngresses: vi.fn(async () => []), fetchIngressClasses: vi.fn(async () => [{ name: 'traefik' }]), addIngress, setNamespace: () => {} }) }))
vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn() } }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'default' } }), useRouter: () => ({ push: () => {} }) }))

import NsIngress from '../../NsIngress.vue'

function mountDlg() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsIngress, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { Modal: { props: ['modelValue','title','width'], template: '<div><slot/></div>' }, Breadcrumbs: true, Pagination: true, PortSelect: true, AnnotationKeySelect: true, DataTable: true } } })
}

test('选 traefik + 填 entrypoints → addIngress 注解带 traefik 前缀、无 nginx 键', async () => {
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="ingress-class-select"]').setValue('traefik')
  await flushPromises()
  await w.find('[data-testid="perf-panel"] input[placeholder="web"]').setValue('websecure')
  await w.find('[data-testid="create-ingress-btn"]').trigger('click')
  await flushPromises()
  const arg = addIngress.mock.calls.at(-1)[0]
  expect(arg.annotations['traefik.ingress.kubernetes.io/router.entrypoints']).toBe('websecure')
  expect(Object.keys(arg.annotations).some(k => k.startsWith('nginx.ingress.kubernetes.io/'))).toBe(false)
})
```

> create 按钮若无 testid 则顺手加 `data-testid="create-ingress-btn"`;面板容器(291 行组渲染区的外层)加 `data-testid="perf-panel"`。

- [ ] **Step 2: 跑测试确认 FAIL**

- [ ] **Step 3: 接线**(与 T3 同构)

```js
import { dialectGroups, dialectHint, detectDialect, buildIngressAnnotations } from '@/composables/useIngressPerf'
const createDialect = computed(() => detectDialect(createForm.value.className))
watch(createDialect, () => { adv.value = {} })
```
模板:246 行 select 加 testid;hint `<p>` 同 T3;291 行 `PERF_GROUPS.filter(x => x.tab === createTab)` → `dialectGroups(createDialect).filter(x => x.tab === createTab)`;**tab 空则隐藏**(traefik/kong 无 extra 组):

```vue
<!-- tab 按钮区: v-if 对应 tab 有组才显示 -->
<button v-if="dialectGroups(createDialect).some(g => g.tab === 'extra')" ... >{{ t('ns.ingress.tabExtra') }}</button>
```
116 行:`annotations: buildIngressAnnotations(createDialect.value, adv.value, customAnnotations.value)`。

- [ ] **Step 4: 跑测试确认 PASS + 门禁**(新测试 + `NsIngress.unwrapping.test.js` 回归 + i18n:check + typecheck + mount smoke "NsIngress.vue")

- [ ] **Step 5: Commit**

`git add src/views/NsIngress.vue src/views/__tests__/NsIngress.dialect.test.js && git commit -m "feat(ingress-perf): NsIngress 创建弹窗方言切换 + traefik 提交前缀验证"`

---

## 完工门禁

```bash
npm run typecheck && npm run i18n:check && npm test
```
全绿后:手测(DeployApp 向导选 traefik → 调优面板变 traefik 字段;NsIngress 同)→ 终审流程照旧(SDD final review)。

## Self-Review(spec 覆盖)

- §3 注册表/detect/dialectGroups/build 签名/兼容别名 → T1;§4 字段目录 + 官方核实 → T1 Step 1-4;§5 两消费方接线 → T3/T4;§6 数据流 → T3/T4 实现;§7 错误处理(generic/空类/残留过滤)→ T1(generic 忽略 adv)+ T3/T4(watch 清空);§8 测试 → T1 契约 + T3/T4 vitest;§9 约束 → Global Constraints。无缺口。
- 占位符扫描:nginx groups 明示「原样移入」(内容在现文件,非 TBD);其余为完整代码。✓
- 类型一致:dialect 字符串字面量集、`buildIngressAnnotations(dialect, adv, custom)` 三任务一致。✓
