# 部署向导存储步骤门禁实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DeployApp 向导 step 2(存储)加门禁:每个卷条目必须来源完整 + mountPath 合法 + target 有效,否则拦下一步并内联提示。

**Architecture:** 纯函数 `firstVolumeMountError` 放 `src/logic/volumeMountValidation.js`(仿 containerValidation 单源),DeployApp `stepBlockReason` 加 step 2 分支消费;i18n 3 键。

**Tech Stack:** Vue 3 + vitest + vue-i18n(zh/en)。

**Spec:** `docs/superpowers/specs/2026-08-25-volume-mount-gate-design.md`

## Global Constraints

- 开工先 EnterWorktree(分支 `worktree-fix-volume-mount-gate`);commit 前 `git branch --show-current`
- 不新增依赖;新文案 zh/en 双语;docs/ 提交 `git add -f`
- 串扰条款:全量失败全为 timeout 型 → 隔离复跑/放宽 --testTimeout 定论,勿因串扰改码;**验证命令以 vitest 退出码为准,勿用 grep 管道接 && 链**

---

### Task 1: volumeMountValidation + 门禁接线(TDD)

**Files:**
- Create: `src/logic/volumeMountValidation.js`
- Test: `src/logic/__tests__/volumeMountValidation.test.js`(新建)
- Modify: `src/views/DeployApp.vue`(import + stepBlockReason step 2 分支)
- Modify: `src/locales/zh.json`/`en.json`(`deploy` 对象内 3 键)

**Interfaces:**
- Consumes: DeployApp 既有 `containerTargets` computed(value 集 = 'main' + 有镜像 `init:i`/`sidecar:i`)
- Produces: `firstVolumeMountError(volumeMounts, validTargets)` → `{ key: string, n: number } | null`

- [ ] **Step 1: i18n 键(zh.json `deploy` 对象内;两文件同步)**

zh:
```json
"volumeSourceRequired": "第 {n} 个存储缺少来源(按类型填 PVC/路径/服务器/名称)",
"volumeMountRequired": "第 {n} 个存储缺少容器内挂载路径(须以 / 开头)",
"volumeTargetInvalid": "第 {n} 个存储的目标容器不存在或未配置镜像",
```
en:
```json
"volumeSourceRequired": "Volume #{n} is missing its source (PVC/path/server/name per type)",
"volumeMountRequired": "Volume #{n} is missing the in-container mount path (must start with /)",
"volumeTargetInvalid": "Volume #{n} targets a container that does not exist or has no image",
```

- [ ] **Step 2: 写失败测试**

```js
// src/logic/__tests__/volumeMountValidation.test.js
// 向导 step2 门禁纯函数:卷必须映射到容器(来源/mountPath/target 三查),堵静默丢弃洞。
import { test, expect } from 'vitest'
import { firstVolumeMountError } from '@/logic/volumeMountValidation'

const OK = ['main', 'init:0', 'sidecar:0']
const base = { name: 'vol-1', target: 'main', type: 'pvc', mountPath: '/data', subPath: '', readOnly: false, pvcName: 'my-pvc', hostPath: '', server: '', nfsPath: '', cmName: '', secretName: '', items: [] }

test('全部合法 → null', () => {
  expect(firstVolumeMountError([{ ...base }], OK)).toBe(null)
  expect(firstVolumeMountError([{ ...base, type: 'emptyDir', mountPath: '/scratch' }], OK)).toBe(null)
})

test('来源缺失:按类型查字段,返回首坏序号', () => {
  expect(firstVolumeMountError([{ ...base, pvcName: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, type: 'hostPath', hostPath: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, type: 'nfs', server: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, type: 'configMap', cmName: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, type: 'secret', secretName: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base }, { ...base, name: 'vol-2', pvcName: '' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 2 })
})

test('mountPath:空或非斜杠开头 → deploy.volumeMountRequired', () => {
  expect(firstVolumeMountError([{ ...base, mountPath: '' }], OK)).toEqual({ key: 'deploy.volumeMountRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, mountPath: 'data' }], OK)).toEqual({ key: 'deploy.volumeMountRequired', n: 1 })
})

test('target 悬空(容器已删/无镜像)→ deploy.volumeTargetInvalid', () => {
  expect(firstVolumeMountError([{ ...base, target: 'sidecar:9' }], OK)).toEqual({ key: 'deploy.volumeTargetInvalid', n: 1 })
})
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: FAIL(模块不存在)

- [ ] **Step 4: 实现**

```js
// src/logic/volumeMountValidation.js
// 部署向导 step2(存储)门禁纯函数:每个卷条目必须「来源完整 + mountPath 合法 + target 有效」。
// 背景:mountsForTarget 与 pod 级 volumesYaml 都静默过滤不完整条目——未映射的卷在
// 生成 YAML 里整个消失,用户无感知(2026-08-25 用户报障)。单一事实源,无 Vue 依赖。
const SOURCE_FIELD = { pvc: 'pvcName', hostPath: 'hostPath', nfs: 'server', configMap: 'cmName', secret: 'secretName' }

