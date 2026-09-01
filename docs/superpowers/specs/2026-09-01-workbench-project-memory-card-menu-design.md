# 项目卡片 ⋮ 菜单「项目记忆」直编 — 设计

- 日期:2026-09-01
- 状态:已批准(问答裁决:①弹窗保存+清空双钮 ②卡片不加「有记忆」chip)
- 范围:**纯前端,零服务端改动、零新端点**;承接 2026-09-01 可见性修复(卡片 ⋮ 菜单已存在)

## 1. 背景

项目管理入口(重命名/删除)已在卡片 ⋮ 菜单可见;项目记忆(projectRecap)编辑目前只有聊天页背景卡一个入口。用户要求在重命名/删除同处直接编辑项目历史记忆,不必进对话页。

数据侧条件现成:`GET /api/workbench/projects` 列表为 `SELECT *`,**payload 每项目已携带 `projectRecap` 全文**;`PATCH /api/workbench/projects/:id` 的 `{ recap }` 链路已存在(65536 上限;`''`=置 NULL+`historyWatermark` 归零,摘要器从头重新滚动生成)。

## 2. 菜单项

`WorkbenchProjects.vue` 的 `cardActions(p)` 追加第三项,位于重命名与删除之间:

```js
{ label: t('workbench.card.projectMemory'), icon: 'folder_special', action: () => startMemory(p) }
```

icon `folder_special` 与聊天页项目背景卡一致,语义呼应。

## 3. 记忆弹窗

- `startMemory(p)`:`memoryTarget=p`、`memoryText=p.projectRecap || ''`、开 Modal(标题「项目记忆·{name}」)。textarea rows≈8、resize-y,**预填零额外请求**。
- 按钮组:**清空**(danger)/ 取消 / 保存。
- 提交语义与聊天页同构,内部共享 `commitRecap(next)`:
  - **保存**:提交 textarea 原文;trim 后为空**且**原记忆非空 → `confirm(t('workbench.card.memoryClearConfirm'))`,拒绝则中止,同意按 `''` 提交。
  - **清空钮**:`confirm` 同款二次确认 → 提交 `''`。
- 成功:本地就地更新 `projects` 数组对应项 `p.projectRecap = next || null`(**不触发 reload**,列表数据单源);notify(`memorySaved`/`memoryCleared`);关窗。
- 失败:错误消息透传服务端(含 65536 超长的 400 `recapTooLong`),**弹窗与输入保留可重试**;`memoryBusy` 在途防双发(保存与清空共用)。
- 清空后聊天页背景卡自然转空态(同一条数据,两入口共享,无需联动代码)。

## 4. i18n(workbench.card 新增 6 键,zh/en 成对)

| 键 | zh | en |
|---|---|---|
| `projectMemory` | 项目记忆 | Project memory |
| `memoryModalTitle` | 项目记忆·{name} | Project memory · {name} |
| `memorySaved` | 项目记忆已更新 | Project memory updated |
| `memoryCleared` | 项目记忆已清空 | Project memory cleared |
| `memoryClearConfirm` | 确认清空该项目记忆?清空后 AI 不再携带旧摘要,对话将重新滚动生成新记忆。 | Clear this project's memory? The AI will stop carrying the old summary; new memory will build up from upcoming conversations. |
| `memorySaveFailed` | 保存项目记忆失败 | Failed to save project memory |

## 5. 测试(追加至 `WorkbenchProjects.lifecycle.test.js`,7 条)

1. 菜单含「项目记忆」项;点击开弹窗且 textarea 预填列表携带的 recap(种子项目带 `projectRecap`)。
2. 无记忆项目:textarea 为空。
3. 保存非空:`updateProject(id,{recap})` + 本地 `projectRecap` 就地更新 + success + 关窗。
4. 清空钮 confirm 同意:`updateProject(id,{recap:''})` + 本地置 null + 关窗;拒绝:不发请求、弹窗保留。
5. 空文本保存(原记忆非空):confirm 同意按 `''` 提交;拒绝不发请求。
6. 保存失败(error 透传,如超长 400 message):error notify + 弹窗保留可重试。
7. busy 防双发:在途再点保存/清空不发第二发。

门禁四件:`test:unit` + `i18n:check` + `typecheck` + `build`。手测 3 项(真浏览器):菜单项出现、弹窗编辑保存生效(与聊天页背景卡数据互通)、清空 confirm 全流程。

## 6. 风险与裁决记录

- 双写语义风险:项目记忆现在有两个编辑入口(卡片弹窗/聊天页背景卡),数据单源(workbench_projects.projectRecap)+保存语义同构,并发编辑后写者胜(既有 PATCH 全量覆盖语义,无合并诉求,接受)。
- 流程:worktree 分支实施 `--no-ff` 合回;作者 aliangone 禁 Claude 尾注。

## 7. 非目标

- 卡片「有记忆」chip(已裁决不加)。
- 聊天页背景卡、详情页不动;AI 侧项目记忆工具仍不做(spec 前作 §7 既有裁决延续)。
- 项目记忆的 diff/版本历史(projectRecap 无版本链,如需另行立项)。
