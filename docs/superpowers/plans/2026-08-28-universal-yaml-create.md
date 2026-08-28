# 全资源「从 YAML 创建」通用化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已存在的通用 YAML apply 通道铺到 12 个视图 / 13 入口点(SplitButton 次级项 + 按视图 kind 模板),服务端补「缺 metadata.namespace 时落当前命名空间」语义,并抽取 `server/apply-yaml.mjs` 可测模块。

**Architecture:** 前端新增黏合组件 `CreateWithYamlButton`(SplitButton + 自持 CreateFromYamlDialog)与模板单源 `src/utils/yamlTemplates.js`;defaultNs 经 dialog → useResourceApply → store → api 四层透传到 `POST /api/apply`;服务端 `applyYaml`/`applyYamlPartial` 抽为 `createApplyYaml({ requestKubernetes })` 工厂,ns 缺省链 `显式 > defaultNs > 'default'` 收在单一 helper。设计全文:`docs/superpowers/specs/2026-08-28-universal-yaml-create-design.md`。

**Tech Stack:** Vue 3 `<script setup>` + Pinia + Vue Query(前端);Node ESM + `js-yaml` + `node:test`(服务端);vitest + @vue/test-utils + happy-dom(前端测试)。

## Global Constraints

- 依赖政策:**不新增任何外部依赖**(js-yaml/vitest 等均为现存依赖)。
- 提交:作者恒 `aliangone <aliangone@gmail.com>`(repo config 已设);**禁止** `Co-Authored-By: Claude` 尾注;禁止改写已推送历史。每个 Task 一提交。
- i18n:改 `src/locales/en.json` 与 `zh.json` 必须成对;消息值含字面 `@` 须写成 `{'@'}`(本计划两条新文案不含 `@`);完成后 `npm run i18n:check` 必须绿。
- 执行环境:开工先用 `superpowers:using-git-worktrees`(或 EnterWorktree)开隔离工作树;**服务端改动需重启网关才对手测生效**。
- 测试命令:`npm run test:server`(收 `server/*.test.mjs` 新文件)、`npx vitest run <file>` 单跑前端、`npm test` 全量、`npm run typecheck`、`npm run i18n:check`。
- 事实锚点行号基于 2026-08-28 的 main;执行时以文件实际内容为准,行号漂移不算错,**语义锚点(引号内代码)才算**。

---

### Task 1: 服务端 `apply-yaml.mjs` 抽取 + defaultNs

**Files:**
- Create: `server/apply-yaml.mjs`
- Create: `server/apply-yaml.test.mjs`
- Modify: `server/index.mjs`(删 `:59` discoveryCache 声明、删 `:466-530` 三函数、新增 import 与工厂调用、改 `:1564` handler)
- Modify: `server/api-key-tools.test.mjs`(不加断言,仅回归——见 Step 8 说明)

**Interfaces:**
- Consumes: `requestKubernetes(session, path, init)`(index.mjs:427 现有签名,工厂注入)。
- Produces: `createApplyYaml({ requestKubernetes })` → `{ applyYaml(session, yaml, defaultNs), applyYamlPartial(session, yaml, defaultNs) }`。返回体契约不变:`{ resources, applied, failed, total }` / `{ applied, failed, total }`;唯一行为变更 = `applied`/`failed` label 的 `namespace` 为补齐后值。
- 关键事实:MCP/API-key 的 `apply_yaml` 本就**强制**显式 `metadata.namespace`(policy 拒,`api-key-tools.mjs:388-391`),故 label 补齐对该路径是 no-op,无需新断言,既有回归全绿即可。

- [ ] **Step 1: 写失败测试(全文)**

创建 `server/apply-yaml.test.mjs`:

```js
// apply-yaml 内核单测:defaultNs 缺省补齐语义 + 抽取回归(requestFn mock,无需真集群)。
// 语义:namespaced 资源 ns = metadata.namespace || defaultNs || 'default';集群级 kind 忽略后两者。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createApplyYaml } from './apply-yaml.mjs'

const session = { apiServer: 'https://k8s.example:6443' }
const DEPLOY_YAML = 'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: d1\n'

// mock requestFn:记录每次调用;discovery 返回 apps/v1 与 core v1 的资源表;PATCH 回声。
function makeK8s() {
  const calls = []
  const requestFn = async (s, path, init = {}) => {
    calls.push({ path, method: init.method || 'GET' })
    if (path === '/apis/apps/v1') return { body: { resources: [{ kind: 'Deployment', name: 'deployments', namespaced: true }] } }
    if (path === '/api/v1') return { body: { resources: [
      { kind: 'Service', name: 'services', namespaced: true },
      { kind: 'Namespace', name: 'namespaces', namespaced: false },
    ] } }
    if (init.method === 'PATCH') return { body: { metadata: { name: 'echo' } } }
    throw new Error('mock: unexpected ' + path)
  }
  return { requestFn, calls }
}

test('applyYaml: namespaced 缺 ns → 补 defaultNs 到路径与 label', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  const r = await applyYaml(session, DEPLOY_YAML, 'demo')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/demo/deployments/d1?'), patch.path)
  assert.deepEqual(r.applied, [{ kind: 'Deployment', name: 'd1', namespace: 'demo' }])
  assert.equal(r.failed.length, 0)
  assert.equal(r.total, 1)
})

test('applyYaml: 显式 ns → 不覆盖', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  const r = await applyYaml(session, DEPLOY_YAML + '  namespace: other\n', 'demo')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/other/deployments/d1?'), patch.path)
  assert.equal(r.applied[0].namespace, 'other')
})

test('applyYaml: 集群级 kind(Namespace) → 忽略 defaultNs,无 /namespaces/ 段', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  const yaml = 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: new-ns\n'
  const r = await applyYaml(session, yaml, 'demo')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/api/v1/namespaces/namespaces/new-ns?'), patch.path)
  assert.equal(r.applied[0].namespace, undefined)
})

test('applyYaml: 不传 defaultNs → 落 default(兼容回归)', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  await applyYaml(session, DEPLOY_YAML)
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/default/deployments/d1?'), patch.path)
})

test('applyYaml: defaultNs 空串 → 同样落 default(无特判)', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  await applyYaml(session, DEPLOY_YAML, '')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/default/deployments/d1?'), patch.path)
})

test('applyYamlPartial: 同语义(ns 补齐 + label 报补齐值)', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYamlPartial } = createApplyYaml({ requestKubernetes: requestFn })
  const r = await applyYamlPartial(session, DEPLOY_YAML, 'demo')
  const patch = calls.find(c => c.method === 'PATCH')
  assert.ok(patch.path.includes('/namespaces/demo/deployments/d1?'), patch.path)
  assert.deepEqual(r.applied, [{ kind: 'Deployment', name: 'd1', namespace: 'demo' }])
  assert.equal(r.total, 1)
})

test('applyYaml: 多文档混合(缺ns/显式ns/集群级)逐资源正确', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  const yaml = [
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: s1',
    'apiVersion: v1\nkind: Service\nmetadata:\n  name: s2\n  namespace: other',
    'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: n1',
  ].join('\n---\n') + '\n'
  const r = await applyYaml(session, yaml, 'demo')
  const patches = calls.filter(c => c.method === 'PATCH').map(c => c.path)
  assert.equal(patches.length, 3)
  assert.ok(patches[0].includes('/namespaces/demo/services/s1?'), patches[0])
  assert.ok(patches[1].includes('/namespaces/other/services/s2?'), patches[1])
  assert.ok(patches[2].includes('/api/v1/namespaces/namespaces/n1?'), patches[2])
  assert.deepEqual(r.applied.map(a => a.namespace), ['demo', 'other', undefined])
})

test('applyYaml: discovery 缓存——同实例第二次 apply 不再发 discovery 请求', async () => {
  const { requestFn, calls } = makeK8s()
  const { applyYaml } = createApplyYaml({ requestKubernetes: requestFn })
  await applyYaml(session, DEPLOY_YAML, 'demo')
  await applyYaml(session, DEPLOY_YAML, 'demo')
  assert.equal(calls.filter(c => c.path === '/apis/apps/v1').length, 1)
  assert.equal(calls.filter(c => c.method === 'PATCH').length, 2)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test server/apply-yaml.test.mjs`
