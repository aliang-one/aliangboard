# StorageClass 创建流程 + 标准 Provisioner 预设 — 设计

**日期**: 2026-08-08
**状态**: 已确认设计(待写实现计划)

## 问题

当前 `Storage.vue` 的「创建存储类」弹窗是一个**裸表单**:free-text `provisioner` 字段、free-text `parameters` 字段(逗号字符串)、`reclaimPolicy`、`default`。placeholder 是一个任意的 `pd.csi.storage.gke.io`。**零引导**——要创建一个能用的 StorageClass,用户必须已经知道确切的 provisioner 串(`rancher.io/local-path`、`driver.longhorn.io`、`nfs.csi.k8s.io`…)以及该 provisioner 的正确参数键。

这是「没有创建 storageclass 的过程」之痛的根源:有弹窗,但不给出可用方案。

## 目标

- 在现有创建弹窗顶部加「预设方案」选择器,选中后自动填好 provisioner + parameters + reclaimPolicy + volumeBindingMode + allowVolumeExpansion。
- 提供 16 个常见 provisioner 的标准预设(本地/分布式/NFS/云厂商 4 个 family)。
- parameters 从单行逗号字符串升级为 KV 行编辑器(支持 10+ 参数,如 Ceph RBD)。
- 弹窗底部加只读 YAML 预览,实时反映将 apply 的 YAML。
- 必填参数未填(仍含占位符)时**阻断**创建,避免静默失败的坏 SC。

## 非目标(Out of Scope)

- 不做可编辑 YAML 向导(那是 create-workload 分割按钮的另一套模式;本特性只读预览,高级编辑走 `StorageClassDetail` 的 YAML 编辑器)。
- 不改 `StorageClassDetail` 的编辑弹窗(它正确地只动 default+labels+annotations;因为 `reclaimPolicy`/`volumeBindingMode`/`parameters`/`mountOptions` 在 K8s 里**创建后不可变**)。
- 不自动取消其它 StorageClass 的 default(K8s 允许多 default;与现有 `updateStorageClass` 行为一致)。
- 不把 parameters 升级成全局可复用组件(本次内联复用现有 KV 行模式;提取组件留作未来)。

## 架构与文件布局

```
NEW  src/data/storageClassPresets.js   # 纯数据:16 预设 + family 分组 + 纯函数
EDIT src/views/Storage.vue             # SC 创建弹窗:预设下拉 + parameters KV 行 + binding/expand + 只读 YAML 预览 + 校验
EDIT src/stores/cluster.js             # generateYAML('storageclass') 扩展;mapStorageClass 补 volumeBindingMode
EDIT src/locales/zh.json + en.json     # 新 i18n 键(两份同步)
NEW  <零依赖运行器测试>                # 预设数据 + generateYAML 纯逻辑
```

**为何预设单独成文件**:16 个预设 + 多字段是纯数据,放独立模块可被零依赖运行器单测(无 Vue 依赖),且加/删预设零成本。表单响应式状态留在 `Storage.vue`,数据与接线分离。

## 预设目录(16 个)

每个预设:`id` / `family` / `label`(i18n 键)/ `hint`(i18n 键)/ `provisioner` / `reclaimPolicy` / `volumeBindingMode` / `allowVolumeExpansion` / `defaultName` / `parameters`(对象 map)/ `requiredParams`(数组,值含 `<...>` 占位符者)。

### 本地/单机 (`family: 'local'`)

| id | provisioner | reclaim | binding | parameters | expand | requiredParams |
|---|---|---|---|---|---|---|
| `local-path` | `rancher.io/local-path` | Delete | WaitForFirstConsumer | —(空) | ❌ | [] |
| `no-provisioner` | `kubernetes.io/no-provisioner` | Retain | WaitForFirstConsumer | —(空) | ❌ | [] |
| `host-path` | `kubernetes.io/host-path` | Delete | WaitForFirstConsumer | —(空) | ❌ | [] |

- `local-path`:单机/homelab 最常用,需先 helm 装 local-path-provisioner。
- `no-provisioner`:不自动创建 PV,需手动预先创建 PV。
- `host-path`:in-tree 已弃用,仅旧集群兼容。

### 分布式块存储 (`family: 'distributed'`)

| id | provisioner | reclaim | binding | parameters | expand | requiredParams |
|---|---|---|---|---|---|---|
| `longhorn` | `driver.longhorn.io` | Delete | Immediate | `numberOfReplicas=3`, `staleReplicaTimeout=30` | ✅ | [] |
| `ceph-rbd` | `rook-ceph.rbd.csi.ceph.com` | Delete | Immediate | `clusterID`, `pool`, `imageFormat=2`, `imageFeatures=layering` + 6 个 `csi.storage.k8s.io/*-secret-*`(预填 Rook 默认值) + `csi.storage.k8s.io/fstype=ext4` | ✅ | [`clusterID`, `pool`] |
| `cephfs` | `rook-ceph.cephfs.csi.ceph.com` | Delete | Immediate | `clusterID`, `fsName` + secret 引用 + `csi.storage.k8s.io/fstype=ext4` | ✅ | [`clusterID`, `fsName`] |
| `openebs-localpv` | `openebs.io/local` | Delete | WaitForFirstConsumer | `storageType=hostpath` | ❌ | [] |
| `topolvm` | `topolvm.io` | Delete | WaitForFirstConsumer | `csi.storage.k8s.io/fstype=xfs` | ✅ | [] |

