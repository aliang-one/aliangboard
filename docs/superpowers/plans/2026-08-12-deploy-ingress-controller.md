# 部署 Ingress 控制器(预设模板)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在平台 `IngressClasses.vue` 一键部署 ingress 控制器(nginx-ingress / traefik / haproxy / kong),装完新 IngressClass 真实可用、出现在所有创建表单下拉。

**Architecture:** 服务端打包各控制器官方清单(`server/manifests/ingress-controllers/<id>.yaml`)+ catalog 元数据,提供 2 个 GET 端点(列 catalog、回清单文本);前端 `DeployIngressControllerDialog` 选控制器 → 清单进 YamlEditor 可微调 → RBAC 预检 → 复用 `POST /api/apply` 多文档 server-side apply → 逐资源进度 → 失效 IngressClass Vue Query key。

**Tech Stack:** Node gateway(`server/index.mjs`,`node --test`)、Vue 3 + Vite + Pinia + @tanstack/vue-query、vitest + @vue/test-utils、js-yaml、i18n(zh/en)。

## Global Constraints

- **依赖政策**:仓库默认不新增外部依赖(CLAUDE.md)。本功能用到的 `js-yaml`(已用)、`node:fs/path`(内置)、`@vue/test-utils`+`vitest`(已登记例外)均已就位 —— **不引新依赖**。
- **测试三轨**:`scripts/test.mjs`(零依赖运行器,纯逻辑)+ `node --test server/*.test.mjs`(服务端)+ `npm run test:unit`(vitest 前端)。`npm run typecheck`(`node --check` .js/.mjs)+ `npm run i18n:check`(残存中文/键对齐/引用键缺失)为门禁。
- **i18n**:所有用户可见串走 i18n,zh/en 两份同步、键对齐、点分路径正确(注意命名空间层级,如 `ns.ingress` ≠ `ns.ingressDetail`)。
- **本仓库 worktree**:`.claude/worktrees/feat+next`(分支 `worktree-feat+next`);所有命令在此目录跑。
- **清单为「拉取的官方资产」约定**:本计划不逐字复制 700+ 行官方清单(那既不现实也会失真)。凡「创建 `<id>.yaml`」步骤 = 用给定的**精确 URL + 版本** `curl` 拉取官方 bare-metal/NodePort 变体、原样落盘,随后由 **manifest 有效性门禁测试**校验(可解析、资源数 ≥4、含 IngressClass 且 `spec.controller` 与 catalog 一致)。URL/version 落到 catalog 的 `source`/`version` 字段。这不是占位符,是可验证的拉取指令。

参考 spec:`docs/superpowers/specs/2026-08-12-deploy-ingress-controller-design.md`(commit 6647363)。

---

## 文件结构

**新建**
- `server/manifests/ingress-controllers/catalog.mjs` — 4 控制器元数据(纯 ES 模块,可被测试直 import)。
- `server/manifests/ingress-controllers/nginx-ingress.yaml` / `traefik.yaml` / `haproxy.yaml` / `kong.yaml` — 官方清单(拉取落盘)。
- `server/ingress-controller-templates.mjs` — 服务端纯函数 `listControllerTemplates()` / `readControllerManifest(id)`。
- `server/ingress-controller-templates.test.mjs` — `node --test`:catalog 完整性 + 清单有效性门禁 + helper 行为。
- `src/components/common/DeployIngressControllerDialog.vue` — 部署弹窗(选 → 编辑 → 预检 → apply → 进度)。
- `src/components/common/__tests__/DeployIngressControllerDialog.test.js` — vitest 组件测试。

**修改**
- `server/index.mjs` — 加 2 个 GET 端点。
- `src/api/client.js` — 加 `ingressControllers.catalog()` / `.manifest(id)`。
- `src/views/IngressClasses.vue` — 加「部署控制器」按钮 + 挂弹窗 + applied 后失效 query。
- `src/locales/zh.json` / `en.json` — `ingressController.*` 键。

---

## Task 1: 服务端地基 — catalog + nginx-ingress 清单 + helper + 测试(P1 脊柱)

**Files:**
- Create: `server/manifests/ingress-controllers/catalog.mjs`
- Create: `server/manifests/ingress-controllers/nginx-ingress.yaml`
- Create: `server/ingress-controller-templates.mjs`
- Test: `server/ingress-controller-templates.test.mjs`

**Interfaces:**
- Produces: `listControllerTemplates()` → 数组(不含 `file` 内部字段);`readControllerManifest(id)` → 清单文本字符串,未知 id 抛 `/未知/`。`INGRESS_CONTROLLER_TEMPLATES`(catalog.mjs 导出)为真相源。

- [ ] **Step 1: 拉取 nginx-ingress 官方清单落盘**