Expected: 全 FAIL,报错 `Cannot find module .../server/apply-yaml.mjs`。

- [ ] **Step 3: 创建 `server/apply-yaml.mjs`(全文)**

```js
// YAML apply 内核(2026-08-28 自 index.mjs 抽出,全资源 YAML 创建):
// /api/apply 与工作台(applyYamlPartial)共用;deps 注入便于单测(api-key-tools 同款模式)。
// ns 缺省链:显式 metadata.namespace > defaultNs > 'default';集群级 kind 忽略后两者
// (namespaced 来自集群 discovery,权威且对 CRD 正确)。
import { loadAll as yamlLoadAll } from 'js-yaml'

export function createApplyYaml({ requestKubernetes }) {
  const discoveryCache = new Map() // apiServer:apiVersion → resources[]

  async function discoverResource(session, object) {
    const apiVersion = String(object.apiVersion || '')
    const [group, version] = apiVersion.includes('/') ? apiVersion.split('/', 2) : ['', apiVersion]
    if (!version) throw new Error('YAML 缺少 apiVersion')
    const cacheKey = `${session.apiServer}:${apiVersion}`
    let resources = discoveryCache.get(cacheKey)
    if (!resources) {
      const discoveryPath = group ? `/apis/${group}/${version}` : `/api/${version}`
      resources = (await requestKubernetes(session, discoveryPath)).body?.resources || []
      discoveryCache.set(cacheKey, resources)
    }
    const resource = resources.find(item => item.kind === object.kind && !item.name.includes('/'))
    if (!resource) throw new Error(`集群未发现资源类型 ${object.kind} (${apiVersion})`)
    return { group, version, resource }
  }

  // 两 apply 函数单点共享的 ns 解析(禁止各自内联 || 链,防漂移);集群级返回 undefined。
  function resolveApplyNamespace(object, resource, defaultNs) {
    if (!resource.namespaced) return undefined
    return object.metadata.namespace || defaultNs || 'default'
  }

  async function applyObjects(session, yaml, defaultNs, { keepBody }) {
    const objects = []
    yamlLoadAll(yaml, object => { if (object) objects.push(object) })
    if (!keepBody && !objects.length) throw new Error('YAML 中没有可应用的资源')
    const resources = [], applied = [], failed = []
    for (const object of objects) {
      const label = { kind: object?.kind, name: object?.metadata?.name }
      try {
        if (!object?.kind || !object?.metadata?.name) throw new Error('YAML 缺少 kind 或 metadata.name')
        const { group, version, resource } = await discoverResource(session, object)
        const ns = resolveApplyNamespace(object, resource, defaultNs)
        label.namespace = ns
        const prefix = group ? `/apis/${group}/${version}` : `/api/${version}`
        const namespacePart = ns !== undefined ? `/namespaces/${encodeURIComponent(ns)}` : ''
        const path = `${prefix}${namespacePart}/${resource.name}/${encodeURIComponent(object.metadata.name)}?fieldManager=aliangboard&force=true`
        const result = await requestKubernetes(session, path, {
          method: 'PATCH',
          headers: { 'content-type': 'application/apply-patch+yaml' },
          body: JSON.stringify(object),
        })
        if (keepBody) resources.push(result.body)
        applied.push(label)
      } catch (e) { failed.push({ ...label, error: e.message }) }
    }
    return keepBody ? { resources, applied, failed, total: objects.length } : { applied, failed, total: objects.length }
  }

  // /api/apply 用:逐资源 try/catch(多文档先建的不被后建失败连累),回 body。
  async function applyYaml(session, yaml, defaultNs) {
    return applyObjects(session, yaml, defaultNs, { keepBody: true })
  }
  // 工作台用(W5):同样逐资源 try/catch,只回 label 不要 body。
  async function applyYamlPartial(session, yaml, defaultNs) {
    return applyObjects(session, yaml, defaultNs, { keepBody: false })
  }

  return { applyYaml, applyYamlPartial }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test server/apply-yaml.test.mjs`
Expected: 8 PASS。

- [ ] **Step 5: 接线 `server/index.mjs`**

5a. 删除 `server/index.mjs:59` 的 `const discoveryCache = new Map()`(整行)。

5b. 删除 `:466-530` 整块——`async function discoverResource(...)`、`async function applyYaml(...)`、`async function applyYamlPartial(...)` 三个函数及其上方注释,原位替换为:

```js
// YAML apply 内核已抽至 ./apply-yaml.mjs(deps 注入便于单测,ns 缺省补齐见该模块)。
const { applyYaml, applyYamlPartial } = createApplyYaml({ requestKubernetes })
```

5c. 在 `:53` `import { normalizeKind, CANONICAL_KINDS } from './kindAlias.mjs'` 之后新增:

```js
import { createApplyYaml } from './apply-yaml.mjs'
```

5d. `:1564` 的 handler 调用改为:

```js
const { resources, applied, failed, total } = await applyYaml(
  session,
  String(input.yaml || ''),
  typeof input.defaultNs === 'string' && input.defaultNs ? input.defaultNs : undefined,
)
```

5e. 清理孤儿 import:运行 `grep -n "yamlLoadAll\|yamlLoad" server/index.mjs`——若 `yamlLoadAll` 仅剩 import 行,把 `:8` 改为 `import { load as yamlLoad } from 'js-yaml'`;若 `yamlLoad` 也无消费者则整行删除(grep 确认后再动)。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test server/apply-yaml.test.mjs && npm run test:server`
Expected: 新 8 用例 PASS + 全部既有 server 测试 PASS(尤其 `api-key-tools.test.mjs` 的 apply_yaml 三用例与 `wb-approval-roundtrip`、`wb-podlogs-roundtrip` 两条网关级集成)。

- [ ] **Step 7: typecheck**

Run: `npm run typecheck`
Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add server/apply-yaml.mjs server/apply-yaml.test.mjs server/index.mjs
git commit -m "refactor(server): applyYaml/applyYamlPartial 抽至 apply-yaml.mjs + defaultNs 缺省补当前 ns(显式>defaultNs>default,集群级忽略;label.namespace 报补齐值)"
```

---

### Task 2: 模板单源 `src/utils/yamlTemplates.js`

**Files:**
- Create: `src/utils/yamlTemplates.js`
- Create: `src/utils/__tests__/yamlTemplates.test.js`

**Interfaces:**
- Produces: `yamlTemplates: Record<Kind, (ns: string) => string>`(14 kind 键 = K8s kind 名)、`CLUSTER_SCOPED_KINDS: Set<string>`(恰含 `ClusterRole`、`ClusterRoleBinding`、`Namespace`)。Task 3/4 按此消费。

