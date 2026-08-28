# 斜杠命令与排障剧本 设计

- 日期:2026-08-28
- 状态:已评审(brainstorming 一问定案:剧本为主 + /compact 动作),待实施
- 范围:AI 对话输入框的 `/` 命令面板与内置排障剧本

## 1. 背景

wb_* 工具组合的排障知识(先 describe 看 events、再 previous logs、再查 secret)散落在用户脑中;空态 3 条建议提示只是冰山一角。把「排障剧本」产品化:`/` 唤起、选中展开为完整提示词(可编辑)再发送。复用既有 @-mention 下拉的交互模式与视觉。

## 2. 决策记录

| # | 决策 | 选择 |
|---|------|------|
| D1 | 形态 | **剧本为主 + /compact 一个动作**;剧本选中→替换输入框内容(可编辑再发,不黑盒直发);动作直接执行。不做 admin CRUD/参数表单(YAGNI) |
| D2 | 触发 | 行首 `/`(多行文本按行首判断);继续输入过滤名称+描述;与 @-mention 并存但互斥(后触发关前者) |
| D3 | 存储 | 前端硬编码 `src/logic/chatPlaybooks.js`(纯数据+过滤函数);文案全走 i18n(zh/en 正文镜像) |

## 3. 架构

### 3.1 数据模块:`src/logic/chatPlaybooks.js`

```js
export const SLASH_ACTIONS = [ { id: 'compact', icon: 'bolt', nameKey: 'workbench.chat.slash.actCompact', descKey: 'workbench.chat.slash.actCompactDesc', enabled: (state) => state.canCompact } ]
export const PLAYBOOKS = [ { id: 'imagepull', icon: 'description', nameKey: 'workbench.chat.pb.imagepull.name', descKey: '...desc', bodyKey: '...body' }, ... 10 个 ]
export function filterSlashItems(query)   // 动作在前剧本在后;query 小写子串匹配 id;返回合并数组
```

剧本清单(10):imagepull / crashloop / pending / svc-unreachable / rollout-stuck / quota / capacity / oomkilled / dns / health-sweep。正文要素见计划(每条含 `【占位】` 标记 + 末句「逐步执行,先说结论再给命令级建议」风格约束)。

### 3.2 WorkbenchChat 接入

- 输入 watch 扩展:`const SLASH_RE = /^\/(\w*)$/m` 多行行首匹配 → `slashOpen/slashItems/activeIndex`;@-mention 触发时 `clearSlash()`,反之亦然(互斥)
- 键盘:onKeydown 的下拉分支扩展为 `searchOpen || slashOpen` 共用 ↑↓/Enter/Tab/Esc
- 选中剧本:`input.value = t(bodyKey 展开值)`,面板关;选中动作:`/compact` → 清 `/compact` 输入 → `showCompact = true`(门禁与余量条压缩钮同:终态可用,非终态面板内禁用置灰)
- 面板 UI:复用 @-mention 下拉容器样式;条目两行(名称 + 描述);动作在禁用态 `opacity-40` + 不可选中(键盘跳过、点击无效)

### 3.3 i18n

zh/en `workbench.chat.slash.*`:面板标题「命令与剧本」/无匹配/actCompact(名+描述)/每剧本 name+desc+body(en 正文镜像翻译)。i18n:check 门禁覆盖(占位 `【】` 属正文内容非 vue-i18n 插值,无冲突)。

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| 非行首 `/`(如 URL 里) | 不触发面板 |
| 剧本选中后直接发送 | 与普通消息无异(它就是文本) |
| /compact 禁用态(运行中/无对话) | 面板置灰不可选;title 提示同余量条按钮 |
| Esc/点击面板外 | 关闭面板,输入保留 |

## 5. 测试

- chatPlaybooks 单测:filterSlashItems(空 query 全量+动作在前/子串过滤/大小写);SLASH_ACTIONS.enabled 谓词
- WorkbenchChat 测试:行首 / 弹面板/输入过滤/↑↓+Enter 选中/剧本替换输入框/动作开 modal/非行首不触发/与 @ 互斥
- 回归:全量绿;i18n:check 六项 0

## 6. 开放问题

无。
