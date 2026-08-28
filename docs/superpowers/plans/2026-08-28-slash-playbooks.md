# 斜杠命令与排障剧本 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 输入框行首 `/` 弹命令面板——10 个排障剧本(选中替换输入框可编辑)+ /compact 动作,复用 @-mention 交互。

**Architecture:** 纯数据模块 `src/logic/chatPlaybooks.js`(SLASH_ACTIONS/PLAYBOOKS/filterSlashItems)+ zh/en 全量文案 → WorkbenchChat 输入 watch/onKeydown/面板 UI 接入(与 @-mention 互斥)。

**Tech Stack:** 零新依赖;vitest;i18n zh/en。

**Spec:** `docs/superpowers/specs/2026-08-28-slash-playbooks-design.md`

## Global Constraints

- 提交作者恒 `aliangone <aliangone@gmail.com>`,禁止 Claude 尾注。
- 触发正则 `/^\/(\w*)$/m`(多行行首);与 @-mention 互斥(后触发关前者)。
- 剧本选中=替换整个输入框;动作 `/compact` 选中=清 `/` 输入 + `showCompact=true`,禁用态(非终态/无对话)置灰不可选(键盘跳过、点击无效)。
- 文案全走 i18n(zh/en 镜像,含剧本正文);`npm run i18n:check` 六项 0。

---

### Task 1: `src/logic/chatPlaybooks.js` + zh/en 文案 + 单测

**Files:**
- Create: `src/logic/chatPlaybooks.js`
- Create: `src/logic/__tests__/chatPlaybooks.test.js`
- Modify: `src/locales/zh.json` / `src/locales/en.json`(workbench.chat 段加 slash 子对象)

**Interfaces:**
- Produces(Task 2 消费):
  - `SLASH_ACTIONS: [{ id, icon, nameKey, descKey, enabled(state) }]`(state = `{ canCompact }`)
  - `PLAYBOOKS: [{ id, icon, nameKey, descKey, bodyKey }]`(10 项)
  - `filterSlashItems(query) → [action|playbook 混合]`(动作在前;query 小写子串匹配 id)

- [ ] **Step 1: 写失败测试**

```js
// src/logic/__tests__/chatPlaybooks.test.js
import { test, expect } from 'vitest'
import { SLASH_ACTIONS, PLAYBOOKS, filterSlashItems } from '../chatPlaybooks'

test('PLAYBOOKS:10 个剧本,id 唯一,键完整', () => {
  expect(PLAYBOOKS).toHaveLength(10)
  expect(new Set(PLAYBOOKS.map(p => p.id)).size).toBe(10)
  for (const p of PLAYBOOKS) expect([p.nameKey, p.descKey, p.bodyKey].every(k => typeof k === 'string' && k.length > 0)).toBe(true)
})

test('SLASH_ACTIONS:compact 动作,enabled 谓词随 canCompact', () => {
  expect(SLASH_ACTIONS.map(a => a.id)).toEqual(['compact'])
  expect(SLASH_ACTIONS[0].enabled({ canCompact: true })).toBe(true)
  expect(SLASH_ACTIONS[0].enabled({ canCompact: false })).toBe(false)
})

test('filterSlashItems:空 query 动作在前全量;子串过滤;大小写不敏感', () => {
  const all = filterSlashItems('')
  expect(all[0].id).toBe('compact')
  expect(all).toHaveLength(11)
  expect(filterSlashItems('image').map(i => i.id)).toEqual(['imagepull'])
  expect(filterSlashItems('IMAGEPULL').map(i => i.id)).toEqual(['imagepull'])
  expect(filterSlashItems('zzz')).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/chatPlaybooks.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 chatPlaybooks.js**

```js
// 斜杠命令面板数据(2026-08-28 spec D3):剧本=可编辑插入的完整提示词;动作=直接执行。
// 纯数据+纯过滤,无 Vue 依赖;文案键指向 locales 的 workbench.chat.slash.*。
export const SLASH_ACTIONS = [
  { id: 'compact', icon: 'bolt', nameKey: 'workbench.chat.slash.actCompact', descKey: 'workbench.chat.slash.actCompactDesc',
    enabled: state => !!state?.canCompact },
]

