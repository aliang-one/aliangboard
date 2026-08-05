# Ingress 路由规则编辑器重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 NsIngressDetail 的 Edit Rules 弹窗从平铺表格重构为 host 分组卡片，加严格校验、补齐 spec.defaultBackend 全链路、host/path 增删/复制/上下移操作。

**Architecture:** 抽一个无依赖纯函数 `buildIngressRulesPatch` 构造 PATCH body（可单测）；store `mapIngress` 加 defaultBackend 字段、`updateIngressRules` 复用纯函数并一次 PATCH rules+defaultBackend；NsIngressDetail 用分组数据模型 `editModel={hosts,defaultBackend}` 全量重写编辑器 script+template（含校验 computed 与操作函数）。

**Tech Stack:** Vue 3 `<script setup>`、Pinia、Vite、原生 fetch、零依赖 node 测试运行器（`scripts/test.mjs`）。

## Global Constraints

- **禁止新增外部依赖**（不引入拖拽库/sortable）；移动用上移/下移按钮。
- 编辑器按 host 分组，与详情页（`rulesByHost`）同构；消除重复填 host。
- **严格校验**：有错误时 Save 按钮 disabled + 顶部错误汇总 + 行级标红。
- `defaultBackend`：开关式卡片（默认收起）；删除用 merge-patch `null`（`null` 必须显式出现在 PATCH body）。
- 不改详情页展示、不改 IngressClass/TLS/Annotations/Labels 编辑、不改 NsIngress.vue 创建表单。
- 纯逻辑测试追加到 `scripts/test.mjs`（遵循该文件零依赖约定，不引入 vitest/jest）。

---

## File Structure

**新增**
- `src/composables/useIngressRules.js` — 纯函数 `buildIngressRulesPatch(flatRules, defaultBackend)`，无依赖，单测可 import。

**修改**
- `src/stores/cluster.js` — `mapIngress` 加 `defaultBackend` 字段；`updateIngressRules` 扩展签名并复用 `buildIngressRulesPatch`。
- `src/views/NsIngressDetail.vue` — 编辑器全量重写（script 的 rules 编辑段 64-93 + template 的 Edit Rules Modal 410-451）。

---

### Task 1: 纯函数 `buildIngressRulesPatch` + 单测（TDD）

**Files:**
- Create: `src/composables/useIngressRules.js`
- Test: `scripts/test.mjs`（追加用例）

**Interfaces:**
- Produces: `buildIngressRulesPatch(flatRules: Array<{host,path,pathType,serviceName,servicePort}>, defaultBackend: {enabled,serviceName,servicePort} | null) => { spec: { rules: Array<{host, http:{paths:[{path,pathType,backend:{service:{name,port:{number}}}}]}>, defaultBackend: {service:{name,port:{number}}} | null } }`。`defaultBackend === null` 表示 merge-patch 删除该字段。从 `../src/composables/useIngressRules.js` import。

- [ ] **Step 1: 写失败测试**

在 `scripts/test.mjs` 的"汇总"段（`const failed = ...` 那行之前）追加：