- [ ] **Step 1: 写失败测试(全文)**

创建 `src/utils/__tests__/yamlTemplates.test.js`:

```js
import { test, expect } from 'vitest'
import { load as yamlLoad } from 'js-yaml'
import { yamlTemplates, CLUSTER_SCOPED_KINDS } from '@/utils/yamlTemplates'

test('共 14 个 kind 模板,键即 K8s kind 名', () => {
  expect(Object.keys(yamlTemplates).sort()).toEqual([
    'ClusterRole', 'ClusterRoleBinding', 'Deployment', 'HorizontalPodAutoscaler',
    'Ingress', 'LimitRange', 'Namespace', 'PersistentVolumeClaim', 'PodDisruptionBudget',
    'ResourceQuota', 'Role', 'RoleBinding', 'Service', 'ServiceAccount',
  ])
})

test('CLUSTER_SCOPED_KINDS 恰含 3 个集群级 kind', () => {
  expect([...CLUSTER_SCOPED_KINDS].sort()).toEqual(['ClusterRole', 'ClusterRoleBinding', 'Namespace'])
})

test('每个模板可被 js-yaml 解析、kind 与键一致、namespaced 模板 ns 插值生效', () => {
  for (const [kind, tpl] of Object.entries(yamlTemplates)) {
    const doc = yamlLoad(tpl('demo-ns'))
    expect(doc.kind, kind).toBe(kind)
    expect(doc.apiVersion, kind).toBeTruthy()
    expect(doc.metadata?.name, kind).toBeTruthy()
    if (CLUSTER_SCOPED_KINDS.has(kind)) {
      expect(doc.metadata?.namespace ?? null, kind).toBeNull() // 集群级:metadata 无 namespace 字段
    } else {
      expect(doc.metadata.namespace, kind).toBe('demo-ns')
    }
  }
})

test('Deployment 模板保留既有 my-app 示例(既有 dialog 测试断言依赖)', () => {
  const doc = yamlLoad(yamlTemplates.Deployment('demo-ns'))
  expect(doc.metadata.name).toBe('my-app')
  expect(doc.spec.template.spec.containers[0].image).toBe('nginx:latest')
})

test('RoleBinding 模板 subjects 的 SA 主体带当前 ns', () => {
  const doc = yamlLoad(yamlTemplates.RoleBinding('demo-ns'))
  expect(doc.roleRef.kind).toBe('Role')
  expect(doc.subjects[0].namespace).toBe('demo-ns')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/utils/__tests__/yamlTemplates.test.js`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 创建 `src/utils/yamlTemplates.js`(全文)**

```js
// 「从 YAML 创建」各 kind 最小模板单源(2026-08-28 全资源 YAML 创建)。
// 约定:键 = K8s kind 名;值为 (ns) => YAML 字符串,纯静态、不依赖 store;
// 集群级 kind(见 CLUSTER_SCOPED_KINDS)的模板不含 metadata.namespace 字段。
// Deployment 迁自 CreateFromYamlDialog 旧内联模板,保留 name: my-app(既有测试断言)。
export const CLUSTER_SCOPED_KINDS = new Set(['ClusterRole', 'ClusterRoleBinding', 'Namespace'])

export const yamlTemplates = {
  Deployment: ns => `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: ${ns}
  labels:
    app: my-app
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
        - name: my-app
          image: nginx:latest
          ports:
            - containerPort: 80
`,
  Service: ns => `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: ${ns}
spec:
  type: ClusterIP
  selector:
    app: my-app
  ports:
    - name: http
      port: 80
      targetPort: 8080
`,
  Ingress: ns => `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: my-ingress
  namespace: ${ns}
spec:
  rules:
    - host: example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: my-service
                port:
                  number: 80
`,
  PersistentVolumeClaim: ns => `apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: my-pvc
  namespace: ${ns}
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 1Gi
`,
  HorizontalPodAutoscaler: ns => `apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: my-hpa
  namespace: ${ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: my-app
  minReplicas: 1
  maxReplicas: 5
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 80
`,
  PodDisruptionBudget: ns => `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: my-pdb
  namespace: ${ns}
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: my-app
`,
  LimitRange: ns => `apiVersion: v1
kind: LimitRange
metadata:
  name: my-limitrange
  namespace: ${ns}
spec:
  limits:
    - type: Container
      default:
        cpu: 500m
        memory: 256Mi
      defaultRequest:
        cpu: 100m
        memory: 128Mi
`,
  ResourceQuota: ns => `apiVersion: v1
kind: ResourceQuota
metadata:
  name: my-resourcequota
  namespace: ${ns}
spec:
  hard:
    pods: "10"
    requests.cpu: "1"
    requests.memory: 1Gi
    limits.cpu: "2"
    limits.memory: 2Gi
`,
  Role: ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: my-role
  namespace: ${ns}
rules:
  - apiGroups: [""]
    resources: ["pods"]
    verbs: ["get", "list", "watch"]
`,
  ClusterRole: () => `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: my-clusterrole
rules:
  - apiGroups: [""]
    resources: ["nodes"]
    verbs: ["get", "list", "watch"]
`,
  RoleBinding: ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: my-rolebinding
  namespace: ${ns}
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: my-role
subjects:
  - kind: ServiceAccount
    name: my-sa
    namespace: ${ns}
`,
  ClusterRoleBinding: ns => `apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: my-clusterrolebinding
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: my-clusterrole
subjects:
  - kind: ServiceAccount
    name: my-sa
    namespace: ${ns}
`,
  ServiceAccount: ns => `apiVersion: v1
kind: ServiceAccount
metadata:
  name: my-sa
  namespace: ${ns}
`,
  Namespace: () => `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace
`,
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/utils/__tests__/yamlTemplates.test.js`
Expected: 5 PASS。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`(Expected: PASS)

```bash
git add src/utils/yamlTemplates.js src/utils/__tests__/yamlTemplates.test.js
git commit -m "feat(utils): yamlTemplates 单源——14 kind 最小 YAML 模板 + CLUSTER_SCOPED_KINDS(全资源从 YAML 创建 T2)"
```

---

### Task 3: 前端 defaultNs 四层链 + dialog kind/nsHint + i18n

**Files:**
- Modify: `src/api/client.js:136`(applyYaml)
- Modify: `src/stores/cluster.js:1863-1867`(applyResourceYaml)
- Modify: `src/composables/useResourceApply.js:9-10`
- Modify: `src/components/common/CreateFromYamlDialog.vue`(kind prop/nsHint/模板查表/透传)
- Modify: `src/locales/en.json` + `src/locales/zh.json`(component.createFromYaml.hint 改写 + nsHint 新增)
- Create: `src/composables/__tests__/useResourceApply.defaultNs.test.js`
- Create: `src/stores/__tests__/cluster.apply-yaml-ns.test.js`
- Modify: `src/components/common/__tests__/CreateFromYamlDialog.test.js`

**Interfaces:**
- Consumes: Task 2 的 `yamlTemplates`/`CLUSTER_SCOPED_KINDS`。
- Produces: `useResourceApply().applyYaml(yamlStr, opts = {})`;`store.applyResourceYaml(yamlStr, opts = {})`(第二参可省,省略 = 现行为);`api.applyYaml(yaml, defaultNs)`;dialog props 增 `kind: String`(默认 `'Deployment'`)。不传 defaultNs 的既有调用方(约 23 文件经 composable + 2 直调)行为零变化。

- [ ] **Step 1: 写失败测试——composable 透传(全文)**

创建 `src/composables/__tests__/useResourceApply.defaultNs.test.js`:

```js
// defaultNs 透传链第二跳:useResourceApply → store(2026-08-28;C2 审查:此跳断裂则功能整体静默失效)。
import { test, expect, vi } from 'vitest'

const applyResourceYaml = vi.fn(async () => ({ ok: true, kind: 'Service', name: 's1' }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ applyResourceYaml: (...a) => applyResourceYaml(...a) }),
}))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))