export const PLAYBOOKS = [
  { id: 'imagepull', icon: 'description', nameKey: 'workbench.chat.slash.pb.imagepull.name', descKey: 'workbench.chat.slash.pb.imagepull.desc', bodyKey: 'workbench.chat.slash.pb.imagepull.body' },
  { id: 'crashloop', icon: 'description', nameKey: 'workbench.chat.slash.pb.crashloop.name', descKey: 'workbench.chat.slash.pb.crashloop.desc', bodyKey: 'workbench.chat.slash.pb.crashloop.body' },
  { id: 'pending', icon: 'description', nameKey: 'workbench.chat.slash.pb.pending.name', descKey: 'workbench.chat.slash.pb.pending.desc', bodyKey: 'workbench.chat.slash.pb.pending.body' },
  { id: 'svc-unreachable', icon: 'hub', nameKey: 'workbench.chat.slash.pb.svcunreachable.name', descKey: 'workbench.chat.slash.pb.svcunreachable.desc', bodyKey: 'workbench.chat.slash.pb.svcunreachable.body' },
  { id: 'rollout-stuck', icon: 'rocket_launch', iconFallback: 'description', nameKey: 'workbench.chat.slash.pb.rolloutstuck.name', descKey: 'workbench.chat.slash.pb.rolloutstuck.desc', bodyKey: 'workbench.chat.slash.pb.rolloutstuck.body' },
  { id: 'quota', icon: 'prohibit', nameKey: 'workbench.chat.slash.pb.quota.name', descKey: 'workbench.chat.slash.pb.quota.desc', bodyKey: 'workbench.chat.slash.pb.quota.body' },
  { id: 'capacity', icon: 'memory', nameKey: 'workbench.chat.slash.pb.capacity.name', descKey: 'workbench.chat.slash.pb.capacity.desc', bodyKey: 'workbench.chat.slash.pb.capacity.body' },
  { id: 'oomkilled', icon: 'warning', nameKey: 'workbench.chat.slash.pb.oomkilled.name', descKey: 'workbench.chat.slash.pb.oomkilled.desc', bodyKey: 'workbench.chat.slash.pb.oomkilled.body' },
  { id: 'dns', icon: 'dns', nameKey: 'workbench.chat.slash.pb.dns.name', descKey: 'workbench.chat.slash.pb.dns.desc', bodyKey: 'workbench.chat.slash.pb.dns.body' },
  { id: 'health-sweep', icon: 'health_and_safety', nameKey: 'workbench.chat.slash.pb.healthsweep.name', descKey: 'workbench.chat.slash.pb.healthsweep.desc', bodyKey: 'workbench.chat.slash.pb.healthsweep.body' },
]

