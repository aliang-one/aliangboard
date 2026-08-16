# Ingress 路径级后端映射统一 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「域名+path → Service 端口」在全部四个入口可用:抽取共享 `IngressRulesEditor` 组件 + 纯函数层,修复部署向导的 `servicePorts[0]` 硬编码与悬空引用、详情弹窗的手填端口与 Ingress 碎片化、独立创建的单 path 限制。

**Architecture:** ④(NsIngressDetail Edit Rules)的 host 分组编辑器是金标准,抽成 `src/components/common/IngressRulesEditor.vue`;转换/决策/YAML 逻辑下沉为 `src/composables/useIngressRules.js` 纯函数(node --test 直测);①②③④ 四入口消费。backend 一律取 path 级 `serviceName/servicePort`,生成层禁止 `\|\| 80` 兜底与硬编码 `{name}-svc`。

**Tech Stack:** Vue 3 `<script setup>` + Pinia + vue-i18n + @tanstack/vue-query;测试分两层——纯逻辑 `node --test`(零依赖运行器),组件 `vitest + happy-dom + @vue/test-utils`。

**Spec:** `docs/superpowers/specs/2026-08-16-ingress-path-mapping-design.md`(已批准)

## Global Constraints

- 分支 `feat/ingress-path-mapping`,worktree `.claude/worktrees/ingress-path-mapping`(已存在,勿再建)。
- 仓库禁止新增外部依赖(见 CLAUDE.md);本计划零新依赖。
- i18n:新增键 en+zh 同步;HTML 富文案须 `v-html`;完成每个 Task 后跑 `npm run i18n:check`。
- 组件 i18n 键沿用 `ns.ingressDetail.*` 命名空间(保持 ④ 等价、避免键漂移;这是对 spec §3.2 的落地细化)。
- 测试基线:`npm test`(server+unit)与 `npm run typecheck` 全绿才算完成。
- 生成层不变式:backend 取 path 级字段,无 `|| 80` 兜底、无硬编码 `{name}-svc`(旧代码 `buildIngressRulesPatch` 里的 `|| 80` 是存量,不动)。
- 每个 Task 结束单独 commit(消息末尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`)。

---

### Task 1: 纯函数层——转换与规格函数

**Files:**
- Modify: `src/composables/useIngressRules.js`(追加导出)
- Create: `src/composables/useIngressRules.test.mjs`(node:test 语法)
- Modify: `package.json`(test:server 链尾追加)

**Interfaces:**
- Consumes: 无(纯函数,零依赖;仅 `import { yamlScalar } from './useYaml.js'`,该模块已被 scripts/test.mjs 引入,可 node 直跑)
- Produces(后续 Task 依赖的精确签名):

```js
// K8s rules 数组 → 扁平规则(兼容新/旧 backend 形状)
export function ingressRulesToFlat(rules) // [{host,path,pathType,serviceName,servicePort(String)}]
// 扁平规则 → hosts 编辑模型(按 host 首次出现顺序分组)
export function flatToHosts(flatRules) // [{host, tls:false, tlsSecret:'', paths:[{path,pathType,serviceName,servicePort}]}]
// hosts 编辑模型 → 扁平规则(appendPathToIngress/④保存共用)
export function hostsToFlat(hosts) // [{host,path,pathType,serviceName,servicePort}]
// hosts → K8s spec 片段(③ addIngress 用);port 无兜底(未填由校验拦)
export function hostsToK8sSpec(hosts, { defaultTlsSecret = '' } = {})
// → { rules: [{host, http:{paths:[{path,pathType,backend:{service:{name,port:{number}}}}]}}],
//     tls: [{hosts:[host], secretName}] }  // 仅 tls&&host 非空的项
```

- [ ] **Step 1: 写失败测试**(完整文件)

```js
// src/composables/useIngressRules.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildIngressRulesPatch, ingressRulesToFlat, flatToHosts, hostsToFlat, hostsToK8sSpec } from './useIngressRules.js'

test('ingressRulesToFlat: K8s 形状 rules 拍平(新 backend 形状)', () => {
  const rules = [{ host: 'a.com', http: { paths: [{ path: '/api', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 8080 } } } }] } }]
  assert.deepEqual(ingressRulesToFlat(rules), [
    { host: 'a.com', path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' },
  ])
})

test('ingressRulesToFlat: 兼容旧形状(serviceName/servicePort 直挂 backend)+ 命名端口', () => {
  const rules = [{ host: '', http: { paths: [{ path: '/', backend: { serviceName: 'old', servicePort: 'http' } }] } }]
  assert.deepEqual(ingressRulesToFlat(rules), [
    { host: '', path: '/', pathType: 'Prefix', serviceName: 'old', servicePort: 'http' },
  ])
})

test('ingressRulesToFlat: 空/缺段安全', () => {
  assert.deepEqual(ingressRulesToFlat(undefined), [])
  assert.deepEqual(ingressRulesToFlat([{ host: 'a.com' }]), [])
  assert.deepEqual(ingressRulesToFlat([{ host: 'a.com', http: { paths: [] } }]), [])
})

test('flatToHosts: 同 host 聚合(含非相邻),保持首现顺序;round-trip 无损', () => {
  const flat = [
    { host: 'a.com', path: '/x', pathType: 'Prefix', serviceName: 's1', servicePort: '80' },
    { host: 'b.com', path: '/', pathType: 'Exact', serviceName: 's2', servicePort: '9090' },
    { host: 'a.com', path: '/y', pathType: 'Prefix', serviceName: 's1', servicePort: '8080' },
  ]
  const hosts = flatToHosts(flat)
  assert.equal(hosts.length, 2)
  assert.equal(hosts[0].host, 'a.com')
  assert.equal(hosts[0].paths.length, 2)
  assert.equal(hosts[0].paths[1].path, '/y')
  assert.equal(hosts[0].tls, false)
  // round-trip: flat → hosts → flat 与原序一致
  assert.deepEqual(hostsToFlat(hosts), flat)
})

test('flatToHosts: 空输入 → []', () => {
  assert.deepEqual(flatToHosts([]), [])
  assert.deepEqual(flatToHosts(undefined), [])
})

test('hostsToFlat: 逐 path 展开,缺省补齐', () => {
  const hosts = [{ host: 'a.com', tls: true, tlsSecret: 'sec', paths: [{ path: '/api', pathType: 'Exact', serviceName: 'w', servicePort: '8080' }] }]
  assert.deepEqual(hostsToFlat(hosts), [{ host: 'a.com', path: '/api', pathType: 'Exact', serviceName: 'w', servicePort: '8080' }])
})

test('hostsToK8sSpec: 生成 K8s 形状 + per-host TLS 聚合 + 默认 secret 回退', () => {
  const hosts = [
    { host: 'a.com', tls: true, tlsSecret: '', paths: [{ path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' }] },
    { host: 'b.com', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'web', servicePort: '80' }] },
  ]
  const spec = hostsToK8sSpec(hosts, { defaultTlsSecret: 'my-tls' })
  assert.deepEqual(spec.rules, [
    { host: 'a.com', http: { paths: [{ path: '/api', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 8080 } } } }] } },
    { host: 'b.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } },
  ])
  assert.deepEqual(spec.tls, [{ hosts: ['a.com'], secretName: 'my-tls' }])
})

test('hostsToK8sSpec: 显式 secret 优先;空 host 的 tls 不进 tls 数组;port 无 80 兜底', () => {
  const hosts = [{ host: 'a.com', tls: true, tlsSecret: 'explicit', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'w', servicePort: '80' }] },
                 { host: '', tls: true, tlsSecret: 'x', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'w', servicePort: '80' }] }]
  const spec = hostsToK8sSpec(hosts, {})
  assert.deepEqual(spec.tls, [{ hosts: ['a.com'], secretName: 'explicit' }])
})

