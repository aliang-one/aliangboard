# 复制回填保真(volume-backfill)设计 — useWorkloadToForm 结构修复

日期:2026-08-29
状态:设计已获用户认可(2026-08-29);挂载校验增强(2026-08-28-mount-validation-design.md)的后续轮
入口:上一轮 spec §2 明确的非目标「useWorkloadToForm 复制回填的结构性缺陷」,用户指示继续

## 1. 背景与缺陷清单

`src/composables/useWorkloadToForm.js` 把 K8s workload 反解为 DeployApp 表单(CopyWorkloadDialog 复制入口)。现状缺陷(2026-08-29 复核确认):

1. **items 不解析**:`detectVolume` 不读 `configMap.items / secret.items` → 复制后键映射整份丢失(整目录挂载);
2. **hostPathType / defaultMode 不解析** → 上轮新增字段在复制路径被静默抹掉(回填缺口);
3. **只回填主容器挂载**(`mapVolumeMounts` 只看 `containers[0]`)→ init/sidecar 挂载与其独占卷整份丢失;
4. **未知卷类型静默降级 emptyDir** → projected/csi/downwardAPI 等卷复制后保存即被改写为 `emptyDir:{}`(破坏性、无感知);
5. **native sidecar 不归位** → spec.initContainers 中 `restartPolicy: Always` 的行留在 initContainers,与两面生成端的 target 序号约定错位;
6. **第 6 处双轨**:`NsWorkloadDetail.mergeVolumes`(编辑面回填)已实现 items/hostPathType/defaultMode 解析与多容器 target 对齐,但与复制面各写各的。

## 2. 目标与非目标

**目标**:复制出来的表单保存后,卷/挂载行为与原 workload 等价;编辑面与复制面共用同一回填单源;未知卷类型原样透传。

**非目标**:
- 已知类型的冷门子字段(`emptyDir.sizeLimit`、`configMap/secret optional`、NFS 卷级 readOnly)仍不建模——复制后丢失,属已知限制(罕见;编 YAML 路径不受影响);
- 不重写 `NsWorkloadDetail.openEdit` 的容器分流(仅提取其卷回填为共享;容器分流在复制面按同一约定就地实现);
- affinity/自定义 strategy 等非卷字段维持现状(文件头已声明 best-effort)。

## 3. 设计

### 3.1 新共享纯函数模块 `src/logic/volumeBackfill.js`(零依赖,无 Vue)

```js
// 容器分流:native sidecar(initContainers 中 restartPolicy==='Always')归位到 plain sidecar 之后,
// 与编辑面 openEdit 及两面生成端(YAML: initContainers 尾部 + extraContainers 原下标 target)约定一致。
splitContainers(podSpec) → { mainContainer, plainInits, plainSidecars, nativeSidecars }

// 卷回填单源(原 NsWorkloadDetail.mergeVolumes 逻辑上提 + 增强):
backfillVolumes(podSpec) → [行]   // 行形状与 VolumeMountCard/校验器约定一致
//   target 对齐:containers[0]→'main';plainInits→'init:<过滤后序>';
//   containers[1:]→'sidecar:<原下标-1>';nativeSidecars→'sidecar:<plainSidecars 数 + 序>'
//   解析:items(key/path)、hostPath.type→hostPathType、defaultMode int→八进制串(octalOf)
//   未识别类型 → { type:'unknown', raw:<原卷 spec>(含 name) } —— 原样透传,不降级
//   只定义未挂载的卷 → main 占位行(mountPath '',语义不变)
```

### 3.2 两个入口接单源

- `NsWorkloadDetail.vue`:`mergeVolumes(tplSpec, c0)` 删除,改调 `backfillVolumes(podSpec)`(行为保持——它已是增强版,仅上移 + unknown 增强);
- `useWorkloadToForm.workloadToForm`:`mapVolumeMounts` 删除,改调 `backfillVolumes(pod)`;容器部分按 `splitContainers` 归位(Always 行移入 `extraContainers` 尾部,`mapSubContainer` 已回填 `nativeSidecar` 标志)。

### 3.3 `'unknown'` 类型全链

- **VolumeMountCard**:type unknown 时类型胶囊行替换为锁定标签「〈卷类型〉(原样保留,编辑需编 YAML)」;mountPath/subPath/只读照常可编辑;来源区与 items/defaultMode 区不显示;
- **validateEntry**:unknown 天然跳过来源检查(`SOURCE_FIELD` 无该项);mountPath/systemPath/target 及跨卡冲突照常全查;`items`/subPath 投影检查按非投影卷语义跳过;
- **toVolumeDef**:case 'unknown' → `structuredClone(entry.raw)`(raw 自带 name;对象路径——NsWorkloadDetail saveEdit/merge-patch——天然支持);
- **toVolumeDefYaml**:unknown → 返回 null;DeployApp `volumesYaml` 调用点对 unknown 行用既有 `yamlDump` 序列化 raw 并缩进到 6 空格(纯函数模块保持零依赖);
- 投影/`toMountSpec`/`mountsForTarget` 对 unknown 类型无关、照常工作。

### 3.4 i18n

`component.volumeMount.unknownBadge`、`component.volumeMount.unknownNotice`(zh/en 同步),`npm run i18n:check` 全绿。

## 4. 测试与验收

- volumeBackfill 表驱动(target 对齐含 native 序、items/hostPathType/defaultMode 解析、unknown raw 透传、占位行);
- toVolumeDef/toVolumeDefYaml unknown 分支;卡片 unknown 提示渲染与可编辑性;
- useWorkloadToForm:native 归位、卷条目新字段、unknown 行;
- 回归:`npm test` + `npm run test:unit` + `npm run typecheck` + `npm run i18n:check` 全绿;
- 验收场景:含 projected 卷 + CM(items 映射)+ native sidecar 的 workload → 复制 → 不改动直接保存,YAML 中卷/挂载语义与原 spec 等价(unknown 卷逐字保留)。
