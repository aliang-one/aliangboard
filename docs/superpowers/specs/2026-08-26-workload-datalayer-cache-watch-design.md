# Workload 族数据层:缓存永驻 + 载荷瘦身 + watch 增量 设计规格

- 日期:2026-08-26
- 状态:已获用户批准(分节呈现通过)
- 分支:`feat-workload-datalayer-watch`
- 上游脉络:前端数据层重构(Vue Query 路线,Phase 1 + P2 基座已合)的 workload 族收尾与网络开销优化

## 1. 背景与问题(根因均已验证到 file:line)

用户报障两条:

### 1.1 「应用分层」页(NsLayers)重访空白、创建 workload 返回后短暂空白

根因链(三层叠加):

1. **缓存 5 分钟即被 GC**——`src/queryClient.js:12` `gcTime: 5 * 60_000`。离开页面超 5 分钟(部署向导常常超过)后缓存清空,重访时 `data === undefined`。
2. **「加载中」与「真的空」渲染二义**——`src/views/NsLayers.vue:106/211` 以 `v-if="groups.length"` 切换空态卡片,数据未到时显示的是空状态而非骨架。
3. **重拉本身慢**——一轮 `fetchWorkloads` 打 4 个集群级全量 list(deployments/statefulsets/daemonsets `limit=1000` + **replicasets `limit=5000`**,`src/composables/useFetchers.js:97-115`),且 `attachRolloutHistory` 为每个 Deployment 附带完整发布历史与每个 ReplicaSet 的完整 pod 模板 `_template`——该数据仅 NsWorkloadDetail 回滚页消费(`src/views/NsWorkloadDetail.vue:281/362`,`src/stores/cluster.js:646-668`)。网关对 list 响应原样透传(`server/index.mjs:1940`,`managedFields` 未剥),远程集群下重拉为秒级。

### 1.2 数据请求频率高、全量高频查询

| 来源 | 频率 | 内容 |
|---|---|---|
| workload 族页面轮询 | 30s × 6 HTTP | workloads(4 个 list)+ services + ingresses,集群级全量 |
| `refetchOnWindowFocus` | 每次切回窗口 | `staleTime` 仅 15s,几乎必触发,又是 6 HTTP |
| NamespaceOverview 自适应快轮 | 部署中 3s | `useDeployFastPoll`(方向正确,但与 watch 重复) |
| store 后台定时器 | 10s × 2 | `refreshNodeHealth`(`cluster.js:695`)、`metricsTick`(`cluster.js:862`) |
| watch 增量 | 仅 pods/events | `startPodWatch/startEventWatch`(`cluster.js:705/730`),基建齐全但未推广 |

关键现状:watch 基建已完备——`k8sStream` 流式透传(`src/api/client.js:370`,网关 `server/index.mjs:1894-1928` 支持 `watch=true` 10h 长连接)、`applyWatchEvent` 不可变合并(`src/composables/useK8sQuery.js:20-33`)、resourceVersion 续接——但只覆盖 pods/events,workloads/services/ingresses 全靠全量轮询。

## 2. 目标与非目标

**目标:**

| 维度 | 现状 | 目标 |
|---|---|---|
| 重访空白 | gcTime 5min 后缓存 GC → 空态卡片数秒 | 缓存永驻 + 骨架屏,重访零空白即时显示旧数据 |
| 静止集群请求 | ~6 HTTP/30s(workload 族)+ 窗口聚焦重拉 | ~0(watch 空闲零流量) |
| 单轮 workloads 字节 | 4 list + RS `limit=5000` 全史 + `_template` + managedFields | 3 list 瘦载荷,字节降 5-10× |
| 数据新鲜度 | 最长滞后 30s | 变更秒级推送 |

**非目标(本次不动,记 follow-up):**

- store 后台 10s node-health / metrics 采样(nodes 资源族不在 workload 族)
- NsWorkloadDetail 尾部 pvcs/configmaps/secrets 的 30s 轮询(`NsWorkloadDetail.vue:894-896`)
- nodes/metrics/CRD 等其他资源族接 watch
- watch 流逐行剥 managedFields(list 已剥,watch 事件经 mapXxx 后天然丢弃,网络侧几 KB/事件暂容忍)
- Vue Query 缓存持久化到 storage(gcTime Infinity 已消除重访空白,无更早数据的展示需求)