test('buildIngressRulesPatch 存量回归:不因本次改动破坏', () => {
  const patch = buildIngressRulesPatch([{ host: 'a.com', path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' }], null)
  assert.deepEqual(patch.spec.rules[0].http.paths[0].backend.service.name, 's')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/composables/useIngressRules.test.mjs`
Expected: FAIL(`ingressRulesToFlat` 等导出不存在,SyntaxError/undefined)

- [ ] **Step 3: 最小实现**(追加到 `src/composables/useIngressRules.js`,置于 `buildIngressRulesPatch` 之后)

```js
// === hosts 编辑模型 ↔ 扁平规则 ↔ K8s spec(四入口共享)===
// K8s rules 数组 → 扁平规则。兼容两种 backend 形状:
// 新:backend.service.{name,port:{number|name}};旧:backend.{serviceName,servicePort}
export function ingressRulesToFlat(rules) {
  const out = []
  for (const r of rules || []) {
    for (const p of (r.http?.paths || [])) {
      const svc = p.backend?.service || p.backend
      out.push({
        host: r.host || '',
        path: p.path || '/',
        pathType: p.pathType || 'Prefix',
        serviceName: svc?.name ?? svc?.serviceName ?? '',
        servicePort: String(svc?.port?.number ?? svc?.port?.name ?? svc?.servicePort ?? ''),
      })
    }
  }
  return out
}

// 扁平规则 → hosts 编辑模型(按 host 首次出现顺序分组,非相邻同 host 合并)
export function flatToHosts(flatRules) {
  const byHost = new Map()
  for (const r of flatRules || []) {
    if (!byHost.has(r.host)) byHost.set(r.host, [])
    byHost.get(r.host).push({ path: r.path || '/', pathType: r.pathType || 'Prefix', serviceName: r.serviceName || '', servicePort: String(r.servicePort ?? '') })
  }
  return Array.from(byHost.entries()).map(([host, paths]) => ({ host, tls: false, tlsSecret: '', paths }))
}

// hosts 编辑模型 → 扁平规则(updateIngressRules / 追加决策共用)
export function hostsToFlat(hosts) {
  return (hosts || []).flatMap(h => (h.paths || []).map(p => ({
    host: h.host || '', path: p.path || '/', pathType: p.pathType || 'Prefix', serviceName: p.serviceName || '', servicePort: p.servicePort,
  })))
}

// hosts → K8s spec 片段(③ addIngress 构造 rules/tls 用)。
// 注意:port 不做 || 80 兜底——未填由各入口校验拦截(生成层不变式,见 spec §3.3)。
export function hostsToK8sSpec(hosts, { defaultTlsSecret = '' } = {}) {
  const rules = [], tls = []
  for (const h of hosts || []) {
    const paths = (h.paths || []).map(p => ({
      path: p.path || '/',
      pathType: p.pathType || 'Prefix',
      backend: { service: { name: p.serviceName || '', port: { number: Number(p.servicePort) } } },
    }))
    rules.push({ host: h.host || '', http: { paths } })
    if (h.tls && h.host) tls.push({ hosts: [h.host], secretName: h.tlsSecret || defaultTlsSecret })
  }
  return { rules, tls }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/composables/useIngressRules.test.mjs`
Expected: PASS(全部)

- [ ] **Step 5: 注册进测试链**

`package.json` 的 `test:server` 值末尾追加(在 `node --test scripts/deployment-manifest.test.mjs` 之后):

```
 && node --test src/composables/useIngressRules.test.mjs
```

Run: `npm run test:server`
Expected: 全绿(现有用例不回归)

- [ ] **Step 6: Commit**

```bash
git add src/composables/useIngressRules.js src/composables/useIngressRules.test.mjs package.json
git commit -m "feat(ingress): 纯函数层——hosts/flat/K8s spec 互转(四入口共享底座)"
```

---

### Task 2: 纯函数层——追加决策与向导 YAML

**Files:**
- Modify: `src/composables/useIngressRules.js`
- Modify: `src/composables/useIngressRules.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `ingressRulesToFlat`
- Produces:

```js
// 同 host(精确、非空)的已有 Ingress 列表;ingressList 为 store ingress 对象(含 .rules/.name/.defaultBackend)
export function sameHostIngresses(ingressList, host) // → Ingress[]
// 往单个 ingress 追加一条 path;返回拍平后的完整 flatRules + 冲突标记(同 host 同 path 已存在)
export function appendPathToIngress(ingress, rule) // rule:{host,path,pathType,serviceName,servicePort}
// → { flatRules, conflict:boolean }
// 向导 Ingress YAML 文档(以 '\n---\n' 开头);无有效 host 返回 ''
export function buildWizardIngressYaml(hosts, { name, namespace, ingressClassName = '', annotations = {} } = {})
```

说明:spec §3.3 的 `appendPathDecision` 落地为 `sameHostIngresses` + `appendPathToIngress` 两个函数——「候选展示」与「追加构造」分离,② 的弹窗需要在多个候选中让用户选目标,单一 decision 函数装不下。

- [ ] **Step 1: 写失败测试**(追加到 `useIngressRules.test.mjs`)

```js
import { sameHostIngresses, appendPathToIngress, buildWizardIngressYaml } from './useIngressRules.js'

const ING = {
  name: 'app-ingress',
  rules: [
    { host: 'a.com', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'web', port: { number: 80 } } } }] } },
    { host: 'b.com', http: { paths: [{ path: '/x', pathType: 'Exact', backend: { service: { name: 'api', port: { number: 8080 } } } }] } },
  ],
}

test('sameHostIngresses: 精确匹配,空 host 不匹配任何', () => {
  const list = [ING, { name: 'other', rules: [{ host: '', http: { paths: [{ path: '/', backend: { service: { name: 'x', port: { number: 1 } } } }] } }] }]
  assert.equal(sameHostIngresses(list, 'a.com').length, 1)
  assert.equal(sameHostIngresses(list, 'A.com').length, 0)   // 大小写敏感(K8s host 精确)
  assert.deepEqual(sameHostIngresses(list, ''), [])
  assert.deepEqual(sameHostIngresses(list, '  '), [])
  assert.deepEqual(sameHostIngresses(undefined, 'a.com'), [])
})

test('appendPathToIngress: 追加到同 host 组,返回完整 flatRules', () => {
  const { flatRules, conflict } = appendPathToIngress(ING, { host: 'a.com', path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' })
  assert.equal(conflict, false)
  assert.equal(flatRules.length, 3)
  assert.deepEqual(flatRules[2], { host: 'a.com', path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' })
})

test('appendPathToIngress: 同 host 同 path 已存在 → conflict(不管 pathType)', () => {
  const { conflict } = appendPathToIngress(ING, { host: 'a.com', path: '/', pathType: 'Exact', serviceName: 'w', servicePort: '80' })
  assert.equal(conflict, true)
})

test('appendPathToIngress: host 不在 ingress 内也安全(新建组追加)', () => {
  const { flatRules } = appendPathToIngress(ING, { host: 'c.com', path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' })
  assert.equal(flatRules.length, 3)
  assert.equal(flatRules[2].host, 'c.com')
})

test('buildWizardIngressYaml: 完整文档,backend 取 path 级字段', () => {
  const hosts = [
    { host: 'a.com', tls: true, tlsSecret: '', paths: [
      { path: '/api', pathType: 'Prefix', serviceName: 'app-svc', servicePort: '80' },
      { path: '/admin', pathType: 'Prefix', serviceName: 'other-svc', servicePort: '9090' },  // 不同端口分流
    ]},
    { host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 'x', servicePort: '1' }] },
  ]
  const y = buildWizardIngressYaml(hosts, { name: 'app', namespace: 'default', ingressClassName: 'nginx', annotations: { 'k': 'v' } })
  assert.ok(y.startsWith('\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress'))
  assert.ok(y.includes('  name: app\n  namespace: default'))
  assert.ok(y.includes('  ingressClassName: nginx'))
  assert.ok(y.includes('    k: v'))
  assert.ok(y.includes('  - host: a.com'))                       // 空 host 规则被剔除
  assert.ok(!y.includes('host: \n'))                              // 空 host 行不出现
  // path 级 backend:/api→80、/admin→9090(核心回归:不再全指向 servicePorts[0])
  assert.ok(y.includes('- path: /api\n        pathType: Prefix\n        backend:\n          service:\n            name: app-svc\n            port:\n              number: 80'))
  assert.ok(y.includes('- path: /admin\n        pathType: Prefix\n        backend:\n          service:\n            name: other-svc\n            port:\n              number: 9090'))
  // tls:secret 回退 <name>-tls
  assert.ok(y.includes('  tls:\n  - hosts:\n    - a.com\n    secretName: app-tls'))
})

test('buildWizardIngressYaml: 无有效 host → 空串;无注解/无 class 时省略对应行', () => {
  assert.equal(buildWizardIngressYaml([{ host: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' }] }], { name: 'a', namespace: 'd' }), '')
  const y = buildWizardIngressYaml([{ host: 'a.com', tls: false, paths: [{ path: '/', pathType: 'Prefix', serviceName: 's', servicePort: '80' }] }], { name: 'a', namespace: 'd' })
  assert.ok(!y.includes('ingressClassName'))
  assert.ok(!y.includes('annotations'))
  assert.ok(!y.includes('tls:'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test src/composables/useIngressRules.test.mjs`
Expected: FAIL(新导出不存在)

- [ ] **Step 3: 最小实现**(追加到 `useIngressRules.js`;文件顶部补 `import { yamlScalar } from './useYaml.js'`)

```js
// === ② 智能追加决策 ===
// 同 host(精确、trim 后非空)的已有 Ingress 列表。ingressList 为 store ingress 对象。
export function sameHostIngresses(ingressList, host) {
  const h = String(host || '').trim()
  if (!h) return []
  return (ingressList || []).filter(i => (i.rules || []).some(r => (r.host || '') === h))
}

// 往单个 ingress 追加一条 path:拍平现有规则 + 新规则,返回完整 flatRules(供 updateIngressRules)
// 与冲突标记(同 host 同 path 已存在,忽略 pathType)。defaultBackend 由调用方从 ingress 对象读取并回传。
export function appendPathToIngress(ingress, rule) {
  const flat = ingressRulesToFlat(ingress.rules || [])
  const conflict = flat.some(r => r.host === (rule.host || '') && r.path === (rule.path || '/'))
  flat.push({ host: rule.host || '', path: rule.path || '/', pathType: rule.pathType || 'Prefix', serviceName: rule.serviceName || '', servicePort: rule.servicePort })
  return { flatRules: flat, conflict }
}

// === ① 向导 Ingress YAML(从 DeployApp previewYAML 拆出)===
// 生成完整 Ingress 文档(以 '\n---\n' 开头,可直接字符串拼进多资源 YAML)。
// backend 一律取 path 级 serviceName/servicePort;无兜底(向导校验负责拦截)。
export function buildWizardIngressYaml(hosts, { name, namespace, ingressClassName = '', annotations = {} } = {}) {
  const valid = (hosts || []).filter(h => h.host)
  if (!valid.length) return ''
  let yaml = `\n---\napiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata:\n  name: ${name}\n  namespace: ${namespace}`
  if (Object.keys(annotations).length) {
    yaml += '\n  annotations:'
    for (const [k, v] of Object.entries(annotations)) yaml += `\n    ${k}: ${yamlScalar(v)}`
  }
  yaml += `\nspec:`
  if (ingressClassName) yaml += `\n  ingressClassName: ${ingressClassName}`
  const tlsHosts = valid.filter(h => h.tls)
  if (tlsHosts.length) {
    yaml += `\n  tls:`
    tlsHosts.forEach(h => { yaml += `\n  - hosts:\n    - ${h.host}\n    secretName: ${h.tlsSecret || name + '-tls'}` })
  }
  yaml += `\n  rules:`
  valid.forEach(h => {
    yaml += `\n  - host: ${h.host}\n    http:\n      paths:`
    h.paths.filter(p => p.path).forEach(p => {
      yaml += `\n      - path: ${p.path}\n        pathType: ${p.pathType}\n        backend:\n          service:\n            name: ${p.serviceName}\n            port:\n              number: ${p.servicePort}`
    })
  })
  return yaml
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test src/composables/useIngressRules.test.mjs && npm run test:server`
Expected: PASS 全绿

- [ ] **Step 5: Commit**

```bash
git add src/composables/useIngressRules.js src/composables/useIngressRules.test.mjs
git commit -m "feat(ingress): 纯函数层——同host匹配/追加决策/向导YAML(path级backend,灭 servicePorts[0] 硬编码)"
```

---

### Task 3: 共享组件 IngressRulesEditor

**Files:**
- Create: `src/components/common/IngressRulesEditor.vue`
- Create: `src/components/__tests__/IngressRulesEditor.test.js`
- Modify: `src/locales/en.json` + `src/locales/zh.json`(3 个新键)

**Interfaces:**
- Consumes: Task 1/2 无关(组件不 import 纯函数,校验/增删移逻辑自持,与 ④ 现状等价)
- Produces(④①③ 消费的组件契约):

```js
// Props
modelValue: Array  // hosts,默认 [];字段编辑直接 v-model 行对象(父级持有同一响应式引用),
                   // 结构性增/删/移/复制 emit('update:modelValue', 新数组)
services: Array    // [{name, ports:[...], label?(可选显示名,向导虚拟 Service 用「(本向导创建)」)}]
withTls: Boolean           // 渲染 per-host TLS 行(①③ true)
withDefaultBackend: Boolean // 渲染 defaultBackend 卡片(④ true)
defaultBackend: Object     // {enabled, serviceName, servicePort},v-model:default-backend
defaultServiceName: String // 新增 path 的 serviceName 预填(向导传 `${name}-svc`)
withClearAll: Boolean      // 渲染「清空全部」按钮(emit 'clear-all';④ true)
// Emits
'update:modelValue' | 'update:defaultBackend' | 'validation' | 'clear-all'
// validation 载荷:[{loc:'host[0].path[1]'|'defaultBackend', field:'path'|'serviceName'|'servicePort', msg}]
```

- [ ] **Step 1: i18n 新键**(en.json 与 zh.json 的 `ns.ingressDetail` 段内追加,与现有键并排)

```json
"tlsRowLabel": "TLS",                                          // zh: "TLS"
"tlsRowSecretPlaceholder": "secret name (empty = <name>-tls)",  // zh: "secret 名称(留空默认 <ingress名>-tls)"
"virtualSvcBadge": " (this wizard)"                             // zh: "(本向导创建)"
```

其余编辑器文案**复用现有 `ns.ingressDetail.*` 键**(`addHost/addPath/moveUpHost/moveDownHost/moveUpPath/moveDownPath/dupHost/dupPath/removeHost/removePath/pathCount/hostPlaceholder/noHost/clearAll/enableDefaultBackend/noService/selectServiceForPort/defaultBackendSvcHint/defaultBackendPortHint/valPathRequired/valPathSlash/valPathDup/valSvcRequired/valPortRequired/valPortNumber/valDefaultSvcRequired/valDefaultPortRequired/valDefaultPortNumber`——已存在,勿重复定义)。组件挂载即被 `_allComponentsMount.test.js` 自动冒烟(props 全部有默认值,无需登记)。

- [ ] **Step 2: 写失败组件测试**(完整文件)

```js
// src/components/__tests__/IngressRulesEditor.test.js
import { test, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { i18n } from '@/i18n'
import IngressRulesEditor from '@/components/common/IngressRulesEditor.vue'
import PortSelect from '@/components/common/PortSelect.vue'

const SVCS = [
  { name: 'web', ports: ['80', '8080'] },
  { name: 'app-svc', ports: ['80'], label: 'app-svc (this wizard)' },
]

function mountEditor(props = {}) {
  return mount(IngressRulesEditor, {
    props: { modelValue: [{ host: 'a.com', tls: false, tlsSecret: '', paths: [
      { path: '/api', pathType: 'Prefix', serviceName: 'web', servicePort: '80' },
      { path: '/admin', pathType: 'Prefix', serviceName: 'web', servicePort: '8080' },
    ] }], services: SVCS, ...props },
    global: { plugins: [i18n] },
  })
}

test('渲染 host 卡片与每 path 行', () => {
  const w = mountEditor()
  const inputs = w.findAll('input')
  expect(inputs[0].element.value).toBe('a.com')   // defaultBackend 关闭时 host 输入在 DOM 最前
  const pathVals = inputs.map(i => i.element.value).filter(v => v.startsWith('/'))
  expect(pathVals).toEqual(['/api', '/admin'])
})

test('addPath:emit update:modelValue,新增 path 预填 defaultServiceName', async () => {
  const w = mountEditor({ defaultServiceName: 'app-svc' })
  const addPathBtn = w.findAll('button').find(b => b.text().includes(i18n.global.t('ns.ingressDetail.addPath')))
  await addPathBtn.trigger('click')
  const emitted = w.emitted('update:modelValue')
  expect(emitted).toBeTruthy()
  const hosts = emitted.at(-1)[0]
  expect(hosts[0].paths.length).toBe(3)
  expect(hosts[0].paths[2].serviceName).toBe('app-svc')
})

test('service→port 候选联动:PortSelect 收到选中 service 的 ports', () => {
  const w = mountEditor()
  const portSelects = w.findAllComponents(PortSelect)   // 按组件引用匹配(script-setup 无显式 name)
  expect(portSelects.length).toBe(2)                    // 每行两个:serviceName + servicePort
  expect(portSelects[1].props('options')).toEqual(['80', '8080'])   // 第一行的 servicePort 候选 = web 的 ports
})

test('validation:serviceName 缺失时 emit 校验错误', async () => {
  const w = mountEditor({ modelValue: [{ host: 'a.com', tls: false, tlsSecret: '', paths: [
    { path: '/api', pathType: 'Prefix', serviceName: '', servicePort: '80' },
  ] }] })
  await nextTick()
  const v = w.emitted('validation')
  expect(v).toBeTruthy()
  expect(v.at(-1)[0].some(e => e.field === 'serviceName' && e.loc === 'host[0].path[0]')).toBe(true)
})

test('withTls/withDefaultBackend 关闭时不渲染对应区块', () => {
  const w = mountEditor()
  expect(w.findAll('input[type=checkbox]').length).toBe(0)   // TLS 行与 defaultBackend 卡片都未开 → 无 checkbox
  expect(w.text()).not.toContain('spec.defaultBackend')
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/components/__tests__/IngressRulesEditor.test.js`
Expected: FAIL(组件不存在)

- [ ] **Step 4: 实现组件**(完整文件;模板 = ④ `NsIngressDetail.vue:511-573` 等价迁移 + TLS 行 + 联动下拉)

```vue
<script setup>
// Ingress 路由规则共享编辑器:host 分组卡片 + 每 path(path/pathType/serviceName/servicePort 双下拉)。
// 从 NsIngressDetail「Edit Rules」等价抽取,①向导/③独立创建/④规则编辑 三处消费(②保持轻量弹窗不使用)。
// 契约(详见 docs/superpowers/specs/2026-08-16-ingress-path-mapping-design.md §3.2):
// - 字段编辑直接 v-model 行对象(父级持有同一响应式数组,对象引用共享——与被抽取前行为一致);
// - 结构性增/删/移/复制 emit update:modelValue 携带新数组;
// - 校验(行级空值/斜杠/重复 path + defaultBackend)内置,经 validation 事件抛出供父级汇总/禁保存。
// i18n 复用 ns.ingressDetail.* 既有键(等价迁移,避免键漂移);新增仅 tlsRow* 与 virtualSvcBadge。
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import PortSelect from '@/components/common/PortSelect.vue'

const props = defineProps({
  modelValue: { type: Array, default: () => [] },
  services: { type: Array, default: () => [] },
  withTls: { type: Boolean, default: false },
  withDefaultBackend: { type: Boolean, default: false },
  defaultBackend: { type: Object, default: () => ({ enabled: false, serviceName: '', servicePort: '' }) },
  defaultServiceName: { type: String, default: '' },
  withClearAll: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'update:defaultBackend', 'validation', 'clear-all'])

const { t } = useI18n()
const pathTypeOptions = ['Prefix', 'Exact', 'ImplementationSpecific']

// serviceName 候选(平铺;label 可选,向导虚拟 Service 标记「本向导创建」)
const svcOptions = computed(() => props.services.map(s => (s.label ? { label: s.label, value: s.name } : s.name)))
const svcByName = name => props.services.find(s => s.name === name)
const portsFor = name => (svcByName(name)?.ports || [])

function newPath() { return { path: '/', pathType: 'Prefix', serviceName: props.defaultServiceName, servicePort: '' } }
function setHosts(hosts) { emit('update:modelValue', hosts) }
function addHost() { setHosts([...props.modelValue, { host: '', tls: false, tlsSecret: '', paths: [newPath()] }]) }
function removeHost(hi) { setHosts(props.modelValue.filter((_, i) => i !== hi)) }
function duplicateHost(hi) {
  const h = props.modelValue[hi]
  const copy = { host: h.host ? h.host + '-copy' : '', tls: false, tlsSecret: '', paths: h.paths.map(p => ({ ...p })) }
  setHosts([...props.modelValue.slice(0, hi + 1), copy, ...props.modelValue.slice(hi + 1)])
}
function moveHost(hi, dir) {
  const j = hi + dir
  if (j < 0 || j >= props.modelValue.length) return
  const a = [...props.modelValue]; const tmp = a[hi]; a[hi] = a[j]; a[j] = tmp
  setHosts(a)
}
function addPath(hi) { setHosts(props.modelValue.map((h, i) => (i === hi ? { ...h, paths: [...h.paths, newPath()] } : h))) }
function removePath(hi, pi) { setHosts(props.modelValue.map((h, i) => (i === hi ? { ...h, paths: h.paths.filter((_, j) => j !== pi) } : h))) }
function duplicatePath(hi, pi) {
  setHosts(props.modelValue.map((h, i) => (i === hi ? { ...h, paths: [...h.paths.slice(0, pi + 1), { ...h.paths[pi] }, ...h.paths.slice(pi + 1)] } : h)))
}
function movePath(hi, pi, dir) {
  setHosts(props.modelValue.map((h, i) => {
    if (i !== hi) return h
    const j = pi + dir
    if (j < 0 || j >= h.paths.length) return h
    const paths = [...h.paths]; const tmp = paths[pi]; paths[pi] = paths[j]; paths[j] = tmp
    return { ...h, paths }
  }))
}
function setDb(patch) { emit('update:defaultBackend', { ...props.defaultBackend, ...patch }) }

// 校验:与 ④ 抽取前逻辑等价(空值/斜杠/重复 path/端口数字 + defaultBackend)
const errors = computed(() => {
  const errs = []
  props.modelValue.forEach((h, hi) => {
    const seen = {}
    h.paths.forEach((p, i) => {
      const loc = `host[${hi}].path[${i}]`
      if (!p.path) errs.push({ loc, field: 'path', msg: t('ns.ingressDetail.valPathRequired') })
      else if (!p.path.startsWith('/')) errs.push({ loc, field: 'path', msg: t('ns.ingressDetail.valPathSlash', { val: p.path }) })
      else {
        if (seen[p.path]) errs.push({ loc: `host[${hi}]`, field: 'path', msg: t('ns.ingressDetail.valPathDup', { val: p.path }) })
        seen[p.path] = true
      }
      if (!p.serviceName) errs.push({ loc, field: 'serviceName', msg: t('ns.ingressDetail.valSvcRequired') })
      if (!p.servicePort) errs.push({ loc, field: 'servicePort', msg: t('ns.ingressDetail.valPortRequired') })
      else if (isNaN(Number(p.servicePort))) errs.push({ loc, field: 'servicePort', msg: t('ns.ingressDetail.valPortNumber', { val: p.servicePort }) })
    })
  })
  if (props.withDefaultBackend && props.defaultBackend.enabled) {
    const db = props.defaultBackend
    if (!db.serviceName) errs.push({ loc: 'defaultBackend', field: 'serviceName', msg: t('ns.ingressDetail.valDefaultSvcRequired') })
    if (!db.servicePort) errs.push({ loc: 'defaultBackend', field: 'servicePort', msg: t('ns.ingressDetail.valDefaultPortRequired') })
    else if (isNaN(Number(db.servicePort))) errs.push({ loc: 'defaultBackend', field: 'servicePort', msg: t('ns.ingressDetail.valDefaultPortNumber') })
  }
  return errs
})
watch(errors, v => emit('validation', v), { immediate: true })
function fieldError(hi, pi, field) { return errors.value.find(e => e.loc === `host[${hi}].path[${pi}]` && e.field === field) }
</script>

<template>
  <div class="flex flex-col gap-sm">
    <!-- 默认后端(④ 专用,开关式卡片) -->
    <div v-if="withDefaultBackend" class="rounded-lg border border-outline-variant p-sm mb-sm">
      <label class="flex items-center gap-sm cursor-pointer">
        <input v-model="defaultBackend.enabled" type="checkbox" class="h-4 w-4 accent-primary" @change="setDb({ enabled: defaultBackend.enabled })" />
        <span class="text-body-sm font-medium">{{ t('ns.ingressDetail.enableDefaultBackend') }} <code class="font-mono text-xs text-on-surface-variant">spec.defaultBackend</code></span>
      </label>
      <div v-if="defaultBackend.enabled" class="grid grid-cols-2 gap-sm mt-sm">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Service</label>
          <PortSelect :model-value="defaultBackend.serviceName" :options="svcOptions" placeholder="my-svc" :empty-hint="t('ns.ingressDetail.defaultBackendSvcHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-sm font-mono" @update:model-value="v => setDb({ serviceName: v })" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Port</label>
          <PortSelect :model-value="defaultBackend.servicePort" :options="portsFor(defaultBackend.serviceName)" placeholder="80" :empty-hint="t('ns.ingressDetail.defaultBackendPortHint')" input-class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-sm font-mono" @update:model-value="v => setDb({ servicePort: v })" />
        </div>
      </div>
    </div>

    <!-- host 分组卡片 -->
    <div v-for="(h, hi) in modelValue" :key="hi" class="rounded-lg border border-outline-variant overflow-hidden">
      <div class="px-sm py-1.5 bg-surface-container-low flex items-center gap-xs">
        <span class="material-symbols-outlined text-primary text-base">language</span>
        <input v-model="h.host" class="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded px-sm py-1 text-sm font-mono" :placeholder="t('ns.ingressDetail.hostPlaceholder')" />
        <span class="text-[10px] text-on-surface-variant shrink-0">{{ t('ns.ingressDetail.pathCount', { n: h.paths.length }) }}</span>
        <div class="flex items-center gap-0.5 shrink-0">
          <button @click="moveHost(hi, -1)" :disabled="hi === 0" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" :title="t('ns.ingressDetail.moveUpHost')"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
          <button @click="moveHost(hi, 1)" :disabled="hi === modelValue.length - 1" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" :title="t('ns.ingressDetail.moveDownHost')"><span class="material-symbols-outlined text-base">arrow_downward</span></button>
          <button @click="duplicateHost(hi)" class="p-0.5 text-on-surface-variant hover:text-primary rounded" :title="t('ns.ingressDetail.dupHost')"><span class="material-symbols-outlined text-base">content_copy</span></button>
          <button @click="removeHost(hi)" class="p-0.5 text-on-surface-variant hover:text-error rounded" :title="t('ns.ingressDetail.removeHost')"><span class="material-symbols-outlined text-base">delete</span></button>
        </div>
      </div>
      <div class="p-sm flex flex-col gap-xs">
        <div v-for="(p, i) in h.paths" :key="i" class="flex gap-xs items-center flex-wrap">
          <input v-model="p.path" :class="['w-28 bg-surface-container-low border rounded px-sm py-1 text-sm font-mono', fieldError(hi, i, 'path') ? 'border-error' : 'border-outline-variant']" placeholder="/" />
          <select v-model="p.pathType" class="bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-sm">
            <option v-for="pt in pathTypeOptions" :key="pt" :value="pt">{{ pt }}</option>
          </select>
          <PortSelect v-model="p.serviceName" :options="svcOptions" placeholder="my-svc" :empty-hint="t('ns.ingressDetail.noService')" :input-class="['w-32 bg-surface-container-low border rounded px-sm py-1 text-sm font-mono', fieldError(hi, i, 'serviceName') ? 'border-error' : 'border-outline-variant'].join(' ')" />
          <PortSelect v-model="p.servicePort" :options="portsFor(p.serviceName)" placeholder="80" :empty-hint="t('ns.ingressDetail.selectServiceForPort')" :input-class="['w-20 bg-surface-container-low border rounded px-sm py-1 text-sm font-mono', fieldError(hi, i, 'servicePort') ? 'border-error' : 'border-outline-variant'].join(' ')" />
          <div class="flex items-center gap-0.5 shrink-0">
            <button @click="movePath(hi, i, -1)" :disabled="i === 0" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" :title="t('ns.ingressDetail.moveUpPath')"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
            <button @click="movePath(hi, i, 1)" :disabled="i === h.paths.length - 1" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" :title="t('ns.ingressDetail.moveDownPath')"><span class="material-symbols-outlined text-base">arrow_downward</span></button>
            <button @click="duplicatePath(hi, i)" class="p-0.5 text-on-surface-variant hover:text-primary rounded" :title="t('ns.ingressDetail.dupPath')"><span class="material-symbols-outlined text-base">content_copy</span></button>
            <button @click="removePath(hi, i)" class="p-0.5 text-on-surface-variant hover:text-error rounded" :title="t('ns.ingressDetail.removePath')"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
        </div>
        <button @click="addPath(hi)" class="self-start flex items-center gap-xs px-sm py-xs text-sm text-primary hover:bg-primary-container/10 rounded">
          <span class="material-symbols-outlined text-sm">add</span> {{ t('ns.ingressDetail.addPath') }}
        </button>
        <!-- per-host TLS(①③;④ 的 TLS 走详情页单独编辑,不开) -->
        <label v-if="withTls" class="flex items-center gap-sm cursor-pointer mt-xs">
          <input type="checkbox" v-model="h.tls" class="rounded text-primary h-4 w-4" />
          <span class="text-xs">{{ t('ns.ingressDetail.tlsRowLabel') }}</span>
          <input v-if="h.tls" v-model="h.tlsSecret" class="flex-1 bg-surface-container-lowest border border-outline-variant rounded px-sm py-xs text-xs font-mono" :placeholder="t('ns.ingressDetail.tlsRowSecretPlaceholder')" />
        </label>
      </div>
    </div>
    <div v-if="!modelValue.length" class="text-center text-on-surface-variant text-sm py-md">{{ t('ns.ingressDetail.noHost') }}</div>

    <div class="flex items-center gap-sm mt-sm">
      <button @click="addHost" class="flex items-center gap-xs px-sm py-xs border border-dashed border-outline-variant rounded-lg text-sm text-on-surface-variant hover:bg-surface-container-low">
        <span class="material-symbols-outlined text-sm">add</span> {{ t('ns.ingressDetail.addHost') }}
      </button>
      <button v-if="withClearAll" @click="emit('clear-all')" :disabled="!modelValue.length && !(withDefaultBackend && defaultBackend.enabled)" class="ml-auto flex items-center gap-xs px-sm py-xs text-sm text-error hover:bg-error-container/10 rounded disabled:opacity-40">
        <span class="material-symbols-outlined text-sm">delete_sweep</span> {{ t('ns.ingressDetail.clearAll') }}
      </button>
    </div>
  </div>
</template>
```

注意:`defaultBackend.enabled` 的 checkbox 用 `v-model` + `@change` 双写(v-model 改本地 prop 对象字段保持响应,change 再 emit 全量对象给父级 v-model:defaultBackend);PortSelect 行级用 `v-model`(共享行对象引用,同 ④ 现状)。

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/components/__tests__/IngressRulesEditor.test.js && npm run i18n:check`
Expected: PASS(含自动挂载冒烟不炸:`npm run test:unit` 全绿)

- [ ] **Step 6: Commit**

```bash
git add src/components/common/IngressRulesEditor.vue src/components/__tests__/IngressRulesEditor.test.js src/locales/en.json src/locales/zh.json
git commit -m "feat(ingress): 共享 IngressRulesEditor 组件(host分组+path级service/port双下拉,自④等价抽取)"
```

---

### Task 4: ④ NsIngressDetail Edit Rules 等价迁移

**Files:**
- Modify: `src/views/NsIngressDetail.vue`(script `90-182` 行编辑器内部逻辑、template `499-588` 行弹窗)

**Interfaces:**
- Consumes: Task 3 组件;Task 1 `flatToHosts`/`hostsToFlat`
- Produces: 无(行为等价;后续 Task 以此为回归基准)

- [ ] **Step 1: script 替换**(删除 `92-182` 行的 `pathTypeOptions/nsServiceNames/portsFor/editModel/openRulesEditor 重组逻辑/addHost…movePath/clearAll/errors/fieldError/saveRules 平铺`,保留 `showRulesModal/showClearConfirm`;新增):

```js
import IngressRulesEditor from '@/components/common/IngressRulesEditor.vue'
import { flatToHosts, hostsToFlat } from '@/composables/useIngressRules'

const editHosts = ref([])
const editDb = ref({ enabled: false, serviceName: '', servicePort: '' })
const rulesErrors = ref([])
const svcOptions = computed(() => nsServices.value.map(s => ({ name: s.name, ports: (s.portList || []).map(p => p.port) })))

function openRulesEditor() {
  editHosts.value = flatToHosts(allRules.value)
  if (!editHosts.value.length) editHosts.value = [{ host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }] }]
  const db = ing.value?.defaultBackend
  editDb.value = db && db.serviceName
    ? { enabled: true, serviceName: db.serviceName, servicePort: db.servicePort }
    : { enabled: false, serviceName: '', servicePort: '' }
  showRulesModal.value = true
}
function onClearAll() { editHosts.value = []; editDb.value = { enabled: false, serviceName: '', servicePort: '' }; showClearConfirm.value = false }
async function saveRules() {
  if (rulesErrors.value.length) return
  const flat = hostsToFlat(editHosts.value)
  try {
    await store.updateIngressRules(route.params.name, route.params.namespace, flat, editDb.value)
    showRulesModal.value = false
  } catch (e) { notify('error', e.message || t('ns.ingressDetail.saveRulesFailed')) }
}
```

- [ ] **Step 2: template 弹窗体替换**(`501-578` 行之间:错误汇总保留但遍历 `rulesErrors`;defaultBackend 卡片+host 卡片+底部按钮整体替换为)

```html
<IngressRulesEditor v-model="editHosts" v-model:default-backend="editDb" :services="svcOptions"
  :with-default-backend="true" :with-clear-all="true" @validation="v => rulesErrors = v" @clear-all="showClearConfirm = true" />
```

保存按钮禁用条件改 `:disabled="rulesErrors.length > 0"`;`onClearAll` 接现有清空确认弹窗的确认按钮。

- [ ] **Step 3: 回归验证**

Run: `npm run test:unit && npm run test:server && npm run typecheck && npm run i18n:check`
Expected: 全绿(④ 无专属视图测试;由组件测试 + `_allViewsMount` 冒烟 + 本任务手测覆盖)

- [ ] **Step 4: 手测**(有集群环境时;无则记入 Task 8 清单)
  打开任一 Ingress 详情 → Edit Rules:规则回显、增删移复制、defaultBackend 开关、空值红框、保存后 15s 内列表刷新。

- [ ] **Step 5: Commit**

```bash
git add src/views/NsIngressDetail.vue
git commit -m "refactor(ingress): ④ Edit Rules 等价迁移到共享 IngressRulesEditor(行为不变,后续入口的回归基准)"
```

---

### Task 5: ③ NsIngress 独立创建——多 host 多 path + generateYAML tlsList

**Files:**
- Modify: `src/views/NsIngress.vue`(script `74-140`、template `256-305`)
- Modify: `src/stores/cluster.js`(`generateYAML` ingress 分支 `tlsBlock`,`1198` 行附近)
- Modify: `src/locales/en.json` + `zh.json`(删 6 个废弃键,若 grep 无其他引用)

**Interfaces:**
- Consumes: Task 3 组件;Task 1 `hostsToK8sSpec`
- Produces: `addIngress` item 新增可选 `tlsList: [{hosts, secretName}]`(generateYAML 优先消费;不传则走存量单 tls 逻辑,②/其他调用方零影响)

- [ ] **Step 1: generateYAML tlsList 支持**(cluster.js `1197-1198` 行替换)

```js
const firstHost = rules[0]?.host || resource.hosts || ''
// tlsList(多 host TLS,③ per-host 创建)优先;存量单 tls 布尔兜底(② 与其他调用方不变)
const tlsBlock = resource.tlsList?.length
  ? '\n  tls:\n' + resource.tlsList.map(e => `  - hosts:\n    - ${e.hosts[0]}\n    secretName: ${e.secretName}`).join('\n')
  : (resource.tls ? `\n  tls:\n  - hosts:\n    - ${firstHost}\n    secretName: ${resource.tlsSecret || name + '-tls'}` : '')
```

- [ ] **Step 2: script 改造**(NsIngress.vue)

```js
import IngressRulesEditor from '@/components/common/IngressRulesEditor.vue'
import { hostsToK8sSpec } from '@/composables/useIngressRules'

const createForm = ref({ name: '', className: '' })
const hosts = ref([{ host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '' }] }])
const rulesErrors = ref([])
const svcOptions = computed(() => nsServices.value.map(s => ({ name: s.name, ports: (s.portList || []).map(p => p.port) })))
const hasValidRule = computed(() => hosts.value.some(h => h.host && h.paths.some(p => p.path)))

function resetCreate() {
  createForm.value = { name: '', className: '' }
  hosts.value = [{ host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '' }] }]
  rulesErrors.value = []
  adv.value = {}; customAnnotations.value = []; createTab.value = 'basic'
}

