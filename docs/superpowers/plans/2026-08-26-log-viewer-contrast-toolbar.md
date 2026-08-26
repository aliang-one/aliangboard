# 日志查看器对比度修复 + 工具栏双行重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** LogViewerBody 渲染区全部文本绑定暗底语义色(修 6 处深字点),工具栏按双行分区重构,零逻辑改动。

**Architecture:** 单组件 `src/components/common/LogViewerBody.vue`(PodDetail 内嵌 tab 与 LogPopup 同源);等级色组件内常量表;存量 vitest 回归 + 新增语义类断言。

**Tech Stack:** Vue 3 script setup、tailwind 语义 token(on-code-surface/code-surface-selection/MD_PALETTE fixed 系)、vitest。

**Spec:** `docs/superpowers/specs/2026-08-26-log-viewer-contrast-toolbar-design.md`

## Global Constraints

- 提交作者恒为 `aliangone <aliangone@gmail.com>`,**禁止 Co-Authored-By 尾注**(CLAUDE.md 2026-08-26)。
- 纯 JS;不新增依赖;不动过滤/跟随/计数/下载等逻辑;现有 `data-testid` 全部保留。
- 样式断言只查关键语义类存在,不断言完整 class 串。
- worktree 分支 `fix-log-viewer-contrast`;`docs/superpowers/` 提交须 `git add -f`。

## 关键现状锚点

- `src/components/common/LogViewerBody.vue`(191 行,本会话未改动,行号即当前):L48-52 `LEVEL_CHIPS`;L111-168 单行工具栏;L174-182 渲染区。
- 测试骨架 `src/components/common/__tests__/LogViewerBody.test.js`:`mountBody()` + `streamHandlers.onMessage('2026-01-01T00:00:00Z app started')` 推流;api.k8s 静态返回三行(app started/error/warn);断言风格 `w.find('[data-testid="log-line"] .text-error')`。

---

### Task 1: 渲染区语义色修复(6 处 + LEVEL_COLORS)

**Files:**
- Modify: `src/components/common/LogViewerBody.vue`
- Modify: `src/components/common/__tests__/LogViewerBody.test.js`(追加)

**Interfaces:**
- Produces: `LEVEL_COLORS` 常量 + `levelColor(lv)` helper(T2 无依赖,仅同文件);新 testid `log-level-tag`(级别标签 span,静态,可 findAll)。

- [ ] **Step 1: 追加失败测试**

`LogViewerBody.test.js` 末尾:

```js
test('渲染区语义色:容器含 text-on-code-surface;INFO 标签 primary-fixed-dim;行内不再用边框 token 冒充文字色', async () => {
  const w = mountBody()
  streamHandlers.onMessage('2026-01-01T00:00:00Z app started')
  await w.vm.$nextTick()
  expect(w.find('[data-testid="log-scroll"]').classes()).toContain('text-on-code-surface')
  const tags = w.findAll('[data-testid="log-level-tag"]')
  expect(tags.length).toBeGreaterThan(0)
  expect(tags[0].classes()).toContain('text-primary-fixed-dim')   // 首行 = 'app started' → INFO
  expect(w.find('[data-testid="log-line"] .text-outline-variant').exists()).toBe(false)
})
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/components/common/__tests__/LogViewerBody.test.js`
Expected: 新例 FAIL(无 log-level-tag / 无 text-on-code-surface);存量 PASS

- [ ] **Step 3: 实现**

(a) script `LEVEL_CHIPS` 常量之后加:

```js
// 等级标签色:渲染区为恒暗底 code-surface,fixed 系 = 固定暗面安全变体;
// INFO 用 primary-fixed-dim(#4edea3)与工具栏 INFO chip 的 primary 身份一致。
const LEVEL_COLORS = {
  ERROR: 'text-error',
  WARN: 'text-tertiary-fixed-dim',
  INFO: 'text-primary-fixed-dim',
}
const levelColor = lv => LEVEL_COLORS[lv] || 'text-on-code-surface/60'
```

(b) 模板 L174-179 替换为(渲染容器补文字色;空态/时间戳/级别标签/命中段全部换语义色;级别标签加 testid):

