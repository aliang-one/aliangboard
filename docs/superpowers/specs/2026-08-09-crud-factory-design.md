# CRUD 工厂化设计 spec

**日期**:2026-08-09 / 分支:待定(实现时从最新 main 拉隔离 worktree)
**目标**:把 cluster.js 里 ~72 个高度重复的 add/update/delete CRUD(~800 行)收敛成一张配置表 + 一个生成器,预计省 ~150-180 行;并**顺带从结构上消灭 await-race**。
**前置**:main 已无已知 bug,await-race + .value 两类已有确定性守门(本会话已建)。

---

## 1. 背景:为什么要做

cluster.js(2778 行)里每个资源的 add/update/delete 是同一副骨架:
```
addX(item):    remoteMode ? await remoteCreate(generateYAML(type,item),`Kind/name`,()=>refetch(api,ref,mapper)) : ref.push(...); invalidateResource(plural)
updateX(n,ns,u): 找 idx → 乐观更新 → remoteMode ? await remoteUpdate(gen,...,rollback) : noop; invalidateResource(plural)
deleteX(n,ns):  remoteMode ? await remoteDelete(api/ref, ref, matchFn) : splice; invalidateResource(plural)
```
~23 资源 × 3 ≈ 72 个函数,几乎逐字复制。这是 cluster.js 瘦身(数据层重构 Plan 5)的最大块,也是 bug 温床(await-race 就是因为每个 handler 各写一遍 await+invalidate 顺序才漏)。

---

## 2. 教训护栏(本会话翻过的错 → 这次不许再犯)

| 教训 | 本设计的对策 |
|---|---|
| 状态耦合函数抽进纯模块 → `ref is not defined` 白屏 | 工厂**留在 cluster.js 内**(用 store ref / remoteMode / invalidateResource),**不**抽成独立纯模块 |
| 删了函数但 return 对象留悬挂引用 → store 初始化崩 | 生成的 add/update/delete 必须正确接入 `return {...}`;改完 grep return |
| computed 漏 .value / 漏 import | 工厂集中所有 `ref.value` 访问,每处一次;生成器在 cluster.js 作用域,ref/mapper/invalidateResource 全已在 scope |
| await-race(未 await + invalidate 抢跑) | 工厂**集中** `await remoteOp` + `invalidateResource` 顺序写死 → 工厂覆盖资源结构上不可能再出此 race |
| mock 挂载套件 computed 惰性盲区 | CRUD 不在挂载路径 → **新增 CRUD 冒烟测试**(确定性批量验证每个生成的函数) |

**元原则**:typecheck/build 通过 ≠ 运行期干净。唯一可靠护栏是**真正跑到那条路径的测试 + 确定性静态守门**。

---

## 3. 方案定调:全覆盖 + 仅复杂资源用 hook

- **所有 ~24 资源都进工厂表**(用户裁定 B = 全覆盖)。
- **~19 规整资源**:纯配置(secrets 等带轻量 beforeSave 预处理 hook,无结构性差异),占 800 行大头,风险最低。
- **~5 复杂资源**:配置 + 可选结构性 hook。**hook 复用现有手写逻辑**(merge-patch / custom YAML / dynamicPlural / sideEffects),工厂只接线、不发明新逻辑 → 不新增 bug 面。
- (规整/复杂的精确切分在 plan 阶段按 API 路径核实最终定;ingress/pod/crd 的特殊 op 始终手写)
- 这比「统一 rich hook schema」安全:hook 只在复杂资源出现,且是已存在、已测代码搬位置。

> 为什么不纯配置到底:复杂资源的 add/update 在结构上就不同(workload 用 merge-patch 不 regenerate、namespace 用自定义 YAML 不走 generateYAML、namespace update 仅 mock)。强行纯配置会把特殊逻辑塞进生成器,反而成新 bug 面。hook 是「把已有的特殊逻辑挂回去」的最小侵入方式。

---

## 4. 架构(全在 cluster.js,状态耦合)