- `ceph-rbd` 标准 secret 引用(Rook 默认 namespace `rook-ceph`):
  `csi.storage.k8s.io/provisioner-secret-name=rook-csi-rbd-provisioner`,
  `csi.storage.k8s.io/provisioner-secret-namespace=rook-ceph`,
  `csi.storage.k8s.io/controller-expand-secret-name=rook-csi-rbd-provisioner`,
  `csi.storage.k8s.io/controller-expand-secret-namespace=rook-ceph`,
  `csi.storage.k8s.io/node-stage-secret-name=rook-csi-rbd-node`,
  `csi.storage.k8s.io/node-stage-secret-namespace=rook-ceph`。
- `ceph-rbd`/`cephfs` 的 `clusterID` 默认占位 `<rook-ceph>`(Rook 集群通常即 namespace 名)、`pool=<replicapool>`、`fsName=<cephfs>`。

### NFS (`family: 'nfs'`)

| id | provisioner | reclaim | binding | parameters | expand | requiredParams |
|---|---|---|---|---|---|---|
| `nfs-csi` | `nfs.csi.k8s.io` | Delete | Immediate | `server=<IP>`, `share=</exported/path>`, `csi.storage.k8s.io/fstype=nfs` | ✅ | [`server`, `share`] |
| `nfs-in-tree` | `kubernetes.io/nfs` | Retain | Immediate | `server=<IP>`, `path=</path>` | ❌ | [`server`, `path`] |

### 云厂商块存储 (`family: 'cloud'`)

| id | provisioner | reclaim | binding | parameters | expand | requiredParams |
|---|---|---|---|---|---|---|
| `aws-ebs` | `ebs.csi.aws.com` | Delete | WaitForFirstConsumer | `type=gp3`, `csi.storage.k8s.io/fstype=ext4` | ✅ | [] |
| `gce-pd` | `pd.csi.storage.gke.io` | Delete | WaitForFirstConsumer | `type=pd-ssd` | ✅ | [] |
| `azure-disk` | `disk.csi.azure.com` | Delete | WaitForFirstConsumer | `skuName=StandardSSD_LRS`, `csi.storage.k8s.io/fstype=ext4` | ✅ | [] |
| `aliyun-disk` | `disk.csi.alibabacloud.com` | Delete | WaitForFirstConsumer | `type=cloud_essd` | ✅ | [] |
| `tencent-cbs` | `com.tencent.cloud.csi.cbs` | Delete | WaitForFirstConsumer | `type=CLOUD_SSD` | ✅ | [] |
| `huawei-evs` | `ebs.csi.huaweicloud.com` | Delete | WaitForFirstConsumer | `csi.storage.k8s.io/fstype=ext4` | ✅ | [] |

## 数据模型

### 预设对象(`src/data/storageClassPresets.js`)

```js
{
  id: 'nfs-csi',
  family: 'nfs',
  label: 'storage.presets.nfs-csi.label',          // i18n 键
  hint: 'storage.presets.nfs-csi.hint',
  provisioner: 'nfs.csi.k8s.io',
  reclaimPolicy: 'Delete',
  volumeBindingMode: 'Immediate',
  allowVolumeExpansion: true,
  defaultName: 'nfs-client',
  parameters: { server: '<IP>', share: '</exported/path>', 'csi.storage.k8s.io/fstype': 'nfs' },
  requiredParams: ['server', 'share'],
}
```

### 纯函数(同文件导出)

- `STORAGE_CLASS_PRESETS`(16 元素数组)+ `STORAGE_CLASS_PRESET_FAMILIES`(`[{key:'local',labelKey:…}, …]`)。
- `presetToFormState(preset)` → `{ name, provisioner, parameters:[{key,value}], reclaimPolicy, volumeBindingMode, allowVolumeExpansion, default:false }`。
- `paramsMapToRows(map)` / `paramsRowsToMap(rows)` — 镜像 `StorageClassDetail.vue` 的 `labelsToRows`/`rowsToMap`。
- `hasPlaceholderParam(rows, requiredParams)` — 任一必填参数的 value 仍含 `<...>` → `true`。
- `normalizeParamsToMap(parameters)` — 接受 ① KV 行数组 ② 对象 map ③ 旧逗号字符串,统一输出有序 map(generateYAML 内部用)。

### 创建表单状态(`Storage.vue`,扩展现有 `createSCForm`)