## 3. 已裁决决策

1. **方案彻底程度**(2026-08-26 用户裁决):彻底方案——缓存修复 + 载荷瘦身 + watch 增量一步到位,workload 族全接入。
2. **watch 断线策略**(2026-08-26 用户裁决):自动重连 + 降级兜底。**推翻**旧决策「不做自动重连,由 UI 提示用户手动恢复」(`cluster.js:701-702` 注释)——理由:watch 成为主数据通道后,断流不重连 = 数据永久陈旧;风暴风险以指数退避 + 降级轮询控制。

## 4. 架构总览

```
                      ┌─ 初次/降级:list(网关剥 managedFields/last-applied)─────────┐
                      │                                                              ▼
Vue Query 缓存   useClusterWatch 管理器(单例,store 内)
['cluster',cid,   ├─ deployments  ──watch──┐
 'workloads']  ◀─┼─ statefulsets ──watch──┤ merge 进同一 key
                  ├─ daemonsets   ──watch──┘  (applyWatchEvent + uidKey)
                  ├─ services     ──watch──▶ ['cluster',cid,'services']
                  ├─ ingresses    ──watch──▶ ['cluster',cid,'ingresses']
                  ├─ pods(已有)  ──watch──▶ ['cluster',cid,'pods']
                  └─ events(已有)──watch──▶ ['cluster',cid,'events']
                  断线:退避重连 1s→60s;410→自动 relist;连续 5 败→降级 60s 轮询
```

数据流单一真相:所有消费者只读 Vue Query canonical key;watch 与 invalidate 是两个写入方,均走不可变合并/全量替换,收敛正确。

## 5. 详细设计

### 5.1 缓存策略(空白根除)

- canonical key(`['cluster', cid, resource]`)的 `gcTime`:`5 * 60_000` → `Infinity`(`src/composables/useK8sQuery.js:43` 默认值)。正确性不靠 GC,靠 watch 纠偏 + mutation 后显式 invalidate(`cluster.js:30-34` `invalidateResource` 已存在)。切集群 `queryClient.clear()`(`cluster.js:995`)已兜底不串台。
- workload 族 canonical query 的 `refetchOnWindowFocus` 关闭(watch 在,聚焦重拉是纯浪费);其余资源保持现状。
- **骨架态三分**:
  - `isPending && 无缓存数据` → 骨架屏(新增共享组件 `ListSkeleton`,workload 族列表/分层页统一接)
  - 有数据(哪怕 stale)→ 直接渲染旧数据 + 后台静默刷新
  - `data.length === 0 && !isPending` → 真空态文案
  - 消除 `NsLayers.vue:106` 的 `v-if="groups.length"` 二义性。

### 5.2 载荷瘦身

**第一刀:拆回滚历史出共享列表(最大字节收益)**

- `fetchWorkloads()`(`useFetchers.js:97-115`)删除 replicasets 拉取与 `attachRolloutHistory` 调用,只留 dep/sts/ds 三类 mapped 对象。
- 新 `fetchWorkloadRevisions(name, ns)`:拉单 Deployment + 命名空间级 ReplicaSets 列表(`/apis/apps/v1/namespaces/{ns}/replicasets`,按 `ownerReferences` 过滤——RS 不携带指向 Deployment 的 controller-uid label,不能走 labelSelector),复用 `attachRolloutHistory` 抽出的单对象逻辑。StatefulSet/DaemonSet 维持现状(当前版本仅展示当前 revision)。
- 消费方两处同步改:
  - NsWorkloadDetail revisions tab → 自有 `useResourceDetail`(key `['cluster', cid, 'revisions', ns, name]`,进 tab 才拉)
  - `rollbackWorkload`(`cluster.js:646`)→ 改调 `fetchWorkloadRevisions` 取 `target._template`(fetch-first 语义不变)
- 护栏:回滚链路单测钉死「PATCH 请求体含完整 template」。

**第二刀:网关 list 响应剥冗余**

