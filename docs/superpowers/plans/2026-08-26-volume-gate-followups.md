# 卷校验补齐实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** items 半填规则进单源(向导门禁自动获得)+ WLD 编辑路径补 target 有效性与 items 检查。

**Architecture:** volumeMountValidation.js 新增 `volumeItemsIncomplete(entry)` 并作 firstVolumeMountError 第 4 规则;NsWorkloadDetail validateEdit 内联补两条(消息风格复用既有 w 变量);i18n 3 键。

**Tech Stack:** Vue 3 + vitest + vue-i18n。

**Spec:** `docs/superpowers/specs/2026-08-26-volume-gate-followups-design.md`

## Global Constraints

- 开工先 EnterWorktree(分支 `worktree-fix-volume-gate-followups`);commit 前 `git branch --show-current`
- **提交规范(CLAUDE.md)**:作者恒 aliangone,信息中文,**禁加 Co-Authored-By: Claude 尾注**
- 不新增依赖;验证以退出码为准(勿 grep 管道接 &&)
- **`.value` 红线**:script 语境 computed 一律 `.value`(全仓守卫测试会抓)
- docs/ 提交 `git add -f`

---

### Task 1: items 规则 + WLD 编辑路径补齐(TDD)

**Files:**
- Modify: `src/logic/volumeMountValidation.js`(新导出 volumeItemsIncomplete + 第 4 规则)
- Test: `src/logic/__tests__/volumeMountValidation.test.js`(追加用例)
- Modify: `src/views/NsWorkloadDetail.vue`(validateEdit :1026 块 + import)
- Modify: `src/locales/zh.json`/`en.json`(3 键)

**Interfaces:**
- Produces: `volumeItemsIncomplete(entry) → boolean`(items 任一半填行 `(key||path)&&!(key&&path)`;全空行忽略)

- [ ] **Step 1: i18n 键(共 3 键,分属两个对象;zh/en 同位置镜像)**

`deploy` 对象内(zh / en):
```json
"volumeItemsIncomplete": "第 {n} 个存储的键映射(items)有半填行(key/path 须成对)" / "Volume #{n} has partially-filled key mapping rows (key/path must be paired)"
```
`workload.validation` 对象内(既有 volumeMissingMountPath 等所在;zh / en):
```json
"volumeItemsIncomplete": "{name} 的键映射(items)有半填行(key/path 须成对)" / "{name} has partially-filled key mapping rows (key/path must be paired)"
"volumeTargetInvalid": "{name} 的目标容器不存在或未配置镜像" / "{name} targets a container that does not exist or has no image"
```
(注意:`volumeItemsIncomplete` 在两个对象各有一份、值不同——deploy 用序号 {n},workload.validation 用卷名 {name},JSON 键各自成对)

- [ ] **Step 2: 追加失败测试(volumeMountValidation.test.js 末尾)**

```js
import { firstVolumeMountError, volumeItemsIncomplete } from '@/logic/volumeMountValidation'

test('items 半填:key-only/path-only → volumeItemsIncomplete;全空行忽略', () => {
  const it = (key, path) => ({ key, path })
  expect(volumeItemsIncomplete({ items: [it('k', '')] })).toBe(true)
  expect(volumeItemsIncomplete({ items: [it('', 'p')] })).toBe(true)
  expect(volumeItemsIncomplete({ items: [it('', ''), it('k', 'p')] })).toBe(false)
  expect(volumeItemsIncomplete({})).toBe(false)
  expect(firstVolumeMountError([{ ...base, items: [{ key: 'k', path: '' }] }], OK)).toEqual({ key: 'deploy.volumeItemsIncomplete', n: 1 })
  expect(firstVolumeMountError([{ ...base, items: [{ key: '', path: '' }] }], OK)).toBe(null)
})
```

(`base`/`OK` 用文件顶部既有常量)

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: FAIL(volumeItemsIncomplete 未导出),exit≠0

- [ ] **Step 4: 实现(volumeMountValidation.js)**

文件末尾追加:

```js
// items 键映射半填:key/path 须成对;全空行忽略(与 YAML 生成 it.key 过滤的「整行空=跳过」语义一致)
export function volumeItemsIncomplete(entry) {
  return (entry?.items || []).some(it => (it.key || it.path) && !(it.key && it.path))
}
```

`firstVolumeMountError` 的 target 检查之后、return null 之前插入:

```js
    if (volumeItemsIncomplete(v)) return { key: 'deploy.volumeItemsIncomplete', n: i + 1 }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: 5/5(exit 0)

- [ ] **Step 6: NsWorkloadDetail validateEdit 补两条**

import 区(:21 附近 containerValidation import 旁)加 `import { volumeItemsIncomplete } from '@/logic/volumeMountValidation'`。

validateEdit 的卷块(:1024-1035)`else { ... }` 内(现有 mountPath/来源检查之后)追加:

```js
      const validTargets = containerTargets.value.map(x => x.value)
      if (!validTargets.includes(v.target)) errs.push(t('workload.validation.volumeTargetInvalid', { name: v.name || '#' + (i + 1) }))
      if (volumeItemsIncomplete(v)) errs.push(t('workload.validation.volumeItemsIncomplete', { name: v.name || '#' + (i + 1) }))
```

(移到 else 块外计算 validTargets 一次亦可——放 forEach 外更优:`const validTargets = containerTargets.value.map(x => x.value)` 置于 forEach 之前,循环内只做 includes。)

- [ ] **Step 7: 验证(退出码为准)**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js src/views/__tests__ && node scripts/check-missing-value.mjs && npm run i18n:check && npm run build`
Expected: 全 exit 0

- [ ] **Step 8: Commit(中文,无尾注)**

```bash
git branch --show-current
git add src/logic/volumeMountValidation.js src/logic/__tests__/volumeMountValidation.test.js src/views/NsWorkloadDetail.vue src/locales/zh.json src/locales/en.json
git commit -m "fix(workload): 卷校验补齐——items 半填(key/path 须成对)进单源,编辑路径补 target 有效性(悬空挂载不再静默丢失)"
```

---

### Task 2: 门禁+终审+合并推送(控制器执行)

- [ ] Step 1: `npm run test:unit && npm test && npm run typecheck && npm run build`(退出码;串扰条款)
- [ ] Step 2: 全分支终审(SDD review-package)
- [ ] Step 3: main ff-only 合并+push(分叉则查重叠→零重叠 merge→定向 sanity→ff)
- [ ] Step 4: 手测交付

## Self-Review 记录

- 覆盖:spec items 单源→Step 2-5;WLD 两条→Step 6;i18n 3 键→Step 1;验证→Task 2 ✓
- 占位:无(代码全量内联;i18n 双对象同键异值已显式说明)✓
- 类型一致:`volumeItemsIncomplete(entry)→boolean` 两消费方一致;`.value` 红线已标注 ✓
