# 小修一揽子(fix/small-fixes-batch)

## 背景

容器配置排版与 env 交互两个特性落地后,盘点项目遗留的小问题(会话审计 + 项目记忆挂账 + 三路代码探查),收敛出一批低风险小修。分支 `fix/small-fixes-batch`,基于 main `c4408e9`。

## 修复项

### ① DeployApp 空行跳过推广(`src/views/DeployApp.vue` validate() L657-671)

env 三区块已有 `isEmptyEnvRow` 空行跳过(上个特性);推广到其余四个「加了行又不想填会卡部署」的区块:

| 区块 | 空行判定字段(全空 → 跳过) | 半填仍报 |
|------|--------------------------|----------|
| ports(L671) | `['containerPort']` | `deploy.portMissing` |
| volumeMounts(L657-668) | `['mountPath','pvcName','hostPath','server','cmName','secretName']` | 现有类型化错误(volumeMissingMountPath 等) |
| initContainers(L669) | `['name','image','command','args']` | `deploy.initContainerMissingImage` |
| extraContainers(L670) | `['name','image','command','args']` | `deploy.sidecarMissingImage` |

注意:各 `addXxx()` 的预填默认值(protocol='TCP'、type='pvc'、cpu/mem 预设、genVolName())不算"已填"——判定字段刻意只列用户语义字段。YAML 生成端本就 `.filter()` 跳过不完整行,两端语义对齐。复用 `@/utils/envRows` 的 `isEmptyEnvRow`,不改其实现(函数名虽叫 envRow,语义是通用行判空;不更名,避免无谓 churn)。

### ② makeCrud sideEffects 加 ok 守卫(`src/stores/cluster.js` ~L346-348)

`add()` 现状:`sideEffects.onAdd(item)` 无条件触发 → 远端创建失败时 services 命名空间计数 +1(漂移)。改为仅 `r.ok` 时触发;`invalidateResource(plural)` 保持无条件(无害刷新)。`delete()`/`remove()` 里的 `sideEffects.onDelete` 同族检查:仅删除成功时触发(实现时 Read 确认 remove 的返回形状,同 `remoteDelete` 的 ok 语义)。

补 store 单测(vitest,`src/stores/__tests__/`):mock 远端创建失败 → `onAdd` 不触发;成功 → 触发。

### ③ 5 个无视 `{ok}` 的调用方补契约

统一照 NsServices 现成模式(`const r = await store.addX(...); if (r && r.ok === false) return`,注释「远端创建失败:保留弹窗(错误已由 store notify)」):

| 调用方 | 位置 | 现状问题 |
|--------|------|----------|
| `NsWorkloadDetail.saveExpose` | ~L744 | 失败仍弹成功 toast + 关弹窗 |
| `NsStorage` addPVC | ~L81 | 失败仍走后续(关窗/刷新) |
| `Storage` addPVC | ~L55 | 同上 |
| `NsRBAC` addServiceAccount | ~L82 | 同上 |
| `IngressClasses` addIngressClass | ~L40 | 同上 |

各调用方后续行为(关弹窗/notify 成功/invalidate)只在 ok 时执行;行号实现时按内容定位。

### ④ KIND_API_PATH 去重(新增 `server/kind-paths.mjs`)

现状两份定义已漂移:`server/index.mjs` ~L992-1009(15 kind,SP3 扩展后)vs `server/routes/workbench-conversations.mjs` ~L14-24(9 kind 内联副本)。routes 侧缺 nodes/persistentvolumes/persistentvolumeclaims/storageclasses/networkpolicies/serviceaccounts → 工作台 @ 这些资源返回「不支持的 kind」。

修法:抽 `server/kind-paths.mjs` 导出唯一 `KIND_API_PATH`(取 index.mjs 的 15 kind 完整版),两个消费方 import。跑 `npm run test:server` 全绿(现有 workbench-conversations 测试覆盖 routes 行为)。

### ⑤ NamespaceDetail query key 快照(`src/views/NamespaceDetail.vue:27`)

`key: ['cluster', cid, 'namespaces', nsName.value]` → `nsName`(传 ref 本体,与全库 ⑦ 号修复同一模式)。

### ⑥ 清理

- 提交两份未跟踪 plan 草稿:`docs/superpowers/plans/2026-08-12-deployapp-container-config-layout.md`、`2026-08-13-deploy-env-interactions.md`(特性已合并,plan 入库作档案)。
- `git worktree prune`(只清失效注册,不动活跃 worktree)。

## 明确不修(销账理由)

- **"find 边界"**(LLM 硬化挂账):实地核查仅测试代码命中 `history[history.length-1]`,生产代码已用 `messages[0]?.role` 守卫——无事可修。
- **"refs 冗余"**(同上):创建会话时抓取 refs 服务前端 ResourceCard、发消息时每轮刷新是硬化的刻意特性;「两次抓取」是无状态设计的固有成本,无安全小修法,需单独设计。

## 测试与门禁

- ②:新增 store 单测(vitest);①③⑤:靠 `npm run typecheck` + `npm run build` + `npm run test:unit` 全量;④:`npm run test:server`;全部任务:`npm run i18n:check`(本批无新 i18n 键,门禁须保持绿)。
- 无新增外部依赖;无新 i18n 键。

## 影响面

- `src/views/DeployApp.vue`(validate 四行区)
- `src/stores/cluster.js`(add/delete sideEffects 守卫)+ 新 store 测试
- `src/views/NsWorkloadDetail.vue`、`NsStorage.vue`、`Storage.vue`、`NsRBAC.vue`、`IngressClasses.vue`(各 ~3 行)
- `server/kind-paths.mjs`(新)、`server/index.mjs`、`server/routes/workbench-conversations.mjs`
- `src/views/NamespaceDetail.vue`(1 行)
- `docs/superpowers/plans/` ×2 入库