import { useResourceApply } from '@/composables/useResourceApply'

test('applyYaml 透传 opts.defaultNs 给 store.applyResourceYaml', async () => {
  const { applyYaml } = useResourceApply()
  await applyYaml('a: 1', { defaultNs: 'demo' })
  expect(applyResourceYaml).toHaveBeenCalledWith('a: 1', { defaultNs: 'demo' })
})

test('不传 opts:第二参为 {}(现行为)', async () => {
  const { applyYaml } = useResourceApply()
  await applyYaml('a: 1')
  expect(applyResourceYaml).toHaveBeenLastCalledWith('a: 1', {})
})
```

- [ ] **Step 2: 写失败测试——store 透传**

创建 `src/stores/__tests__/cluster.apply-yaml-ns.test.js`:以 `src/stores/__tests__/cluster.crud-factory.test.js` 顶部桩区(`vi.mock('@/api/client')` 全量符号、`vi.mock('@/queryClient')`、localStorage 垫片的 beforeEach/afterEach)为底本原样复制,然后把其 `applyYaml` 桩的返回改为 `async () => ({ resources: [], applied: [{ kind: 'Service', name: 's1' }], failed: [], total: 1 })`,追加两个用例:

```js
test('applyResourceYaml 透传 opts.defaultNs → api.applyYaml 第二参', async () => {
  setActivePinia(createPinia())
  const store = useClusterStore()
  await store.applyResourceYaml('apiVersion: v1\nkind: Service\nmetadata:\n  name: s1', { defaultNs: 'demo' })
  expect(applyYaml).toHaveBeenCalledWith('apiVersion: v1\nkind: Service\nmetadata:\n  name: s1', 'demo')
})

test('applyResourceYaml 不传 opts → api.applyYaml 第二参 undefined(现行为)', async () => {
  setActivePinia(createPinia())
  const store = useClusterStore()
  await store.applyResourceYaml('apiVersion: v1\nkind: Service\nmetadata:\n  name: s1')
  expect(applyYaml.mock.calls[0][1]).toBeUndefined()
})
```

(注意:`import { useClusterStore } from '@/stores/cluster'` 必须放在所有 `vi.mock` 之后,与底本文件一致。)

- [ ] **Step 3: 跑两个新测试确认失败**

Run: `npx vitest run src/composables/__tests__/useResourceApply.defaultNs.test.js src/stores/__tests__/cluster.apply-yaml-ns.test.js`
Expected: FAIL(composable 第二参被丢弃;store 不透传)。

- [ ] **Step 4: 实现四层透传**

4a. `src/api/client.js:136`:

```js
applyYaml: (yaml, defaultNs) => k8sHttp.request('/api/apply', { method: 'POST', body: JSON.stringify({ yaml, defaultNs }) }),
```

(`defaultNs` 为 undefined 时 `JSON.stringify` 自动丢键,老 body 逐字节不变。)

4b. `src/stores/cluster.js:1863` 函数签名与 `:1867` 调用:

```js
async function applyResourceYaml(yamlStr, opts = {}) {
  try {
    let object = null
    yamlLoadAll(yamlStr, document => { if (!object && document) object = document })
    const result = await api.applyYaml(yamlStr, opts.defaultNs) // { resources, applied, failed, total }
```

(仅改签名行与该一行调用,函数其余不动。)

4c. `src/composables/useResourceApply.js:9-10`:

```js
  async function applyYaml(yamlStr, opts = {}) {
    const res = await store.applyResourceYaml(yamlStr, opts)
```

4d. `src/components/common/CreateFromYamlDialog.vue`:

- props 增一行:`kind: { type: String, default: 'Deployment' },`
- script 头部:`import { ref, watch } from 'vue'` 改为 `import { ref, watch, computed } from 'vue'`;新增 `import { yamlTemplates, CLUSTER_SCOPED_KINDS } from '@/utils/yamlTemplates'`;删除整个 `function template() {...}`(`:18-43`),替换为:

```js
const nsHint = computed(() => !!props.namespace && !CLUSTER_SCOPED_KINDS.has(props.kind))
```

- `:51` 的 watch 回调改为:`if (v) { yaml.value = (yamlTemplates[props.kind] || yamlTemplates.Deployment)(props.namespace || 'default'); parseError.value = ''; applying.value = false }`
- `:68` 的 create() 调用改为:`const res = await applyYaml(yaml.value, props.namespace ? { defaultNs: props.namespace } : undefined)`
- 模板 `:84` YamlEditor 之后、parseError 段之前插入:

```html
      <p v-if="nsHint" class="text-body-sm text-on-surface-variant">{{ t('component.createFromYaml.nsHint', { ns: props.namespace }) }}</p>
```

4e. i18n——`src/locales/zh.json` `component.createFromYaml` 块(`:73-78`)改为:

```json
      "hint": "粘贴或编辑 YAML 后创建。显式写的 metadata.namespace 优先;未写则创建到当前命名空间。",
      "nsHint": "未写 metadata.namespace 的文档将创建到 {ns}",
```

(`title`/`create`/`parseError` 三行不动。)同位置 `src/locales/en.json`:

```json
      "hint": "Paste or edit YAML then create. Explicit metadata.namespace wins; documents without it are created in the current namespace.",
      "nsHint": "Documents without metadata.namespace will be created in {ns}",
```

- [ ] **Step 5: 扩充 dialog 测试(在既有文件追加)**

`src/components/common/__tests__/CreateFromYamlDialog.test.js`:把 `vi.mock` 工厂改为可检查的 hoisted mock,并追加用例。文件头部改为:

```js
import { test, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const { applyYamlMock } = vi.hoisted(() => ({ applyYamlMock: vi.fn() }))
// 组件挂载即触发 useResourceApply()→useClusterStore()→activeApiServer()→localStorage,
// mock 掉 composable 以隔离副作用;applyYamlMock 供透传断言。
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: applyYamlMock }),
}))

import CreateFromYamlDialog from '@/components/common/CreateFromYamlDialog.vue'
```

(原「挂载并渲染标题 + YamlEditor」用例保留不动。)

追加用例:

```js
test('kind prop 注入对应模板', () => {
  const w = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  expect(document.body.textContent).toContain('my-service')
  w.unmount()
})

test('nsHint:namespaced kind + 有 ns → 显示(与改写后 hint 同窗并存);集群级 kind / 无 ns → 隐藏', () => {
  const shown = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  expect(document.body.textContent).toContain(i18n.global.t('component.createFromYaml.nsHint', { ns: 'demo' }))
  expect(document.body.textContent).toContain(i18n.global.t('component.createFromYaml.hint'))
  shown.unmount()
  const clusterKind = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'ClusterRole' }, global: { plugins: [createPinia(), i18n] } })
  expect(document.body.textContent).not.toContain(i18n.global.t('component.createFromYaml.nsHint', { ns: 'demo' }))
  clusterKind.unmount()
  const noNs = mount(CreateFromYamlDialog, { props: { modelValue: true, kind: 'Deployment' }, global: { plugins: [createPinia(), i18n] } })
  expect(document.body.textContent).not.toContain(i18n.global.t('component.createFromYaml.nsHint', { ns: 'demo' }))
  noNs.unmount()
})