```js
// --- Ingress 规则 PATCH body 构造：按 host 聚合 + defaultBackend 启用/删除语义 ---
// 契约：stores/cluster.js 的 updateIngressRules 复用本纯函数；defaultBackend===null 时 merge-patch 删除字段。
import { buildIngressRulesPatch } from '../src/composables/useIngressRules.js'
test('Ingress 规则 PATCH 构造：按 host 聚合 + defaultBackend 启用/删除', () => {
  const flat = [
    { host: 'a.com', path: '/', pathType: 'Prefix', serviceName: 'web', servicePort: '80' },
    { host: 'a.com', path: '/api', pathType: 'Prefix', serviceName: 'api', servicePort: '8080' },
    { host: '', path: '/', pathType: 'Prefix', serviceName: 'default', servicePort: '80' },
  ]
  // 未启用 defaultBackend → null（删除语义）
  const r = buildIngressRulesPatch(flat, null)
  assert.equal(r.spec.rules.length, 2, 'a.com 与空 host 各一组')
  const acom = r.spec.rules.find(x => x.host === 'a.com')
  assert.equal(acom.http.paths.length, 2, 'a.com 下两条 path')
  assert.equal(acom.http.paths[0].backend.service.name, 'web')
  assert.equal(acom.http.paths[1].backend.service.port.number, 8080)
  assert.equal(r.spec.defaultBackend, null, '未启用 → null')
  // 启用 defaultBackend → 对象
  const r2 = buildIngressRulesPatch(flat, { enabled: true, serviceName: 'fallback', servicePort: '80' })
  assert.equal(r2.spec.defaultBackend.service.name, 'fallback')
  assert.equal(r2.spec.defaultBackend.port.number, 80)
  // enabled 但缺 serviceName → 视为删除（null）
  const r3 = buildIngressRulesPatch(flat, { enabled: true, serviceName: '', servicePort: '' })
  assert.equal(r3.spec.defaultBackend, null, 'enabled 但无 serviceName → null')
  // 空入参
  assert.deepEqual(buildIngressRulesPatch([], null), { spec: { rules: [], defaultBackend: null } })
  // 默认值：空 path→'/'，空 pathType→'Prefix'，空 port→80
  const r4 = buildIngressRulesPatch([{ host: 'x', path: '', pathType: '', serviceName: 's', servicePort: '' }], null)
  assert.equal(r4.spec.rules[0].http.paths[0].path, '/')
  assert.equal(r4.spec.rules[0].http.paths[0].pathType, 'Prefix')
  assert.equal(r4.spec.rules[0].http.paths[0].backend.service.port.number, 80)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node scripts/test.mjs`
Expected: FAIL，报 `Cannot find module '../src/composables/useIngressRules.js'`。

- [ ] **Step 3: 实现纯函数**

创建 `src/composables/useIngressRules.js`：

```js
// 构造 Ingress 路由规则的 PATCH body（networking.k8s.io/v1，merge-patch 语义）。
// 入参：flatRules [{host,path,pathType,serviceName,servicePort}] + defaultBackend {enabled,serviceName,servicePort} | null
// 出参：{ spec: { rules, defaultBackend } }；defaultBackend===null 表示删除该字段。
// 无依赖纯函数，便于 scripts/test.mjs 直接 import；stores/cluster.js 的 updateIngressRules 复用本函数。
export function buildIngressRulesPatch(flatRules = [], defaultBackend = null) {
  const byHost = new Map()
  for (const r of flatRules) {
    const host = r.host || ''
    if (!byHost.has(host)) byHost.set(host, [])
    byHost.get(host).push({
      path: r.path || '/',
      pathType: r.pathType || 'Prefix',
      backend: { service: { name: r.serviceName || '', port: { number: Number(r.servicePort) || 80 } } },
    })
  }
  const rules = Array.from(byHost.entries()).map(([host, paths]) => ({ host, http: { paths } }))
  let db = null
  if (defaultBackend && defaultBackend.enabled && defaultBackend.serviceName) {
    db = { service: { name: defaultBackend.serviceName, port: { number: Number(defaultBackend.servicePort) || 80 } } }
  }
  return { spec: { rules, defaultBackend: db } }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `node scripts/test.mjs`
Expected: PASS（末尾 `✓ N/N 用例全部通过`）。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useIngressRules.js scripts/test.mjs
git commit -m "feat(ingress): 抽 buildIngressRulesPatch 纯函数 + 契约测试"
```

---

### Task 2: store 暴露 defaultBackend + updateIngressRules 复用纯函数

**Files:**
- Modify: `src/stores/cluster.js`（顶部 import；`mapIngress` ~1841；`updateIngressRules` ~548）

**Interfaces:**
- Consumes: `buildIngressRulesPatch`（Task 1）。
- Produces: `mapIngress` 返回对象新增 `defaultBackend: {serviceName, servicePort} | null`；`updateIngressRules(name, ns, flatRules, defaultBackend = null)`（新增第 4 参数），远端一次 PATCH `{spec:{rules, defaultBackend}}`。

- [ ] **Step 1: 引入纯函数**

