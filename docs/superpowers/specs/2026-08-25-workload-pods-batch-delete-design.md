# 工作负载详情 Pods tab 批量删除设计

日期:2026-08-25 · 来源:用户需求(NsPods 批量删除的推广)· 状态:已与用户对齐

## Context

NsPods 列表已有卡片批量删除(选中集跨分页/allSettled 汇总/失败保留重试,issue #3 第 2 点)。用户要求工作负载详情页(NsWorkloadDetail)的 Pods 子导航也支持。该页 Pods tab(:1833-1867)是 计数+状态筛选 chips+双列 PodCard 网格(`managedPods`/`filteredPods`),单删已有(confirmDeletePod+Modal)。批量逻辑现内联在 NsPods(~45 行)——两个消费方,抽 composable 单一事实源。

## 设计

### `src/composables/usePodBatchDelete.js`(新)

```js
usePodBatchDelete({ universe, candidates, getNamespace, onOpen })
// universe:     ComputedRef<Pod[]> 存在性校验全集(NsPods: nsPods / WLD: managedPods)
// candidates:   ComputedRef<Pod[]> 全选范围(NsPods: filtered / WLD: filteredPods)
// getNamespace: () => string
// onOpen:       (pod) => void 非批量模式的卡片点击回退(导航)
// 返回 { batchMode, selectedNames, showBatchModal, toggleSelect, enterBatch, exitBatch,
//        selectAllCandidates, clearSelection, batchTargets, batchNamesPreview, onCardClick, handleBatchDelete }
```

- 逻辑自 NsPods:88-131 **原样迁入**:选中集 Set 跨筛选保留;`batchTargets = universe ∩ selectedNames`(列表刷新后失效项自动排除);`batchNamesPreview` 前 10+「等 N 个」;`handleBatchDelete` = `Promise.allSettled(deletePod)` + `summarizeResults` → 全成 notify+清空+退出 / 部分败 notify(前 5+等 N 个)+保留失败选中不退出
- 内部自引 `useClusterStore`(`deletePod`)、`notify`、`useI18n`(键全量复用既有 `ns.pods.batch*`,**零新键**)
- NsPods 重构接上:删内联块改 `const batch = usePodBatchDelete({ universe: nsPods, candidates: filtered, ... })`(模板引用经解构保持不变,`selectAllFiltered`→`selectAllCandidates`);行为保持

### NsWorkloadDetail Pods tab 接线(:1833-1867)

- 头部行(:1835 筛选 chips 之后):批量开关(两态,样式同 NsPods)+ 批量态操作条(已选 N/全选=当前 filteredPods/清空/删除所选 disabled@0)
- PodCard(:1850-1859)加 `:selectable="batchMode" :selected="batchMode && selectedNames.has(p.name)"`,`@click="goPodDetail"` → `@click="onCardClick"`(goPodDetail 作 onOpen 回退);actions 插槽(终端)与单删不动
- 文件末尾(单删 Modal 旁)追加批量确认 Modal(与 NsPods 同款:数量+batchNamesPreview+控制器重建警告——本页语境尤其贴切)

## 测试

- 新 `src/composables/__tests__/usePodBatchDelete.test.js`(补此前视图层无测的洞):选中切换/全选=candidates 范围/batchTargets=universe∩selected 存在性校验/onCardClick 两路/handleBatchDelete 全成(清空+退出+关弹窗)与部分败(保留失败选中+不退出)——`vi.mock('@/stores/cluster')` 注入 deletePod 成/败
- NsPods 重构与 WLD 接线:既有套件+门禁代行,手测收尾

## 验证

门禁四连+i18n:check 全绿(i18n 无改动应零差)。手测:WLD Pods tab 进批量→多选→全选(当前筛选)→确认弹窗名单→删除 toast 汇总;Deployment 重建的新 Pod 由轮询补回;NsPods 批量行为不回归。

## 明确不做

ServiceDetail Endpoints 的 PodCard 批量(未要求);批量重启/其它批量操作;跨 ns。