test('create():defaultNs 透传第二参;namespace 为空则不传', async () => {
  applyYamlMock.mockResolvedValue({ ok: true, kind: 'Service', name: 'my-service' })
  const w = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  await w.vm.create()
  expect(applyYamlMock).toHaveBeenCalledTimes(1)
  expect(applyYamlMock.mock.calls[0][1]).toEqual({ defaultNs: 'demo' })
  w.unmount()
  applyYamlMock.mockClear()
  const w2 = mount(CreateFromYamlDialog, { props: { modelValue: true, kind: 'Deployment' }, global: { plugins: [createPinia(), i18n] } })
  await w2.vm.create()
  expect(applyYamlMock.mock.calls[0][1]).toBeUndefined()
  w2.unmount()
})

test('parse 失败分支:无效 YAML → 内联报错,不调 applyYaml', async () => {
  const w = mount(CreateFromYamlDialog, { props: { modelValue: true, namespace: 'demo', kind: 'Service' }, global: { plugins: [createPinia(), i18n] } })
  await w.setData({ yaml: '::: not-yaml [' })
  await w.vm.create()
  expect(document.body.textContent).toContain(i18n.global.t('component.createFromYaml.parseError'))
  expect(applyYamlMock).not.toHaveBeenCalled()
  w.unmount()
})
```

- [ ] **Step 6: 跑测试确认全绿**

Run: `npx vitest run src/composables/__tests__/useResourceApply.defaultNs.test.js src/stores/__tests__/cluster.apply-yaml-ns.test.js src/components/common/__tests__/CreateFromYamlDialog.test.js`
Expected: 全 PASS。

- [ ] **Step 7: 回归 + 门禁**

Run: `npm run test:unit && npm run typecheck && npm run i18n:check`
Expected: 全 PASS(既有 dialog 冒烟用例「my-app」不破;~23 个既有调用方零改动)。

- [ ] **Step 8: 提交**

```bash
git add src/api/client.js src/stores/cluster.js src/composables/useResourceApply.js src/components/common/CreateFromYamlDialog.vue src/locales/en.json src/locales/zh.json src/composables/__tests__/useResourceApply.defaultNs.test.js src/stores/__tests__/cluster.apply-yaml-ns.test.js src/components/common/__tests__/CreateFromYamlDialog.test.js
git commit -m "feat(ui): defaultNs 四层透传(dialog→composable→store→api)+ dialog kind 模板/nsHint + i18n hint 改写(全资源从 YAML 创建 T3)"
```

---

### Task 4: `CreateWithYamlButton` 黏合组件

**Files:**
- Create: `src/components/common/CreateWithYamlButton.vue`
- Create: `src/components/common/__tests__/CreateWithYamlButton.test.js`

**Interfaces:**
- Consumes: `SplitButton`(props `{label, icon, mainAction, items, disabled}`,无 emit)、Task 3 后的 `CreateFromYamlDialog`(props `{modelValue, kind, namespace}`,emit `applied`)。
- Produces: props `{ label: String(必填), icon: String='add', mainAction: Function|undefined, mainOpensYaml: Boolean=false, yamlTemplate: String='Deployment', namespace: String='', extraItems: Array=[], disabled: Boolean=false }`;emit `applied`。`mainOpensYaml=true` 时主按钮直开 YAML 弹窗(供无表单创建的 tab,如 NsRBAC rolebindings)。单根 div 包装(多根组件不继承 attrs,NamespaceOverview 空态的 `class="mt-md"` 需落点)。

- [ ] **Step 1: 写失败测试(全文)**

创建 `src/components/common/__tests__/CreateWithYamlButton.test.js`:

```js
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { i18n } from '@/i18n'

const { applyYamlMock } = vi.hoisted(() => ({ applyYamlMock: vi.fn() }))
vi.mock('@/composables/useResourceApply', () => ({
  useResourceApply: () => ({ applyYaml: applyYamlMock }),
}))

import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'

function mountBtn(props = {}) {
  return mount(CreateWithYamlButton, {
    props: { label: 'NEW', mainAction: () => {}, ...props },
    global: { plugins: [createPinia(), i18n] },
    attachTo: document.body,
  })
}
function menuItemTexts() {
  return [...document.body.querySelectorAll('[data-menu-item]')].map(el => el.textContent.trim())
}

test('主按钮触发 mainAction', async () => {
  const mainAction = vi.fn()
  const w = mountBtn({ mainAction })
  await w.findAll('button')[0].trigger('click')
  expect(mainAction).toHaveBeenCalledTimes(1)
  w.unmount()
})

test('YAML 项在最前、extraItems 随后(workload 视图现状顺序)', async () => {
  const w = mountBtn({ extraItems: [{ label: 'COPY', icon: 'content_copy', action: () => {} }] })
  await w.findAll('button')[1].trigger('click') // 箭头钮展开菜单
  const texts = menuItemTexts()
  expect(texts[0]).toContain(i18n.global.t('component.splitButton.createFromYaml'))
  expect(texts[1]).toBe('COPY')
  w.unmount()
})

test('YAML 项打开 dialog,模板随 yamlTemplate + namespace 填充', async () => {
  const w = mountBtn({ yamlTemplate: 'Service', namespace: 'demo' })
  await w.findAll('button')[1].trigger('click')
  await w.findAll('button')[2].trigger('click') // 菜单里的「从 YAML 创建」
  await flushPromises()
  expect(document.body.textContent).toContain('my-service')
  expect(document.body.textContent).toContain('demo')
  w.unmount()
})

test('mainOpensYaml=true:主按钮直开 dialog 且忽略 mainAction', async () => {
  const mainAction = vi.fn()
  const w = mountBtn({ mainAction, mainOpensYaml: true, yamlTemplate: 'RoleBinding', namespace: 'demo' })
  await w.findAll('button')[0].trigger('click')
  await flushPromises()
  expect(mainAction).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('my-rolebinding')
  w.unmount()
})

test('disabled 透传 SplitButton', async () => {
  const mainAction = vi.fn()
  const w = mountBtn({ mainAction, disabled: true })
  const [mainBtn] = w.findAll('button')
  expect(mainBtn.attributes('disabled')).toBeDefined()
  await mainBtn.trigger('click')
  expect(mainAction).not.toHaveBeenCalled()
  w.unmount()
})