在 `src/stores/cluster.js` 顶部 `@/composables/...` import 段追加（与其它 composable import 同段）：

```js
import { buildIngressRulesPatch } from '@/composables/useIngressRules'
```

- [ ] **Step 2: mapIngress 加 defaultBackend 字段**

把 `src/stores/cluster.js` 中 `const mapIngress = item => ({ ... })`（约 1841 行）整体替换为：

```js
  const mapIngress = item => {
    const spec = item.spec || {}
    const dbs = spec.defaultBackend?.service
    const defaultBackend = dbs ? { serviceName: dbs.name || '', servicePort: String(dbs.port?.number ?? dbs.port?.name ?? '') } : null
    return {
      name: item.metadata?.name,
      namespace: item.metadata?.namespace,
      className: spec.ingressClassName || '',
      hosts: (spec.rules || []).map(r => r.host).filter(Boolean).join(','),
      rules: spec.rules || [],
      defaultBackend,
      tls: Boolean(spec.tls?.length),
      tlsSecret: spec.tls?.[0]?.secretName || '',
      age: ageOf(item.metadata?.creationTimestamp),
      labels: item.metadata?.labels || {},
      annotations: item.metadata?.annotations || {},
    }
  }
```

- [ ] **Step 3: updateIngressRules 扩展签名 + 复用纯函数**

把 `src/stores/cluster.js` 中 `async function updateIngressRules(name, ns, flatRules) { ... }`（约 548 行，到对应 `}` 结束，含本地 `updateIngress(...)` 调用）整体替换为：

```js
  // 结构化编辑 Ingress 路由规则：入参 flatRules + defaultBackend，
  // 用 buildIngressRulesPatch 构造 PATCH body（rules + defaultBackend 一次提交）；
  // defaultBackend===null 时 merge-patch 删除该字段。本地合并 rules/defaultBackend/hosts。
  async function updateIngressRules(name, ns, flatRules, defaultBackend = null) {
    const patch = buildIngressRulesPatch(flatRules, defaultBackend)
    const rules = patch.spec.rules
    const db = patch.spec.defaultBackend
    if (remoteMode.value) {
      await api.k8s(`/apis/networking.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/ingresses/${encodeURIComponent(name)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify(patch),
      })
    }
    updateIngress(name, ns, { rules, defaultBackend: db, hosts: rules.map(r => r.host).filter(Boolean).join(',') })
  }
```

- [ ] **Step 4: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误（仅 pre-existing chunk-size 提示）。

- [ ] **Step 5: 提交**

```bash
git add src/stores/cluster.js
git commit -m "feat(ingress): mapIngress 暴露 defaultBackend + updateIngressRules 复用纯函数"
```

---

### Task 3: NsIngressDetail 编辑器全量重写（分组卡片 + 校验 + defaultBackend + 操作）

**Files:**
- Modify: `src/views/NsIngressDetail.vue`（script 的 rules 编辑段约 64-93；template 的 Edit Rules Modal 约 410-451）

**Interfaces:**
- Consumes: `store.updateIngressRules(name, ns, flatRules, defaultBackend)`（Task 2，新第 4 参数）、`store.nsServices`、`store.getServiceByName`、`ing.defaultBackend`（Task 2）、`PortSelect`。
- Produces: 重写后的编辑器（`editModel` 分组模型、`errors` computed、host/path 操作函数）。

**Discipline:** 只替换两段（script rules 编辑段、Edit Rules Modal）。**不触碰**详情页展示区（rulesByHost 渲染、Hero、右列面板）、不触碰其它 Modal（Annotation/Label/Class/TLS/Delete）。注意：Task 2 之后 `updateIngressRules` 多了第 4 参数，本任务调用处必须传入 `editModel.defaultBackend`。

- [ ] **Step 1: 替换 script 的 rules 编辑段**

把 `src/views/NsIngressDetail.vue` 中从 `// === Rules 结构化编辑（远端 PATCH spec.rules）===` 到对应 `saveRules` 函数结束的 `}`（约 64-93 行，含 `showRulesModal`/`editRules`/`pathTypeOptions`/`nsServiceNames`/`portsFor`/`openRulesEditor`/`addRule`/`removeRule`/`saveRules`）整体替换为：

