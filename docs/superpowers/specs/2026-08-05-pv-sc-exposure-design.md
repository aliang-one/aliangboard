# 子项目 A：PV / StorageClass 暴露 + 可变字段结构化编辑

- **日期**：2026-08-05
- **状态**：已确认，待实现
- **范围**：子项目 A（存储资源暴露与编辑）。子项目 B（监控中心）为独立周期，本 spec 不含。
- **worktree**：`feat/storage-monitoring`（基于 main `6f7304f`）

## 1. 背景与动机

PV 与 StorageClass **功能其实已完整**（`Storage.vue` 3-Tab 中心含列表/创建/删除，`PVDetail`/`StorageClassDetail` 详情页含只读展示 + YAML 编辑，store 有完整 CRUD 与水合），但：

- **无侧边栏入口** → `/storage` 只能靠 URL 或 PVC 链接进入，用户以为"没有 PV/SC 支持"。
- **详情页无编辑/删除按钮** → 删除必须回列表页；编辑只能改 YAML。
- **`store.updatePV`/`updateStorageClass` 只改本地、无远端 PATCH** → 是个 gap（当前唯一能落库的编辑是详情页 YAML 的 `applyYaml` 全量 apply）。

**K8s 硬约束**：PV/SC 创建后大部分字段不可变（capacity/accessModes/storageClassName/volume source/provisioner/parameters 等改了会被 K8s 拒）。可编辑的仅：
- **PV**：`spec.persistentVolumeReclaimPolicy`（Retain↔Delete↔Recycle）、`metadata.labels`、`metadata.annotations`。
- **SC**：`metadata.annotations['storageclass.kubernetes.io/is-default-class']`（默认开关）、`metadata.labels`、`metadata.annotations`。

**关键实现约束**：`mapPV`/`mapStorageClass` 是**有损摘要**（不含 PV 的 volume source 等字段），故编辑**不能**走 `generateYAML` + 全量 apply（会丢 volume source）。必须走**手术式 merge-patch**（只 patch 改动字段）。

## 2. 目标与非目标

### 目标
1. 侧边栏加「存储」入口 → `/storage`（现有 3-Tab 中心），PV/SC 立即可见。
2. `mapPV`/`mapStorageClass` 补 `labels`/`annotations` 字段。
3. `updatePV`/`updateStorageClass` 改为**远端 merge-patch**（修复"只改本地"的 gap）。
4. `PVDetail`/`StorageClassDetail` 加结构化编辑 Modal（仅可变字段）+ 删除按钮。
5. Labels/Annotations 编辑器支持增/改/删（删 = merge-patch 该键为 `null`）。

### 非目标（YAGNI）
- 不做 PV 创建表单的 volume source（hostPath/nfs/csi）——是已知 gap，属"创建"非"编辑"，留后续。
- 不重构 Ingress 详情的 labels/annotations 编辑器为公共组件（避免无关改动）；PV/SC 内联复用其样式。
- 不做不可变字段的编辑（K8s 会拒）。
- 子项目 B（监控中心）不在本 spec。

## 3. 现状（关键代码位置）

- `src/router/index.js`：`/storage`、`pv/:name`(PVDetail)、`storageclass/:name`(StorageClassDetail) 路由均已存在（scope: global）。
- `src/views/Storage.vue`：3-Tab（pvc/pv/sc），含列表 + 创建 Modal + 列表行删除；无编辑入口。
- `src/views/PVDetail.vue`：只读 overview + YAML tab（`useLiveYaml` 远端全量 yaml + `applyYaml`）；header 无编辑/删除按钮。
- `src/views/StorageClassDetail.vue`：同上结构。
- `src/stores/cluster.js`：
  - `mapPV`（约 1734）/`mapStorageClass`（约 1745）：**未映射 labels/annotations**。
  - `getPVByName`/`getSCByName`、`addPV`/`addStorageClass`（远端 create）、`deletePV`/`deleteStorageClass`（远端 delete）均存在。
  - `updatePV(name, updates)`/`updateStorageClass(name, updates)`：**仅本地合并，无远端 PATCH**。
- `src/components/layout/SideNavBar.vue`：`clusterResourcesNav` 无「存储」入口。

## 4. 设计