async function handleCreate() {
  const f = createForm.value
  const spec = hostsToK8sSpec(hosts.value, { defaultTlsSecret: `${f.name}-tls` })
  const r = await store.addIngress({
    name: f.name,
    namespace: route.params.namespace,
    hosts: spec.rules.map(rr => rr.host).filter(Boolean).join(','),
    tls: !!spec.tls.length,
    tlsSecret: spec.tls[0]?.secretName || '',
    tlsList: spec.tls,
    className: f.className,
    annotations: buildIngressAnnotations(createDialect.value, adv.value, customAnnotations.value),
    rules: spec.rules,
  })
  if (r && r.ok === false) return
  queryClient.invalidateQueries({ queryKey: ingressesKey })
  showCreateModal.value = false
  resetCreate()
}
```

删除:`createForm` 旧字段、`selectedServicePorts`、`nsServiceNames`(若仅创建表单用;`svcByName` 保留给其他用途时同步核查)。`watch(createDialect…)` 不动。

- [ ] **Step 3: template basic 标签替换**(`271-304` 行:host/path/pathType/service/port/enableTLS/tlsSecret 七个字段区块 →)

```html
<IngressRulesEditor v-model="hosts" :services="svcOptions" :with-tls="true" @validation="v => rulesErrors = v" />
```

创建按钮(`345` 行)禁用条件改 `:disabled="!createForm.name || !hasValidRule || rulesErrors.length > 0"`。

- [ ] **Step 4: i18n 清理**

对候选键 `grep -rn "ns.ingress.hostLabel\|ns.ingress.pathLabel\|ns.ingress.pathTypeLabel\|ns.ingress.backendSvcLabel\|ns.ingress.svcPortLabel\|ns.ingress.enableTls\|ns.ingress.tlsSecretLabel" src/`——仅当无引用时从 en.json/zh.json 删除(`noServiceInNs/selectSvcForPort` 保留:其他空提示语义仍在用)。

- [ ] **Step 5: 回归**

Run: `npx vitest run && npm run test:server && npm run typecheck && npm run i18n:check`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/views/NsIngress.vue src/stores/cluster.js src/locales/en.json src/locales/zh.json
git commit -m "feat(ingress): ③ 独立创建支持多 host 多 path(per-host TLS;generateYAML 增 tlsList)"
```