```js
// === Rules 结构化编辑（按 host 分组 + defaultBackend + 校验 + 操作）===
const showRulesModal = ref(false)
const pathTypeOptions = ['Prefix', 'Exact', 'ImplementationSpecific']
// 当前 ns Service 名候选（serviceName 下拉）
const nsServiceNames = computed(() => store.nsServices.map(s => s.name))
// 按行 serviceName 取其暴露端口（servicePort 下拉）
function portsFor(serviceName) {
  const svc = store.getServiceByName(serviceName, route.params.namespace)
  return (svc?.portList || []).map(p => p.port)
}
// 编辑模型：host 分组 + defaultBackend（告别平铺 editRules）
const editModel = ref({ hosts: [], defaultBackend: { enabled: false, serviceName: '', servicePort: '' } })

function openRulesEditor() {
  const byHost = {}
  for (const r of allRules.value) {
    const h = r.host || ''
    ;(byHost[h] ||= []).push({ path: r.path || '/', pathType: r.pathType || 'Prefix', serviceName: r.serviceName || '', servicePort: String(r.servicePort ?? '') })
  }
  const hosts = Object.entries(byHost).map(([host, paths]) => ({ host, paths }))
  if (!hosts.length) hosts.push({ host: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }] })
  const db = ing.value?.defaultBackend
  editModel.value = {
    hosts,
    defaultBackend: db && db.serviceName
      ? { enabled: true, serviceName: db.serviceName, servicePort: db.servicePort }
      : { enabled: false, serviceName: '', servicePort: '' },
  }
  showRulesModal.value = true
}
// host / path 增删
function addHost() { editModel.value.hosts.push({ host: '', paths: [{ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }] }) }
function removeHost(hi) { editModel.value.hosts.splice(hi, 1) }
function addPath(hi) { editModel.value.hosts[hi].paths.push({ path: '/', pathType: 'Prefix', serviceName: '', servicePort: '80' }) }
function removePath(hi, i) { editModel.value.hosts[hi].paths.splice(i, 1) }
// 复制 / 上下移
function duplicateHost(hi) {
  const h = editModel.value.hosts[hi]
  editModel.value.hosts.splice(hi + 1, 0, { host: h.host ? h.host + '-copy' : '', paths: h.paths.map(p => ({ ...p })) })
}
function moveHost(hi, dir) {
  const j = hi + dir
  if (j < 0 || j >= editModel.value.hosts.length) return
  const a = editModel.value.hosts, t = a[hi]; a[hi] = a[j]; a[j] = t
}
function duplicatePath(hi, i) {
  editModel.value.hosts[hi].paths.splice(i + 1, 0, { ...editModel.value.hosts[hi].paths[i] })
}
function movePath(hi, i, dir) {
  const paths = editModel.value.hosts[hi].paths, j = i + dir
  if (j < 0 || j >= paths.length) return
  const t = paths[i]; paths[i] = paths[j]; paths[j] = t
}
const showClearConfirm = ref(false)
function clearAll() {
  editModel.value.hosts = []
  editModel.value.defaultBackend = { enabled: false, serviceName: '', servicePort: '' }
  showClearConfirm.value = false
}
// 校验：错误列表，用于顶部汇总 + 行标红 + Save 禁用
const errors = computed(() => {
  const errs = []
  editModel.value.hosts.forEach((h, hi) => {
    const seen = {}
    h.paths.forEach((p, i) => {
      const loc = `host[${hi}].path[${i}]`
      if (!p.path) errs.push({ loc, field: 'path', msg: 'path 必填' })
      else if (!p.path.startsWith('/')) errs.push({ loc, field: 'path', msg: `path 须以 / 开头（${p.path}）` })
      else { if (seen[p.path]) errs.push({ loc: `host[${hi}]`, field: 'path', msg: `重复 path「${p.path}」` }); seen[p.path] = true }
      if (!p.serviceName) errs.push({ loc, field: 'serviceName', msg: 'service 必填' })
      if (!p.servicePort) errs.push({ loc, field: 'servicePort', msg: 'port 必填' })
      else if (isNaN(Number(p.servicePort))) errs.push({ loc, field: 'servicePort', msg: `port 须为数字（${p.servicePort}）` })
    })
  })
  const db = editModel.value.defaultBackend
  if (db.enabled) {
    if (!db.serviceName) errs.push({ loc: 'defaultBackend', field: 'serviceName', msg: '默认后端 service 必填' })
    if (!db.servicePort) errs.push({ loc: 'defaultBackend', field: 'servicePort', msg: '默认后端 port 必填' })
    else if (isNaN(Number(db.servicePort))) errs.push({ loc: 'defaultBackend', field: 'servicePort', msg: '默认后端 port 须为数字' })
  }
  return errs
})
function fieldError(hi, i, field) {
  return errors.value.find(e => e.loc === `host[${hi}].path[${i}]` && e.field === field)
}
async function saveRules() {
  if (errors.value.length) return
  const flat = editModel.value.hosts.flatMap(h => h.paths.map(p => ({ host: h.host, path: p.path, pathType: p.pathType, serviceName: p.serviceName, servicePort: p.servicePort })))
  try {
    await store.updateIngressRules(route.params.name, route.params.namespace, flat, editModel.value.defaultBackend)
    showRulesModal.value = false
  } catch (e) { notify('error', e.message || '保存规则失败') }
}
```