test('applied 透传:dialog 创建成功后 emit applied', async () => {
  applyYamlMock.mockResolvedValue({ ok: true, kind: 'Service', name: 'my-service' })
  const w = mountBtn({ yamlTemplate: 'Service', namespace: 'demo' })
  await w.findAll('button')[1].trigger('click')
  await w.findAll('button')[2].trigger('click')
  await flushPromises()
  const createBtn = [...document.body.querySelectorAll('button')].find(b => b.textContent.trim() === i18n.global.t('component.createFromYaml.create'))
  expect(createBtn).toBeTruthy()
  await createBtn.trigger('click')
  await flushPromises()
  expect(applyYamlMock).toHaveBeenCalledTimes(1)
  expect(w.emitted('applied')).toHaveLength(1)
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/CreateWithYamlButton.test.js`
Expected: FAIL(组件不存在)。

- [ ] **Step 3: 创建组件(全文)**

创建 `src/components/common/CreateWithYamlButton.vue`:

```vue
<script setup>
// 「创建」按钮黏合层:SplitButton(主=表单创建,次=从 YAML 创建)+ 自持 CreateFromYamlDialog。
// 单根 div:多根组件不继承 attrs,NamespaceOverview 空态的 class="mt-md" 需要落点。
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import SplitButton from '@/components/common/SplitButton.vue'
import CreateFromYamlDialog from '@/components/common/CreateFromYamlDialog.vue'

const props = defineProps({
  label: { type: String, required: true },
  icon: { type: String, default: 'add' },
  mainAction: { type: Function, default: undefined },
  mainOpensYaml: { type: Boolean, default: false }, // 主按钮直开 YAML 弹窗(无表单创建的 tab 用)
  yamlTemplate: { type: String, default: 'Deployment' },
  namespace: { type: String, default: '' },
  extraItems: { type: Array, default: () => [] }, // 追加在「从 YAML 创建」之后
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['applied'])

const { t } = useI18n()
const showYaml = ref(false)

function openYaml() { showYaml.value = true }
function onMain() { if (props.mainOpensYaml) openYaml(); else if (props.mainAction) props.mainAction() }
</script>

<template>
  <div>
    <SplitButton
      :label="label"
      :icon="icon"
      :main-action="onMain"
      :items="[
        { label: t('component.splitButton.createFromYaml'), icon: 'description', action: openYaml },
        ...extraItems,
      ]"
      :disabled="disabled"
    />
    <CreateFromYamlDialog v-model="showYaml" :kind="yamlTemplate" :namespace="namespace" @applied="emit('applied')" />
  </div>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/CreateWithYamlButton.test.js`
Expected: 5 PASS。

- [ ] **Step 5: typecheck + 提交**

Run: `npm run typecheck`(Expected: PASS)

```bash
git add src/components/common/CreateWithYamlButton.vue src/components/common/__tests__/CreateWithYamlButton.test.js
git commit -m "feat(ui): CreateWithYamlButton 黏合组件(SplitButton+YAML dialog,mainOpensYaml/applied 透传)(全资源从 YAML 创建 T4)"
```

---

### Task 5: 三个 workload 视图重构(行为不变)

**Files:**
- Modify: `src/views/Workloads.vue`(:41 删 showYamlDialog、:139-148 换组件)
- Modify: `src/views/NsWorkloads.vue`(:32 删 ref、:134-143 换组件)
- Modify: `src/views/NamespaceOverview.vue`(:50 删 ref、:256-265 与 :377-385 两处换组件)

**Interfaces:**
- Consumes: Task 4 的 `CreateWithYamlButton`。
- 行为不变契约(审查 m3/f 项):Workloads 的 dialog **不带 namespace、不接 applied**;NsWorkloads/NamespaceOverview **带 `:namespace` + `@applied="workloadsQuery.refetch()"`**;`showCopyDialog`/`CopyWorkloadDialog` 原样保留。

- [ ] **Step 1: Workloads.vue**

1a. script:删 `const showYamlDialog = ref(false)`(`:41`);import 区把 `SplitButton` 与 `CreateFromYamlDialog` 的引入替换为 `CreateWithYamlButton`(若 SplitButton 已无其他使用处;grep 确认)。

1b. `:139-148` 的 `<SplitButton ... />` + `<CreateFromYamlDialog v-model="showYamlDialog" />` 两段替换为:

```html
          <CreateWithYamlButton
            :label="t('ns.workloads.new')"
            icon="rocket_launch"
            :main-action="() => router.push('/deploy')"
            yaml-template="Deployment"
            :extra-items="[{ label: t('component.splitButton.copyWorkload'), icon: 'content_copy', action: () => { showCopyDialog = true } }]"
          />
```

(`<CopyWorkloadDialog>` 行保留。)

- [ ] **Step 2: NsWorkloads.vue**

删 `:32` 的 `const showYamlDialog = ref(false)`;`:134-143` 替换为:

```html
      <CreateWithYamlButton
        :label="t('ns.workloads.new')"
        icon="rocket_launch"
        :main-action="() => router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })"
        yaml-template="Deployment"
        :namespace="route.params.namespace"
        :extra-items="[{ label: t('component.splitButton.copyWorkload'), icon: 'content_copy', action: () => { showCopyDialog = true } }]"
        @applied="workloadsQuery.refetch()"
      />
```

(`<CopyWorkloadDialog>` 行保留。)

- [ ] **Step 3: NamespaceOverview.vue(两处)**

删 `:50` 的 ref;第一处(`:256-264` SplitButton + `:265` dialog)替换为:

```html
        <CreateWithYamlButton
          :label="t('ns.namespaceOverview.deploy')"
          icon="add"
          :main-action="() => router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })"
          yaml-template="Deployment"
          :namespace="route.params.namespace"
          :extra-items="[{ label: t('component.splitButton.copyWorkload'), icon: 'content_copy', action: () => { showCopyDialog = true } }]"
          @applied="workloadsQuery.refetch()"
        />
```

(`<CopyWorkloadDialog>` `:266` 保留。)第二处(空态 `:377-385`,同文件内第二个 SplitButton,label 为 `t('ns.namespaceOverview.deployApp')`、icon `rocket_launch`、带 `class="mt-md"`)替换为:

```html
      <CreateWithYamlButton
        class="mt-md"
        :label="t('ns.namespaceOverview.deployApp')"
        icon="rocket_launch"
        :main-action="() => router.push({ name: 'NsDeploy', params: { namespace: route.params.namespace } })"
        yaml-template="Deployment"
        :namespace="route.params.namespace"
        :extra-items="[{ label: t('component.splitButton.copyWorkload'), icon: 'content_copy', action: () => { showCopyDialog = true } }]"
        @applied="workloadsQuery.refetch()"
      />
```

(class 经单根 div 继承,布局不变。)

- [ ] **Step 4: 回归**

Run: `npx vitest run src/views/__tests__/NamespaceOverview.workload-types.test.js && npm run test:unit && npm run typecheck`
Expected: 全 PASS(NamespaceOverview 既有测试是本步的存量回归防线)。

- [ ] **Step 5: 提交**

```bash
git add src/views/Workloads.vue src/views/NsWorkloads.vue src/views/NamespaceOverview.vue
git commit -m "refactor(ui): 三个 workload 视图的 YAML 创建入口收敛到 CreateWithYamlButton(行为不变,全资源从 YAML 创建 T5)"
```

---

### Task 6: 七个表单视图接线

**Files(全部 Modify):**
- `src/views/NsServices.vue`(:220-224 按钮)
- `src/views/NsIngress.vue`(:184-186)
- `src/views/NsStorage.vue`(:149-151,仅 PVC tab)
- `src/views/NsHPA.vue`(:116-118)
- `src/views/NsPDBs.vue`(:130-132)
- `src/views/NsLimitRanges.vue`(:114-116)
- `src/views/NsResourceQuotas.vue`(:130-132)

**Interfaces:**
- Consumes: Task 4 组件。统一规则:**每个视图 `<script setup>` import `CreateWithYamlButton`;把创建 `<button>` 整体替换为下面对应的 `<CreateWithYamlButton>`(label 表达式照抄原按钮文案);不接 `@applied`(列表已迁 `useResourceList`,key 前缀 `['cluster', …]`,被 `applyResourceYaml` 的 invalidate predicate `cluster.js:1868` 覆盖)**。

- [ ] **Step 1: 七视图逐一替换**(替换锚点 = 原按钮全文,执行前先读所在行确认)

NsServices.vue——`<button @click="showCreateModal = true" class="flex items-center gap-sm px-3 py-1.5 text-body-sm font-semibold bg-primary text-on-primary rounded-lg hover:opacity-90 active:scale-95 transition-all">…</button>` 换为:

```html
        <CreateWithYamlButton :label="`${t('common.create')} ${t('ns.services.title')}`" :main-action="() => { showCreateModal = true }" yaml-template="Service" :namespace="route.params.namespace" />
```

NsIngress.vue:

```html
      <CreateWithYamlButton :label="t('ns.ingress.new')" :main-action="() => { showCreateModal = true }" yaml-template="Ingress" :namespace="route.params.namespace" />
```

NsStorage.vue(仅 PVC tab 的 `showCreatePVC` 按钮;StorageClass tab 无创建,不动):

```html
        <CreateWithYamlButton :label="t('ns.storage.newPVC')" :main-action="() => { showCreatePVC = true }" yaml-template="PersistentVolumeClaim" :namespace="route.params.namespace" />
```

NsHPA.vue / NsPDBs.vue / NsLimitRanges.vue / NsResourceQuotas.vue(四者结构相同,仅 label 键与 kind 不同):

```html
      <CreateWithYamlButton :label="t('ns.hpa.createBtn')" :main-action="() => { showCreateModal = true }" yaml-template="HorizontalPodAutoscaler" :namespace="route.params.namespace" />
```

```html
      <CreateWithYamlButton :label="t('ns.pdb.newBtn')" :main-action="() => { showCreateModal = true }" yaml-template="PodDisruptionBudget" :namespace="route.params.namespace" />
```

```html
      <CreateWithYamlButton :label="t('ns.limitRanges.newBtn')" :main-action="() => { showCreateModal = true }" yaml-template="LimitRange" :namespace="route.params.namespace" />
```

```html
      <CreateWithYamlButton :label="t('ns.resourceQuotas.newBtn')" :main-action="() => { showCreateModal = true }" yaml-template="ResourceQuota" :namespace="route.params.namespace" />
```

- [ ] **Step 2: 回归**

Run: `npx vitest run src/views/__tests__/NsServices.delete-ok.test.js src/views/__tests__/NsIngress.create-validation.test.js src/views/__tests__/NsHPA.create-await.test.js src/views/__tests__/NsLimitRanges.render.test.js src/views/__tests__/NsResourceQuotas.cpu.test.js && npx vitest run src/views/__tests__/_allViewsMount.test.js && npm run typecheck`
Expected: 全 PASS(`_allViewsMount` 桩测是七视图挂载不炸的全量防线;若该测试发现新组件未 stub 导致失败,在该测试的 stubs 表中加 `CreateWithYamlButton: true` 同款桩)。

- [ ] **Step 3: 提交**

```bash
git add src/views/NsServices.vue src/views/NsIngress.vue src/views/NsStorage.vue src/views/NsHPA.vue src/views/NsPDBs.vue src/views/NsLimitRanges.vue src/views/NsResourceQuotas.vue
git commit -m "feat(ui): 七个表单视图创建按钮接入从 YAML 创建(Service/Ingress/PVC/HPA/PDB/LimitRange/ResourceQuota)(T6)"
```

---

### Task 7: Namespaces 视图

**Files:**
- Modify: `src/views/Namespaces.vue`(:145-150 按钮)

**Interfaces:**
- Consumes: Task 4 组件。Namespace 是集群级 kind:不传 `namespace` prop、不接 `@applied`(namespacesQuery key `['cluster', cid, 'namespaces']` 已被 invalidate 覆盖;**禁接 `sync()`**——它会清空整个 cluster 缓存并弹假「已同步」toast,审查 M2)。

- [ ] **Step 1: 替换按钮**

`:145-150` 的创建按钮换为(script 已有 `openCreate`):

```html
        <CreateWithYamlButton :label="t('ns.namespaces.new')" :main-action="openCreate" yaml-template="Namespace" />
```

并 import 组件。

- [ ] **Step 2: 回归**

Run: `npx vitest run src/views/__tests__/_allViewsMount.test.js && npm run typecheck`
Expected: PASS。

- [ ] **Step 3: 提交**

```bash
git add src/views/Namespaces.vue
git commit -m "feat(ui): Namespaces 视图接入从 YAML 创建(集群级 kind,无 ns 字段)(全资源从 YAML 创建 T7)"
```

---

### Task 8: NsRBAC 单按钮随 tab + RoleBinding 断链顺修

**Files:**
- Modify: `src/views/NsRBAC.vue`(script 加 computed;:160-165 页头双按钮换单组件;删 :215-219、:253-255、:283-285 三处 tab 级创建按钮)
- Create: `src/views/__tests__/NsRBAC.yaml-create.test.js`

**Interfaces:**
- Consumes: Task 4 组件(`mainOpensYaml`)。行为:页头单按钮随 `activeTab`(`:50`)——roles/clusterroles→开 Role modal(不预置 scope,与被移除按钮一致;Cluster 提交分支在 `createRole` `:72` 现状)、serviceaccounts→SA modal、clusterrolebindings→CRB modal、rolebindings→`mainOpensYaml` 直开 YAML 弹窗;yamlTemplate 随 tab 取 `RBAC_TAB_KINDS`。

- [ ] **Step 1: 写失败测试(全文)**

创建 `src/views/__tests__/NsRBAC.yaml-create.test.js`(桩区照抄同目录 `NsRBAC.crb-validation.test.js:12-35` 的全部 vi.mock + mountView;**stubs 表去掉 `Modal: true`**——本测试要断言 dialog 内容经 Teleport 渲染到 body):

```js
// NsRBAC 从 YAML 创建:页头单按钮随 activeTab + RoleBinding 断链顺修回归。
// 背景:原 rolebindings tab 的「Create RoleBinding」按钮开的是 Role modal(断链,硬编码英文),
// 本测试是「tab 级按钮移除干净」的唯一防线(i18n 门禁抓不到硬编码英文)。
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({ api: { k8s: vi.fn(async () => ({ items: [] })) } }))
vi.mock('@/composables/useToast', () => ({ notify: vi.fn() }))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({
    currentCluster: 'demo', setNamespace: () => {},
    fetchRoles: vi.fn(async () => []), fetchRoleBindings: vi.fn(async () => []),
    fetchClusterRoleBindings: vi.fn(async () => []), fetchServiceAccounts: vi.fn(async () => []),
  }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: { namespace: 'demo' } }), useRouter: () => ({ push: () => {} }) }))

