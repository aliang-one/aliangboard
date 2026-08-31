# Workload Overview 紧凑化设计(历史版本合并行 + PodCard 指标数值下移)

日期:2026-08-30
状态:已批准(用户确认范围与布局)
分支:worktree-feat+workload-overview-compact

## 1. 背景与目标

Workload 详情页(NsWorkloadDetail)两处密度问题:

1. **左列「版本历史」**:每张版本卡 4 行(头行 / 镜像 / 副本统计 3 盒子 / 操作行),其中副本统计(期望/当前/就绪,标签在上数值在下)与操作行(查看 YAML/回滚/删除 图标按钮)合计占 ~52px,信息密度低。
2. **中列 Pods(PodCard 行3)**:CPU/MEM 单行 flex = `[标签|56px 进度条|数值]×2`,数值形如 `124m/500m`、`182Mi/512Mi`,父行无换行、数值无 truncate(min-width:auto 不收缩),300px 窄列中长数值必然顶破卡片边框。

目标:两处高度更紧凑;PodCard 数值移到进度条下方并缩小字体,结构性根除溢出。

## 2. 范围(用户裁决)

- 改动 1/2:左列版本历史列表卡 + 中列「历史版本详情」面板**都改**(用户选择"左列+中列都改")。
- 改动 3:PodCard 为共享组件,**全局统一改**,不加 prop 分叉(用户选择"全局统一改")。消费方:NsWorkloadDetail、NsPods、NsServiceDetail、NodeDetail、PodDetail。
- 无新增 i18n 键(复用 `workload.revision.desired/current/ready` 与现有 title);无新增依赖。

## 3. 改动明细

### 3.1 左列版本卡合并行(NsWorkloadDetail.vue ~L1451-1471)

现状:「副本统计」`grid grid-cols-3`(3 个盒子,标签 9px 在上 + 数值 11px mono 在下)+「操作」行(3 个图标按钮,`justify-end`)。

改为**单行 flex**(删除上述两块,替换为):

```
│ 期望 2  当前 2  就绪 2              ⌥ ↩ 🗑 │
```

- 左侧:`flex items-center gap-1.5 min-w-0`,三个行内对 = 标签 `text-[9px] leading-none` + 数值 `ml-0.5 font-mono text-[10px] font-bold leading-none`。
- 就绪数值沿用 `revReadyClass(rev)` 着色;当前版本的 `on-primary` 色系跟随逻辑保留(标签用 `/60~70` 透明度,数值用主色)。
- 去掉盒子背景(`bg-surface-container/80` / `bg-on-primary/15`)——盒子是行内化的对立面,也是高度来源。
- 右侧:三个操作按钮(viewYaml/rollback/delete)原样保留,`ml-auto shrink-0` 推右。
- 每卡高度净省 ~30px。

### 3.2 中列历史版本详情面板合并行(NsWorkloadDetail.vue ~L1528-1559)

现状:「副本统计」3 列 grid(标签 10px + 数值 body-sm)+ 元信息 + 吸底「操作」`grid grid-cols-3`(icon 上、文字下,`mt-auto` 吸底)。

改为:3 列 grid 与吸底操作条**合并为一行**,位于 hero(镜像)之后、元信息之前:

```
│ nginx:1.24                                   │
│ 期望 2  当前 2  就绪 2        [⌥ YAML] [↩ 回滚] [🗑 删除] │
│ ── 创建于 2d / reason… ──                     │
```

- 指标侧同 3.1(标签 9px + 数值 10px mono bold,就绪 `revReadyClass` 着色,当前 >0 用 primary)。
- 操作按钮保留 **icon+文字** 横排(`text-[11px]`),样式沿用现 hover 配色(YAML/回滚 → primary hover,删除 → error hover);中列宽 300px,放得下文字。
- 移除 `mt-auto` 吸底与底部 `border-t` 条;元信息区块保持在合并行下方。
- 面板净省 ~76px。

### 3.3 PodCard 行3 数值下移(PodCard.vue L116-128,全局)

现状:单行 flex,标签 `w-6`(11px)+ 固定 `w-14` 进度条 + 数值(11px mono)。

改为**两个并排块**,每块条在上、数值在下:

```
│ CPU ▓▓▓▓▓▓▓░░░░░░░░   MEM ▓▓▓▓▓▓▓▓▓░░░░ │
│     124m/500m             182Mi/512Mi    │
```

```html
<div v-if="hasMetrics" class="flex gap-md mt-1 max-w-sm">
  <div v-if="pod.cpu" class="flex-1 min-w-0">
    <div class="flex items-center gap-1">
      <span class="text-[10px] text-on-surface-variant/50 w-6 shrink-0">CPU</span>
      <div class="flex-1 h-1 bg-outline-variant/25 rounded-full overflow-hidden">
        <div class="h-full rounded-full" :class="色带阈值不变" :style="{ width: cpuPct + '%' }"></div>
      </div>
    </div>
    <p class="font-mono text-[10px] text-on-surface-variant/70 leading-none mt-1 pl-7 truncate" :title="pod.cpu">{{ pod.cpu }}</p>
  </div>
  <div v-if="pod.memory" class="flex-1 min-w-0"><!-- MEM 同构 --></div>
</div>
```

- 数值从条右侧移到**条下方**,`pl-7`(24px 标签 + 4px gap)对齐条起点。
- 字号 11px → 10px(标签与数值);`truncate + :title` 兜底——任何容器宽度下都不再溢出。
- 进度条从固定 `w-14` 改 `flex-1`(窄列 ~100px,宽页受整行 `max-w-sm`(384px)封顶,约 150px);色带阈值(>80 error / >60 tertiary / 其余 primary|secondary)不变。
- 单指标(只有 cpu 或只有 memory)时该块独占整行(仍封顶 384px)。
- `podCpuPct/podMemPct`(pctRatio)已处理 total=0 → 0,无除零风险,不改动。

## 4. 不做什么

- 不加 prop 分叉、不保留旧布局(全局一套)。
- 不给数值追加百分比文本(进度条已编码占比,`title` 悬停有全量)。
- 不动行1/行2/行4(PodCard 其余行)、不动右列 Pod 详情、不动左列卡的头行/镜像行。
- 不改 `mapPod` 数据格式与 `pctRatio`。

## 5. 测试

- **单测(改动中新增/更新)**:
  - `PodCard.test.js`:有 metrics 时数值元素在进度条同块内(下方兄弟节点)、含 `truncate`、整行含 `max-w-sm`;长数值(如 `11234m/500m`)不产生横向溢出结构(min-w-0 链存在)。
  - NsWorkloadDetail 侧:合并行容器内同时渲染 `期望/当前/就绪` 三对标签数值与三个操作按钮(vue-query/store mock 沿用 edit-shell 测试既有基建,若挂载成本过高则以 PodCard 单测 + 手测覆盖,在计划中裁决)。
- **手测(实现后,需集群)**:workload 详情(有历史版本:左列卡合并行、中列详情面板合并行)、Pods 列表页、Service 详情、Node 详情、Pod 详情 5 处 PodCard 均无溢出、数值位于条下方。
- 门禁:`npm run test:unit` + `npm run typecheck` + `npm run i18n:check`(无新键,应全绿)。

## 6. 交付

- worktree 分支 `worktree-feat+workload-overview-compact` 上开发,完成后 `--no-ff` 合回 main(用户 2026-08-30 工作流要求)。
- 纯前端改动,无网关重启需求。