```
┌─ RESOURCE_SPECS (表,key=plural) ─────────────────────────┐
│  configmaps: {kind,api,ref,mapper,namespaced:true}        │ ← 规整,纯配置
│  secrets:    {..., beforeSave: encodeSecretData}           │ ← 规整 + 一个预处理 hook
│  workloads:  {..., dynamicPlural, patch:'merge', sideFx}   │ ← 复杂,多 hook
│  namespaces: {..., customYaml, refreshMapper, skipUpd:true}│ ← 复杂
│  ... (~23 entry)                                           │
└────────────────────────────────────────────────────────────┘
            │ makeCrud(plural, spec)  ← 一个生成器
            ▼
┌─ 生成的 { add, update, delete } ──────────────────────────┐
│  集中:await remoteCreate/Update/Delete + invalidateResource│
│  + 乐观更新 + 失败回滚(复用现有 remoteXxx 语义)           │
│  + 触发 spec 的 hook(beforeSave / customYaml / sideFx...) │
└────────────────────────────────────────────────────────────┘
            │ 解构接入 store return
            ▼
   store.addConfigMap / updateConfigMap / deleteConfigMap ... (签名不变 → 视图零改动)
```

---

## 5. Spec schema(配置表字段)

**标准字段(规整资源只需这些)**:
| 字段 | 说明 | 例 |
|---|---|---|
| `kind` | K8s Kind(用于提示/remoteCreate 标签) | `'ConfigMap'` |
| `api` | list/子资源 API 路径(含 ns 占位) | `'/api/v1/namespaces/{ns}/configmaps'`(namespaced)或 `'/api/v1/nodes'`(cluster) |
| `ref` | store 列表 ref | `configMapList` |
| `mapper` | K8s 对象→前端扁平 | `mapConfigMap` |
| `namespaced` | 是否命名空间作用域(决定路径/findIndex 带 ns) | `true`/`false` |

**可选 hook(仅复杂资源)**:
| hook | 触发点 | 用在哪 |
|---|---|---|
| `beforeSave(item)` | add/update 入参预处理(如 base64 编码) | secrets(`encodeSecretData`) |
| `genType` | generateYAML 的 type(默认 = plural) | 个别资源 type≠plural 时 |
| `customYaml(item)` | 完全自定义 YAML(绕过 generateYAML) | namespaces |
| `refreshMapper(item)` | refetch 后的映射(派生字段) | namespaces(算 pods/services) |
| `dynamicPlural(item)` | 按 item.type 返回 API plural | workloads(Deployment→deployments) |
| `patch:'merge'` | update 用定点 merge-patch(不 regenerate,保深模板) | workloads |
| `sideEffects:{onAdd,onDelete}` | 跨资源副作用 | workloads(增减 namespace pod 数) |
| `skipRemoteUpdate:true` | update 仅 mock,无远端 | namespaces |
| `extra:{name:fn}` | CRUD 之外的特殊 op,单独暴露 | ingresses(`updateRules`) |

**资源分类(初定,plan 阶段核实 API 路径)**:
- **规整(纯配置,~17)**:configmaps, secrets, pvcs, pvs, storageclasses, services, networkpolicies, hpas, resourcequotas, limitranges, roles, serviceaccounts, rolebindings, clusterrolebindings, clusterroles, pdbs, ingressclasses, runtimeclasses, priorityclasses
- **复杂(hook,~6)**:workloads(dynamicPlural+merge+sideFx+extra rollback/scale/restart), namespaces(customYaml+refreshMapper+skipUpd), ingresses(extra updateRules), pods(add/delete 特殊), crd-instances(deleteCRInstance 特殊)

---

## 6. makeCrud 生成契约

每个生成的函数**契约与现有手写完全一致**(签名、返回、副作用),视图层无感。核心是集中 await+invalidate:

- **add(item)**:`remoteMode` → `await remoteCreate(yaml, 'Kind/name', refresh)`(yaml = customYaml 或 generateYAML(genType, beforeSave?item));否则 `ref.push({...,age:'Just now'})`;`sideEffects.onAdd?.(item)`;`invalidateResource(plural)`。
- **update(name, ns?, updates)**:findIndex → 存 before → 乐观合并 → `remoteMode` 且非 skipRemoteUpdate → `await remoteUpdate(yaml|mergepatch, 'Kind', rollback)`;`invalidateResource(plural)`。`patch:'merge'` 时走定点 patch(复用现有 workload merge-patch 逻辑)而非 regenerate。
- **delete(name, ns?)**:`remoteMode` → `await remoteDelete(api/ref, ref, matchFn)`;否则 splice;`sideEffects.onDelete?.(item)`;`invalidateResource(plural)`。

> `remoteCreate/Update/Delete` 原语**不变**(工厂调用它们)。乐观更新 + 失败回滚语义保持(现有用户体验不变)。

---

## 7. await-race 从结构上消灭

