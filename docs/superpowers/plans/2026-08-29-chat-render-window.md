# 长对话渐进渲染窗口 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 消息区只渲染最后 60 条(turns 数据全量不动),顶部哨兵渐进扩窗 +60,prepend 锚定不跳视野。

**Architecture:** 纯 WorkbenchChat.vue 内改:`renderedTurns = computed(slice(-renderLimit))` 裁渲染;哨兵行(点击+IntersectionObserver 双触发)扩窗;扩窗前后 scrollHeight 差补偿 scrollTop;切对话重置 60。

**Tech Stack:** 零新依赖;vitest;zh/en 各一键。

**Spec:** `docs/superpowers/specs/2026-08-29-chat-render-window-design.md`

## Global Constraints

- 提交作者恒 `aliangone <aliangone@gmail.com>`,禁止 Claude 尾注。
- **只裁渲染不动数据**:turns 数组全量;`WINDOW = 60`、步进 60。
- 哨兵 `v-if="turns.length > renderedTurns.length"`;testid `load-earlier-sentinel`;IntersectionObserver 不可用时点击路径仍可用。
- i18n 键 `workbench.chat.loadEarlier`(「↑ 加载更早的 {n} 条」/"Load {n} earlier messages")zh/en 同步,`npm run i18n:check` 六项 0。

---

### Task 1: 渐进窗口实现

**Files:**
- Modify: `src/components/workbench/WorkbenchChat.vue`
- Modify: `src/locales/zh.json` / `en.json`(workbench.chat 段 loadEarlier 键)
- Test: `src/components/workbench/__tests__/WorkbenchChat.test.js`(追加)

**Interfaces:**
- Consumes: 既有 `turns`/`chatScroller()`/`watch(() => props.conversationId)` 清理段
- Produces: 渲染窗口(testid `load-earlier-sentinel`);`renderedTurns`/`renderLimit` 组件内状态

- [ ] **Step 1: 写失败测试**(追加;文件极简 i18n 的 workbench.chat 补 `loadEarlier: '↑ 加载更早的 {n} 条'`)

```js
// ── 渲染窗口 T1(spec D2:只裁渲染不动数据)──
const manyMsgs = n => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', content: `消息 ${i}`, createdAt: i + 1 }))

test('渲染窗口:200 条 turns 只渲染 60;哨兵显示余量;扩窗渐进;末条恒在窗内', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValue({ id: 'c-big', status: 'done', content: '终', trace: '[]', steps: 1, recap: '', messages: manyMsgs(200) })
  const w = await mountChat({ conversationId: 'c-big', activeConversationId: 'c-big' })
  expect(w.vm.turns.length).toBe(200, '数据层全量')
  let nodes = w.findAll('[data-role]')
  expect(nodes.length).toBe(60, 'DOM 只渲染 60')
  expect(w.text()).toContain('消息 199', '末条在窗内')
  const sentinel = w.find('[data-testid="load-earlier-sentinel"]')
  expect(sentinel.exists()).toBe(true)
  expect(sentinel.text()).toContain('140')
  await sentinel.trigger('click')
  expect(w.findAll('[data-role]').length).toBe(120)
  expect(w.text()).toContain('消息 0') === undefined // 占位防御勿留——用下行真断言
  expect(w.find('[data-testid="load-earlier-sentinel"]').text()).toContain('80')
  // 连点两次至覆盖全部 → 哨兵消失
  await w.find('[data-testid="load-earlier-sentinel"]').trigger('click')
  await w.find('[data-testid="load-earlier-sentinel"]').trigger('click')
  expect(w.findAll('[data-role]').length).toBe(200)
  expect(w.find('[data-testid="load-earlier-sentinel"]').exists()).toBe(false)
})

test('渲染窗口:切对话重置回 60', async () => {
  api.conversations.get.mockReset()
  api.conversations.get.mockResolvedValueOnce({ id: 'c-big', status: 'done', content: '终', trace: '[]', steps: 1, recap: '', messages: manyMsgs(200) })
  api.conversations.get.mockResolvedValueOnce({ id: 'c2', status: 'done', content: 'ok', trace: '[]', steps: 1, recap: '', messages: manyMsgs(4) })
  const w = await mountChat({ conversationId: 'c-big', activeConversationId: 'c-big' })
  await w.find('[data-testid="load-earlier-sentinel"]').trigger('click')   // 扩到 120
  expect(w.findAll('[data-role]').length).toBe(120)
  await w.setProps({ conversationId: 'c2', activeConversationId: 'c2' })
  await flushPromises()
  expect(w.findAll('[data-role]').length).toBe(4)
  expect(w.vm.renderLimit).toBe(60, '窗口重置')
})
```