// 返回首个坏条目 { key, n }(n 为 1-based 序号,供 i18n 提示);全部合法 → null
export function firstVolumeMountError(volumeMounts, validTargets) {
  for (let i = 0; i < (volumeMounts || []).length; i++) {
    const v = volumeMounts[i]
    const src = SOURCE_FIELD[v.type]
    if (src && !v[src]) return { key: 'deploy.volumeSourceRequired', n: i + 1 }
    if (!v.mountPath || !String(v.mountPath).startsWith('/')) return { key: 'deploy.volumeMountRequired', n: i + 1 }
    if (!(validTargets || []).includes(v.target)) return { key: 'deploy.volumeTargetInvalid', n: i + 1 }
  }
  return null
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: PASS 4/4

- [ ] **Step 6: DeployApp 接线**

import 区(:16 附近 subContainer import 旁)加:

```js
import { firstVolumeMountError } from '@/logic/volumeMountValidation'
```

`stepBlockReason`(:274 step1 块之后)插入:

```js
  if (currentStep.value === 2) {
    // 存储门禁:每个卷必须来源完整+映射到有效容器的挂载路径(否则 YAML 里静默消失)
    const e = firstVolumeMountError(f.volumeMounts, containerTargets.map(x => x.value))
    if (e) return t(e.key, { n: e.n })
  }
```

- [ ] **Step 7: 验证**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js src/views/__tests__ ; npm run i18n:check 2>&1 | tail -1 ; npm run build 2>&1 | tail -1`(注意用 `;` 分隔读取输出,判定以各命令退出码为准)
Expected: 4/4+views 全过;i18n 0;build 成功

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add src/logic/volumeMountValidation.js src/logic/__tests__/volumeMountValidation.test.js src/views/DeployApp.vue src/locales/zh.json src/locales/en.json
git commit -m "fix(deploy): 向导存储步骤门禁——卷必须来源完整+映射到有效容器,堵静默丢弃洞(用户报障)"
```

---

### Task 2: 门禁四连+终审+合并推送(控制器执行)

- [ ] Step 1: `npm run test:unit && npm test && npm run typecheck && npm run build`(退出码为准;串扰条款)
- [ ] Step 2: 全分支终审(SDD review-package)
- [ ] Step 3: main ff-only 合并+push(main 被推进则查重叠→零重叠 merge→定向 sanity→ff)
- [ ] Step 4: 手测清单交付 + NsWorkloadDetail 编辑路径同款洞记 follow-up

## Self-Review 记录

- 覆盖:spec 三规则→Step 2-4;接线→Step 6;i18n→Step 1;验证→Task 2 ✓
- 占位:无 ✓;类型一致:`firstVolumeMountError(volumeMounts, validTargets)` 签名两任务一致 ✓
