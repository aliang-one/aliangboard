# 长对话渐进渲染窗口 设计

- 日期:2026-08-29
- 状态:已评审(brainstorming 定案:顶部渐进窗口),待实施
- 范围:WorkbenchChat 消息区渲染性能(千条消息)

## 1. 背景

消息区 `v-for` 全量渲染 ChatTurn(markdown+Prism+工具时间线),千条消息 DOM 常驻——流式 delta/滚动/粘底都拖着全部重量。已有 150ms 渲染节流与 WeakMap 块缓存,但 DOM 规模本身是瓶颈。

## 2. 决策记录

| # | 决策 | 选择 |
|---|------|------|
| D1 | 方案 | **顶部渐进窗口**(非完整虚拟化):日常只渲染最后 60 条,顶部哨兵扩窗 +60;痛点 95% 在底部活跃区,向上翻到底渐进回到全量(不劣于现状)。不做高度测量/双向回收/引库 |
| D2 | 分层 | **只裁渲染不动数据**:turns 数组永远全量(编辑 N 计数/lastAssistantIndex/水合/余量全不受影响),`renderedTurns = computed(() => turns.slice(-renderLimit))` |

## 3. 架构(WorkbenchChat.vue)

- `renderLimit = ref(60)`;消息容器内、`v-for renderedTurns` 之上放哨兵行:`v-if="turns.length > renderedTurns.length"`,内容「↑ 加载更早的 N 条」(N=turns.length - renderedTurns.length),点击 `renderLimit += 60`;同时挂 IntersectionObserver(进入视口即同款扩窗;组件卸载/切对话 disconnect)
- **prepend 滚动锚定**:扩窗路径记录扩前 `scrollHeight`,nextTick 后 `scrollTop += (新 scrollHeight - 旧)`——视野不跳
- 重置:`watch(() => props.conversationId)` 清理段 `renderLimit.value = 60`
- 流式钉尾:窗口语义即「最后 N 条」,新 turn push 自动在窗内;粘底/回到底部按钮零改动
- i18n:zh/en 各一键 `workbench.chat.loadEarlier`(「↑ 加载更早的 {n} 条」/"Load {n} earlier messages")

## 4. 边界与错误处理

- 窗口 ≥ turns.length → 哨兵消失;向上翻到底 = 全量渲染(等价现状)
- IntersectionObserver 不可用(测试环境)→ 点击路径仍在(降级双保险)
- 切对话/编辑/压缩/审批全走数据层,不受窗口影响

## 5. 测试

- 200 条 turns → DOM 渲染 60 条 ChatTurn + 哨兵显示「还有 140」
- 哨兵点击 → 窗口 120,DOM 120;再点至覆盖全部 → 哨容消失
- 末条恒在窗内;切对话窗口重置回 60
- prepend 锚定属布局行为,记手测清单(vitest 无真实滚动布局)

## 6. 开放问题

无。
