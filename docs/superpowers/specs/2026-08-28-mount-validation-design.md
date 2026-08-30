# Workload 挂载(volumes/volumeMounts)校验增强 — 单源校验器 + 卡片即时反馈 + 落点预览

日期:2026-08-28
状态:已获用户逐节认可(架构/规则/UI/接线四节)
入口:用户报障「挂 ConfigMap 做 items 映射后,映射出的文件挂到哪里、整个挂载是否合理、潜在问题,都没有检查,经常出错」

## 1. 背景与根因

现状(2026-08-28 侦察,行号为当日快照):

- 校验/生成散落 **5 处且语义互不一致**:
  1. `DeployApp.vue:285` step2 门禁 → `firstVolumeMountError`(仅 4 条规则:来源必填/mountPath 以 `/` 开头/target 有效/items 成对);
  2. `DeployApp.vue:745-753` 部署前 `validate()`(不查 target、不查 items,747 行整行未动静默跳过);
  3. `DeployApp.vue:444` `mountLines` 与 `DeployApp.vue:496-508` `volumesYaml`(静默过滤:缺 name/mountPath 或来源字段的条目从 YAML 整条消失——2026-08-25 报障根因);
  4. `src/logic/subContainer.js:116` `mountsForTarget`(同款静默过滤,子容器复用);
  5. `NsWorkloadDetail.vue:1036` `mountObjs`(mountsForTarget 的手抄副本)+ `:1042` `validateEdit`(不查 mountPath 以 `/` 开头;整行空报错,与创建面「跳过」语义相反)。
- **卡片内零错误态**:`VolumeMountCard.vue` 无红框/aria-invalid/行内错误;唯一反馈是向导底部一行「第 n 个存储…」红字。
- **键全集残缺**:`useResourceMappers.js` 的 `mapConfigMap/mapSecret` 丢弃 `binaryData`,卡片 `selectedKeys` 只读 `data` → items 下拉与校验可用的键集不含 binaryData 键。
- 回跳改表、走编辑面或复制入口,即可绕过任一层——「经常出错、错在部署后」的结构性根因。

## 2. 目标与非目标

**目标**:三入口(DeployApp 创建向导 / NsWorkloadDetail 编辑弹窗 / 二者复用的 VolumeMountCard)用同一套单源校验;错误即时、逐字段、分级呈现;items 映射的「文件落点」可视化预览;补齐 hostPathType/defaultMode 两个缺失字段(回填保真优先)。

**非目标(下一轮)**:
- `useWorkloadToForm.js` 复制回填的结构性缺陷(detectVolume 不解析 items/子容器挂载只回填主容器/未知卷类型静默降级 emptyDir);
- ConfigMap/Secret `optional` 字段;
- 网关侧 NFS/PVC 连通性探测;
- hostPath 敏感路径的平台级策略拦截(本轮只做前端提示与阻断)。

## 3. 架构:单源校验器(方案 A)

`src/logic/volumeMountValidation.js` 扩成唯一事实源,纯函数、零 Vue 依赖:

```js
// 单条卷的逐字段问题。level: 'error' | 'warn' | 'hint'
validateEntry(entry, ctx) → [{ code, field, level }]
//   field ∈ 'source' | 'mountPath' | 'subPath' | 'items' | 'itemsPath:<i>' | 'target' | 'name' | 'hostPathType' | 'defaultMode' | …
//   ctx: { validTargets, cmKeys: Map<name, string[]>, secretKeys: Map<name, string[]>,
//          knownCmNames, knownSecretNames, knownPvcNames }   // 名单/键集未加载时相应规则不判,绝不误报
//
// 跨卡冲突(按 target 分组):mountPath 相等(error)/父子嵌套(warn)/卷名重复(error)/孤儿 mount(error)
//   cross.entries 为涉事卡下标数组:跨卡冲突为 [i, j],孤儿 mount(规则 16)为 [i]
validateVolumeMounts(entries, ctx) → { byEntry: [ [issues…] ], cross: [{ code, entries: number[], level }] }
//
// 落点投影(预览纯数据):[{ path, from: 'key'|'item'|'subPath', warn? }]
projectMountFiles(entry, keys)
//
// 生成侧单源(见 §6):YAML 拼接所需的最小形态
toVolumeDef(entry) / toMountSpec(entry)
```

- `firstVolumeMountError` / `volumeItemsIncomplete` **保留为薄包装**(门禁取第一个 error;编辑面沿用旧 i18n key),现有调用方与测试不破坏。
- 错误文案参数习惯不强行合并:创建面沿用 `deploy.volume*` 的 `{n}`、编辑面沿用 `workload.validation.volume*` 的 `{name}`,同一 code 两套 i18n 文案;卡片内联文案用新命名空间 `component.volumeMount.issue.*`。
- `ctx` 数据源:DeployApp/NsWorkloadDetail 已有 `useResourceList` 的 CM/Secret/PVC 列表;`useResourceMappers.js` 的 `mapConfigMap/mapSecret` 透传 `binaryKeys`(与 `data` 键合并去重后供 ctx)。