import NsRBAC from '../NsRBAC.vue'

function mountView() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(NsRBAC, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { DataTable: true, Breadcrumbs: true, Pagination: true } } })
}

test('rolebindings tab:无 tab 级创建按钮(断链按钮已移除,硬编码英文消失)', async () => {
  const w = mountView()
  await w.setData({ activeTab: 'rolebindings' })
  await flushPromises()
  expect(document.body.textContent).not.toContain('Create RoleBinding')
  w.unmount()
})

test('rolebindings tab:主按钮直开 YAML 弹窗(RoleBinding 模板)', async () => {
  const w = mountView()
  await w.setData({ activeTab: 'rolebindings' })
  await flushPromises()
  const mainBtn = w.findAll('button').find(b => b.textContent.trim() === i18n.global.t('common.create'))
  expect(mainBtn).toBeTruthy()
  await mainBtn.trigger('click')
  await flushPromises()
  expect(document.body.textContent).toContain('my-rolebinding')
  w.unmount()
})

test('roles tab:主按钮开 Role modal(不预置 scope)', async () => {
  const w = mountView()
  await flushPromises()
  const mainBtn = w.findAll('button').find(b => b.textContent.trim() === i18n.global.t('common.create'))
  await mainBtn.trigger('click')
  expect(w.vm.showCreateRoleModal).toBe(true)
  w.unmount()
})

