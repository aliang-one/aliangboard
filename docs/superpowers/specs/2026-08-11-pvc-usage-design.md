# PVC 实际用量(已用 / 容量%)设计

> **Status:** Approved design (2026-08-11),待转实现计划(writing-plans)。

## Goal

让用户在 PVC 列表(每行)与 PVC 详情页看到 **实际已用存储** 与 **占容量百分比**(如「3Gi / 10Gi · 30%」+ 进度条),而非仅当前显示的「申请容量」。列表每行 + 详情页都要显示。

## 背景 / 现状

- `mapPVC`(`src/composables/useResourceMappers.js:171`)当前只取 `capacity: spec.resources.requests.storage || status.capacity.storage`——这是**申请/授予容量**,不含「实际已用」。K8s 的 PVC 对象本身**不存**已用字节数。
- 真实已用唯一来源:**kubelet `/stats/summary`**——按 node → pod → volume 给出 `usedBytes` / `capacityBytes` / `inodesUsed` / `inodesCapacity`,且 PVC 支撑的 volume 条目带 `pvcRef: {name, namespace}`。
- 网关 `server/index.mjs` 的 `/api/k8s/*` 处理器(:1877-1890)对任意 K8s API 路径**透明透传**给 `requestKubernetes`——无白名单。故 `/api/v1/nodes/{node}/proxy/stats/summary` 经前端 `api.k8s(path)`(`src/api/client.js:122`)可达,**前提是当前集群 ServiceAccount 有 `get nodes/stats`(或 `nodes/proxy`)RBAC**。
- 复用件:`ProgressBar.vue`(`value` 为 0–100 百分比,自动 >80 红 / >60 琥珀配色)、`NsPVCDetail.vue`、`NsStorage.vue`(`column-key="nsStoragePVC"`,走自定义列目录)、Vue Query。

## 非目标 (Non-Goals)

- **不改网关**:不新增后端聚合端点(保持「透明透传 K8s API」定位)。
- **不引入 Prometheus / metrics-server 依赖**:metrics-server 不含 volume 指标;Prometheus 不保证安装。
- **默认不做 inode 用量**:仅字节已用 + 占比(inode 为后续可选)。
- 不改 DeployApp / 其它资源视图。

## Architecture

纯前端方案。新增 composable `usePvcUsage(namespace)`,一次聚合该命名空间所有 PVC 的用量,产出 `Map<pvcName, Usage>`;列表与详情**共用同一 Vue Query 缓存**(自动去重 + 统一刷新)。

```
NsStorage(列表每行) ─┐
                      ├─→ usePvcUsage(ns) ─→ { pvcName → {usedBytes, capacityBytes, percent, mounted} }
NsPVCDetail(详情卡) ─┘            │
                                 ├─ ① api.k8s('/api/v1/namespaces/{ns}/pods')        (raw pods:spec.volumes PVC 卷 + spec.nodeName)
                                 ├─ ② targetNodes = 有 PVC 卷的 pod 所在 node(去重)
                                 ├─ ③ 每 node:api.k8s('/api/v1/nodes/{n}/proxy/stats/summary')
                                 ├─ ④ 遍历 .pods[].volumes[];凡 pvcRef.namespace===ns → 记 usedBytes/capacityBytes
                                 └─ ⑤ 每 PVC 多挂载取 max usedBytes → percent = used/capacity*100
```

容量字节解析与格式化由纯函数 `bytes.js` 承担(可零依赖测试)。

## Components

### A. `src/composables/usePvcUsage.js`(新建)

**契约**:`usePvcUsage(namespace: ComputedRef<string>|string)` → `{ usage: ComputedRef<Map<string, Usage>>, noStatsAccess: ComputedRef<boolean>, isLoading, error }`,其中 `Usage = { usedBytes:number|null, capacityBytes:number|null, percent:number|null, mounted:boolean }`。

- `mounted`:**是否有 pod 引用该 PVC**(来自步骤 2 的 pod 卷声明,与 stats 完全无关)。
- `noStatsAccess`:**所有** node 的 `/stats/summary` 调用都失败(典型为 403,SA 缺 `nodes/stats`)→ true,用于把「用量为空」正确归因为权限不足而非数据未就绪。