## 4. 规则清单(error=拦提交 / warn=黄字可继续 / hint=灰字建议)

单卡内(`validateEntry`;K8s 依据栏为 API server/kubelet 真实行为):

| # | 规则 | 级别 | K8s 依据 |
|---|------|------|----------|
| 1 | 来源必填 / mountPath 以 `/` 开头 / target 有效 / items key-path 成对(现有 4 条,收编) | error | 422 / 静默丢失 |
| 2 | mountPath:先 trim;`//` 或尾斜杠 → hint(**直接归一回写 entry**,比报错友好);含反斜杠 → warn;`mountPath === '/'` → error | error/warn/hint | 422 前导空格非绝对路径;`/` 整根覆盖毁文件系统 |
| 3 | 系统路径覆盖:`/proc` `/sys` `/dev` → error;`/etc/hosts` `/etc/resolv.conf` `/etc/hostname` → error(文案指路 hostAliases/dnsConfig);`/var/run/secrets` 前缀 → error(SA token 冲突);`/etc` `/usr` `/bin` `/sbin` `/lib` `/root` `/var/lib` → warn(整目录遮蔽) | error/warn | kubelet 对 /etc/hosts 有显式豁免 → 静默坏 DNS/自注册;敏感挂点 runc 层直接失败 |
| 4 | items 的 path:绝对路径/含 `..` 段/含空段或空白 → error;非空 path 重复 → warn;placeholder 改「相对路径,可含子目录 conf/app.yml」 | error/warn | ValidateLocalNonReservedPath 422;重复 path 投影互相覆盖 |
| 5 | items 的 key 不在所选 CM/Secret 的 `data ∪ binaryData` 键集 → error(键集已加载才判);换绑 cmName/secretName 后旧行失效 → 逐行标红,**不自动删数据** | error | pod 卡 ContainerCreating:`references non-existent config key` |
| 6 | cmName/secretName/pvcName 不在当前 ns 已知名单 → error(名单未加载不判) | error | `configmap "x" not found` / `PersistentVolumeClaim not found` 事件 |
| 7 | subPath:绝对路径/含 `..` → error;与投影集(items path 集,无 items 时键全集)求交集不在其中 → **warn**(2026-08-30 降级,原 error)「卷内不存在此路径,kubelet 会创建空目录」(投影集未加载 → hint) | error/warn | 422 `must be a relative path`(API 真拒,error);kubernetes#62156 静默建目录——但 YAML 合法、pod 能跑,拦门禁过严(2026-08-30 用户报障 subPath=test 卡死 step2「无法下一步」),降 warn 与 mountPathNested/systemPathShadow 同类 |
| 8 | subPath 非空 → 卡片显示「单文件挂载:mountPath 须为文件完整路径,且不随 ConfigMap/Secret 更新」 | hint | 官方文档明确 subPath 挂载不热更新 |
| 9 | NFS:server 填而 nfsPath 空 → warn「将挂载整个导出 `/`」;nfsPath 非空不以 `/` 开头 → error | error/warn | API 默认 `path: /`(整导出);相对路径 MountVolume.SetUp failed |
| 10 | hostPath 命中敏感清单(`/`、`/etc`、`/var/run`、`/var/run/docker.sock`、`/root`、`/home`)→ error「等于交出节点级权限」 | error | 容器逃逸/节点提权经典路径 |
| 11 | secret/configMap 未勾只读 → hint;defaultMode 显式选了非 0400/0640(含自定义)→ hint | hint | K8s 默认 0644,组/其他可读私钥;安全基线 |
| 12 | items 非空且所选资源键数 > items 行数 → hint「其余 N 个 key 不会出现在挂载目录里」 | hint | items = 整卷重投影,最易踩的静默语义 |

跨卡(`validateVolumeMounts`):

| # | 规则 | 级别 | K8s 依据 |
|---|------|------|----------|
| 13 | 同容器 mountPath 相等(path.Clean 归一后比对) | error | 422 `container.volumeMounts[N].mountPath: must be unique` |
| 14 | 同容器 mountPath 父子嵌套(真前缀) | warn | API 不校验但遮蔽/写落点心智错乱 |
| 15 | 卷名重复(涉事两张卡头部卷名标红) | error | 平台按 name 去重首见胜出 → 静默用错卷,比 422 更难查 |
| 16 | 挂载引用的卷来源不完整(有 mount 无 volume 定义)→ error | error | 422 `volumeMounts[0].name: Not found`(生成端孤儿 mount) |

