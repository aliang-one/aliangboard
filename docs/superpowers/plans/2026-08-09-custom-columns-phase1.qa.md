# 自定义列 Phase 1 — 全量验证结果 + 手测清单

> 配套实现计划:`2026-08-09-custom-columns-phase1.md`。本文档记录 Task 7 的自动化门禁结果与手测要点,供 PR 前最终核对。

**分支:** `feat/custom-columns-phase1`
**验证日期:** 2026-08-09
**Node:** v25

---

## Step 1: 全量自动化门禁结果

| # | 命令 | 结果 | 实际输出 |
|---|------|------|----------|
| 1 | `npm run typecheck` | ✅ PASS | `✓ 101 个 .js/.mjs 文件通过 node --check` |
| 2 | `npm run i18n:check` | ✅ PASS | 残存中文 0 / 键对齐 ✓ / 引用键缺失 0 / 动态引用键缺失 0 |
| 3a | `node scripts/test.mjs`(零依赖运行器) | ✅ PASS | `✓ 65 用例全部通过`(含 `migrateV1toV2` / `reconcile` 系列 custom-columns 单测) |
| 3b | `node --test server/*.test.mjs` | ✅ PASS | `tests 203 / pass 203 / fail 0` |
| 4 | `npm run test:unit`(vitest 全量) | ⚠️ 77/78 PASS(1 预存例外) | 见下方「已知例外」 |
| 5 | `npm run build`(vite build) | ✅ PASS | `✓ built in 15.85s`,exit 0(chunk-size 警告为既有 advisory,非错误) |

### 已知例外(不视为回归)

`src/components/layout/__tests__/SideNavBar.home.test.js` 单条失败:

```
Error: No 'queryClient' found in Vue context, use 'VueQueryPlugin' to properly initialize the library.
  at useQueryClient  node_modules/@tanstack/vue-query/src/useQueryClient.ts:18:10
  at useBaseQuery    node_modules/@tanstack/vue-query/src/useBaseQuery.ts:82:32
  at useQuery        node_modules/@tanstack/vue-query/src/useQuery.ts:136:9
  at useResourceList src/composables/useK8sQuery.js:40:18
  at setup           src/components/layout/SideNavBar.vue:13:29
```

**根因(已核实):** 该测试缺 `vi.mock('@/composables/useK8sQuery', ...)` —— SideNavBar setup 期走真实 `useResourceList` → 撞 Vue Query 上下文。

**为何不是本 phase 回归:** merge-base(`2dbc0d0`)版本的该测试**同样缺此 mock**(本分支基线即如此)。main 在本分支分叉**之后**才于 commit `0a29d02 test(sidenav): 补 SideNavBar.home 缺失的 useResourceList mock` 补上修复;本分支尚未合并该修复,故仍失败。

```
$ git merge-base main feat/custom-columns-phase1
2dbc0d01bf19b3f92bc03d6d0bcc082f18b2536f
$ git merge-base --is-ancestor 0a29d02 feat/custom-columns-phase1 && echo YES || echo NO
NO   # 分支未含 main 上的修复
```

**合并前动作:** rebase / merge main 时,`SideNavBar.home.test.js` 会冲突 —— 保留 main 版本(含 mock)即可,本 phase 未改该文件逻辑。7 个 custom-columns 任务**均未**改动 SideNavBar 测试或组件。

---

## Step 2: 手测清单

> 在 `npm run dev` 下进行,默认中文 locale。每项核对后打勾。

### A. 就地列管理(表头 ☰ 弹层)

- [ ] **Nodes 页**:表头末尾出现 `☰` 图标;点击展开弹层,显示当前表的所有列(带勾选状态)。
- [ ] 取消勾选「CPU」→ 该列从表格消失;重新勾选 → 列回来。
- [ ] **刷新页面**:勾选/取消状态保持(localStorage 持久化)。
- [ ] **Workloads 页**:同样有 `☰`,可勾选/取消列(如 IMAGE、restarts)。
- [ ] **Namespaces 页**:同样有 `☰`,可管理列。
- [ ] **Network → Services 页** + **Network → Ingress 页**:均有 `☰`,可就地管理列。

### B. 拖拽排序

- [ ] 在 `☰` 弹层内,拖拽某列到新位置 → 表头顺序随之变化。
- [ ] 用 `▲` 按钮:选中某列点上移一位。
- [ ] 用 `▼` 按钮:选中某列点下移一位。
- [ ] **刷新页面**:顺序保持。
- [ ] 顺序变更对 5 张表(Nodes/Workloads/Namespaces/Services/Ingress)均生效。

### C. 列宽拖拽

- [ ] 鼠标移到表头某列右边缘 → 出现 resize 光标。
- [ ] 按住拖动 → 列宽实时变化。
- [ ] 拖到极窄 → 不低于下限(60px);拖到极宽 → 不超上限(600px)。
- [ ] **刷新页面**:列宽保持。
- [ ] 列宽对 5 张表均生效。

### D. Settings → 自定义列 tab

- [ ] 进入 Settings,看到「自定义列」tab。
- [ ] tab 内**内联**展示每张表(Nodes/Workloads/Namespaces/Services/Ingress)的列管理器,可逐表勾选/排序。
- [ ] 每张表有独立的「重置」按钮,点该表的 reset → 该表恢复默认列集与顺序。
- [ ] 「**全部重置**」按钮:点击 → 清空所有 5 张表的自定义(显隐/顺序/列宽全部回归默认)。

### E. i18n 切换

- [ ] 切换到**英文** locale:
  - 表头文字变英文(走 `cols.<table>.<col>` 与 `cols._c.*` 键)。
  - `☰` 弹层内列名、按钮文案(如「全部重置」「向上」「向下」)变英文。
- [ ] 切回**中文**:文字全部回中文。
- [ ] 两种语言下,自定义(显隐/顺序/列宽)**配置本身不变**(配置存的是 col key,与 locale 解耦)。

### F. 向后兼容(未接 catalog 的视图)

- [ ] **RBAC**(Roles / RoleBindings / ClusterRoleBindings 等任一):表格外观与操作与改前一致(无 `☰`、无列宽拖拽,DataTable `columnKey` 未传 → 零行为变化)。
- [ ] **Storage**(PersistentVolumes / PersistentVolumeClaims / StorageClasses 任一):同上,与改前一致。
- [ ] **ApiKeyManagement**:同上,与改前一致。
- [ ] 任何硬编码 `<table>` 视图(非 DataTable):外观与改前一致。

### G. 隐私模式

- [ ] 启用隐私模式(禁 localStorage / 无痕窗口):页面不报错。
- [ ] `☰` 弹层、勾选、排序、列宽**静默降级** —— 操作生效于当前会话,刷新后回到默认(无 localStorage 写入,不抛错)。

---

## Step 3: 收尾

- [ ] 确认分支:`git branch --show-current` → `feat/custom-columns-phase1`。
- [ ] Phase 1 7 任务全部完成,可发起 PR。
- [ ] PR 合并前:rebase / merge main,解决 `SideNavBar.home.test.js` 冲突(保留 main 的 mock 版本)。
- [ ] Phase 2(覆盖扩张到更多表)须与 Vue Query 数据层重构错开排期。