```html
    <div ref="scrollEl" data-testid="log-scroll" @scroll="onScroll" class="flex-1 min-h-0 overflow-auto bg-code-surface text-on-code-surface p-md font-mono text-code-sm code-scroll" :class="wrap ? '' : '[&>div]:whitespace-pre [&>div]:overflow-x-visible'">
      <p v-if="!visibleLines.length" class="text-on-code-surface/60 py-md text-center">{{ t('component.logViewer.empty') }}</p>
      <div v-for="(log, idx) in visibleLines" :key="idx" data-testid="log-line" class="leading-relaxed break-all" :class="wrap ? 'whitespace-pre-wrap' : 'whitespace-pre'">
        <span v-if="showTs" class="text-on-code-surface/50">{{ log.timestamp }} </span>
        <span data-testid="log-level-tag" :class="levelColor(log.level)">[{{ log.level }}]</span>
        <span v-for="(seg, si) in filter.highlight(log.message)" :key="si" :data-testid="seg.hit ? 'log-highlight' : undefined" :class="seg.hit ? 'bg-code-surface-selection text-on-code-surface rounded-sm' : ''">{{ seg.text }}</span>
      </div>
```

(follow 光标条 L181 原样保留。)

- [ ] **Step 4: 确认通过**

Run: `npx vitest run src/components/common/__tests__/LogViewerBody.test.js`
Expected: 全 PASS(存量 5+ + 新 1;存量 `.text-error` 断言不受影响)

- [ ] **Step 5: 提交**

```bash
git add src/components/common/LogViewerBody.vue src/components/common/__tests__/LogViewerBody.test.js
git commit -m "fix(ui): 日志渲染区补暗底语义色——消息正文/时间戳/INFO 标签深底可读(text-on-code-surface 单源对齐)"
```

---

### Task 2: 工具栏双行重构

**Files:**
- Modify: `src/components/common/LogViewerBody.vue`(L111-168 工具栏整块)
- Modify: `src/components/common/__tests__/LogViewerBody.test.js`(追加)

**Interfaces:**
- Consumes: Task 1 同文件现状
- Produces: 新 testid `log-toolbar-row-1`/`log-toolbar-row-2`

- [ ] **Step 1: 追加测试**

```js
test('工具栏双行:数据源行(容器/行数/时间)与查看控制行(搜索/级别)分离', async () => {
  const w = mountBody()
  const r1 = w.find('[data-testid="log-toolbar-row-1"]')
  const r2 = w.find('[data-testid="log-toolbar-row-2"]')
  expect(r1.exists() && r2.exists()).toBe(true)
  expect(r1.find('[data-testid="log-container"]').exists()).toBe(true)
  expect(r1.find('[data-testid="log-search"]').exists()).toBe(false)
  expect(r2.find('[data-testid="log-search"]').exists()).toBe(true)
  expect(r2.find('[data-testid="log-container"]').exists()).toBe(false)
})
```

- [ ] **Step 2: 确认失败**

Run: `npx vitest run src/components/common/__tests__/LogViewerBody.test.js`
Expected: 新例 FAIL(无 row testid)

- [ ] **Step 3: 实现(L111-168 整块替换)**