// query=行首 / 后的输入(可空);小写子串匹配 id;动作恒在前(被过滤同样适用)
export function filterSlashItems(query) {
  const q = String(query || '').toLowerCase()
  const match = item => !q || item.id.toLowerCase().includes(q)
  return [...SLASH_ACTIONS.filter(match), ...PLAYBOOKS.filter(match)]
}
```

- [ ] **Step 4: zh/en locales 补全**(workbench.chat 段,compact 键旁;正文含【占位】,末句风格约束统一)

zh `workbench.chat.slash` 对象(en 镜像翻译,键结构相同):

```json
"slash": {
  "title": "命令与剧本",
  "noMatch": "无匹配的命令或剧本",
  "actCompact": "压缩上下文", "actCompactDesc": "把全部历史重摘要,释放余量(对话空闲时可用)",
  "pb": {
    "imagepull": { "name": "排查 ImagePullBackOff", "desc": "镜像拉取失败:事件→凭据→仓库逐层定位",
      "body": "排查命名空间【ns】里 Pod【pod 名】(或该 ns 全部 Pod)的 ImagePullBackOff:先 describe 看 events 里的镜像名与失败原因(NotFound/BackOff/鉴权),再检查所用 secret/镜像仓库凭据是否正确挂载,必要时读取相关 Secret 的 key 名核对(值已脱敏)。逐步执行,先说结论再给命令级建议。" },
    "crashloop": { "name": "排查 CrashLoopBackOff", "desc": "反复崩溃:上一次日志+退出码定位崩溃点",
      "body": "排查命名空间【ns】里 Pod【pod 名】的 CrashLoopBackOff:先取 previous 日志看崩溃前的最后输出,describe 看退出码/重启次数,结合容器启动命令判断是配置缺失、依赖不可达还是程序错误。逐步执行,先说结论再给命令级建议。" },
    "pending": { "name": "排查 Pod 一直 Pending", "desc": "调度失败:资源/亲和/PVC/配额",
      "body": "排查命名空间【ns】里一直 Pending 的 Pod【pod 名】:describe 看 events 里调度失败的具体原因(资源不足/节点选择器/亲和性/PVC 未绑定/资源配额),逐项核对并给出可执行的解除建议。逐步执行,先说结论再给命令级建议。" },
    "svcunreachable": { "name": "服务访问不通五步排查", "desc": "endpoints→就绪→网络策略→ingress→验证",
      "body": "命名空间【ns】里 Service【svc 名】访问不通,按五步排查:①Service 的 endpoints 是否有 IP(选择器是否匹配到 Pod);②后端 Pod 是否 Ready(探针);③NetworkPolicy 是否挡流;④Ingress 后端与路由是否正确;⑤逐层给出验证方法。逐步执行,先说结论再给命令级建议。" },
    "rolloutstuck": { "name": "排查滚动发布卡住", "desc": "rollout 状态/新旧 RS 对比/探针分析",
      "body": "命名空间【ns】里 Deployment【名称】滚动发布卡住:看 rollout 状态与历史,对比新旧 ReplicaSet 的副本与镜像差异,检查就绪探针/minReadySeconds/资源是否让新 Pod 起不来,判断是否需要回滚并给出依据。逐步执行,先说结论再给命令级建议。" },
    "quota": { "name": "资源配额与限制排查", "desc": "quota/limitrange 对照请求量找超限项",
      "body": "排查命名空间【ns】的资源配额问题:读取该 ns 的 ResourceQuota 与 LimitRange,对照当前工作负载的 requests/limits 总量,找出被拒或截断的具体维度(cpu/memory/pods/存储),并给出调整建议。逐步执行,先说结论再给命令级建议。" },
    "capacity": { "name": "集群容量盘点", "desc": "节点分配率/可调度余量/建议",
      "body": "盘点集群容量:读取节点资源容量与已分配量(requests 口径),计算各节点 cpu/memory 分配率与可调度余量,标出最紧张的节点与资源维度,给出扩容或调度的建议。逐步执行,先说结论再给命令级建议。" },
    "oomkilled": { "name": "排查 OOMKilled", "desc": "退出原因/内存限制与实际用量对比",
      "body": "排查命名空间【ns】里 Pod【pod 名】的 OOMKilled:describe 确认 reason 与最后退出状态,对比容器内存限制与实际用量趋势(可看重启前日志),判断是限制过低还是内存泄漏,给出调整建议。逐步执行,先说结论再给命令级建议。" },
    "dns": { "name": "DNS 解析问题排查", "desc": "同 ns 短名/FQDN/跨 ns 逐级测",
      "body": "排查命名空间【ns】里的 DNS 解析问题:按 同 ns Service 短名 → FQDN → 跨 ns 全名 逐级测试解析(可用 exec 在同 ns 的 Pod 里测),都不通则检查 CoreDNS 相关 Pod 状态与配置。逐步执行,先说结论再给命令级建议。" },
    "healthsweep": { "name": "全景健康巡检", "desc": "ns 内红色项汇总+分级报告",
      "body": "对命名空间【ns】做一次全景健康巡检:列出全部 workload 与 Pod 的异常项(CrashLoop/Pending/ImagePull/重启次数高/OOM)、Warning 事件热点,按 严重/警告/提示 三级汇总成报告,并给出最优先要处理的 3 件事。逐步执行,先说结论再给命令级建议。" }
  }
}
```

en 镜像(slash.title="Commands & playbooks", noMatch="No matching command or playbook", actCompact="Compact context", actCompactDesc="Re-summarize history to free context (available when idle)";每剧本 name/desc 直译,body 译为英文但保留【ns】/【pod name】式占位为【ns】/【pod】标记)。JSON 合法性以 `node -e "JSON.parse(require('fs').readFileSync('src/locales/zh.json','utf8'))"` 校验两文件。

- [ ] **Step 5: 跑测试 + i18n 门禁**

Run: `npx vitest run src/logic/__tests__/chatPlaybooks.test.js && npm run i18n:check`
Expected: 3 pass;i18n 六项 0(引用键缺失=0 靠动态键扫描覆盖 pb.* 点分字面量)

- [ ] **Step 6: 提交**

```bash
git add src/logic/chatPlaybooks.js src/logic/__tests__/chatPlaybooks.test.js src/locales/zh.json src/locales/en.json
git commit -m "feat(wb): 斜杠面板数据模块+内置 10 排障剧本双语文案(slash T1)"
```

---

### Task 2: WorkbenchChat 面板接入

**Files:**
- Modify: `src/components/workbench/WorkbenchChat.vue`(watch/onKeydown/模板)
- Test: `src/components/workbench/__tests__/WorkbenchChat.test.js`(追加;文件极简 i18n 须补真实键——本文件 messages 的 workbench.chat 段加 slash 最小集:name/desc/body 用到的键至少补被断言的 imagepull 三键与 actCompact 两键,写全亦可)

**Interfaces:**
- Consumes: Task 1 的 `SLASH_ACTIONS/PLAYBOOKS/filterSlashItems`;既有 `showCompact`/`compactDisabled`(compact 特性)
- Produces: 面板 testid `slash-panel`,条目 `slash-item`,禁用态 `slash-item-disabled`

- [ ] **Step 1: 写失败测试**(追加;hoisted i18n messages 的 workbench.chat.slash 补 imagepull/compact 相关键)

```js
// ── slash T2:行首 / 面板(spec §3.2)──
test('slash:行首 / 弹面板,输入过滤;非行首 / 不触发', async () => {
  const w = await mountChat()
  await w.find('textarea').setValue('/image')
  expect(w.find('[data-testid="slash-panel"]').exists()).toBe(true)
  expect(w.findAll('[data-testid="slash-item"]').length).toBe(1)
  await w.find('textarea').setValue('看下 https://x.com/a')
  expect(w.find('[data-testid="slash-panel"]').exists()).toBe(false, '非行首 / 不触发')
})