### 4.1 侧边栏入口
`SideNavBar.vue` 的集群级导航（`clusterResourcesNav` 或其上方）加一项：`{ icon: 'storage', label: '存储', route: '/storage' }`。图标用 `storage` 或 `database`。

### 4.2 mapPV / mapStorageClass 补字段
两个 mapper 的返回对象增加：
```js
labels: item.metadata?.labels || {},
annotations: item.metadata?.annotations || {},
```
（与 `mapIngress`/`mapService` 一致。）`mapStorageClass` 的 `default` 维持现有「读 is-default 注解」逻辑不变。

### 4.3 store updatePV / updateStorageClass 改远端 merge-patch

**纯函数（便于单测，遵循 `extractContainerPorts`/`buildIngressRulesPatch` 模式）** —— 放 `src/composables/useStoragePatch.js`：

```js
// 构造 PV 编辑的 merge-patch body。reclaimPolicy 可选；labels/annotations 为「期望全量」，
// 与 original 比较后，被删除的键置 null（merge-patch 删除语义）。
export function buildPVPatch(original = {}, { reclaimPolicy, labels, annotations } = {}) {
  const patch = { spec: {}, metadata: {} }
  let touched = false
  if (reclaimPolicy && reclaimPolicy !== original.reclaimPolicy) {
    patch.spec.persistentVolumeReclaimPolicy = reclaimPolicy; touched = true
  } else {
    delete patch.spec
  }
  const labelsPatch = diffMap(original.labels || {}, labels)   // {key:val 新改, key:null 删除}
  if (Object.keys(labelsPatch).length) { patch.metadata.labels = labelsPatch; touched = true }
  const annPatch = diffMap(original.annotations || {}, annotations)
  if (Object.keys(annPatch).length) { patch.metadata.annotations = annPatch; touched = true }
  if (!Object.keys(patch.metadata).length) delete patch.metadata
  return touched ? patch : null   // null = 无改动
}

// 同理 SC：default 经 is-default 注解；labels/annotations 同上。
export function buildStorageClassPatch(original = {}, { isDefault, labels, annotations } = {}) {
  const patch = { metadata: { annotations: {} } }
  let touched = false
  const cur = original.default
  if (isDefault != null && !!isDefault !== !!cur) {
    patch.metadata.annotations['storageclass.kubernetes.io/is-default-class'] = isDefault ? 'true' : 'false'
    touched = true
  }
  const labelsPatch = diffMap(original.labels || {}, labels)
  if (Object.keys(labelsPatch).length) { patch.metadata.labels = labelsPatch; touched = true }
  const annPatch = diffMap(original.annotations || {}, annotations)
  // 合并进 annotations（与 default 注解同 metadata.annotations）
  for (const [k, v] of Object.entries(annPatch)) patch.metadata.annotations[k] = v
  if (!Object.keys(patch.metadata.annotations).length) delete patch.metadata.annotations
  if (!Object.keys(patch.metadata).length) delete patch.metadata
  return touched ? patch : null
}

// diffMap：desired 相对 original 的变化——新增/改值 → {k:v}；删除 → {k:null}
function diffMap(original, desired) {
  if (!desired) return {}
  const out = {}
  for (const [k, v] of Object.entries(desired)) {
    if (original[k] !== v) out[k] = v
  }
  for (const k of Object.keys(original)) {
    if (!(k in desired)) out[k] = null
  }
  return out
}
```

> `diffMap` 导出（或同文件导出）便于单测。

**store 改造**（cluster.js）：
```js
async function updatePV(name, updates) {
  const idx = pvList.value.findIndex(p => p.name === name)
  if (idx === -1) return
  const before = JSON.parse(JSON.stringify(pvList.value[idx]))
  const patch = buildPVPatch(before, updates)
  if (!patch) return
  if (remoteMode.value) {
    await api.k8s(`/api/v1/persistentvolumes/${encodeURIComponent(name)}`, {
      method: 'PATCH', headers: { 'content-type': 'application/merge-patch+json' }, body: JSON.stringify(patch),
    })
  }
  // 乐观本地合并（reclaimPolicy；labels/annotations 用期望全量覆盖）
  pvList.value[idx] = { ...before, ...(updates.reclaimPolicy ? { reclaimPolicy: updates.reclaimPolicy } : {}),
    ...(updates.labels ? { labels: updates.labels } : {}), ...(updates.annotations ? { annotations: updates.annotations } : {}) }
}
async function updateStorageClass(name, updates) {
  // 同理：buildStorageClassPatch → PATCH /apis/storage.k8s.io/v1/storageclasses/{name}；本地合并 default/labels/annotations
}
```
> 远端成功后本地用「期望全量」覆盖 labels/annotations（乐观），避免重算 diff。失败回滚 `before`（可加 try/catch，与 `remoteUpdate` 风格一致）。