```html
    <!-- 工具栏·第一行:数据源 -->
    <div data-testid="log-toolbar-row-1" class="bg-surface-container-highest/50 px-md py-1.5 flex items-center gap-md border-b border-outline-variant shrink-0">
      <div class="flex items-center gap-xs">
        <span class="text-body-xs text-on-surface-variant font-medium">{{ t('component.logViewer.container') }}</span>
        <select v-model="container" data-testid="log-container" class="h-8 bg-surface-container-low border border-outline-variant rounded-lg px-sm text-body-sm font-mono focus:ring-2 focus:ring-primary">
          <option v-for="c in containers" :key="c" :value="c">{{ c }}</option>
        </select>
      </div>
      <div class="flex items-center gap-xs">
        <span class="text-body-xs text-on-surface-variant font-medium">{{ t('component.logViewer.lines') }}</span>
        <select v-model="logLines" data-testid="log-lines" class="h-8 bg-surface-container-low border border-outline-variant rounded-lg px-sm text-body-sm font-mono focus:ring-2 focus:ring-primary">
          <option v-for="n in LOG_LINE_OPTIONS" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <div class="flex items-center gap-xs">
        <span class="text-body-xs text-on-surface-variant font-medium">{{ t('component.logViewer.since') }}</span>
        <select v-model="logSince" data-testid="log-since" class="h-8 bg-surface-container-low border border-outline-variant rounded-lg px-sm text-body-sm font-mono focus:ring-2 focus:ring-primary">
          <option v-for="o in LOG_SINCE_OPTIONS" :key="o.value" :value="o.value">{{ t(SINCE_LABEL_KEYS[o.value] || 'component.logViewer.since_all') }}</option>
        </select>
      </div>
      <label class="flex items-center gap-1 cursor-pointer select-none" :class="logPrevious ? 'text-tertiary-container font-medium' : 'text-on-surface-variant'" :title="t('component.logViewer.previousHint')">
        <input v-model="logPrevious" data-testid="log-previous" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
        <span class="text-body-sm font-medium">{{ t('component.logViewer.previous') }}</span>
      </label>
      <label class="flex items-center gap-1 cursor-pointer select-none" :class="logPrevious ? 'text-on-surface-variant/50' : 'text-on-surface-variant'">
        <input v-model="followLog" data-testid="log-follow" :disabled="logPrevious" type="checkbox" class="rounded text-primary focus:ring-primary h-4 w-4" />
        <span class="text-body-sm">{{ t('component.logViewer.follow') }}</span>
        <span v-if="followLog" class="flex items-center gap-xs ml-xs px-sm py-0 bg-primary-container/10 text-primary text-xs rounded-full">
          <span class="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-status"></span>{{ t('component.logViewer.live') }}
        </span>
      </label>
    </div>

    <!-- 工具栏·第二行:查看控制 -->
    <div data-testid="log-toolbar-row-2" class="bg-surface-container-highest/30 px-md py-1.5 flex items-center gap-md border-b border-outline-variant shrink-0">
      <div class="flex items-center gap-xs flex-1 min-w-40">
        <span class="material-symbols-outlined text-body-base text-on-surface-variant">search</span>
        <input v-model="search" data-testid="log-search" type="text" :placeholder="t('component.logViewer.searchPlaceholder')" class="flex-1 min-w-0 h-8 bg-surface-container-low border border-outline-variant rounded-lg px-sm text-body-sm font-mono focus:ring-2 focus:ring-primary" />
        <label class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="useRegex ? 'text-primary font-medium' : 'text-on-surface-variant'" :title="t('component.logViewer.regexHint')">
          <input v-model="useRegex" data-testid="log-regex" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.regex') }}
        </label>
        <span v-if="filter.error" data-testid="log-regex-error" class="text-error text-body-xs">{{ t('component.logViewer.invalidRegex') }}</span>
      </div>
      <span class="w-px h-5 bg-outline-variant/60 shrink-0"></span>
      <div class="flex items-center gap-1">
        <button v-for="c in LEVEL_CHIPS" :key="c.lv" data-testid="log-level" @click="toggleLevel(c.lv)"
          class="px-sm py-0.5 rounded-full text-[11px] font-mono border transition-colors"
          :class="activeLevels.includes(c.lv) ? [c.on, 'font-semibold'] : 'border-outline-variant/50 text-on-surface-variant/40'">
          {{ c.lv }}<span class="ml-1 tabular-nums opacity-80">{{ counts[c.lv] }}</span>
        </button>
      </div>
      <span class="w-px h-5 bg-outline-variant/60 shrink-0"></span>
      <label :title="t('component.logViewer.wrapHint')" class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="wrap ? 'text-primary font-medium' : 'text-on-surface-variant'">
        <input v-model="wrap" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.wrap') }}
      </label>
      <label :title="t('component.logViewer.timestampsHint')" class="flex items-center gap-0.5 text-body-xs cursor-pointer select-none" :class="showTs ? 'text-primary font-medium' : 'text-on-surface-variant'">
        <input v-model="showTs" type="checkbox" class="h-3 w-3" />{{ t('component.logViewer.timestamps') }}
      </label>
      <div class="flex items-center gap-1 ml-auto">
        <button @click="restart" :title="t('component.logViewer.refresh')" class="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors"><span class="material-symbols-outlined text-body-md">refresh</span></button>
        <button @click="downloadLogs" :title="t('component.logViewer.download')" class="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors"><span class="material-symbols-outlined text-body-md">download</span></button>
        <button @click="copyLogs" :title="t('component.logViewer.copy')" class="p-1.5 rounded-lg hover:bg-surface-container-low transition-colors"><span class="material-symbols-outlined text-body-md">content_copy</span></button>
      </div>
    </div>
```

(所有 v-model/@click/testid 与原块一一对应,仅布局与样式变化;`ml-auto` 操作组保留在第二行右端。)

- [ ] **Step 4: 确认通过 + 全量回归**

Run: `npx vitest run src/components/common/__tests__/LogViewerBody.test.js`,然后 `npm run test:unit && npm run typecheck && npm run build`
Expected: 全绿

- [ ] **Step 5: 提交**

```bash
git add src/components/common/LogViewerBody.vue src/components/common/__tests__/LogViewerBody.test.js
git commit -m "refactor(ui): 日志工具栏双行分区——数据源行/查看控制行,统一控件规格+级别 chips 加重"
```

---

## 收尾

- [ ] `npm run test:server && npm run test:unit && npm run typecheck && npm run build` 全绿
- [ ] 用户浏览器目验(浅色+深色主题各一遍):①info/正文/时间戳清晰 ②ERROR/WARN/INFO 标签三色可辨 ③双行工具栏不挤、分区清楚 ④搜索高亮块可读