test('slash:选中剧本→替换输入框为剧本正文;Esc 关闭保留输入', async () => {
  const w = await mountChat()
  await w.find('textarea').setValue('/imagepull')
  await w.find('[data-testid="slash-item"]').trigger('click')
  expect(w.find('textarea').element.value).toContain('ImagePullBackOff')
  expect(w.find('[data-testid="slash-panel"]').exists()).toBe(false)
  await w.find('textarea').setValue('/')
  await w.find('textarea').trigger('keydown', { key: 'Escape' })
  expect(w.find('[data-testid="slash-panel"]').exists()).toBe(false)
  expect(w.find('textarea').element.value).toBe('/')
})

test('slash:/compact 选中→开压缩 modal;禁用态不可选', async () => {
  const w = await mountChat()   // 无对话 → canCompact=false → 禁用
  await w.find('textarea').setValue('/compact')
  const item = w.find('[data-testid="slash-item"]')
  expect(item.classes()).toContain('slash-item-disabled')  // 或 disabled 属性断言,实现定后锁死
  await item.trigger('click')
  expect(w.find('[data-testid="context-compact-modal"]').exists()).toBe(false, '禁用不可选')
})
```

(实现者注:第三条断言 class 名以实现为准锁死;键盘 ↑↓/Enter 用 trigger('keydown') 同款补一条:↓ 移动 activeIndex 高亮类/Enter 选中首项替换输入。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.test.js`
Expected: 新测试 FAIL(slash-panel 不存在)

- [ ] **Step 3: 实现**

script 段(@-mention state 旁):

```js
// ── 斜杠面板(2026-08-28 spec §3.2):行首 / 触发,与 @-mention 互斥 ──
const SLASH_RE = /^\/(\w*)$/m
const slashOpen = ref(false)
const slashItems = ref([])
const slashActive = ref(-1)
function clearSlash() { slashOpen.value = false; slashItems.value = []; slashActive.value = -1 }
function selectSlashItem(item) {
  if (item.enabled && !item.enabled({ canCompact: !compactDisabled.value })) return   // 禁用动作不可选
  if (item.id === 'compact') { input.value = input.value.replace(/^\/\w*$/m, '').trimEnd(); clearSlash(); showCompact.value = true; return }
  input.value = t(item.bodyKey)     // 剧本:替换整个输入框(spec D1)
  clearSlash()
  nextTick(() => { if (taEl.value) taEl.value.style.height = 'auto'; taEl.value?.focus?.() })
}
```

watch(input) 里,@-mention 分支之前加:

```js
  const slashMatch = val.match(SLASH_RE)
  if (slashMatch && !(val.match(MENTION_RE) || val.match(AT_RE))) {
    if (searchOpen.value) clearSearch()          // 互斥:后触发关前者
    slashItems.value = filterSlashItems(slashMatch[1])
    slashOpen.value = true
    slashActive.value = slashItems.value.length ? 0 : -1
    return
  }
  clearSlash()
  // …既有 @-mention 逻辑保持(其触发处对应加 if (slashOpen.value) clearSlash())
```