- `/api/k8s/*` 的 list GET 响应(非 watch 流)在 `sendJson` 前剥每个 item 的 `metadata.managedFields` 与 `annotations['kubectl.kubernetes.io/last-applied-configuration']`(`server/index.mjs` K8s 代理分支)。
- 安全性:前端 managedFields 消费方全在删它(useLiveYaml/useYaml/client.js 导出等),无读取方;`NsServiceDetail.vue:239`「从缓存对象生成 YAML」只依赖 spec/status。**不做**更深字段裁剪。
- watch 流保持字节级透传不剥(follow-up)。

### 5.3 watch 增量通道

> **2026-08-26 修订(上线当日事故)**:初版 7 条独立 watch 长连接打爆浏览器 HTTP/1.1 同源 6 连接上限(6 条 watch + HMR WS 占满,第 7 条 watch 与全部数据请求在浏览器排队 pending → 全站白屏,`ss` 实测 7×5173/6×8787)。传输层改为**网关多路复用单流**;`useClusterWatch` 状态机与页面接线不变。

- **传输(修订后)**:网关新增 `GET /api/k8s-watch?resources=<7 资源 CSV>&rv_<r>=<n>`(`server/k8s-watch-mux.mjs`),单条 NDJSON 流聚合 7 路上游 watch,行格式 `{"r":<资源>,"t":<ADDED|MODIFIED|DELETED>,"o":<对象>}`;任一上游失败(含 410 RV 失效)发 `{"r":...,"err":<status>}` 后整通道关闭。前端 `k8sChannel`(client.js,与 k8sStream 共享行读取循环)单连接接入,demux 后按资源走 `applyWatchEvent` 写各自 canonical key——浏览器恒占 **1 条**连接。
- **断线语义(修订后)**:通道级退避重连/降级沿用 `createWatchController`;err 行 → 该资源 `refetchQueries`(刷新 registry RV)后拆通道重连;410 走 onError({status:410}) 不计失败(RV 过期计失败会误降级)。
- **开关**:`localStorage.aliangboard.watchFamily` —— 默认开;'0' 为 kill-switch 强制回落轮询世界(60s 兜底)。
- 旧入口 `startPodWatch/startEventWatch` 保留直连单资源流(NsPods 手动 toggle 等场景;与家庭通道事件幂等双写,多占 1 条连接,已知可接受)。
- 将 `startPodWatch/startEventWatch` 泛化为 `useClusterWatch` 管理器(store 内单例),每资源一条配置 `{ watchPath, mapFn, queryKey }`;旧两个函数改为薄封装,外部行为与现有启动点兼容。
- 新接 5 条:deployments / statefulsets / daemonsets(各自事件 merge 进同一 `['cluster',cid,'workloads']` key)、services、ingresses;连同已有 pods/events 共 7 条长连接,空闲零流量。
- **RV 生命周期**:每次 list(初次 fetch 与降级轮询)把响应 `metadata.resourceVersion` 登记进管理器 → watch 从该 RV 续接只收变更;事件中的新 RV 持续前滚。
- **断线状态机**(已裁决):
  - 指数退避重连:1s→2s→…→60s 封顶
  - `410 Gone`(RV 失效)→ 自动 relist:invalidate + 重拉全量 + 新 RV 续看;410 不计入失败次数
  - 连续 5 次重连失败(网络错误/非 410 的异常状态)→ 降级轮询:该资源 query 的 `refetchInterval` 置 60s
  - 恢复成功 → 回升 live(轮询关闭)
  - UI 三态 chip:live / 重连中 / 已降级
- **生命周期**:进入集群(selectCluster/登录)统一启动 workload 族 watch;切集群 stop-all + `clear()`(已有)。
- mutation 后 invalidate 与 watch 事件并发写缓存:`applyWatchEvent` 不可变合并 + Vue Query structuralSharing,最后写者胜,收敛正确(既有语义,不改)。

### 5.4 轮询治理

- workload 族页面固定 `refetchInterval: 30000`(NsLayers/NsWorkloads/NsServiceDetail/NsHPA/NsWorkloadDetail 等):改为响应式 `computed(() => watchLive ? false : 60000)`——live 时零轮询,降级时 60s 兜底。
- NamespaceOverview 的 `useDeployFastPoll` 3s/30s 自适应:保留,仅在降级态生效(live 时部署事件由 watch 推送)。
- 注意既有约定:`refetchInterval` 须直传 ref,不得传解包值(见 memory:ns-overview-adaptive-polling)。

## 6. 错误处理