**聚合步骤**(在 queryFn 内):
1. `const pods = await api.k8s('/api/v1/namespaces/{ns}/pods')` → 取 `items[]` 的 `spec.volumes[].persistentVolumeClaim.claimName` 与 `spec.nodeName`、`metadata.name`、卷 `name`。
2. 收集 `claimsInNs = Set<claimName>`;`podVolByNode = Map<nodeName, Array<{podName, volumeName, claimName}>>`(只含有 PVC 卷的 pod)。
3. `targetNodes = [...podVolByNode.keys()]`(去重)。空则直接返回空 Map。
4. 对每个 `node ∈ targetNodes`:`const s = await api.k8s('/api/v1/nodes/{node}/proxy/stats/summary')`(并发 `Promise.all`,单个失败 catch 掉返回 null)。
5. 遍历每个非空 stats 的 `.pods[]`:对 `pod.volumes[]` 中 `pvcRef?.namespace === ns` 的条目,记 `pvcRef.name → {usedBytes: +vol.usedBytes, capacityBytes: +vol.capacityBytes}`;无 `pvcRef` 时,用 `{podName: pod.podRef.name, volumeName: vol.name}` 回到 `podVolByNode` 反查 claimName 兜底。
6. 聚合:同一 claimName 多次出现(多 pod/多 node,如 RWX)→ `usedBytes = max`, `capacityBytes` 取对应(或 max)。`percent = capacityBytes ? round(usedBytes/capacityBytes*100) : null`。
7. `mounted` 由「pod 是否引用」决定,不由 stats 决定:凡 `claimName ∈ claimsInNs`(步骤 2 收集到)→ map 中 `mounted=true`(用量字段允许为 null,表示已挂载但暂无 stats);用量由步骤 5–6 填充,缺失则 null。**未被任何 pod 引用的 PVC 不在 map 中** → 列表合并时走默认 `{mounted:false}`。
8. `noStatsAccess = (targetNodes 非空 且 步骤 4 每个 node 调用都失败)`。
9. 返回 `{ usage: Map<claimName, Usage>, noStatsAccess }`。

**Vue Query**:key `['cluster', cid, 'pvc-usage', ns]`;`refetchInterval 60000`、`staleTime 30000`、`retry 1`、`refetchOnWindowFocus true`。列表与详情传相同 `ns` → 命中同一缓存。

**RBAC / stats 不可达**(SA 无 `nodes/stats`,或 kubelet stats 不可达):步骤 4 全失败 → `noStatsAccess=true`;map 仍含 `mounted`(来自步骤 1 的 pods,无需额外权限),用量字段 null。组件据 `noStatsAccess` 给出权限/不可达提示;**不抛错、不影响其它列或页面**。

### B. `src/utils/bytes.js`(新建,纯函数)

- `formatBytes(n)`:`n` 为字节数;返回人类可读(1020 → '1020 B', 2048 → '2.0 Ki','10Gi'-parsed 等);负/NaN → '—'。
- `parseSizeToBytes(s)`:`'10Gi'→10737418240`、`'512Mi'→536870912`、`'1Ti'`、纯数字;非法 → `null`(作分母兜底)。
- 纯逻辑,不引 Vue;纳入 `scripts/test.mjs` 零依赖运行器。

### C. 列表(`src/views/NsStorage.vue`)—— 行合并 + 「已用」列

- 行数据合并用量:`nsPVCs.map(p => ({ ...p, ...(usage.get(p.name) || {usedBytes:null, capacityBytes:null, percent:null, mounted:false}) }))`。
- 给 `nsStoragePVC` 列目录新增「已用」列(`thUsed` 键 + 列定义),单元格三态:
  - `percent != null` → `ProgressBar(:value="percent")` + 小字 `formatBytes(usedBytes) / formatBytes(capacityBytes)`;
  - `percent == null && mounted` → 「—」,tooltip 在 `noStatsAccess` 时显「需要 nodes/stats 权限」、否则显「暂无用量数据」;
  - `mounted === false` → 灰字「未挂载」。

### D. 详情(`src/views/NsPVCDetail.vue`)——「存储用量」卡

- `ProgressBar(:value="percent" showLabel :label="t('ns.storage.usageTitle'))` + 文本 `formatBytes(usedBytes) 已用 / formatBytes(capacityBytes) 容量(percent%)`。
- `percent == null && mounted` → `noStatsAccess` ? 「需要 nodes/stats 权限(或 stats 不可达)」 : 「暂无用量数据」。
- `!mounted` → 「未挂载」。

## Data Flow

进 ns 存储页 → `usePvcUsage(ns)` 首跑 → 列表每行即时渲染用量条;点 PVC 进详情 → 同 query 缓存命中 → 卡片即时显示;60s 后台轮询 + 窗口聚焦重取,列表/详情同步刷新;写卷/删 pod 后手动 refetch 或等下次轮询。