视图层 race 根因:每个 handler 各写 `store.addX()` + `invalidateQueries()`,漏 await 就抢跑。工厂化后:
- store 的 add/update/delete **内部**就是 `await remoteXxx` + `invalidateResource`,顺序写死、不可漏。
- 视图层即使**不 await** `store.addX()`,store 内部的 invalidateResource 仍在 await 后触发(正确顺序)——和 Detail 页 updateX 现在就靠内部 invalidateResource 正确回显同理。
- 即:工厂覆盖资源**不会再有 await-race**(结构性),视图层 handler 的显式 invalidate 也可逐步删(冗余)。
- 现有 await-race 守门继续防**非工厂**的 handler(剩余 view handler + 未来新代码)。

---

## 8. 不变契约(护栏边界)

- `applyResourceYaml`(generateYAML 无损 + mapper + updateXxx)签名不变 —— 工厂生成的 updateXxx 满足它。
- `remoteCreate/Update/Delete`、`refetch`、`invalidateResource` 原语不变。
- 视图调用 `store.addX/deleteX/updateX` **签名不变** → **不改任何 .vue**(挂载套件 + await-race 守门保证不回归)。
- workloads/namespaces/ingresses 的特殊 op(rollback/scale/restart/sync/updateRules)保持手写,只把**标准 add/update/delete** 进工厂。

---

## 9. 测试与守门(确定性,不妥协)

1. **CRUD 冒烟测试(新增,工厂最大红利)**:mock 模式跑每个生成的 add/update/delete,断言 `ref` 变化(push/merge/splice)+ `invalidateResource` 被调用。把 72 个原本无人测的函数 → 一张表 + 一个批量测试。
2. **现有确定性守门**(本会话已建,工厂产物也过):
   - `await-race.guard.test.js`(工厂集中 await+invalidate,生成代码必过)
   - `missing-value.guard.test.js`(工厂内 `ref.value` 用法必过)
3. **store 实例化测试**(`cluster.store-methods.test.js`):防生成的函数没接进 return → 初始化崩。
4. **挂载套件**(views 73 + components 51 + modules):视图零改动 → 必仍绿。

每批迁移的验收门:`typecheck + build + test:unit(含上述全部)+ 两 detector` 全绿才进下一批。

---

## 10. 迁移路径(增量,每步可验、可回退)

实现时从最新 main 拉隔离 worktree(`feat/crud-factory`)。分批,每批独立提交、跑全套守门:

- **批 0:pilot** —— 建 `makeCrud` + `RESOURCE_SPECS`,只填 configmaps/secrets/pvc 3 个规整资源;写 CRUD 冒烟测试;把这 3 个的手写 CRUD 换成工厂生成。跑全套绿。(验证模式 + 测试可用)
- **批 1-2:规整资源批量** —— 分两批把剩余 ~14 规整资源换工厂(纯配置,机械)。每批跑全套。
- **批 3:复杂资源** —— workloads/namespaces/ingresses/pods/crd 接 hook(复用现有逻辑);特殊 op 保持手写。跑全套 + 重点手测(workload 编辑/回滚、namespace sync)。
- **批 4:清理** —— 删旧手写 CRUD、清死代码;cluster.js 行数核对(目标 2778 → ~2600)。
- **批 5:合并** —— 完成后合 main(此时 main 可能已前进,按本会话经验 re-merge latest main、跑全套)。

> 每批结束 commit;任何一批全套不过 → 停在该批,不进下一批(避免错误累积)。

---

## 11. 风险与回退

- **风险 A:复杂资源 hook 接错**(merge-patch 漏字段、sideEffect 没触发)。对策:CRUD 冒烟测试断言 hook 调用 + 批 3 重点手测。
- **风险 B:applyResourceYaml 契约破坏**(updateXxx 签名/行为变了)。对策:契约测试(已有详情页编辑 datalist 依赖),批 0 起就跑。
- **风险 C:main 在迁移期间前进**(本会话已遇 2 次)。对策:每批开始 re-merge latest main;隔离 worktree 防并行覆盖。
- **回退**:每批独立 commit,任一批出问题 `git revert` 该批即可(工厂与手写在过渡期可共存 —— 同名函数,后定义覆盖)。

---

## 12. 出参(成功标准)

- cluster.js 2778 → ~2600 行(省 ~150-180)。
- CRUD 冒烟测试覆盖全部生成的 add/update/delete。
- await-race 守门对工厂资源恒绿(结构性消灭)。
- 视图层零改动,挂载套件 + 现有测试全绿。
- main 无新 bug,两确定性守门持续守。

---

## 下一步

本 spec 经用户复审 → 转 `writing-plans` 出逐批实现计划(批 0-5,每批任务化 + TDD + self-review 检查点)。