### 4.4 PVDetail / StorageClassDetail 编辑 Modal + 删除按钮

**header 加按钮**（与现有标题区同行）：
- 「编辑」→ 打开编辑 Modal。
- 「删除」→ 二次确认 → `store.deletePV`/`deleteStorageClass` → 跳回 `/storage`。

**编辑 Modal**：
- **PV**：
  - Reclaim Policy：`<select>`（Retain/Delete/Recycle），回填 `pv.reclaimPolicy`。
  - Labels 编辑器：key-value 列表（当前 `pv.labels`），增/删行。
  - Annotations 编辑器：同上（当前 `pv.annotations`）。
- **SC**：
  - Default：`<input type="checkbox">`（回填 `sc.default`）。
  - Labels / Annotations 编辑器：同上。**Annotations 编辑器过滤掉 `storageclass.kubernetes.io/is-default-class` 系统注解**（该注解由 Default 开关单独控制，避免双控件冲突；`buildStorageClassPatch` 也只经 `isDefault` 参数写这个键）。
- 保存：调用 `store.updatePV(name, { reclaimPolicy, labels, annotations })` / `store.updateStorageClass(name, { isDefault, labels, annotations })`（labels/annotations 传期望全量）；成功关 Modal。

**Labels/Annotations 编辑器（内联）**：复用 `NsIngressDetail` 的 key-value 列表样式（chip/行 + 增删），在 Modal 内实现；不抽公共组件。

### 4.5 边界与错误处理
- 无改动（`patch === null`）：不发起 PATCH，关闭 Modal（或提示"无改动"）。
- merge-patch 删除键：确保 JSON.stringify 保留 `null`（`{labels:{k:null}}`，非 undefined）。
- SC default：设默认**不会**自动取消其它 SC 的默认（K8s 允许多默认；保持简单，不联动 unset）。
- PV/SC 已被他人删除（PATCH 返回 404）：catch → notify 错误 + 触发列表重水合。
- 保留键校验：labels/annotations 的 key 为空行不提交。

## 5. 测试

- **纯函数单测**（`scripts/test.mjs`，零依赖）：`buildPVPatch` / `buildStorageClassPatch` / `diffMap`：
  - PV：reclaimPolicy 改/不改；labels 增/改/删（null）；无改动→null。
  - SC：default 切换→注解 true/false；labels/annotations diff；无改动→null。
  - diffMap：新增、改值、删除(null)、空 desired。
- **手动验证**（`npm run dev`）：
  - 侧边栏「存储」→ `/storage` 3-Tab 可见，PV/SC 列表正常。
  - PV 详情：编辑 reclaimPolicy + 增删 labels/annotations → 保存 → 远端生效（重新打开回填正确）；删除 → 消失并跳回。
  - SC 详情：default 开关 + labels/annotations → 保存 → 生效；删除。
- **typecheck + build**：无新增错误。

## 6. 涉及文件清单

**新增**
- `src/composables/useStoragePatch.js` —— `buildPVPatch` / `buildStorageClassPatch` / `diffMap` 纯函数（单测可 import）。

**修改**
- `src/stores/cluster.js` —— `mapPV`/`mapStorageClass` 加 labels/annotations；`updatePV`/`updateStorageClass` 改远端 merge-patch（复用纯函数）。
- `src/views/PVDetail.vue` —— header 编辑/删除按钮 + 编辑 Modal（reclaimPolicy + labels/annotations 编辑器）。
- `src/views/StorageClassDetail.vue` —— header 编辑/删除按钮 + 编辑 Modal（default + labels/annotations 编辑器）。
- `src/components/layout/SideNavBar.vue` —— 加「存储」集群级入口。
- `scripts/test.mjs` —— 追加纯函数契约测试。
