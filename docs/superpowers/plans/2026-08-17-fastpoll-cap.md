# fastMode 高频总时长封顶 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `useDeployFastPoll` 增加 5 分钟高频封顶 + 抑制态(解除需连续 10s 平静)+ 抖动不续命——稳态半就绪负载(如 crashloop 1/2)不再让 NsOverview 永久 3s 轮询。

**Architecture:** 只改一个组合式文件与它的测试:fast 真上升沿启动封顶 timer;fast 期间 busy 抖动不重置它;封顶触发后进入抑制态,rising 被忽略且取消进行中的解除计时;busy 连续平静满 holdMs 才解除抑制并重新武装。页面零改动(API 仅新增可选参数,默认生效)。

**Tech Stack:** Vue 3 组合式 + vitest fake timers(既有测试文件追加用例)。

**Spec:** `docs/superpowers/specs/2026-08-17-fastpoll-cap-design.md`(已批准+加固)

## Global Constraints

- 分支 `feat/fastpoll-cap`,worktree `.claude/worktrees/fastpoll-cap`(已存在,勿再建)。
- 不新增依赖;页面/视图零改动;API 向后兼容(`maxFastMs` 可选,默认 `MAX_FAST_MS = 300000`)。
- 既有 6 个 vitest 用例(常量/初始/上升沿立即/收敛保持/保持期内取消回落/连续收敛不叠加/作用域清理)必须全绿不回归。
- 提交信息末尾带 `Co-Authored-By: Claude <noreply@anthropic.com>`。

---

### Task 1: useDeployFastPoll 封顶 + 抑制态

**Files:**
- Modify: `src/composables/useDeployFastPoll.js`(整体替换实现,保留对外 API)
- Test: `src/composables/__tests__/useDeployFastPoll.test.js`(追加 3 用例)

**Interfaces:**
- Consumes: `anyWorkloadTransitioning`(@/logic/workloadTransition,不变)
- Produces: `useDeployFastPoll(source, { holdMs = 10000, maxFastMs = 300000 } = {})` → `{ fastMode, pollInterval }`;新导出常量 `MAX_FAST_MS = 300000`;既有 `FAST_MS/SLOW_MS` 不变。消费方(NamespaceOverview)零改动。

- [ ] **Step 1: 追加失败测试**(加到既有测试文件末尾;busyRaw/okRaw 夹具与 beforeEach/afterEach(fake timers)沿用文件顶部既有定义)

```js
// === 高频封顶 + 抑制态(spec 2026-08-17)===
test('封顶:持续 busy 满默认 5min → 强制回落并抑制;抑制期 rising 被忽略(短暂平静不算解除)', () => {
  const src = ref([busyRaw])
  const { fastMode } = useDeployFastPoll(() => src.value)
  expect(fastMode.value).toBe(true)
  vi.advanceTimersByTime(300000)
  expect(fastMode.value).toBe(false)        // 封顶强制回落
  src.value = [okRaw]                        // 平静 → 解除计时启动
  vi.advanceTimersByTime(5000)
  src.value = [{ ...busyRaw }]               // 5s 后又 busy → 取消解除计时,维持抑制
  vi.advanceTimersByTime(60000)
  expect(fastMode.value).toBe(false)         // 未连续平静 10s,不得解除
})

test('抑制解除:连续 10s 平静 → 重新武装;新会话有完整 5min 额度', () => {
  const src = ref([busyRaw])
  const { fastMode } = useDeployFastPoll(() => src.value)
  vi.advanceTimersByTime(300000)             // 封顶进入抑制
  src.value = [okRaw]
  vi.advanceTimersByTime(10000)              // 连续平静 10s → 解除
  src.value = [{ ...busyRaw }]
  expect(fastMode.value).toBe(true)          // 新部署正常进 fast
  vi.advanceTimersByTime(299999)
  expect(fastMode.value).toBe(true)          // 额度完整(旧 timer 已清)
  vi.advanceTimersByTime(1)
  expect(fastMode.value).toBe(false)
})

test('抖动不续命:fast 期间 busy 反复抖动不重置封顶计时', () => {
  const src = ref([busyRaw])
  const { fastMode } = useDeployFastPoll(() => src.value)
  for (let i = 0; i < 30; i++) {             // 30 轮:3s busy + 瞬时平静 + 又 busy
    vi.advanceTimersByTime(3000)
    src.value = [okRaw]
    src.value = [{ ...busyRaw }]
  }
  expect(fastMode.value).toBe(true)          // 抖动期间仍 fast(突发未断)
  vi.advanceTimersByTime(210000)             // 累计 300s → 封顶照触发
  expect(fastMode.value).toBe(false)
})
```

- [ ] **Step 2: 跑测试确认新用例失败**