test('yamlTemplate 随 activeTab 变化', async () => {
  const w = mountView()
  await flushPromises()
  expect(w.vm.rbacYamlTemplate).toBe('Role')
  await w.setData({ activeTab: 'clusterrolebindings' })
  expect(w.vm.rbacYamlTemplate).toBe('ClusterRoleBinding')
  await w.setData({ activeTab: 'rolebindings' })
  expect(w.vm.rbacYamlTemplate).toBe('RoleBinding')
  w.unmount()
})

test('clusterroles / clusterrolebindings tab:tab 级创建按钮已移除(创建收敛页头)', async () => {
  const w = mountView()
  await w.setData({ activeTab: 'clusterroles' })
  await flushPromises()
  expect(document.body.textContent).not.toContain(i18n.global.t('ns.rbac.createClusterRoleBtn'))
  await w.setData({ activeTab: 'clusterrolebindings' })
  await flushPromises()
  expect(document.body.textContent).not.toContain(i18n.global.t('ns.rbac.createClusterRoleBindingBtn'))
  w.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/views/__tests__/NsRBAC.yaml-create.test.js`
Expected: FAIL(vm 无 `rbacYamlTemplate`;body 仍含 'Create RoleBinding')。

- [ ] **Step 3: 实现**

3a. script:`import CreateWithYamlButton from '@/components/common/CreateWithYamlButton.vue'`;在 `activeTab`(`:50`)声明后加:

```js
// 创建入口随 tab:roles/clusterroles 复用 Role modal(scope 用户自选);rolebindings 无表单 → 直开 YAML(断链顺修)。
const RBAC_TAB_KINDS = { roles: 'Role', serviceaccounts: 'ServiceAccount', rolebindings: 'RoleBinding', clusterroles: 'ClusterRole', clusterrolebindings: 'ClusterRoleBinding' }
const rbacYamlTemplate = computed(() => RBAC_TAB_KINDS[activeTab.value] || 'Role')
const rbacMainAction = computed(() => {
  switch (activeTab.value) {
    case 'roles':
    case 'clusterroles': return () => { showCreateRoleModal.value = true }
    case 'serviceaccounts': return () => { showCreateSAModal.value = true }
    case 'clusterrolebindings': return () => { showCreateCRBModal.value = true }
    default: return undefined // rolebindings:mainOpensYaml 接管
  }
})
```

(确认文件已从 vue import `computed`——`:45-48` 已在用,应已导入。)

3b. 页头 `:159-166` 的两个 `<button>`(`showCreateRoleModal`/`showCreateSAModal`)整体替换为:

```html
        <CreateWithYamlButton
          :label="$t('common.create')"
          :main-action="rbacMainAction"
          :main-opens-yaml="activeTab === 'rolebindings'"
          :yaml-template="rbacYamlTemplate"
          :namespace="route.params.namespace"
        />
```

3c. 删除三处 tab 级创建按钮:
- `:215-219` rolebindings 段的 `<div class="flex justify-end">…Create RoleBinding…</div>` 整块(硬编码英文随移除消失);
- `:253-255` clusterroles 段的 `{{ $t('ns.rbac.createClusterRoleBtn') }}` 按钮(外层 hint 条 `flex items-center justify-between` 保留 hint 文案);
- `:283-285` clusterrolebindings 段的 `{{ $t('ns.rbac.createClusterRoleBindingBtn') }}` 按钮(同上)。

- [ ] **Step 4: 跑测试确认通过 + 既有 NsRBAC 回归**

Run: `npx vitest run src/views/__tests__/NsRBAC.yaml-create.test.js src/views/__tests__/NsRBAC.crb-validation.test.js`
Expected: 全 PASS(crb-validation 桩里有 Modal: true 的 mountView,不受本改动影响;其 4 用例测的是 CRB modal 提交逻辑,未动)。

- [ ] **Step 5: 全量门禁 + 提交**

Run: `npm run test:unit && npm run typecheck && npm run i18n:check`(Expected: 全 PASS;页头按钮改用 `common.create` 后,`ns.rbac.createRoleBtn`/`createSaBtn`/`createClusterRoleBtn`/`createClusterRoleBindingBtn` 四键成孤儿——若 `i18n:check` 报未引用键,从 en/zh 两文件**成对**删除;若不报则保留不动)

```bash
git add src/views/NsRBAC.vue src/views/__tests__/NsRBAC.yaml-create.test.js
git commit -m "fix(ui): NsRBAC 页头单创建按钮随 tab(Role/SA/CRB 表单 + RoleBinding 直开 YAML)+ 移除断链假按钮(全资源从 YAML 创建 T8)"
```

---

### Task 9: 终验 + 手测清单

**Files:** 无新改动(验证任务;发现问题回各 Task 修后重跑)。

- [ ] **Step 1: 四门禁全绿**

Run: `npm test && npm run typecheck && npm run i18n:check`
Expected: 全 PASS(`npm test` = test:server + test:unit)。

- [ ] **Step 2: 构建验证**

Run: `npm run build`
Expected: 成功,.vue SFC 编译零错。

- [ ] **Step 3: 手测清单(需集群 + LLM 无关;网关须重启加载新 server 代码)**

1. NsServices:创建 ▾ → 从 YAML 创建 → 模板为 Service、ns 为当前 ns → 改名提交 → 列表出现;
2. 同法抽查 NsIngress/NsStorage(PVC tab)/NsHPA/NsPDBs/NsLimitRanges/NsResourceQuotas;
3. 粘贴**无 namespace** 的多文档 YAML(如 ConfigMap+Service)→ 创建到当前 ns;显式写其他 ns → 落该 ns;集群级 YAML(如 Namespace)→ 忽略 nsHint 与 defaultNs;
4. Namespaces:创建 ▾ 主按钮=表单,次级=YAML(Namespace 模板无 namespace 字段),两条路径各建一个 ns;
5. NsRBAC 五个 tab 逐一切换:主按钮行为与模板随 tab;rolebindings tab 主按钮直开 YAML 且可成功建 RoleBinding(断链修复);clusterroles/clusterrolebindings/rolebindings 段内无残留创建按钮;
6. 三个 workload 视图:从 YAML 创建行为与重构前一致(Deployment 模板;Workloads 无 ns 提示,NsWorkloads/NamespaceOverview 有);「复制工作负载」仍可用;
7. toast 与部分成功语义:粘贴一好一坏两文档 → 成功 warning 明细;
8. API-key/MCP `apply_yaml` 回归:带显式 ns 的 apply 照常(admin key)。

- [ ] **Step 4: 汇报**

汇报含:各 Task 提交哈希、四门禁输出摘要、手测结果、以及 spec §7 backlog 的遗留项({ok} 契约四处、CM/Secret 不动等)。