---

### Task 6: ① DeployApp 向导 Step5——path 级后端 + 悬空引用根除

**Files:**
- Modify: `src/views/DeployApp.vue`(form `98`、helpers `188-191`、校验 `248`、YAML `620-651`、template `1423-1473`)
- Modify: `src/locales/en.json` + `zh.json`(1 新键 + 1 键值更新)

**Interfaces:**
- Consumes: Task 3 组件;Task 2 `buildWizardIngressYaml`
- Produces: 无

- [ ] **Step 1: i18n**——`deploy` 段新增/更新:

```json
"ingressBackendRequired": "Each ingress path needs a backend service and port",   // zh: "Ingress 每条路径需选择后端 Service 与端口"
"ingressRuleHint": "Each path maps to its own backend service and port.",          // zh: "每条路径可独立选择后端 Service 与端口。"(旧值说「全部映射到第一个端口」,已不实)
```

- [ ] **Step 2: script 改造**

`makeForm` `98` 行改:

```js
ingressRules: [{ host: '', tls: false, tlsSecret: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '' }] }],
```

删除 `188-191` 行 `addIngressRule/removeIngressRule/addIngressPath/removeIngressPath`(结构操作由组件 emit)。新增(放在 `ingressDialect` 附近):

```js
import IngressRulesEditor from '@/components/common/IngressRulesEditor.vue'
import { buildWizardIngressYaml } from '@/composables/useIngressRules'

// Service 候选:ns 已有(Vue Query)+ 向导自建虚拟项(createService 开启时;label 标「本向导创建」)
const svcQ = useResourceList({ key: ['cluster', cid, 'services'], fetcher: () => store.fetchServices(), options: { refetchInterval: 30000 } })
const virtualServiceName = computed(() => (form.value.createService && form.value.name ? `${form.value.name}-svc` : ''))
const ingressServiceOptions = computed(() => {
  const real = (svcQ.data.value || []).filter(s => s.namespace === form.value.namespace)
    .map(s => ({ name: s.name, ports: (s.portList || []).map(p => p.port) }))
  const virt = virtualServiceName.value
    ? [{ name: `${form.value.name}-svc`, ports: form.value.servicePorts.filter(p => p.port).map(p => String(p.port)), label: `${form.value.name}-svc${t('ns.ingressDetail.virtualSvcBadge')}` }]
    : []
  return [...virt, ...real]
})
// 虚拟名变化/消失时,仍指向旧虚拟名的 path 改指新虚拟名/清空(防悬空引用)
watch(virtualServiceName, (nv, ov) => {
  if (nv === ov) return
  for (const h of form.value.ingressRules) for (const p of h.paths) {
    if (p.serviceName === ov) p.serviceName = nv
  }
})
```