(实现者注:第二条测试 `data-role` 节点数断言在 ChatTurn 根 div——happy-dom 下 turn 数= `[data-role]` 数,与首条同口径;删掉首条里的占位防御行。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.test.js`
Expected: 新测试 FAIL(load-earlier-sentinel 不存在;DOM 全量 200)

- [ ] **Step 3: 实现**

script 段(lastAssistantIndex 附近):

```js
// ── 渐进渲染窗口(2026-08-29 spec D2):只裁渲染不动数据——turns 全量供编辑计数/水合;
// 千条消息 DOM 常驻是滚动/流式瓶颈,日常只渲染尾部 WINDOW 条,顶部哨兵渐进扩。──
const WINDOW = 60
const renderLimit = ref(WINDOW)
const renderedTurns = computed(() => turns.value.slice(-renderLimit.value))
const remainingCount = computed(() => turns.value.length - renderedTurns.value.length)
async function loadEarlier() {
  if (!remainingCount.value) return
  const el = chatScroller()
  const before = el ? el.scrollHeight : 0
  renderLimit.value += WINDOW
  await nextTick()
  // prepend 锚定:扩出的前缀把内容顶下去,补差保视野不跳(spec §3)
  if (el) el.scrollTop += el.scrollHeight - before
}
// 哨兵 IntersectionObserver:进入视口自动扩(点击双保险;无 IO 环境降级仅点击)
let earlierObserver = null
function observeSentinel(el) {
  if (earlierObserver) { earlierObserver.disconnect(); earlierObserver = null }
  if (!el || typeof IntersectionObserver === 'undefined') return
  earlierObserver = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) loadEarlier() }, { root: chatScroller() })
  earlierObserver.observe(el)
}
```

`watch(() => props.conversationId)` 清理段加 `renderLimit.value = WINDOW`;onUnmounted 加 `earlierObserver?.disconnect()`。

模板:消息容器(recap 卡之后、`v-for="(turn, i) in turns"` 处)改为:

```html
        <!-- 渐进窗口哨兵:还有更早消息时可扩(spec §3) -->
        <button v-if="remainingCount > 0" data-testid="load-earlier-sentinel" type="button" :ref="observeSentinel" @click="loadEarlier"
          class="mx-auto my-sm px-md py-xs text-body-xs text-on-surface-variant border border-outline-variant rounded-full hover:bg-surface-container transition-colors">
          {{ t('workbench.chat.loadEarlier', { n: remainingCount }) }}
        </button>
        <div v-for="(turn, i) in renderedTurns" :key="turn._id">
          <ChatTurn :turn="turn"
            :show-regenerate="turn.role === 'assistant' && turns.length - (turns.length - renderedTurns.length) + i === lastAssistantIndex && !sending && ['done', 'error'].includes(turn.status)"
            ...其余属性照旧... />
        </div>
```

(实现者注:show-regenerate 的「最后一条 assistant」判断改为基于全量 turns 的 lastAssistantIndex 与渲染起点的偏移:`renderStart = turns.length - renderedTurns.length`,条件 `renderStart + i === lastAssistantIndex`。**同时排查既有消费 `i` 的其它绑定**(如无则只此一处);ChatTurn 的 showEdit/edit 绑定与 messageId 逻辑不受窗口影响(基于 turn 对象)。)

- [ ] **Step 4: 跑测试确认通过 + 组件全量回归 + i18n**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.test.js src/components/workbench/__tests__/ChatTurn.test.js src/components/workbench/__tests__/ChatModal.test.js && npm run i18n:check`
Expected: PASS;六项 0

- [ ] **Step 5: 提交**

```bash
git add src/components/workbench/WorkbenchChat.vue src/components/workbench/__tests__/WorkbenchChat.test.js src/locales/zh.json src/locales/en.json
git commit -m "perf(ui): 长对话渐进渲染窗口——只裁渲染不动数据,哨兵扩窗+prepend 锚定(渲染窗口 T1)"
```

---

### Task 2: 全量回归 + 收尾

- [ ] **Step 1:** `npm test` / `npm run typecheck` / `npm run build` / `npm run i18n:check` 全绿。
- [ ] **Step 2:** 手测清单记入合并提交信息(200+ 条对话初始只渲 60/哨兵扩窗视野不跳/流式期间滚动流畅/编辑态计数正确)。
- [ ] **Step 3:** 合并:rebase main(如有并行)→ 全量验证 → ff 合并 → push(用户裁决 tag)。

---

## Self-Review 记录

1. **Spec 覆盖**:§3 全部机制→T1(窗口/哨兵/锚定/重置/i18n);§5 测试对应;prepend 锚定标注手测。无遗漏。
2. **占位符**:模板里 `...其余属性照旧...` 是对现场代码的保留指令(ChatTurn 既有绑定不动),附排查指令;测试中占位防御行已注明删除。无 TBD。
3. **类型一致**:`renderedTurns/renderLimit/remainingCount/loadEarlier/observeSentinel` 定义与模板/测试一致;`renderStart + i === lastAssistantIndex` 的偏移口径在指令中写明。