onKeydown 下拉分支:`if (searchOpen.value && mentionItems.value.length)` 改为 `if ((searchOpen.value && mentionItems.value.length) || (slashOpen.value && slashItems.value.length))`,内部 ↑↓/Enter/Tab/Esc 对 slashOpen 分支操作 slashItems/slashActive(Enter/Tab → `e.preventDefault(); selectSlashItem(slashItems.value[slashActive.value])`)。

模板(@-mention 下拉旁并列):

```html
        <!-- 斜杠面板:行首 / 触发;动作禁用置灰不可选 -->
        <div v-if="slashOpen" data-testid="slash-panel" class="absolute bottom-full left-0 right-0 mb-xs bg-surface-container-lowest border border-outline-variant rounded-xl shadow-xl max-h-64 overflow-y-auto z-30">
          <div class="px-md py-xs text-body-xs text-on-surface-variant border-b border-outline-variant flex items-center gap-xs">
            <span class="material-symbols-outlined text-sm">bolt</span>{{ t('workbench.chat.slash.title') }}
          </div>
          <div v-if="!slashItems.length" class="px-md py-sm text-body-sm text-on-surface-variant">{{ t('workbench.chat.slash.noMatch') }}</div>
          <button v-for="(item, i) in slashItems" :key="item.id" type="button" data-testid="slash-item"
            :class="[i === slashActive ? 'bg-primary/10' : 'hover:bg-primary/5', item.enabled && !item.enabled({ canCompact: !compactDisabled.value }) ? 'slash-item-disabled opacity-40 cursor-not-allowed' : '']"
            class="w-full flex items-start gap-sm text-left px-md py-sm"
            @mousedown.prevent="() => { if (!(item.enabled && !item.enabled({ canCompact: !compactDisabled.value }))) { slashActive = i; selectSlashItem(item) } }">
            <span class="material-symbols-outlined text-base text-primary mt-0.5">{{ item.icon }}</span>
            <span class="min-w-0 flex-1">
              <span class="block text-body-sm font-semibold text-on-surface truncate">{{ t(item.nameKey) }}</span>
              <span class="block text-body-xs text-on-surface-variant truncate">{{ t(item.descKey) }}</span>
            </span>
          </button>
        </div>
```

import:`import { SLASH_ACTIONS, PLAYBOOKS, filterSlashItems } from '@/logic/chatPlaybooks'`(SLASH_ACTIONS/PLAYBOOKS 仅测试消费,组件用 filterSlashItems;为避免未用 import 告警只 import filterSlashItems)。

- [ ] **Step 4: 跑测试确认通过 + 组件回归 + i18n**

Run: `npx vitest run src/components/workbench/__tests__/WorkbenchChat.test.js && npm run i18n:check`
Expected: PASS;六项 0

- [ ] **Step 5: 提交**

```bash
git add src/components/workbench/WorkbenchChat.vue src/components/workbench/__tests__/WorkbenchChat.test.js
git commit -m "feat(ui): 输入框行首 / 命令面板——剧本插入可编辑/compact 动作/与 @ 互斥(slash T2)"
```

---

### Task 3: 全量回归 + 收尾

- [ ] **Step 1:** `npm test` / `npm run typecheck` / `npm run build` / `npm run i18n:check` 全绿。
- [ ] **Step 2:** 手测清单记入合并提交信息(/ 面板弹出与过滤/键盘导航/剧本插入含【占位】/compact 动作开 modal/编辑态内 / 照常/多行文本行首 / 触发)。
- [ ] **Step 3:** 合并:rebase main(如有并行)→ 全量验证 → ff 合并 → push(用户裁决 tag)。

---

## Self-Review 记录

1. **Spec 覆盖**:§3.1 数据模块→T1;§3.2 面板接入→T2;§3.3 i18n→T1 Step 4;§4 错误处理散在 T2(非行首/禁用/Esc);§5 测试对应两任务+T3 回归。无遗漏。
2. **占位符**:en 镜像要求「直译+保留占位标记」是明确的翻译指令非 TBD;键盘测试实现者注为「补一条」的明确动作。代码完整。
3. **类型一致**:`filterSlashItems(query)`、`SLASH_ACTIONS[].enabled({canCompact})`、testid(slash-panel/slash-item/slash-item-disabled)两任务一致;`compactDisabled` 复用既有(compact 特性)。