`stepBlockReason` `248` 行(ingress 校验)替换为:

```js
if (f.createIngress) {
  if (!f.ingressRules.some(r => r.host)) return t('deploy.ingressHostRequired')
  const badBackend = f.ingressRules.filter(r => r.host).some(r => r.paths.some(p => !p.serviceName || !p.servicePort))
  if (badBackend) return t('deploy.ingressBackendRequired')
}
```

`previewYAML` `620-651` 行(Ingress 段整体)替换为:

```js
if (f.createIngress) {
  yaml += buildWizardIngressYaml(f.ingressRules, {
    name: f.name, namespace: f.namespace, ingressClassName: f.ingressClassName,
    annotations: buildIngressAnnotations(ingressDialect.value, f.ingressAdv, f.ingressCustomAnnotations),
  })
}
```

- [ ] **Step 3: template 替换**(`1428-1473` 行:ingressClassName 选择保留;「多 Rule 编辑器」+TLS+hint 区块 →)

```html
<IngressRulesEditor v-model="form.ingressRules" :services="ingressServiceOptions" :with-tls="true" :default-service-name="virtualServiceName || undefined" />
<p class="text-xs text-on-surface-variant mt-sm flex items-center gap-xs">
  <span class="material-symbols-outlined text-xs">info</span>{{ t('deploy.ingressRuleHint') }}
</p>
```