## 错误处理 / 边界

- **RBAC 403**(SA 无 `nodes/stats`):步骤 4 全失败 → map 仅含 `mounted`,用量 null → 列表显「—」+ tooltip、详情显权限提示;**不抛错、不影响其它列或页面**。
- **PVC 未挂载**(无 pod 引用该 PVC):`mounted=false`,列表「未挂载」、详情对应文案。注:`mounted` 只看 pod spec 是否引用,与 PVC phase 无关——Pending PVC 若被某 pod(含 pending pod)引用则 `mounted=true`(只是暂无 stats)。
- **RWX 多 pod 挂载**:取 `max usedBytes`(同一卷,各挂载点近似)。
- **stats capacityBytes ≠ PVC 申请量**:分母用 stats 的 `capacityBytes`(真实 PV 容量);PVC 申请量仍作为既有「容量」列展示供对照。
- **pods 列表失败**:query error → 列表/详情用量区显示「—」,不阻塞页面其余部分。
- **空 ns / 无 node**:map 空,正常降级。

## i18n(zh.json / en.json 对齐,`ns.storage.*`)

新增键:`used`(已用 / Used)、`usageTitle`(存储用量 / Storage usage)、`notMounted`(未挂载 / Not mounted)、`usageNoPermission`(需要 nodes/stats 权限 / Requires nodes/stats permission)、`usedOfCapacity`('{used} / {capacity}')、`thUsed`(已用 / Used,列头)。门禁 `npm run i18n:check`。

## Testing(CLAUDE.md 政策)

**纯逻辑(零依赖运行器,`scripts/test.mjs`):**
- `bytes.js`:`formatBytes`(0、1020、2048、1.5e12、负、NaN)、`parseSizeToBytes`('10Gi'、'512Mi'、'1Ti'、'1024'、非法 → null)。

**组件/composable(vitest + happy-dom,mock `@/api/client` 的 `api.k8s`):**
- `usePvcUsage`:
  - 正常:`/pods` 返回 1 pod(nodeA,卷 data→pvc1)→ `/nodes/nodeA/proxy/stats/summary` 返回该 pod volume 带 `pvcRef{name:pvc1, usedBytes:3G, capacityBytes:10G}` → map: pvc1 = {percent:30, mounted:true}。
  - RWX 多挂载取 max。
  - Pending PVC(pods 无引用)→ mounted:false。
  - node stats 全 403 → map 仅 mounted,用量 null,不抛。
  - 无 pvcRef 时按 {podName,volumeName} 兜底匹配。

**基线(每任务结束):** `npm run typecheck`、`npm run i18n:check`、`npm run build`、`npm run test:unit`。

**手测(需连真实集群):**
- 列表每行显示用量条 + 「xGi/yGi」;详情卡显示百分比;60s/聚焦刷新;
- 拿掉 SA 的 `nodes/stats` → 列表降级「—」、详情权限提示,不报错;
- Pending PVC 显「未挂载」。

## 文件清单

**新建:**
- `src/composables/usePvcUsage.js` + `src/composables/__tests__/usePvcUsage.test.js`
- `src/utils/bytes.js` + `src/utils/__tests__/bytes.test.mjs`(零依赖运行器;或并入 scripts/test.mjs 约定)

**修改:**
- `src/views/NsStorage.vue`(合并用量 + 「已用」列单元格)
- `src/views/NsPVCDetail.vue`(「存储用量」卡)
- 自定义列目录(加 `nsStoragePVC` 的「已用」列 + `thUsed` 键;位置:`useTableColumns`/列 catalog 所在文件)
- `src/locales/zh.json`、`src/locales/en.json`

**不改:** 网关(`server/*`)、DeployApp、其它资源视图。

## Global Constraints(对齐 CLAUDE.md / 仓库政策)

- **零新增依赖**:不引任何新运行时/工具链;复用 `@tanstack/vue-query`、`ProgressBar.vue`、`api.k8s`。
- **网关零改动**:全部聚合在前端 composable 完成。
- **i18n 门禁**:`npm run i18n:check` 绿,zh/en 键一一对应。
- **纯逻辑优先零依赖运行器**:`bytes.js` 走 `scripts/test.mjs`;composable 走 vitest。
- **降级不阻塞**:任何用量数据不可用都不影响 PVC 列表/详情其余部分。
