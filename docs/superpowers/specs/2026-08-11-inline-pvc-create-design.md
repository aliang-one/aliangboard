# 工作台创建负载:PVC 内联快速创建

> **Status:** Approved design (2026-08-11),待转实现计划(writing-plans)。

## Goal

在创建负载(DeployApp 向导)的「卷挂载」步骤,当某个卷类型选为 PVC 时,PVC 选择下拉旁当前只有一个 `<select>`。本次新增一个「新建」按钮:点击打开弹窗快速创建一个 PVC,创建确认后**自动把该卷的 PVC 选择切换到新建的这个 PVC**。

## 背景 / 现状

- PVC 下拉渲染于 `src/components/common/VolumeMountCard.vue:83-86`:`<select v-model="entry.pvcName">`,选项来自 `:pvcs` prop(字符串名数组)。
- DeployApp 在 `src/views/DeployApp.vue:248` 用 `useResourceList(['cluster', cid, 'pvcs'], store.fetchPVCs)` 拉取,`:258` 的 `availablePVCs` computed 按 `store.currentNamespace` 过滤后映射成名,`:1153` 传 `:pvcs="availablePVCs"` 给卡片。
- 已存在的「创建 PVC」表单在 `src/views/NsStorage.vue:220-253`(内联 Modal,字段 name/capacity/accessModes/storageClass,调 `store.addPVC` + `queryClient.invalidateQueries`)。它耦合在 NsStorage 页面、不可复用。
- `store.addPVC`(`src/stores/cluster.js:409-410`,经 `makeCrud('pvcs', ...)`)、`store.fetchStorageClasses()`(集群级)、`Modal.vue`(v-model + #actions slot + ESC/遮罩关闭)、Vue Query 失效机制——基础设施均齐备。

## 非目标 (Non-Goals)

- 不迁移 NsStorage 的内联创建表单(保留原样,日后可再统一)。
- 不为 ConfigMap / Secret 卷类型做同样的「内联新建」(YAGNI,本次仅 PVC)。
- 不改 DeployApp.vue、不改 NsStorage.vue。
- 不修复「全局 `/deploy` 路由下 `store.currentNamespace` 与 `form.namespace` 可能不一致」这一既有瑕疵(超出本次范围;见下方兜底)。

## Architecture

新增**一个**可复用组件 `CreatePvcDialog.vue`,由 `VolumeMountCard.vue` 自包含地持有与触发。创建成功后通过 `emit('created', name)` 把新 PVC 名回传,卡片写回 `entry.pvcName` 并用一个本地 `createdPvcName` ref 把该名并入下拉选项 —— 使「自动选中」在任何时候都立即生效,不依赖父列表刷新时机,也不受 namespace 过滤差异影响。

```
DeployApp (不改)
  └── VolumeMountCard  ← 新增:「新建」按钮 + showCreatePvc/createdPvcName + options 合并
        └── CreatePvcDialog (新组件, v-model + :namespace, @created)
              ├── 自取 StorageClass (useResourceList)
              ├── store.addPVC(...)  → 网关透传 K8s create PVC
              └── invalidateQueries(pvcs) → emit('created', name)
```

## Components

### A. `src/components/common/CreatePvcDialog.vue`(新建)

**Props**

| prop | 类型 | 默认 | 说明 |
|------|------|------|------|
| `modelValue` | Boolean | `false` | v-model 控制显隐 |
| `namespace` | String | `''` | 创建 PVC 的目标命名空间(必填) |

**Emits**

| event | payload | 时机 |
|-------|---------|------|
| `update:modelValue` | `Boolean` | 关闭弹窗时(false) |
| `created` | `name: String` | `store.addPVC` 成功 + 失效查询后 |

**内部行为**

- StorageClass 列表:`useResourceList({ key: ['cluster', cid, 'storageclasses'], fetcher: () => store.fetchStorageClasses() })`,集群级,弹窗自取(组件自包含、可复用,不依赖父组件喂入)。
- 表单状态:`ref({ name: '', capacity: '10Gi', accessModes: 'RWO', storageClass: '' })`。
- 打开时(`watch(modelValue)`,新值为 true):重置表单为上述默认值、清空错误、清 applying 态。
- 默认 SC:提交时 `storageClass || allSCs.find(s => s.default)?.name || 'standard'`(与 NsStorage `:76` 一致)。
- `create()`:
  1. `name` 非空校验(空则置 nameRequired 错误,不提交);
  2. `applying = true`;`await store.addPVC({ name, namespace, capacity, accessModes, storageClass: <resolved>, status: 'Pending', volume: '', age: 'Just now' })`;
  3. 成功:`queryClient.invalidateQueries({ predicate: q => Array.isArray(q.queryKey) && q.queryKey[0] === 'cluster' && q.queryKey[2] === 'pvcs' })`(复用 `src/stores/cluster.js:28-32` 的 `invalidateResource` 同款谓词,或等价直接调用)→ `emit('created', name)` → `emit('update:modelValue', false)`。
  4. 失败(`addPVC` 抛错):捕获,弹窗内 inline 显示错误信息(带 `error.message`),**不关闭**,保留用户输入,允许改后重试。
  5. `finally: applying = false`。
- UI:复用 `Modal`(`width="max-w-lg"`,`#actions` 放「取消 / 创建」);创建按钮 `:disabled="!name || applying"`,applying 时显示 spinner 图标;字段布局参照 NsStorage 既有创建表单(name 一行;capacity + accessMode 两列;storageClass 一行)。

### B. `src/components/common/VolumeMountCard.vue`(修改)

- import `CreatePvcDialog`。
- 新增:`const showCreatePvc = ref(false)`、`const createdPvcName = ref('')`。
- PVC 下拉选项合并(去重,过滤空):
  ```js
  const pvcOptions = computed(() => [...new Set([...props.pvcs, createdPvcName.value].filter(Boolean))])
  ```
  PVC `<select>` 的 `v-for` 由 `pvcs` 改为 `pvcOptions`。
- 模板:在 PVC `<select>`(`entry.type === 'pvc'` 分支)旁加一个图标按钮「新建」(material symbol `add` 或 `create_new_folder`),`@click="showCreatePvc = true"`;`namespace` 为空时禁用该按钮。
- 挂载:`<CreatePvcDialog v-model="showCreatePvc" :namespace="namespace" @created="onPvcCreated" />`。
- `onPvcCreated(name)`:`createdPvcName.value = name`;写回 `entry.pvcName = name`(走卡片既有的 entry 写入路径)。
  > **已知对齐点(实现时先读卡片确认):** 卡片对 `entry` 的写入方式(可写 computed 代理 `v-model="entry.pvcName"`,或须 `emit('update:modelValue', { ...modelValue, pvcName: name })`)以 `VolumeMountCard.vue` 实测为准 —— 类似 workloadToForm 漏 `toleration.operator` 的教训,先读再对齐。

## Data Flow

1. 用户在卷挂载步骤把某卷类型选为 PVC,点 PVC `<select>` 旁的「新建」→ `showCreatePvc = true`。
2. `CreatePvcDialog` 打开,自取 StorageClass,表单就绪。
3. 用户填 name / capacity / accessMode / storageClass → 点「创建」。
4. `store.addPVC` → 网关透传 K8s `POST /api/v1/namespaces/{namespace}/persistentvolumeclaims`。
5. `invalidateQueries(pvcs)` → DeployApp 的 `_pvcQ` 异步重取。
6. `emit('created', name)` → VolumeMountCard:`createdPvcName = name` + `entry.pvcName = name` → 下拉**立即**显示为选中(因 `createdPvcName` 已并入 `pvcOptions`)。
7. 父列表重取完成后,新名自然出现在 `props.pvcs`,`pvcOptions` 经 Set 去重无重复;`createdPvcName` 作为兜底可保留(无害)。

## 错误处理 / 边界

- `name` 空 → 创建按钮 disabled(并/或提交时 nameRequired 提示)。
- `addPVC` reject(名字冲突 / SC 不存在 / RBAC 无权限 / 配额不足)→ 弹窗内 inline 显示错误,不关闭,保留输入可重试。
- `applying` 中 → 创建按钮禁用 + spinner,防重复提交。
- `namespace` 为空 → 「新建」按钮禁用(工作台里 namespace 总有值,兜底)。
- 命名空间路由 `/ns/:ns/deploy` 下 `route.params.namespace` 锁定命名空间且挂载时 `store.setNamespace(...)`,故 `currentNamespace === form.namespace`,新 PVC 正常入列;全局 `/deploy` 路由的既有 namespace 过滤差异由 `createdPvcName` 并入 options 兜底覆盖(YAML 预览读 `form.volumeMounts[].pvcName`,与下拉过滤无关,始终正确)。

## i18n(新增键,zh.json / en.json 对齐)

`component` 块内新增:
```json
"createPvc": {
  "title": "新建 PVC" / "New PVC",
  "hint": "在命名空间 {ns} 下创建" / "Create in namespace {ns}",
  "nameRequired": "请输入名称" / "Name is required",
  "creating": "创建中…" / "Creating…",
  "createFailed": "创建失败" / "Failed to create"
}
```
`component.volumeMount` 块内新增:`"newPvc": "新建" / "New"`。

复用既有键:`ns.storage.capacity`、`ns.storage.accessMode`、`ns.storage.storageClass`、`ns.storage.defaultOption`、`common.create`、`common.cancel`。访问模式选项文本(ReadWriteOnce / ReadWriteMany / ReadOnlyMany)与 NsStorage 现有硬编码一致。

门禁:`npm run i18n:check` 必须绿(zh/en 键对齐、无残留中文、无缺失引用键)。

## Testing(CLAUDE.md 政策)

**组件(vitest + @vue/test-utils + happy-dom,`npm run test:unit`):**

- `src/components/common/__tests__/CreatePvcDialog.test.js`(新建):
  - 填 name,触发创建,mock `store.addPVC` resolve → 断言 `emit('created', name)` 被调用且 payload = name,并 `emit('update:modelValue', false)`。
  - mock `store.addPVC` reject → 断言错误信息显示、未 `emit('created')`、弹窗未关闭(modelValue 仍 true)。
  - name 为空 → 创建按钮 disabled。
- `VolumeMountCard` 测试(若无则新建 `__tests__/VolumeMountCard.test.js` 补冒烟):
  - 卷类型 = PVC 时「新建」按钮可见,点击后弹窗打开;
  - 触发 `created(name)` 后 `entry.pvcName === name` 且 `pvcOptions` 含 name。

**基线(每任务结束):** `npm run typecheck`(`node --check` 全 .js/.mjs,.vue 由 build 覆盖)、`npm run i18n:check`、`npm run build`。

**手测(需连真实集群):**
- 工作台创建负载 → 卷挂载步骤 → 加一个卷、类型选 PVC → 点「新建」→ 填写创建 → 下拉自动切到新 PVC;
- YAML 预览该卷 `persistentVolumeClaim.claimName` 为新 PVC 名;
- 在命名空间存储页创建 PVC 的原功能不受影响(回归 NsStorage)。

## 文件清单

**新建:**
- `src/components/common/CreatePvcDialog.vue`
- `src/components/common/__tests__/CreatePvcDialog.test.js`
- (视情况)`src/components/common/__tests__/VolumeMountCard.test.js`

**修改:**
- `src/components/common/VolumeMountCard.vue`(按钮 + 状态 + options 合并 + 挂弹窗)
- `src/locales/zh.json`、`src/locales/en.json`

**不改:** `src/views/DeployApp.vue`、`src/views/NsStorage.vue`。

## Global Constraints(对齐 CLAUDE.md / 仓库政策)

- **零新增依赖**:不引任何新运行时/工具链依赖。
- **i18n 门禁**:`npm run i18n:check` 绿,zh/en 键一一对应,每个新增键同时加中英文。
- **ESC/遮罩关闭**:弹窗复用 `Modal`(已内置)。
- **写边界(node:sqlite 坑)**:本功能前端不直接写 DB;`store.addPVC` 走既有 `remoteCreate` 路径,绑定安全。