ingress-nginx bare-metal NodePort 变体(无云 LB 依赖)。确认 URL 返回 200,钉版本写进 catalog。

```bash
curl -fsSL https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/baremetal/deploy.yaml \
  -o server/manifests/ingress-controllers/nginx-ingress.yaml
test -s server/manifests/ingress-controllers/nginx-ingress.yaml && echo OK
```

> 若该 tag/路径 404:去 https://github.com/kubernetes/ingress-nginx/tree/main/deploy/static/provider 找当前 baremetal `deploy.yaml` 的 pin-able tag,替换 URL,把最终 tag 填进下面 catalog 的 `version`/`source`。门禁测试会校验内容结构。

- [ ] **Step 2: 写 catalog.mjs(先只 nginx-ingress 一条,P2 再加)**

```js
// server/manifests/ingress-controllers/catalog.mjs
// 部署 Ingress 控制器的官方清单目录(打包静态资产)。清单 <id>.yaml 从官方钉版本拉取,
// catalog 记元数据。纯 ES 模块:server/ingress-controller-templates.mjs 与 server *.test.mjs 均可直 import。
export const INGRESS_CONTROLLER_TEMPLATES = [
  {
    id: 'nginx-ingress',
    labelKey: 'ingressController.nginx-ingress.label',
    descKey: 'ingressController.nginx-ingress.desc',
    notesKey: 'ingressController.nginx-ingress.notes',
    version: 'controller-v1.12.1',                 // 与上方拉取 tag 一致
    source: 'https://raw.githubusercontent.com/kubernetes/ingress-nginx/controller-v1.12.1/deploy/static/provider/baremetal/deploy.yaml',
    variant: 'bare-metal NodePort',
    controller: 'k8s.io/ingress-nginx',            // 必须等于清单内 IngressClass.spec.controller
    defaultClassName: 'nginx',
    file: 'nginx-ingress.yaml',
  },
]

export function findControllerTemplate(id) {
  return INGRESS_CONTROLLER_TEMPLATES.find(t => t.id === id) || null
}
```

- [ ] **Step 3: 写 helper(被端点复用)**

```js
// server/ingress-controller-templates.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INGRESS_CONTROLLER_TEMPLATES, findControllerTemplate } from './manifests/ingress-controllers/catalog.mjs'

const MANIFEST_DIR = join(import.meta.dirname, 'manifests', 'ingress-controllers')

// 给前端用:剥离 file 内部字段
export function listControllerTemplates() {
  return INGRESS_CONTROLLER_TEMPLATES.map(({ file, ...rest }) => rest)
}

export function readControllerManifest(id) {
  const t = findControllerTemplate(id)
  if (!t) throw new Error(`未知 ingress 控制器模板: ${id}`)
  return readFileSync(join(MANIFEST_DIR, t.file), 'utf8')
}
```

- [ ] **Step 4: 写失败测试**

```js
// server/ingress-controller-templates.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { loadAll as yamlLoadAll } from 'js-yaml'
import { INGRESS_CONTROLLER_TEMPLATES } from './manifests/ingress-controllers/catalog.mjs'
import { listControllerTemplates, readControllerManifest } from './ingress-controller-templates.mjs'

const REQUIRED = ['id', 'labelKey', 'descKey', 'version', 'source', 'variant', 'controller', 'defaultClassName', 'file']

test('catalog: 每条字段齐全 + id 唯一', () => {
  const ids = new Set()
  for (const t of INGRESS_CONTROLLER_TEMPLATES) {
    for (const k of REQUIRED) assert.ok(t[k], `catalog ${t.id} 缺字段 ${k}`)
    assert.ok(!ids.has(t.id), `重复 id: ${t.id}`); ids.add(t.id)
  }
})

test('listControllerTemplates: 不泄露 file 字段', () => {
  for (const t of listControllerTemplates()) assert.ok(!('file' in t), `list 不应含 file: ${t.id}`)
})

test('readControllerManifest: 未知 id 抛错', () => {
  assert.throws(() => readControllerManifest('no-such'), /未知/)
})

test('清单有效性门禁: 每条可解析 + 资源≥4 + 含 IngressClass 且 controller 一致', () => {
  for (const t of INGRESS_CONTROLLER_TEMPLATES) {
    const text = readControllerManifest(t.id)
    assert.match(text, new RegExp(t.controller), `${t.id}: 清单文本未含 controller 串 ${t.controller}`)
    const objs = []; yamlLoadAll(text, o => o && objs.push(o))
    assert.ok(objs.length >= 4, `${t.id}: 资源数 ${objs.length} < 4(疑似截断)`)
    const ics = objs.filter(o => o.kind === 'IngressClass')
    assert.ok(ics.length >= 1, `${t.id}: 清单未含 IngressClass`)
    for (const ic of ics) assert.equal(ic.spec?.controller, t.controller, `${t.id}: IngressClass.spec.controller 与 catalog 不一致`)
  }
})
```