## 5. UI:卡片错误态 + 落点预览

VolumeMountCard 新增 `issues` prop(父层 computed 下发),复用现有 Material 风格:

- **逐字段错误态**:`field` 匹配的输入框红框(`border-error`)+ 行内 10px 红字;warn 黄框黄字;hint 灰字。文案 code 走 `component.volumeMount.issue.*`。跨卡冲突映射到涉事卡对应字段(13/14 → mountPath;15 → 头部卷名)。
- **状态灯**:卡片头部小圆点 绿(无问题)/红(error)/黄(warn)——多卡时一眼定位,不必逐张读。
- **落点预览**(items 区下方常驻小节,`projectMountFiles` 驱动):
  - 无 items 无 subPath:`/etc/config/ → app.yaml · log.conf …` 键 chips;binaryData 键带 `B` 角标;键未加载 → 「整目录挂载(键未加载)」灰字。
  - 有 items:缩进树 `/etc/config/ └ nginx.conf ← key: nginx.conf`,多级 path 按层级缩进;key 不存在行整行红、path 重复行黄——**预览本身即校验结果**。
  - 有 subPath:主行变单文件形态 `/etc/nginx/nginx.conf ← subPath: nginx.conf(单文件挂载·不随源更新)`;subPath 不在投影集标红。
  - 只读加锁图标;规则 12 的「其余 N 个 key 不可见」hint 也挂这里。

## 6. 字段扩展与生成端统一

### 6.1 hostPathType(回填保真优先)

- `entry.hostPathType` 新字段;选项:''(不指定)/`DirectoryOrCreate`/`Directory`/`FileOrCreate`/`File`/`Socket`/`CharDevice`/`BlockDevice`。
- **新建卷(addVolume)默认 `DirectoryOrCreate`**;编辑面 `mergeVolumes` 解析已有 `hostPath.type` 原样回显,没有则保持 ''(保存不写 type)——**存量 workload 不因打开编辑被改写**。
- YAML 生成:非空才写 `type:`。
- 复制回填路径本轮不动:detectVolume 本就不解析该字段,行为与今天一致,无回归。

### 6.2 defaultMode(secret/configMap)

- `entry.defaultMode` 新字段;下拉「K8s 默认(不写)/ 0400 / 0640 / 自定义八进制(校验 ^[0-7]{3,4}$)」。
- **默认档不输出字段**,显式选择才写 `defaultMode:`——用户不碰零行为变化。

### 6.3 生成侧单源

- `toVolumeDef(entry)` / `toMountSpec(entry)` 收编 DeployApp `volumesYaml`/`mountLines`、`subContainer.mountsForTarget`、NsWorkloadDetail `saveEdit` 重建的拼接与过滤语义。
- `mountsForTarget` 保留导出签名(`subContainer.test.mjs` 已固化语义),内部委托 `toMountSpec`。
- 生成前门禁保证无 error,故「有 mount 无 volume」不会走到生成;`toVolumeDef` 对来源不完整返回 null 的旧行为保留,但该状态已被规则 16 拦截。

## 7. i18n / 测试 / 验收

**i18n**:`component.volumeMount.issue.*`(卡片内联,~25 条,zh/en 同步);门禁侧 `deploy.volume*`(`{n}`)与 `workload.validation.volume*`(`{name}`)按新 code 增补;删除死键 `deploy.volumeEmptyMount`;`npm run i18n:check` 全绿。

**测试**:
- 纯逻辑(vitest 表驱动,沿用 `volumeMountValidation.test.js`):validateEntry 每条规则正/反例 + 降级路径(ctx 未加载不误报);跨卡 13-16 三态;`projectMountFiles` 三形态(items/subPath/全量);`toVolumeDef`/`toMountSpec` 与现 YAML 输出**逐字等价**对照(防生成端重构引入行为变化)。
- 组件(VolumeMountCard.test.js 扩展):issues prop 驱动红框/状态灯/预览树;binaryKeys 角标;hostPathType/defaultMode 新控件。
- 集成面:DeployApp 门禁与卡片即时态一致(同一 mountAudit)。
- 回归命令:`npm test` + `npm run test:unit` + `npm run typecheck` + `npm run i18n:check` 全绿为验收线。

**验收场景**(用户报障原景):挂 ConfigMap + items 映射 → 卡片即时显示落点树(key 不存在标红、path 重复标黄、其余 key 不可见灰字提示);两个卷同容器撞 mountPath → 第二张卡 mountPath 红框 + 门禁文案指到具体卷;subPath 填绝对路径 → 当场红框,不用等部署 422。
