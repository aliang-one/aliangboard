# 工作台项目管理+项目记忆入口可见性修复 — 设计

- 日期:2026-09-01
- 状态:已批准(brainstorming 三决策问答:①卡片 ⋮ 菜单 ②聊天页空态卡 ③删死组件+测试移植)
- 范围:**纯前端装配层,零服务端改动、零 API 契约改动**

## 1. 背景与根因

项目管理(重命名/删除)与项目记忆(recap)人工编辑的后端能力、API 封装、UI 交互全部已实现并合入 main,但用户在界面上看不到。两处装配断点:

- **断点一(死组件)**:重命名+确认名删除的完整 UI 全部写在 `src/views/WorkbenchList.vue`,而项目 tab 实际渲染的是 `WorkbenchProjects.vue` 卡片网格(2026-08-09 起替代列表视图)。WorkbenchList.vue 在生产渲染树零引用(仅其自身测试与注释引用)。08-31 生命周期特性(a4a203b→939295d)整套落在死组件上,守卫测试 `WorkbenchList.lifecycle.test.js` 直接挂载死组件 → 门禁全绿、线上不可见。
- **断点二(v-if 门控)**:项目记忆编辑/清空按钮在聊天页 recap 折叠卡 summary 内,卡片为 `<details v-if="projectRecap">`(`WorkbenchChat.vue:1044`)。recap 为空(新项目/摘要器从未触发)时整卡不渲染,连「写入第一条记忆」的入口都不存在;项目详情页亦无记忆入口。

补充事实:wb_* 工具面(tool-registry)有 `read/write_project_file`,但无项目记忆读写/项目管理工具——AI 不能编辑自己的项目记忆。这是 T5 的既有设计裁决(记忆走人工 UI 通道),**不在本设计范围**。

## 2. §1 项目卡片 ⋮ 菜单(WorkbenchProjects.vue)

- 卡片名行右侧挂现成 `src/components/common/DropdownMenu.vue`(triggerIcon `more_vert`,items API:`{label, icon, action, danger}`)。组件自带 `stopPropagation`,整卡 `@click` 进详情不受误触。
- 菜单项:**重命名**(icon `edit`)/ **删除**(icon `delete`,`danger: true`)。
- **重命名**:复用创建弹窗模式(`Modal` `max-w-md` + 名字输入)。确认 → `workbenchApi.updateProject(id, { name })` → 本地 `load()` 刷新。空名/纯空白不发请求;失败保留弹窗与输入可重试,错误消息透传服务端。
- **删除**:确认名弹窗,原样移植死组件 13 条已验证语义:
  1. 输入项目名与 `deleteTarget.name` **逐字一致**才启用确定钮;
  2. 两侧 trim 对称(项目名本身可含首尾空白,只 trim 输入侧会使这类项目永远删不掉);
  3. trim 后仍不等则禁用(不是放弃校验);
  4. `deleteBusy` 在途防双发(第二发落在已删项目 → 404 → 假「删除失败」),在途期间确定钮禁用;
  5. 成功 → 本地列表移除 + notify;响应带 `warning`(repo 目录清除失败)→ **error 级**提示且含 warning 文本,行仍移除;无 warning → 恒 success(不误报警);
  6. 请求失败 → 列表保留 + error notify + 弹窗保留可重试。
- **权限**:前端不裁剪(与既有 bind-cluster 下拉一致),服务端 ownership 403 是权威防线,错误消息透传。
- i18n:新增 `workbench.card.*` 键(菜单项/弹窗标题/确认名占位),与既有 `workbench.list.*` 键**不共用**(后者随死组件删除)。

## 3. §2 聊天页项目背景卡常驻(WorkbenchChat.vue)

- `v-if="projectRecap"` 改为有 `props.projectId` 即渲染(`projectId` 缺失时不渲染,防御)。
- **空态**:标题「项目背景」(复用 `workbench.chat.projectRecapTitle`)+ 空态说明(AI 每轮携带此摘要;可手动写入或由对话自动滚动生成)+「写入记忆」按钮 → 直接进既有编辑态(`startRecapEdit` 已支持空草稿,并自动展开卡片)。**空态卡默认展开**(`open` 属性钉死)——若空态也默认收起,入口再次不可见,等于没修;有记忆态维持现状默认收起。
- 编辑/保存/清空逻辑**零改动**:保存空串=清空(confirm 二次确认)、保存中禁用、错误透传(recap 超长等服务端消息)均维持现状。
- 有记忆态渲染与既有 `WorkbenchChat.recap.test.js` 回归不破坏。

## 4. §3 死组件清除

- 删除 `src/views/WorkbenchList.vue` 与 `src/views/__tests__/WorkbenchList.lifecycle.test.js`。
- 13 条行为语义按 §2 新形态重写为 `src/views/__tests__/WorkbenchProjects.lifecycle.test.js`(挂卡片 ⋮ 菜单与弹窗,`data-testid` 沿用 `rename-input`/`delete-confirm-input`/`delete-confirm-btn` 等既有命名便于评审对照)。
- `workbench.list.*` i18n 键:全量清点引用,仅死组件引用的键删除(`npm run i18n:check` 引用键缺失/孤儿键门禁把关)。
- 既有 `WorkbenchProjects.open-create.test.js` / `WorkbenchProjects.unbound.test.js` 不受影响。

## 5. §4 测试与验收

**单测矩阵(vitest + happy-dom)**

- WorkbenchProjects.lifecycle:重命名(成功/空名不发请求/失败保留可重试);删除(确认名一致才启用、trim 对称、trim 后不等禁用、busy 防双发、在途禁用、成功移除、warning→error 级含 warning、无 warning→success、失败保留);菜单点开不触发卡片导航(stopPropagation)。
- WorkbenchChat.recap 空态:无 recap → 卡渲染 + 「写入记忆」进编辑态;保存空草稿路径与清空 confirm 行为不回归。

**门禁四件**:`npm run test:unit` + `npm run i18n:check` + `npm run typecheck` + `npm run build`。

**手测 5 项(待真浏览器)**:①卡片 hover ⋮ 菜单出现且点击不进详情;②重命名即时生效;③确认名删除全流程(含输错禁用);④聊天页无记忆空态卡 + 写入记忆;⑤有记忆态编辑/清空回归。

## 6. 形态裁决与风险

- **重命名形态变更**:死组件为行内 blur 重命名;卡片形态下改**弹窗确认式**。enter/blur 竞态守卫语义随形态消失,由 Modal 单次确认 + busy 防重替代。测试按新形态重写断言,不逐行照搬。
- **流程**:worktree 分支实施,完成后 `--no-ff` 合回 main(用户 2026-08-30 硬约束);提交作者恒 aliangone、禁 Claude 尾注。

## 7. 非目标

- AI 工具面新增项目管理/项目记忆工具(另行立项)。
- 项目详情页头部管理入口(已裁决只放卡片菜单)。
- 非所有者卡片的前端权限裁剪(服务端 403 兜底,属 follow-up)。
- WorkbenchDetail/WorkbenchChat 的既有测试结构重组。