Run: `npx vitest run src/composables/__tests__/useDeployFastPoll.test.js`
Expected: 3 个新用例 FAIL(现实现无封顶:5min 后仍 true),既有用例 PASS

- [ ] **Step 3: 实现**(src/composables/useDeployFastPoll.js 整体替换为)

```js
// 部署感知 fastMode 状态机:workload 变更进行中 → 立即进入高频;全部收敛 → 保持 holdMs 后回落。
// 高频封顶(spec 2026-08-17):fast 真上升沿启动 maxFastMs 封顶计时,期间 busy 抖动不重置;
// 到点强制回落并进入抑制态——rising 被忽略、取消进行中的解除计时;busy 连续平静满 holdMs
// 才解除抑制重新武装。稳态半就绪负载(crashloop 1/2)不会让页面永久 3s 轮询。
// 消费方:NamespaceOverview 自适应轮询(唯一);source 为懒求值 getter(flush:'sync' 前提:纯读)。
import { ref, computed, watch, toValue, onScopeDispose } from 'vue'
import { anyWorkloadTransitioning } from '@/logic/workloadTransition'

export const FAST_MS = 3000
export const SLOW_MS = 30000
export const MAX_FAST_MS = 300000

export function useDeployFastPoll(source, { holdMs = 10000, maxFastMs = MAX_FAST_MS } = {}) {
  const fastMode = ref(false)
  const pollInterval = computed(() => (fastMode.value ? FAST_MS : SLOW_MS))
  let fallTimer = null    // holdMs 平静计时:fast 态=收敛保持回落;抑制态=解除抑制
  let maxTimer = null     // 高频封顶计时(跨抖动不重置)
  let suppressed = false  // 封顶后抑制:需连续 holdMs 平静才重新武装
  const clearFall = () => { if (fallTimer) { clearTimeout(fallTimer); fallTimer = null } }
  const clearMax = () => { if (maxTimer) { clearTimeout(maxTimer); maxTimer = null } }
  const armFall = () => {
    if (fallTimer) return
    fallTimer = setTimeout(() => {
      fallTimer = null
      fastMode.value = false
      clearMax()          // 自然回落:短会话不占用下一会话封顶额度
      suppressed = false  // 连续平静达标:解除抑制
    }, holdMs)
  }
  const tripCap = () => { maxTimer = null; clearFall(); fastMode.value = false; suppressed = true }
  watch(
    () => anyWorkloadTransitioning(toValue(source)),
    busy => {
      if (busy) {
        if (suppressed) { clearFall(); return }   // 抑制期:忽略 rising,并取消解除计时
        clearFall()
        if (!fastMode.value) {                    // 真上升沿:进 fast + 启封顶
          fastMode.value = true
          maxTimer = setTimeout(tripCap, maxFastMs)
        }
        // fast 态 re-trigger(10s 保持期内又 busy):不重置 maxTimer——抖动不续命
      } else {
        armFall()                                  // fast=收敛保持;抑制=解除计时;slow 平静=幂等
      }
    },
    { immediate: true, flush: 'sync' },
  )
  onScopeDispose(() => { clearFall(); clearMax() })
  return { fastMode, pollInterval }
}
```

- [ ] **Step 4: 跑全部测试确认通过**

Run: `npx vitest run src/composables/__tests__/useDeployFastPoll.test.js && npx vitest run`
Expected: 该文件 9/9(既有 6 + 新 3)PASS;全量 vitest 无回归

- [ ] **Step 5: 全量门禁**

Run: `npm run test:server && npm run typecheck`
Expected: 全绿(本次无 i18n/视图改动)

- [ ] **Step 6: Commit**

```bash
git add src/composables/useDeployFastPoll.js src/composables/__tests__/useDeployFastPoll.test.js
git commit -m "feat(overview): fastMode 高频封顶(5min)+抑制态——稳态半就绪负载不再永久 3s;抖动不续命"
```

---

## Self-Review 记录

- **Spec 覆盖**:§2 六条行为(封顶/抖动不续命/抑制忽略+取消解除/连续10s解除/短会话重置/页面零改动)→ Task 1 Step 3 实现逐条对应;§3 四组用例→Step 1(3 新用例覆盖 1/2/3,第 4 组「既有不回归」由 Step 4 保障);§4 范围外未越界。
- **占位符**:无;实现与测试代码完整。
- **类型一致性**:`maxFastMs` 参数名/`MAX_FAST_MS` 常量/spec §2 一致;`busyRaw/okRaw` 夹具沿用既有测试文件定义(Step 1 已注明)。
- **边界推演**:既有用例 3(保持期内再进行中)在新实现下——re-trigger 不重置 maxTimer,t=11s 处 advance(5000) 距封顶远,断言不受影响;既有用例 2 的回落到点同时 clearMax+清 suppressed,幂等无害。