网关调优 `<details>`(`1476+`)不动。`resetForm` 用 `makeForm()` 重建,自动携带新结构;copySeed 旧结构由组件容错渲染(`serviceName` undefined → PortSelect 空串)。

- [ ] **Step 4: 回归**

Run: `npx vitest run && npm run test:server && npm run typecheck && npm run i18n:check`
Expected: 全绿

- [ ] **Step 5: 手测场景(记入 Task 8)**:双端口 Service 分流(/api→80、/admin→8080);关 Service 开 Ingress 选已有 Service;勾 Ingress 未选后端 → 下一步 block。

- [ ] **Step 6: Commit**

```bash
git add src/views/DeployApp.vue src/locales/en.json src/locales/zh.json
git commit -m "feat(deploy): 向导 Ingress path 级后端选择——灭 servicePorts[0] 硬编码与悬空引用"
```

---

### Task 7: ② NsWorkloadDetail 暴露弹窗——端口下拉 + 智能追加

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`(script `733-753`、template `2175-2188`)
- Modify: `src/locales/en.json` + `zh.json`(workload.ingressMap 段 7 新键)

**Interfaces:**
- Consumes: Task 2 `sameHostIngresses`/`appendPathToIngress`;`updateIngressRules`(cluster.js,已有)
- Produces: 无

- [ ] **Step 1: i18n**(`workload.ingressMap` 段追加,en/zh):

```json
"pathType": "Path Type",                                                     // zh: "路径类型"
"targetMode": "Save To",                                                     // zh: "保存到"
"appendTo": "Append to {name}",                                              // zh: "追加到 {name}"
"createNew": "New Ingress",                                                  // zh: "新建 Ingress"
"conflict": "Path {path} already exists in this ingress",                    // zh: "该 Ingress 已存在路径 {path}"
"selectSvcForPorts": "Select a service to list its ports",                   // zh: "先选择 Service 再选端口"
"relatedBadge": " (related)",                                                // zh: "(关联)"
```

- [ ] **Step 2: script 改造**(`733-753` 行替换)

```js
import { sameHostIngresses, appendPathToIngress } from '@/composables/useIngressRules'