- watch 断流 ≠ 数据错:缓存永驻,断流期间显示旧数据 + 三态 chip;降级轮询接管纠偏。
- relist 失败(网关不可达):维持降级终态,靠窗口聚焦/定时重试回升;toast 一次,不轰炸。
- watch 启动失败(如网关不支持):静默落入降级轮询,页面功能不受影响。

## 7. 测试与验收

**单测(vitest):**

- watch 状态机:退避序列、410 → relist、连续 5 败 → 降级、恢复 → 回升(假时钟)
- `fetchWorkloadRevisions`:owner 过滤、revision 排序、`_template` 完整性
- `ListSkeleton` 渲染分支;NsLayers loading/stale/empty 三态
- **回滚护栏**:`rollbackWorkload` PATCH 请求体含目标 `_template` 完整结构

**网关(node --test):**

- list 响应剥字段:pods/deployments 样本断言 managedFields / last-applied-configuration 不在、spec/status 完整
- watch 流与单对象 GET 不受影响

**手测清单(需 kind/真实集群):**

**实现完成,回归全绿,以下 8 项待执行(需真实集群环境):**

1. NsLayers 离开 >5min 后重访:首帧即内容(旧数据),无空态闪烁
2. 部署向导建 workload → 返回分层页:无空白
3. `kubectl scale deployment` → NsWorkloads/NsLayers 秒级跟变(网络面板无 list 轮询,仅 watch 字节)
4. 停网关 30s:chip 转「重连中」→ 连续失败后「已降级轮询」且 60s 轮询可见 → 重启网关 → 回「实时」
5. watch 断开期间 `kubectl delete pod` → 恢复后(降级轮询或 relist)列表对齐
6. NsWorkloadDetail revisions tab 正常展示;一键回滚到旧 rev 后 spec.template 与该 rev 一致
7. 切换集群:旧集群 watch 全断(网关连接数归零)、缓存清空不串台、新集群 7 条 watch 重建
8. 网络面板确认:list 响应无 managedFields/last-applied-configuration;单对象 GET 仍在(不剥)

**验收指标:**停留在 workload 族页面期间网络面板 0 新增请求(集群无变更时,watch 长连接无字节);NsLayers 重访首帧即内容。注:重访页面时若数据已 stale(静止集群无 watch 事件刷新 `dataUpdatedAt`),至多触发一轮兜底 list——这是刻意的安全网,不是缺陷。

## 8. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 回滚链路改数据源(最高危) | fetcher 单源两消费方共用 + 护栏单测 + 手测回归 |
| watch 与 invalidate 竞写 | 不可变合并语义不变(既有) |
| ~~7 条长连接压力~~ → **浏览器同源 6 连接上限**(已发生,当日修订) | 传输改多路复用单流(§5.3 修订);watchFamily '0' kill-switch |
| mux 网关侧无背压(write 返回值未理) | 与旧流式分支同特性,7 路聚合放大——follow-up 加 drain |
| mux 双上游同 tick 失败二次 write-after-end | 实践 cosmetic(浏览器反正重连)——follow-up 加 ended 守卫 |
| NsPods toggle 与家庭通道双写 pods | applyWatchEvent 幂等,多占 1 连接,已知可接受 |
| gcTime Infinity 内存增长 | mapped 对象为瘦结构;切集群 clear 已有;量级(百资源 × 几 KB)无虞 |
| 网关剥字段误伤未知消费方 | 仅剥已验证零读取方的两个字段;单测钉住 spec/status 完整 |
| watch DELETED 事件与在途全量 refetch 竞写(旧快照后到覆盖删除) | 展示级陈旧:该条目短暂复活,路由重挂(staleTime 15s→remount refetch)或下一事件自愈;接受为已知限制,不为此引入合并复杂度 |

## 9. 交付物清单

- 前端:`src/composables/useClusterWatch.js`(新)、`useK8sQuery.js`(gcTime/焦点策略)、`useFetchers.js`(fetchWorkloads 瘦身 + fetchWorkloadRevisions)、`stores/cluster.js`(watch 泛化迁移 + rollbackWorkload 改源)、workload 族视图(interval 响应化 + 骨架态)、`components/common/ListSkeleton.vue`(新)
- 网关:`server/index.mjs`(list 响应剥冗余)
- 测试:如 §7