- [ ] **Step 5: 跑测试,确认通过**

```bash
node --test server/ingress-controller-templates.test.mjs
npm run typecheck   # .mjs 语法
```
Expected: 4 tests PASS;typecheck ✓。

- [ ] **Step 6: Commit**

```bash
git add server/manifests/ingress-controllers/catalog.mjs server/manifests/ingress-controllers/nginx-ingress.yaml server/ingress-controller-templates.mjs server/ingress-controller-templates.test.mjs
git commit -m "feat(ingress-controller): catalog + nginx-ingress 清单 + 服务端 helper(含门禁测试)"
```

---

## Task 2: 服务端 2 个 GET 端点

**Files:**
- Modify: `server/index.mjs`(在 `handle()` 内,`/api/health` 等纯 GET 附近加 2 条)

**Interfaces:**
- Consumes: `listControllerTemplates()`, `readControllerManifest(id)`(Task 1)。
- Produces: `GET /api/ingress-controllers/catalog` → `{ templates: [...] }`;`GET /api/ingress-controllers/manifest/<id>` → `{ yaml }`,未知 id → 404。

- [ ] **Step 1: 加导入**

在 `server/index.mjs` 顶部 import 区(挨着其它 server 端模块 import)加:

```js
import { listControllerTemplates, readControllerManifest } from './ingress-controller-templates.mjs'
```

- [ ] **Step 2: 加 2 条 GET 路由**

在 `handle(req, res)` 内,`/api/health` 这类无鉴权 GET 附近加(catalog/清单是平台内置静态资产,不需 K8s session;但清单 apply 仍走需 session 的 `/api/apply`):

```js
if (req.method === 'GET' && url.pathname === '/api/ingress-controllers/catalog') {
  return sendJson(res, 200, { templates: listControllerTemplates() })
}
const manifestMatch = req.method === 'GET' && url.pathname.startsWith('/api/ingress-controllers/manifest/')
if (manifestMatch) {
  const id = decodeURIComponent(url.pathname.slice('/api/ingress-controllers/manifest/'.length))
  try { return sendJson(res, 200, { yaml: readControllerManifest(id) }) }
  catch (e) { return sendJson(res, 404, { message: e?.message || '未知模板' }) }
}
```

> `sendJson` 与 `url`(URL 对象,`url.pathname`)是 `handle` 内既有变量,沿用即可(范式见 `/api/health`、`/api/resource/tree`)。

- [ ] **Step 3: 起服手测**

```bash
node server/index.mjs &
SERVER_PID=$!
sleep 1
curl -s http://127.0.0.1:3000/api/ingress-controllers/catalog | head -c 300
echo
curl -s http://127.0.0.1:3000/api/ingress-controllers/manifest/nginx-ingress | head -c 200
echo
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3000/api/ingress-controllers/manifest/nope   # 期望 404
kill $SERVER_PID
```
Expected: catalog JSON 含 nginx-ingress 条目;manifest 返回 YAML 头;`nope` → 404。(端口若非 3000,按 `PORT` env 调整。)

- [ ] **Step 4: Commit**

```bash
git add server/index.mjs
git commit -m "feat(ingress-controller): GET /api/ingress-controllers/{catalog,manifest/:id}"
```

---

## Task 3: 前端 api/client 方法

**Files:**
- Modify: `src/api/client.js`(在 `api` 对象内,挨着 `applyYaml`)

**Interfaces:**
- Produces: `api.ingressControllers.catalog()` → `GET /api/ingress-controllers/catalog`;`api.ingressControllers.manifest(id)` → `GET /api/ingress-controllers/manifest/<id>`。

- [ ] **Step 1: 加方法**

```js
// src/api/client.js —— api 对象内(与 applyYaml 同级)加:
  ingressControllers: {
    catalog: () => k8sHttp.request('/api/ingress-controllers/catalog'),
    manifest: id => k8sHttp.request(`/api/ingress-controllers/manifest/${encodeURIComponent(id)}`),
  },
```

> `k8sHttp.request` 自动带 session token(范式见 `applyYaml: yaml => k8sHttp.request('/api/apply', ...)`)。

- [ ] **Step 2: 跑类型 + 模块挂载门禁**

```bash
npm run typecheck
npx vitest run src/__tests__/_allModulesImport.test.js
```
Expected: typecheck ✓;模块导入测试 PASS(client.js 仍可 import)。

- [ ] **Step 3: Commit**

```bash
git add src/api/client.js
git commit -m "feat(ingress-controller): api/client 加 ingressControllers.catalog/manifest"
```