const showIngressMapModal = ref(false)
const ingressMapForm = ref({ name: '', host: '', path: '/', pathType: 'Prefix', serviceName: '', servicePort: '', target: '' })
// 同 host 候选(精确、非空)
const sameHost = computed(() => sameHostIngresses(ingressList.value || [], ingressMapForm.value.host))
// Service 候选:关联置顶(label 标「关联」)+ ns 全量;端口候选 = 选中 Service 的 portList
const mapSvcOptions = computed(() => {
  const related = new Set(relatedServices.value.map(s => s.name))
  return (serviceList.value || []).map(s => ({ name: s.name, ports: (s.portList || []).map(p => p.port), label: related.has(s.name) ? `${s.name}${t('workload.ingressMap.relatedBadge')}` : undefined }))
})
const mapPortsFor = computed(() => {
  const svc = (serviceList.value || []).find(s => s.name === ingressMapForm.value.serviceName)
  return (svc?.portList || []).map(p => p.port)
})
function openIngressMap() {
  const svc = relatedServices.value[0]
  const base = workload.value?.name || 'app'
  const existing = new Set(ingressList.value.map(i => i.name))
  let name = `${base}-ingress`, n = 2
  while (existing.has(name)) name = `${base}-ingress-${n++}`
  ingressMapForm.value = { name, host: '', path: '/', pathType: 'Prefix', serviceName: svc?.name || '', servicePort: (svc?.portList || [])[0]?.port || '', target: '' }
  showIngressMapModal.value = true
}
const mapConflict = ref('')
async function saveIngressMap() {
  const f = ingressMapForm.value
  if (!f.serviceName) { notify('error', t('workload.notify.selectService')); return }
  const rule = { host: (f.host || '').trim(), path: f.path || '/', pathType: f.pathType, serviceName: f.serviceName, servicePort: f.servicePort }
  const targetIng = f.target && f.target !== 'new' ? (ingressList.value || []).find(i => i.name === f.target) : null
  if (targetIng) {
    const { flatRules, conflict } = appendPathToIngress(targetIng, rule)
    if (conflict) { mapConflict.value = t('workload.ingressMap.conflict', { path: rule.path }); return }
    mapConflict.value = ''
    const db = targetIng.defaultBackend?.serviceName
      ? { enabled: true, serviceName: targetIng.defaultBackend.serviceName, servicePort: targetIng.defaultBackend.servicePort }
      : null   // 注意:updateIngressRules 传 null=删除;仅在确实无 defaultBackend 时传 null(见 spec §6)
    try {
      await store.updateIngressRules(targetIng.name, route.params.namespace, flatRules, db)
    } catch (e) { notify('error', e.message || t('workload.notify.createIngressFailed')); return }
    notify('success', t('workload.notify.createdIngress', { host: rule.host || '*', path: rule.path, service: rule.serviceName, port: rule.servicePort }))
    showIngressMapModal.value = false
    return
  }
  const r = await store.addIngress({ name: f.name || `${workload.value?.name || 'app'}-ingress`, namespace: route.params.namespace, className: '', tls: false, tlsSecret: '', rules: [{ host: rule.host, http: { paths: [{ path: rule.path, pathType: rule.pathType, backend: { serviceName: rule.serviceName, servicePort: Number(rule.servicePort) || 80 } }] } }] })
  if (r && r.ok === false) return
  notify('success', t('workload.notify.createdIngress', { host: rule.host || '*', path: rule.path, service: rule.serviceName, port: rule.servicePort }))
  showIngressMapModal.value = false
}
```

注意:`serviceList/ingressList/relatedServices` 为该视图既有 Vue Query 派生(`41-52` 行),直接复用;`workload.notify.createIngressFailed` 键若不存在则补(en "Failed to update ingress" / zh "Ingress 更新失败")。

- [ ] **Step 3: template 弹窗体替换**(`2176-2183` 行)

```html
<div class="flex flex-col gap-md">
  <div><label class="text-xs text-on-surface-variant">{{ $t('workload.ingressMap.host') }}</label><input v-model="ingressMapForm.host" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="app.example.com" /></div>
  <div class="grid grid-cols-2 gap-md">
    <div><label class="text-xs text-on-surface-variant">{{ $t('workload.ingressMap.path') }}</label><input v-model="ingressMapForm.path" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" placeholder="/" /></div>
    <div><label class="text-xs text-on-surface-variant">{{ $t('workload.ingressMap.pathType') }}</label><select v-model="ingressMapForm.pathType" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm"><option>Prefix</option><option>Exact</option><option>ImplementationSpecific</option></select></div>
  </div>
  <div class="grid grid-cols-2 gap-md">
    <div><label class="text-xs text-on-surface-variant">{{ $t('workload.ingressMap.service') }}</label><PortSelect v-model="ingressMapForm.serviceName" :options="mapSvcOptions" placeholder="my-service" :empty-hint="$t('ns.ingressDetail.noService')" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
    <div><label class="text-xs text-on-surface-variant">{{ $t('workload.ingressMap.port') }}</label><PortSelect v-model="ingressMapForm.servicePort" :options="mapPortsFor" placeholder="80" :empty-hint="$t('workload.ingressMap.selectSvcForPorts')" input-class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm font-mono" /></div>
  </div>
  <!-- 智能追加:同 host 已有 Ingress 时选择目标 -->
  <div v-if="sameHost.length">
    <label class="text-xs text-on-surface-variant">{{ $t('workload.ingressMap.targetMode') }}</label>
    <select v-model="ingressMapForm.target" class="w-full bg-surface-container-low border border-outline-variant rounded-lg px-md py-sm text-body-sm">
      <option v-for="i in sameHost" :key="i.name" :value="i.name">{{ $t('workload.ingressMap.appendTo', { name: i.name }) }}</option>
      <option value="new">{{ $t('workload.ingressMap.createNew') }}</option>
    </select>
  </div>
  <p v-if="mapConflict" class="text-xs text-error flex items-center gap-xs"><span class="material-symbols-outlined text-sm">warning</span>{{ mapConflict }}</p>