- [ ] **Step 2: 替换 Edit Rules Modal 模板**

把 `src/views/NsIngressDetail.vue` 中从 `<!-- Edit Rules Modal -->` 到该 Modal 结束的 `</Modal>`（约 410-451 行）整体替换为：

```html
  <!-- Edit Rules Modal -->
  <Modal v-model="showRulesModal" title="Edit Routing Rules" width="max-w-4xl">
    <p class="text-body-sm text-on-surface-variant mb-md">编辑路由规则，保存后写回 Ingress <span class="font-mono">{{ route.params.name }}</span>（等同 <code class="font-mono text-code-sm bg-surface-container-low px-1 rounded">kubectl patch ingress</code>）。</p>

    <!-- 校验错误汇总 -->
    <div v-if="errors.length" class="mb-md rounded-lg border border-error/40 bg-error-container/10 p-sm">
      <div class="flex items-center gap-xs text-error text-body-sm font-medium mb-xs"><span class="material-symbols-outlined text-base">error</span>{{ errors.length }} 处问题，修复后可保存</div>
      <ul class="text-xs text-error/80 space-y-0.5 list-disc list-inside">
        <li v-for="(e, ei) in errors" :key="ei"><span class="font-mono">{{ e.loc }}</span>：{{ e.msg }}</li>
      </ul>
    </div>

    <!-- 默认后端（开关式卡片，默认收起）-->
    <div class="rounded-lg border border-outline-variant p-sm mb-md">
      <label class="flex items-center gap-sm cursor-pointer">
        <input v-model="editModel.defaultBackend.enabled" type="checkbox" class="h-4 w-4 accent-primary" />
        <span class="text-body-sm font-medium">启用默认后端 <code class="font-mono text-xs text-on-surface-variant">spec.defaultBackend</code></span>
      </label>
      <div v-if="editModel.defaultBackend.enabled" class="grid grid-cols-2 gap-sm mt-sm">
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Service</label>
          <PortSelect v-model="editModel.defaultBackend.serviceName" :options="nsServiceNames" placeholder="my-svc" empty-hint="暂无 Service，可直接输入" input-class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" />
        </div>
        <div>
          <label class="text-label-caps text-on-surface-variant block mb-xs">Port</label>
          <PortSelect v-model="editModel.defaultBackend.servicePort" :options="portsFor(editModel.defaultBackend.serviceName)" placeholder="80" empty-hint="选 Service 后显示端口" input-class="w-full bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" />
        </div>
      </div>
    </div>

    <!-- host 分组卡片 -->
    <div class="flex flex-col gap-sm">
      <div v-for="(h, hi) in editModel.hosts" :key="hi" class="rounded-lg border border-outline-variant overflow-hidden">
        <div class="px-sm py-1.5 bg-surface-container-low flex items-center gap-xs">
          <span class="material-symbols-outlined text-primary text-base">language</span>
          <input v-model="h.host" class="flex-1 min-w-0 bg-surface-container-lowest border border-outline-variant rounded px-sm py-1 text-body-sm font-mono" placeholder="app.example.com（留空=通配）" />
          <span class="text-[10px] text-on-surface-variant shrink-0">{{ h.paths.length }} path</span>
          <div class="flex items-center gap-0.5 shrink-0">
            <button @click="moveHost(hi, -1)" :disabled="hi === 0" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" title="上移 host"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
            <button @click="moveHost(hi, 1)" :disabled="hi === editModel.hosts.length - 1" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" title="下移 host"><span class="material-symbols-outlined text-base">arrow_downward</span></button>
            <button @click="duplicateHost(hi)" class="p-0.5 text-on-surface-variant hover:text-primary rounded" title="复制 host"><span class="material-symbols-outlined text-base">content_copy</span></button>
            <button @click="removeHost(hi)" class="p-0.5 text-on-surface-variant hover:text-error rounded" title="删除 host"><span class="material-symbols-outlined text-base">delete</span></button>
          </div>
        </div>
        <div class="p-sm flex flex-col gap-xs">
          <div v-for="(p, i) in h.paths" :key="i" class="flex gap-xs items-center flex-wrap">
            <input v-model="p.path" :class="['w-28 bg-surface-container-low border rounded px-sm py-1 text-body-sm font-mono', fieldError(hi, i, 'path') ? 'border-error' : 'border-outline-variant']" placeholder="/" />
            <select v-model="p.pathType" class="bg-surface-container-low border border-outline-variant rounded px-sm py-1 text-body-sm">
              <option v-for="t in pathTypeOptions" :key="t" :value="t">{{ t }}</option>
            </select>
            <PortSelect v-model="p.serviceName" :options="nsServiceNames" placeholder="my-svc" empty-hint="暂无 Service，可直接输入" :input-class="['w-32 bg-surface-container-low border rounded px-sm py-1 text-body-sm font-mono', fieldError(hi, i, 'serviceName') ? 'border-error' : 'border-outline-variant'].join(' ')" />
            <PortSelect v-model="p.servicePort" :options="portsFor(p.serviceName)" placeholder="80" empty-hint="选 Service 后显示端口" :input-class="['w-20 bg-surface-container-low border rounded px-sm py-1 text-body-sm font-mono', fieldError(hi, i, 'servicePort') ? 'border-error' : 'border-outline-variant'].join(' ')" />
            <div class="flex items-center gap-0.5 shrink-0">
              <button @click="movePath(hi, i, -1)" :disabled="i === 0" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" title="上移 path"><span class="material-symbols-outlined text-base">arrow_upward</span></button>
              <button @click="movePath(hi, i, 1)" :disabled="i === h.paths.length - 1" class="p-0.5 text-on-surface-variant hover:text-primary disabled:opacity-30 rounded" title="下移 path"><span class="material-symbols-outlined text-base">arrow_downward</span></button>
              <button @click="duplicatePath(hi, i)" class="p-0.5 text-on-surface-variant hover:text-primary rounded" title="复制 path"><span class="material-symbols-outlined text-base">content_copy</span></button>
              <button @click="removePath(hi, i)" class="p-0.5 text-on-surface-variant hover:text-error rounded" title="删除 path"><span class="material-symbols-outlined text-base">delete</span></button>
            </div>
          </div>
          <button @click="addPath(hi)" class="self-start flex items-center gap-xs px-sm py-xs text-body-sm text-primary hover:bg-primary-container/10 rounded">
            <span class="material-symbols-outlined text-sm">add</span> 加 path
          </button>
        </div>
      </div>
      <div v-if="!editModel.hosts.length" class="text-center text-on-surface-variant text-body-sm py-md">无 host，点击下方添加</div>
    </div>

    <div class="flex items-center gap-sm mt-md">
      <button @click="addHost" class="flex items-center gap-xs px-md py-xs border border-dashed border-outline-variant rounded-lg text-body-sm text-on-surface-variant hover:bg-surface-container-low">
        <span class="material-symbols-outlined text-sm">add</span> 加 host
      </button>
      <button @click="showClearConfirm = true" :disabled="!editModel.hosts.length && !editModel.defaultBackend.enabled" class="ml-auto flex items-center gap-xs px-md py-xs text-body-sm text-error hover:bg-error-container/10 rounded-lg disabled:opacity-40">
        <span class="material-symbols-outlined text-sm">delete_sweep</span> 清空全部
      </button>
    </div>

    <template #actions>
      <button @click="showRulesModal = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">Cancel</button>
      <button @click="saveRules" :disabled="errors.length > 0" class="px-md py-sm bg-primary text-on-primary rounded-lg text-body-md font-semibold hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed">Save Rules</button>
    </template>
  </Modal>

  <!-- 清空全部确认 -->
  <Modal v-model="showClearConfirm" title="清空全部规则" width="max-w-md">
    <p class="text-body-md text-on-surface-variant">将清除所有 host 规则与默认后端设置（保存前不会写回 Ingress）。</p>
    <template #actions>
      <button @click="showClearConfirm = false" class="px-md py-sm border border-outline-variant rounded-lg text-body-md hover:bg-surface-container-high">取消</button>
      <button @click="clearAll" class="px-md py-sm bg-error text-error rounded-lg text-body-md font-semibold hover:opacity-90">清空</button>
    </template>
  </Modal>
```