---

## Task 4: DeployIngressControllerDialog —— 选控制器 + 载入编辑器(前端 TDD 上半)

**Files:**
- Create: `src/components/common/DeployIngressControllerDialog.vue`
- Test: `src/components/common/__tests__/DeployIngressControllerDialog.test.js`

**Interfaces:**
- Consumes: `api.ingressControllers.catalog/manifest`(Task 3);`YamlEditor`(`@/components/common/YamlEditor.vue`,v-model 文本)。
- Produces: props `modelValue: Boolean`;emits `update:modelValue`、`applied`(Task 5 才发)。内部 `pickedId` ref + `yaml` ref。

- [ ] **Step 1: 写失败组件测试(渲染 + 选控制器载入清单)**

```js
// src/components/common/__tests__/DeployIngressControllerDialog.test.js
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: {
    ingressControllers: {
      catalog: vi.fn(async () => ({ templates: [
        { id: 'nginx-ingress', labelKey: 'ingressController.nginx-ingress.label', version: 'v1', variant: 'bare-metal', controller: 'k8s.io/ingress-nginx', defaultClassName: 'nginx' },
      ] })),
      manifest: vi.fn(async () => ({ yaml: 'apiVersion: v1\nkind: ServiceAccount\nmetadata:\n  name: nginx\n' })),
      applyYaml: vi.fn(async () => ({ applied: [], failed: [], total: 0 })),
    },
    k8s: vi.fn(async () => ({ status: { allowed: true } })),
  },
}))
vi.mock('@/stores/cluster', () => ({
  useClusterStore: () => ({ currentCluster: 'demo', checkAccessServer: vi.fn(async () => ({ allowed: true })) }),
}))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import DeployIngressControllerDialog from '../DeployIngressControllerDialog.vue'

function mountDlg() {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return mount(DeployIngressControllerDialog, {
    props: { modelValue: true },
    global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { YamlEditor: true, Modal: true } },
  })
}

test('打开即拉 catalog 并渲染控制器卡片', async () => {
  const w = mountDlg()
  await flushPromises()
  expect(w.text()).toContain('nginx-ingress')
})

test('选控制器后载入清单到编辑器(props.manifest 调用一次)', async () => {
  const { api } = await import('@/api/client')
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  expect(api.ingressControllers.manifest).toHaveBeenCalledWith('nginx-ingress')
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/components/common/__tests__/DeployIngressControllerDialog.test.js
```
Expected: FAIL(组件不存在)。

- [ ] **Step 3: 写最小组件(上半:catalog + 选 + 载入)**

```vue
<script setup>
// src/components/common/DeployIngressControllerDialog.vue
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api/client'
import Modal from '@/components/common/Modal.vue'
import YamlEditor from '@/components/common/YamlEditor.vue'

const props = defineProps({ modelValue: { type: Boolean, default: false } })
const emit = defineEmits(['update:modelValue', 'applied'])
const { t } = useI18n()

const templates = ref([])
const pickedId = ref('')
const yaml = ref('')
const loading = ref(false)

watch(() => props.modelValue, async (open) => {
  if (!open || templates.value.length) return
  const r = await api.ingressControllers.catalog()
  templates.value = r.templates || []
}, { immediate: true })

async function pick(tpl) {
  pickedId.value = tpl.id
  loading.value = true
  try { const r = await api.ingressControllers.manifest(tpl.id); yaml.value = r.yaml }
  finally { loading.value = false }
}
function close() { emit('update:modelValue', false) }
</script>

<template>
  <Modal :model-value="modelValue" @update:model-value="close" :title="t('ingressController.dialogTitle')" width="max-w-3xl">
    <div v-if="!pickedId" class="grid grid-cols-2 gap-md">
      <button v-for="tpl in templates" :key="tpl.id" data-testid="controller-card"
        class="text-left border border-outline-variant rounded-lg p-md hover:border-primary"
        @click="pick(tpl)">
        <div class="font-semibold">{{ t(tpl.labelKey) }}</div>
        <div class="text-xs text-on-surface-variant">{{ tpl.version }} · {{ tpl.variant }}</div>
      </button>
    </div>
    <div v-else>
      <YamlEditor v-model="yaml" />
    </div>
  </Modal>
</template>
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/components/common/__tests__/DeployIngressControllerDialog.test.js
```
Expected: 2 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/common/DeployIngressControllerDialog.vue src/components/common/__tests__/DeployIngressControllerDialog.test.js
git commit -m "feat(ingress-controller): 部署弹窗 —— catalog 选择 + 清单载入编辑器"
```

---

## Task 5: 弹窗 —— RBAC 预检 + apply + 进度 + applied(前端 TDD 下半)

**Files:**
- Modify: `src/components/common/DeployIngressControllerDialog.vue`
- Modify: `src/components/common/__tests__/DeployIngressControllerDialog.test.js`

**Interfaces:**
- Consumes: `useClusterStore().checkAccessServer({verb,resource,namespace})` → `{allowed}`;`api.applyYaml(yaml)` → 服务端原始 `{ resources, applied, failed, total }`(注意:**直接调 api.applyYaml 拿逐资源明细**,不走 useResourceApply 的汇总态);`useQueryClient` 失效 `['cluster', cid, 'ingressclasses']`。
- Produces: emits `applied` 当有资源成功。

- [ ] **Step 1: 加失败测试(RBAC 预检 + apply 进度 + applied emit)**

在 Task 4 测试文件追加:

```js
test('RBAC 预检: 全部允许时显示通过(选控制器后自动跑)', async () => {
  // 默认 store mock 的 checkAccessServer 全部 allowed:true(Task 4 mock)
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()   // pick → checkRbac 完成
  expect(w.text()).toContain('RBAC 预检通过')   // ingressController.rbacOk 的 zh 文案
})

