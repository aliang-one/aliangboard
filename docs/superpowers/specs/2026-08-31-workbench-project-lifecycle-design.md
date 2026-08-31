# 工作台项目生命周期补全设计——删除/重命名/项目记忆人工通道/摘要器加固

日期:2026-08-31
状态:已评审(审计驱动的管理缺口补全,范围五点经用户确认)
关联:`server/routes/workbench-projects.mjs`、`server/workbench-projects.mjs`、`server/workbench-summarize.mjs`、`server/workbench-agent.mjs:186/276`、`src/views/WorkbenchDetail.vue`

## 0. 背景与动机

2026-08-31 线上事故:工作台 AI 反复声称"没有 SSH 工具",排查一天,最终根因是**项目记忆(projectRecap)把历史调查的瞬时结论("此前缺少 wb_ssh_exec 等接口")固化成持久先验注入每轮对话**。修复过程暴露出工作台项目管理域的一串缺口:

1. **项目不可删除**——无路由、无数据层函数、无 UI。后果:`data/workbench/<...>/<projectId>/` git repo 永久残留、conversations/messages/projectRecap 全成孤儿、磁盘只增不减、废弃项目永远占列表。
2. **项目不可重命名**——只有换绑集群的 PUT,名字错了只能重建。
3. **projectRecap 零人工通道**——无读写 API,前端只有只读折叠卡;唯一写入方是自动摘要器;人无法纠偏毒记忆(本次只能 kubectl 进库修)。
4. **摘要器无防护**——摘要提示词不禁止"把瞬时能力结论写成持久事实";注入头不声明"以本轮实际工具为准"。不改则同类毒记忆会再次生成。

## 1. 项目删除

**API**:`DELETE /api/workbench/projects/:id`(body JSON `{ confirmName }`,必须与项目名逐字一致,防误删;owner 或 admin,其余 403;运行中/paused 的对话**先取消**再删——沿用对话删除的 P0(F) 守卫语义:cancel → busDispose,使 in-flight run 结果不回写已删对象)。

**级联(单事务 + 目录删除两段式)**:
```
BEGIN
  DELETE workbench_messages   WHERE conversationId IN (SELECT id FROM workbench_conversations WHERE projectId=?)
  DELETE workbench_conversations WHERE projectId=?
  DELETE workbench_projects   WHERE id=?
COMMIT
fs.rmSync(repoRoot, { recursive, force })   # 事务提交后执行;失败仅记日志不回滚 DB(孤儿目录可手清,半删数据更糟)
```

**repoRoot 安全**:repo 路径经 `projectRepoPath(workbenchDir, project)` 解析,**必须** `path.resolve` 后前缀校验 `workbenchDir`,不满足即拒绝(防 path 逃逸);两种历史形态(`repoRoot==='projects'` → `<dir>/projects/<id>`,legacy → `<dir>/<clusterId>/projects/<id>`)都要能删。

**审计**:`writeAudit { verb:'write', tool:'project_delete', requestSummary:'name=<名> conversations=<n>', source:'platform' }`。

**前端**:项目列表每行「删除」→ Modal 确认框要求**输入项目名**一致才可点确定。

## 2. 项目重命名 + 项目记忆人工通道

**API**:`PATCH /api/workbench/projects/:id`(owner/admin)body `{ name?, recap? }`:
- `name`:trim 后非空,≤80 字符;更新 project.name
- `recap`:字符串 ≤64KB;**空串 = 清空**(置 NULL 并把 `historyWatermark` 归零,让摘要器从干净状态重新积累);非空 = 人工覆写(保留 watermark,视为对当前摘要的精修)

**前端**:
- 项目列表行「重命名」(inline 输入)
- 对话页项目记忆折叠卡(`WorkbenchChat.vue` `data-testid="project-recap-card"`)加「编辑」「清空」按钮(owner/admin 可见);编辑用 textarea,保存调 PATCH;清空需二次确认;操作后本地刷新卡片

## 3. 摘要器加固(断掉毒记忆再生机制)

- **摘要提示词**(`workbench-summarize.mjs` 拼装处)追加约束:工具/能力/权限的**可用性随部署与配置随时变化,不得作为持久事实写入摘要**;摘要只记录稳定的项目事实、目标与决策。
- **注入头**(`workbench-agent.mjs:186/276` 两处)`[Project memory — 之前对话的决策摘要]` 追加说明:`(历史经验供参考;工具与能力以本轮实际提供的为准)`——两处字面同步改,相关测试断言同步更新。

## 4. 非目标

- 项目导出/导入、跨用户转移
- 孤儿目录扫描清理端点(删除实现好后,存量孤儿一次性手清即可)
- 项目记忆的版本历史/审计(人工通道已够纠偏)

## 5. 测试

- 数据层单测:deleteProject 级联完整性(消息/对话/项目行)、running 对话取消守卫、repoRoot 双形态路径解析与逃逸拒绝、recap 清空时 watermark 归零
- 路由测试:DELETE 确认名不符 400、非 owner 403、成功路径级联;PATCH name/recap 校验(空名 400、recap 超长 400)
- 摘要器单测:提示词含约束语句;注入头 caveat 断言(更新既有字面断言)
- 前端 vitest:recap 卡编辑/清空交互;确认名不符时删除按钮禁用
- 门禁:`npm run test:server` + `npm run test:unit` + `npm run i18n:check`(新 UI 键 en/zh 齐)+ `npm run build`

## 6. 决策记录

| 决策 | 结论 | 理由 |
|---|---|---|
| 删除确认方式 | 输入项目名 | 项目删除不可逆且级联大;输名字是最强防误删 UI 习语 |
| running 对话 | 先取消再删 | 与对话删除 P0(F) 语义一致;拒绝式("先手动停止")在多对话场景烦人 |
| repo 目录删除失败 | 不回滚 DB,记日志 | 半删数据状态比孤儿目录危害大;孤儿目录可手清 |
| recap 清空 | 置 NULL + watermark 归零 | 让摘要器可重建;覆写则保留水位(视为精修) |
| 注入头改字面 | 两处同步 + 测试更新 | 该字面是我们自己的约定,非外部契约 |
