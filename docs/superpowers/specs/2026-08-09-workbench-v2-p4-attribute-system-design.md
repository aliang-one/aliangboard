# 工作台 V2 P4 — 属性系统(catalog + ResourceCard)

- 日期:2026-08-09
- 分支:`feat/workbench-v2-p1`(worktree)
- 状态:APPROVED(brainstorm 2026-08-09)
- 关联:V2 愿景 P4;P3 卡片的地基

## 背景

V2 愿景 P4:定义一次基础属性 schema → 资源卡片 / manifest 表单 / 对话产物全处复用。JSON Schema 驱动:catalog 配置定义每种 kind 的属性,通用渲染器读 catalog + 资源对象 → 卡片。加 kind 只需加配置,不改代码。

## 范围

**做:**
1. `src/data/resourceCatalog.js` — 6 个常见 kind 的属性定义(Pod/Deployment/Service/Namespace/Ingress/ConfigMap)。
2. `src/components/common/ResourceCard.vue` — 通用渲染器(props: `{ resource: Object }`;读 catalog 按 type 渲染)。
3. 5 种属性类型:text / badge / chips / age / code。
4. i18n:属性 label 经 catalog 定义(静态英文 label,P4 不做 i18n 化 label——卡片是开发者面向,英文 OK)。

**不做:**@-mention tokenizer(P3)/ 搜索 API(P3)/ manifest 表单生成 / 动态 schema 编辑器 / label i18n 化。

## 设计

### 1. Catalog(`src/data/resourceCatalog.js`)

```js
export const RESOURCE_CATALOG = {
  Pod: {
    icon: 'podcasts',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', label: 'Namespace' },
      { key: 'status', path: 'status.phase', type: 'badge', label: 'Status', badgeMap: { Running: 'ok', Pending: 'warn', Failed: 'err', Succeeded: 'ok' } },
      { key: 'node', path: 'spec.nodeName', type: 'text', label: 'Node' },
      { key: 'podIP', path: 'status.podIP', type: 'code', label: 'Pod IP' },
      { key: 'images', path: 'spec.containers', type: 'chips', extract: 'image', label: 'Images' },
      { key: 'restarts', path: 'status.containerStatuses', type: 'text', extract: 'restartCount', reduce: 'sum', label: 'Restarts' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', label: 'Age' },
    ],
  },
  Deployment: {
    icon: 'deployed_code',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', label: 'Namespace' },
      { key: 'replicas', path: 'spec.replicas', type: 'text', label: 'Desired' },
      { key: 'ready', path: 'status.readyReplicas', type: 'text', label: 'Ready' },
      { key: 'updated', path: 'status.updatedReplicas', type: 'text', label: 'Updated' },
      { key: 'images', path: 'spec.template.spec.containers', type: 'chips', extract: 'image', label: 'Images' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', label: 'Age' },
    ],
  },
  Service: {
    icon: 'hub',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', label: 'Namespace' },
      { key: 'type', path: 'spec.type', type: 'badge', label: 'Type' },
      { key: 'clusterIP', path: 'spec.clusterIP', type: 'code', label: 'Cluster IP' },
      { key: 'ports', path: 'spec.ports', type: 'chips', extract: 'port', label: 'Ports' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', label: 'Age' },
    ],
  },
  Namespace: {
    icon: 'folder',
    attributes: [
      { key: 'status', path: 'status.phase', type: 'badge', label: 'Status', badgeMap: { Active: 'ok', Terminating: 'warn' } },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', label: 'Age' },
    ],
  },
  Ingress: {
    icon: 'dns',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', label: 'Namespace' },
      { key: 'hosts', path: 'spec.rules', type: 'chips', extract: 'host', label: 'Hosts' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', label: 'Age' },
    ],
  },
  ConfigMap: {
    icon: 'description',
    attributes: [
      { key: 'namespace', path: 'metadata.namespace', type: 'text', label: 'Namespace' },
      { key: 'keys', path: 'data', type: 'chips', extract: 'key', label: 'Data Keys' },
      { key: 'age', path: 'metadata.creationTimestamp', type: 'age', label: 'Age' },
    ],
  },
}
```

### 2. 路径提取(`getPath(obj, path, extract?, reduce?)`)

- `path`: dot notation into K8s object(`metadata.name`)。
- 若 path 指向 array: `extract` 取每个元素的指定字段。
- `reduce: 'sum'`: 对提取的数字数组求和(restarts)。
- `extract: 'key'`: 对 object 的 key 取键名(ConfigMap data keys)。
- 返回值: scalar(string/number)或 array(→ chips)。

### 3. ResourceCard.vue

- **props**: `{ resource: Object }`(K8s API 对象,含 `.kind`)。
- **行为**: `const spec = RESOURCE_CATALOG[resource.kind]`;若无 → fallback spec(`[{ key: 'kind', ... }, { key: 'namespace', ... }, { key: 'age', ... }]`)。
- **模板**: 卡片容器(border + rounded)→ header(icon + kind + name)→ 属性网格(label: value 对)。
- **type 渲染**:
  - `text`: `<span>{{ value }}</span>`
  - `badge`: `<span class="badge" :class="badgeClass">{{ value }}</span>`(badgeMap 映射颜色: ok=green, warn=yellow, err=red)。
  - `chips`: `<span v-for="v in value" class="chip">{{ v }}</span>`。
  - `age`: `<span>{{ relativeTime(value) }}</span>`。
  - `code`: `<code>{{ value }}</code>`。

### 4. 无 catalog 的 kind（fallback）

```js
const FALLBACK = {
  icon: 'extension',
  attributes: [
    { key: 'kind', path: 'kind', type: 'text', label: 'Kind' },
    { key: 'namespace', path: 'metadata.namespace', type: 'text', label: 'Namespace' },
    { key: 'age', path: 'metadata.creationTimestamp', type: 'age', label: 'Age' },
  ],
}
```

### 5. 测试

- 纯逻辑:`getPath` 提取(scalar/array/sum/key fallback)——`scripts/test.mjs` 或 `node --test`。
- 前端:`npm run build`(ResourceCard 编译)+ i18n:check。
- 手测:用 mock K8s 对象渲染各种 kind 的卡片。

## 非目标
@-mention(P3)/ 搜索 API(P3)/ manifest 表单 / label i18n / badge 颜色自定义 UI / catalog 编辑器。