test('apply: 回 applied/failed/total,有成功则 emit applied', async () => {
  const { api } = await import('@/api/client')
  api.ingressControllers.manifest = vi.fn(async () => ({ yaml: 'apiVersion: v1\nkind: Namespace\nmetadata:\n  name: x\n' }))
  api.applyYaml = vi.fn(async () => ({ applied: [{ kind: 'Namespace', name: 'x' }], failed: [], total: 1 }))
  const w = mountDlg()
  await flushPromises()
  await w.find('[data-testid="controller-card"]').trigger('click')
  await flushPromises()
  await w.find('[data-testid="deploy-btn"]').trigger('click')
  await flushPromises()
  expect(api.applyYaml).toHaveBeenCalled()
  expect(w.emitted().applied).toBeTruthy()
  expect(w.text()).toContain('1/1')   // 进度摘要
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/components/common/__tests__/DeployIngressControllerDialog.test.js
```
Expected: 新 2 条 FAIL。

- [ ] **Step 3: 扩展组件(RBAC 预检 + apply + 进度)**

在 `<script setup>` 内(Task 4 基础上)追加:

```js
import { useClusterStore } from '@/stores/cluster'
import { useQueryClient } from '@tanstack/vue-query'
const store = useClusterStore()
const qc = useQueryClient()
const cid = () => store.currentCluster || 'cluster'

const REQUIRED_RBAC = [
  { resource: 'clusterroles' }, { resource: 'clusterrolebindings' },
  { resource: 'roles' }, { resource: 'rolebindings' },
  { resource: 'serviceaccounts' }, { resource: 'deployments' },
  { resource: 'services' }, { resource: 'configmaps' }, { resource: 'ingressclasses' },
].map(r => ({ ...r, verb: 'create', namespace: '' }))

const rbacMissing = ref([])
const rbacChecked = ref(false)
const applying = ref(false)
const result = ref(null)   // { applied, failed, total }

async function checkRbac() {
  const miss = []
  for (const attrs of REQUIRED_RBAC) {
    const r = await store.checkAccessServer(attrs)
    if (!r?.allowed) miss.push(attrs.resource)
  }
  rbacMissing.value = miss; rbacChecked.value = true
}

async function deploy() {
  applying.value = true; result.value = null
  try {
    const r = await api.applyYaml(yaml.value)        // 服务端原始 {applied,failed,total}
    result.value = r
    if ((r.applied || []).length) {
      emit('applied')
      qc.invalidateQueries({ queryKey: ['cluster', cid(), 'ingressclasses'] })
    }
  } finally { applying.value = false }
}
```

`pick()` 成功载入后调 `checkRbac()`;模板内编辑器下方加(伪代码示意结构,实现时按既有 Modal #footer/#actions slot 接按钮):

```vue
<!-- 编辑器下方 -->
<div data-testid="rbac-check" v-if="rbacChecked" class="text-body-sm">
  <span v-if="!rbacMissing.length">{{ t('ingressController.rbacOk') }}</span>
  <span v-else>{{ t('ingressController.rbacMissing') }}: {{ rbacMissing.join(', ') }}</span>
</div>
<template #actions>
  <button data-testid="deploy-btn" :disabled="applying" @click="deploy">
    {{ applying ? t('common.applying') : t('ingressController.deploy') }}
  </button>
</template>
<div v-if="result">
  {{ result.applied.length }}/{{ result.total }}
  <ul><li v-for="f in result.failed" :key="f.kind+f.name">{{ f.kind }}/{{ f.name }}: {{ f.error }}</li></ul>
</div>
```

- [ ] **Step 4: 跑测试确认通过**

```bash
npx vitest run src/components/common/__tests__/DeployIngressControllerDialog.test.js
```
Expected: 4 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/components/common/DeployIngressControllerDialog.vue src/components/common/__tests__/DeployIngressControllerDialog.test.js
git commit -m "feat(ingress-controller): 部署弹窗 —— RBAC 预检 + apply 进度 + applied 失效"
```

---

## Task 6: 接入 IngressClasses.vue + i18n

**Files:**
- Modify: `src/views/IngressClasses.vue`(标题栏按钮区加「部署控制器」+ 挂弹窗)
- Modify: `src/locales/zh.json`, `src/locales/en.json`(加 `ingressController.*`)
- Test: `src/views/__tests__/IngressClasses.deploy.test.js`(新增,vitest)

**Interfaces:**
- Consumes: `DeployIngressControllerDialog`(Task 4/5);IngressClasses 既有的 `ingressClassesQuery`(key `['cluster', cid.value, 'ingressclasses']`)。

- [ ] **Step 1: 写失败测试(按钮存在 + 点开弹窗)**

```js
// src/views/__tests__/IngressClasses.deploy.test.js
import { test, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { i18n } from '@/i18n'
import { VueQueryPlugin, QueryClient } from '@tanstack/vue-query'

vi.mock('@/api/client', () => ({
  api: { k8s: vi.fn(async () => ({ items: [] })), applyYaml: vi.fn(), ingressControllers: { catalog: vi.fn(async () => ({ templates: [] })), manifest: vi.fn() } },
}))
vi.mock('@/stores/cluster', () => ({ useClusterStore: () => ({ currentCluster: 'demo', fetchIngressClasses: vi.fn(async () => []), setNamespace: () => {} }) }))
vi.mock('vue-router', () => ({ useRoute: () => ({ params: {} }), useRouter: () => ({ push: () => {} }) }))

import IngressClasses from '../IngressClasses.vue'

test('IngressClasses 有「部署控制器」按钮,点击打开弹窗', async () => {
  setActivePinia(createPinia())
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const w = mount(IngressClasses, { global: { plugins: [i18n, [VueQueryPlugin, { queryClient: qc }]], stubs: { DeployIngressControllerDialog: { template: '<div data-testid="deploy-dlg"/>' }, Modal: true, Breadcrumbs: true, Pagination: true } } })
  await flushPromises()
  const btn = w.find('[data-testid="deploy-controller-btn"]')
  expect(btn.exists()).toBe(true)
  await btn.trigger('click')
  await flushPromises()
  expect(w.find('[data-testid="deploy-dlg"]').exists()).toBe(true)
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
npx vitest run src/views/__tests__/IngressClasses.deploy.test.js
```
Expected: FAIL(无该按钮)。

- [ ] **Step 3: 改 IngressClasses.vue(按钮 + 挂弹窗)**

script setup 加:

```js
import DeployIngressControllerDialog from '@/components/common/DeployIngressControllerDialog.vue'
const showDeployCtrl = ref(false)
// applied 后列表会因弹窗内 invalidateQueries 自动刷新(共享 key),无需额外处理
```

标题栏 `createBtn` 旁加按钮:

```vue
<button data-testid="deploy-controller-btn" @click="showDeployCtrl = true"
  class="flex items-center gap-sm px-md py-sm border border-primary text-primary rounded-lg hover:bg-primary-container transition-all">
  <span class="material-symbols-outlined">rocket_launch</span> {{ $t('ingressController.deployBtn') }}
</button>
<!-- Modal 区尾部 -->
<DeployIngressControllerDialog v-model="showDeployCtrl" />
```

- [ ] **Step 4: 加 i18n 键(zh + en 同步、键对齐)**

`ingressController` 命名空间下加:`deployBtn`、`dialogTitle`、`deploy`、`rbacOk`、`rbacMissing`,以及每控制器 `nginx-ingress.label/desc/notes`(P2 加 traefik/haproxy/kong 时补)。

```jsonc
// zh.json(选一合适顶层位置加 "ingressController": { ... })
"ingressController": {
  "deployBtn": "部署控制器",
  "dialogTitle": "部署 Ingress 控制器",
  "deploy": "部署",
  "rbacOk": "RBAC 预检通过",
  "rbacMissing": "网关 token 缺少以下 create 权限(继续可能在对应资源 403)",
  "nginx-ingress": { "label": "NGINX Ingress", "desc": "社区 ingress-nginx,bare-metal NodePort 变体", "notes": "装完 IngressClass=nginx 出现在下拉" }
}
```

```jsonc
// en.json
"ingressController": {
  "deployBtn": "Deploy Controller",
  "dialogTitle": "Deploy Ingress Controller",
  "deploy": "Deploy",
  "rbacOk": "RBAC precheck passed",
  "rbacMissing": "Gateway token lacks create on (apply may 403 on these)",
  "nginx-ingress": { "label": "NGINX Ingress", "desc": "Community ingress-nginx, bare-metal NodePort", "notes": "IngressClass=nginx appears in dropdowns after install" }
}
```

- [ ] **Step 5: 跑测试 + 门禁**

```bash
npx vitest run src/views/__tests__/IngressClasses.deploy.test.js
npm run i18n:check
npm run typecheck
npx vitest run src/views/__tests__/_allViewsMount.test.js -t "IngressClasses.vue"
```
Expected: 测试 PASS;i18n 残存中文 0 / 键对齐 ✓ / 引用键缺失 0;typecheck ✓;挂载冒烟 PASS。

- [ ] **Step 6: Commit**

```bash
git add src/views/IngressClasses.vue src/views/__tests__/IngressClasses.deploy.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(ingress-controller): IngressClasses 加「部署控制器」入口 + i18n"
```

> **P1 完成**:nginx-ingress 端到端打通(选 → 改 → 预检 → apply → 刷新)。手测:起服 → IngressClasses 页 → 部署 nginx-ingress → 列表出现 `nginx` 类 → 去 NsIngress 创建表单 className 下拉见 `nginx`。

---

## Task 7: P2 — haproxy 控制器

**Files:**
- Create: `server/manifests/ingress-controllers/haproxy.yaml`
- Modify: `server/manifests/ingress-controllers/catalog.mjs`

- [ ] **Step 1: 拉取 haproxy-ingress 官方清单(bare-metal)**

```bash
# haproxy-ingress 发布 baremetal deploy.yaml;确认 200,钉 tag
curl -fsSL https://raw.githubusercontent.com/haproxy-ingress/haproxy-ingress/<tag>/deploy/static/manifests/haproxy-ingress.yaml \
  -o server/manifests/ingress-controllers/haproxy.yaml
test -s server/manifests/ingress-controllers/haproxy.yaml && echo OK
```
> 若路径/tag 不对:去 https://github.com/haproxy-ingress/haproxy-ingress/tree/main/deploy/static 的当前 baremetal 清单找 pin-able tag。

- [ ] **Step 2: catalog 加一条**

```js
{
  id: 'haproxy',
  labelKey: 'ingressController.haproxy.label',
  descKey: 'ingressController.haproxy.desc',
  notesKey: 'ingressController.haproxy.notes',
  version: '<拉取 tag>',
  source: '<实际 URL>',
  variant: 'bare-metal',
  controller: 'haproxy-ingress.github.io/controller',
  defaultClassName: 'haproxy',
  file: 'haproxy.yaml',
},
```

> 确认清单内 IngressClass.spec.controller 等于上方 `controller` 值;不等则以清单实际值为准(门禁测试会校验)。

- [ ] **Step 3: 门禁测试自动覆盖 + i18n**

```bash
node --test server/ingress-controller-templates.test.mjs   # catalog 迭代,自动校验 haproxy 清单
```
加 `ingressController.haproxy.label/desc/notes`(zh+en)。

- [ ] **Step 4: 门禁全跑 + Commit**

```bash
npm run i18n:check && npm run typecheck
git add server/manifests/ingress-controllers/haproxy.yaml server/manifests/ingress-controllers/catalog.mjs src/locales/zh.json src/locales/en.json
git commit -m "feat(ingress-controller): haproxy 模板"
```

---

## Task 8: P2 — traefik 控制器

**Files:**
- Create: `server/manifests/ingress-controllers/traefik.yaml`
- Modify: `server/manifests/ingress-controllers/catalog.mjs`

> ⚠️ traefik 没有官方「单文件 bare-metal deploy.yaml」;标准安装是 Helm。本步骤**组装**:官方 CRD(`docs/content/reference/dynamic-configuration/kubernetes-crd.yml`)+ RBAC + Deployment + Service + IngressClass `traefik`(`spec.controller: traefik.io/ingress-controller`)。可从 traefik 官方 example/kustomize base 拼接。**必须含一个 IngressClass**(门禁要求 + 让类出现在下拉)。

- [ ] **Step 1: 组装清单**

从 traefik repo(`<ver>`)取 CRD yaml + 官方 example 的 Deployment/Service/RBAC,合并进 `traefik.yaml`,并补:

```yaml
apiVersion: networking.k8s.io/v1
kind: IngressClass
metadata:
  name: traefik
spec:
  controller: traefik.io/ingress-controller
```

- [ ] **Step 2: catalog 加一条**

```js
{
  id: 'traefik',
  labelKey: 'ingressController.traefik.label',
  descKey: 'ingressController.traefik.desc',
  notesKey: 'ingressController.traefik.notes',
  version: '<traefik 版本>',
  source: 'https://github.com/traefik/traefik/<ver>/docs/content/reference/dynamic-configuration/kubernetes-crd.yml (+ 官方 example 拼装)',
  variant: 'assembled(CRD + RBAC + Deploy + Svc + IngressClass)',
  controller: 'traefik.io/ingress-controller',
  defaultClassName: 'traefik',
  file: 'traefik.yaml',
},
```

- [ ] **Step 3: 门禁 + i18n + Commit**(同 Task 7 Step 3-4,键改 `traefik`,commit `feat(ingress-controller): traefik 模板`)。门禁失败说明拼装缺资源/IngressClass/controller 不符 —— 按报错修。

---

## Task 9: P2 — kong 控制器

**Files:**
- Create: `server/manifests/ingress-controllers/kong.yaml`
- Modify: `server/manifests/ingress-controllers/catalog.mjs`

> kong ingress controller 官方有 all-in-one base manifest(`config/base/manifests/all-in-one-dbless.yaml` 或 single-node)。优先用官方 single-file;补 IngressClass `kong`。

- [ ] **Step 1: 拉取/组装**

```bash
curl -fsSL https://raw.githubusercontent.com/Kong/kubernetes-ingress-controller/<ver>/config/base/manifests/all-in-one-dbless.yaml \
  -o server/manifests/ingress-controllers/kong.yaml
# 确认内含 IngressClass name=kong, spec.controller=incubator.ingress-controller.konghq.com(或清单实际值)
```

- [ ] **Step 2: catalog 加一条**(`controller` 以清单内 IngressClass.spec.controller 实际值为准;`defaultClassName: 'kong'`)

- [ ] **Step 3: 门禁 + i18n + Commit**(键改 `kong`,commit `feat(ingress-controller): kong 模板`)。

---

## Task 10(可选 / P3):「已装该 class」检测

**Files:** Modify `DeployIngressControllerDialog.vue` + test。

- 进入编辑器后,读当前 IngressClass 列表(`useResourceList(['cluster', cid, 'ingressclasses'])`),若已存在同名 class(`tpl.defaultClassName`)→ 显 `t('ingressController.alreadyInstalled')` 提示「将更新(幂等 SSA)」。加 vitest 用例。Commit `feat(ingress-controller): 已装检测提示`。

## Task 11(可选 / P3):部分失败重试 UX

**Files:** Modify `DeployIngressControllerDialog.vue`。

- apply 后 `failed` 非空时,提供「只重试失败资源」按钮:把 `failed` 对应的 yaml 文档(从原 yaml 按 kind+name 过滤)重 apply。加 vitest 用例。Commit `feat(ingress-controller): 部分失败重试`。

---

## 完工门禁(P2 结束 / 全量)

```bash
npm run typecheck
npm run i18n:check
node --test server/ingress-controller-templates.test.mjs
npm test               # scripts/test.mjs + node --test server/*.test.mjs + vitest 前端
```
全部 PASS。手测每控制器:IngressClasses → 部署 → 列表/下拉出现对应类。

## Self-Review(spec 覆盖核对)

- §3 目标(4 控制器一键部署、编辑、刷新、RBAC 预检、逐资源进度)→ Task 1-9 覆盖。
- §4 架构(catalog、2 端点、复用 /api/apply、RBAC 预检)→ Task 1-3、5 覆盖。
- §5 组件清单(每项)→ Task 1-6 对应(server helper/端点、api client、DeployIngressControllerDialog、IngressClasses 接入、i18n)。`useIngressControllerTemplates.js` 在 spec 列为「可并入 store 视实现定」—— 本计划直接在弹窗调 api,YAGNI 不设独立 composable。
- §7 错误处理(RBAC 不足、部分失败、已装幂等、文件缺)→ Task 5 + Task 10 + 端点 404(Task 2)覆盖。
- §8 测试(服务端 node:test、清单有效性门禁、前端 vitest、RBAC 聚合)→ Task 1/2/4/5/6 + 门禁测试覆盖。门禁测试把 spec 的「必含 IngressClass」细化为「含 IngressClass 且 controller 一致 + 资源≥4 + controller 串出现」(更稳,兼容 traefik/kong 拼装)——属实现期合理细化,spec 意图(校验清单真实完整)不变。
- §10 分期 P1/P2/P3 → Task 1-6 / 7-9 / 10-11 对应。
- §11 开放问题:CreateFromYamlDialog→ 新建(Task 4);catalog .mjs → Task 1;默认 namespace 钉死官方惯例 → 用户在 YAML 改(Task 1 notes)。