- [ ] **Step 3: typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: 无新增错误（仅 pre-existing chunk-size 提示）。若 build 报 `editRules`/`addRule`/`removeRule` 未定义，说明 Step 2 模板里仍残留旧引用——回查替换是否完整。

- [ ] **Step 4: 手动验证清单（无 GUI 运行时则跳过，由 controller/用户后续验证）**

`npm run dev` 登录进某 Ingress 详情 → 点「编辑规则」：
- 弹窗按 host 分组展示；host 卡片内可加/删/复制/上下移 path；host 之间可加/删/复制/上下移；清空全部（二次确认）。
- 默认后端开关：启用→编辑 service/port；关闭→保存后远端 defaultBackend 被删。
- 校验：空 service/port、path 非 `/` 开头、同 host 重复 path → 顶部汇总 + 行标红 + Save 禁用。
- 保存后重新打开编辑器：分组与 defaultBackend 正确回填。

- [ ] **Step 5: 提交**

```bash
git add src/views/NsIngressDetail.vue
git commit -m "feat(ingress): Edit Rules 重构为 host 分组卡片 + 校验 + defaultBackend + 操作"
```

---

## Self-Review（计划编写后自检，已修正）

- **Spec coverage**：① host 分组编辑（Task 3 editModel/UI）② 严格校验+阻断（Task 3 errors computed + Save disabled + 汇总 + 行标红）③ defaultBackend（Task 1 纯函数 + Task 2 store map/update + Task 3 开关卡片）④ 更多操作（Task 3 duplicate/move/clear）⑤ 上下移按钮无拖拽库（Global Constraints）——全覆盖。
- **Placeholder scan**：无 TBD/TODO；每个代码步骤含可执行 old/new。
- **Type consistency**：`buildIngressRulesPatch`（Task 1）签名 → store `updateIngressRules(name, ns, flatRules, defaultBackend=null)`（Task 2）→ 组件 `saveRules` 调用传 `editModel.defaultBackend`（Task 3）；`mapIngress.defaultBackend = {serviceName, servicePort}|null` → 组件 `openRulesEditor` 读 `ing.defaultBackend`、`editModel.defaultBackend = {enabled, serviceName, servicePort}` → `saveRules` 传给 store。字段名一致。
- **defaultBackend null 语义**：Task 1 纯函数返回 `defaultBackend: null`（删除），Task 2 PATCH body 含 null（merge-patch 删除），一致。
- **不越界**：Task 3 仅替换 script rules 段 + Edit Rules Modal，不碰详情页展示/其它 Modal（Discipline 明示）。