</div>
```

(默认 target:openIngressMap 置 `''`,select 首项即第一个同 host Ingress——追加优先语义;`PortSelect` 已在该视图 import,若无需补。)

- [ ] **Step 4: 回归**

Run: `npx vitest run && npm run test:server && npm run typecheck && npm run i18n:check`
Expected: 全绿

- [ ] **Step 5: 手测场景(记入 Task 8)**:同 host 追加后 `kubectl get ingress <名> -o yaml` 验证 path 合并;重复 path 冲突提示;新建模式照旧;追加保留 defaultBackend。

- [ ] **Step 6: Commit**

```bash
git add src/views/NsWorkloadDetail.vue src/locales/en.json src/locales/zh.json
git commit -m "feat(workload): 暴露弹窗端口下拉+同host智能追加(根治 Ingress 碎片化;保留 defaultBackend)"
```

---

### Task 8: 收尾——全量回归 + 手测清单

**Files:**
- Modify: 仅在发现问题时(本 Task 默认零代码改动)

**Interfaces:**
- Consumes: 全部前序 Task
- Produces: 验收结论

- [ ] **Step 1: 全量门禁**

Run: `npm test && npm run typecheck && npm run i18n:check && npm run build`
Expected: 全绿(build 覆盖 .vue 语法基线)

- [ ] **Step 2: 手测清单**(需真实集群 + 已配置 Ingress 控制器;逐项勾选)

1. 向导:Service 双端口(80+8080)+ Ingress `/api→80`、`/admin→8080` → YAML 预览正确 → 部署 → `kubectl get ingress -o yaml` 后端分流无误
2. 向导:关 Service、开 Ingress → 后端下拉仅列已有 Service → YAML 无 `{name}-svc` 悬空引用
3. 向导:勾 Ingress、清空某 path 后端 → 「下一步」block 并提示 `ingressBackendRequired`
4. 向导:勾 Ingress 后改 workload 名 → 虚拟 Service 引用跟随更名(不悬空)
5. ②:同 host 已有 Ingress → 弹窗默认「追加到 …」→ 保存 → 同一 Ingress 内 path 合并(yaml 验证);defaultBackend 不丢
6. ②:追加重复 path → 冲突提示、不落库;切「新建」→ 走 addIngress
7. ③:创建多 host 多 path + 其中一个 host 开 TLS → 生成的 Ingress tls 段正确(per-host)
8. ④:Edit Rules 全流程回归(回显/增删移/复制/defaultBackend/校验/保存)
9. 全局:中英文切换无残缺文案;`npm run i18n:check` 通过

- [ ] **Step 3: 收尾 commit(如有修复)**

```bash
git add -A && git commit -m "fix(ingress): 收尾修复波(手测发现项)"
```

无修复则跳过;向用户汇报验收结果,分支保留待合并(merge 由用户决定,遵循「多会话改 main」防撞流程)。

---

## Self-Review 记录

- **Spec 覆盖**:§3.1 模型(Task 1/3)、§3.2 组件(Task 3)、§3.3 纯函数(Task 1/2;`appendPathDecision` 细化为 `sameHostIngresses`+`appendPathToIngress`,理由已注)、§4①(Task 6)②(Task 7)③(Task 5)④(Task 4)、§5 测试(各 Task 步骤 + Task 8)、§6 坑(defaultBackend null→Task 7 注释;copySeed 容错→Task 6;i18n v-html→本计划文案无 HTML)、§7 范围外未越界。
- **占位符扫描**:无 TBD/「适当处理」类步骤;所有代码块完整可落盘。
- **类型一致性**:`hostsToK8sSpec` 返回 `{rules, tls}`(Task 1 定义 = Task 5 消费);`appendPathToIngress` 返回 `{flatRules, conflict}`(Task 2 = Task 7);组件 props/emits(Task 3 = Task 4/5/6);`virtualSvcBadge` 键名 Task 3 定义 = Task 6 引用。