```js
{
  name, provisioner,
  parameters: [{key, value}],        // 从逗号字符串 → KV 行
  reclaimPolicy, volumeBindingMode,
  allowVolumeExpansion, default,
}
```

## 创建弹窗 UX(改造 `Storage.vue:312-345`)

弹窗从上到下:

1. **预设方案 `<select>`**(带 `<optgroup>`:本地/分布式/NFS/云)+ 顶部一个「自定义(不选预设)」选项。选中 → `presetToFormState(preset)` 填充下方全部字段。选「自定义」→ 清空/恢复默认。
2. **name** 输入(保留)。
3. **provisioner** 输入(保留,选预设后自动填,可改)。
4. **parameters → KV 行编辑器**:复用 `StorageClassDetail.vue:35-54` 的 `labelsToRows`/`rowsToMap`/`addLabelRow`/`removeLabelRow` 模式。每行 `key` + `value` 输入 + 删除按钮,底部「+ 添加参数」。
5. **reclaimPolicy**(保留)+ **新增 volumeBindingMode** select(`Immediate` / `WaitForFirstConsumer`)+ **allowVolumeExpansion** 复选框。
6. **default** 复选框(保留)。
7. **只读 YAML 预览**:底部 `CodeViewer :code="previewYaml" lang="yaml"`,实时 = `generateYAML('storageclass', 当前表单状态)`。随任意字段变化即时刷新。只读。

## generateYAML 契约扩展(`cluster.js:2648-2664`)

当前 `parameters` 只吃逗号字符串。改为经 `normalizeParamsToMap` 归一化(见上)。新增字段输出:

```yaml
volumeBindingMode: ${resource.volumeBindingMode || 'WaitForFirstConsumer'}   # 新,默认 WaitForFirstConsumer
allowVolumeExpansion: true                                                   # 仅 resource.allowVolumeExpansion===true 时输出
mountOptions: [...]                                                          # 仅 resource.mountOptions 非空时输出(NFS 预留)
parameters:
  <归一化后的 KV>                                                              # 空时输出 "{}"
```

保留对旧逗号字符串入参的兼容(mock 路径),故归一化函数同时支持三种形态。

## mapStorageClass 改动(`cluster.js:2021`)

顺带补 `volumeBindingMode: item.volumeBindingMode || 'WaitForFirstConsumer'` 字段(列表/展示用;不影响不可变编辑)。其余不动。

## 校验与错误处理

- **name 必填**(保留)。
- **必填占位符检查(阻断)**:若所选预设的 `requiredParams` 任一 value 仍含 `<...>`(如 `server=<IP>` 未改)→ Create 按钮**置灰** + 行内红字提示。避免创建静默失败的坏 SC。
- **重名软检查**:mock 模式查 `scList` 是否已有同名,提示;远端模式由 K8s apply 自然返回冲突错误(`remoteCreate` 已有错误回显)。
- **default 不自动取消其它**:勾选 default 仅加注解(与现有 `updateStorageClass` 一致)。已知小缺口,记录于此。

## 测试

- **零依赖运行器(必做)**:`storageClassPresets.js` 是纯数据 → 断言每个预设字段完整(`provisioner` 非空、`volumeBindingMode` ∈ {Immediate,WaitForFirstConsumer}、`requiredParams` 是 `parameters` 键的子集、id 无重复、4 个 family 均覆盖)。`generateYAML('storageclass', …)` 对若干代表预设(`ceph-rbd` 多参数、`nfs-csi` 占位符、`aws-ebs`、`local-path` 空 parameters)输出含期望行、`volumeBindingMode`/`allowVolumeExpansion` 正确触发、占位符原样保留。
- **vitest(可选)**:若 §3 接线足够薄(逻辑都委托给纯函数),可只做零依赖那层,跳过 vitest。CLAUDE.md:纯逻辑优先零依赖运行器。

## i18n

`storage.` 下新增:`presetScheme`、`presetCustom`、`familyLocal/Distributed/Nfs/Cloud`、`volumeBindingMode`、`bindingImmediate`、`bindingWaitForFirstConsumer`、`allowVolumeExpansion`、`yamlPreview`、`presetHint`、`requiredParamWarn`、`addParam`、`removeParam`、`key`、`value`,以及 `storage.presets.<id>.label/hint` ×16。zh.json + en.json 同步,落 spec 后跑 `npm run i18n:check`(残存中文 + 键对齐 + 引用缺失 三合一门禁)。

## 依赖政策

本特性**不新增任何外部依赖**。复用现有 `CodeViewer.vue`(Prism.js 已在)、KV 行模式(现有约定)、`Modal`/`DataTable` 等。符合 CLAUDE.md 零依赖政策。

## 未来(不在本次范围)

- 把 parameters KV 行编辑器提取成可复用组件(`KeyValueEditor.vue`),供 labels/annotations/env 复用。
- 预设自动从集群已安装的 CSI driver(查 CSIDriver 资源)推断可选项。
- default 勾选时自动 unset 其它 SC 的 default 注解。
