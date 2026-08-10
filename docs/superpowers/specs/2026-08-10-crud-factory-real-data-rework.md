# CRUD 工厂 rework —— 适配「全部真实数据」架构

**日期**:2026-08-10。**背景**:CRUD 工厂(分支 `worktree-feat+crud-factory`,16 资源进工厂,-249 行,4 轮 review 过)建在 **mock 模式 + store-ref 当缓存**模型上;main 已移除 mock(`remoteMode`=0,走 Vue Query-only 全部真实数据)。工厂 `makeCrud` 用 `remoteMode.value` + store ref(`idxOf`/乐观更新/`refetch` 回调)→ 与新架构错位,不能直接合并。
**目标**:把 `makeCrud` rework 成**纯远端 + Vue Query 缓存**模型,保留 RESOURCE_SPECS 表 + hook(patchFn/beforeSave)+ await 集中,合并入 main。

---

## 1. 新 `makeCrud` 形态(纯远端,无 store ref / 无 remoteMode / 无 mock 分支)

```js
function makeCrud(plural, spec) {
  const { kind, group, resource, namespaced, mapper, genType = resource, genExtra,
          beforeSave, customYaml, patchFn, sideEffects, skipRemoteUpdate } = spec
  const genFn = genExtra ? generateExtraYAML : generateYAML
  const itemApi = (name, ns) => namespaced
    ? `${group}/namespaces/${encodeURIComponent(ns)}/${resource}/${encodeURIComponent(name)}`
    : `${group}/${resource}/${encodeURIComponent(name)}`
  const yamlOf = item => customYaml ? customYaml(item) : genFn(genType, beforeSave ? beforeSave(item) : item)

  // 从 Vue Query 缓存取当前对象(all-real-data 的唯一真相源;替代旧 store-ref idxOf)
  const fromCache = (name, ns) => {
    const cid = currentCluster.value || 'cluster'
    const list = queryClient.getQueryData(['cluster', cid, plural]) || []
    return list.find(x => x.name === name && (!namespaced || x.namespace === ns))
  }

  async function add(item) {
    await remoteCreate(yamlOf(item), `${kind}/${item.name}`)
    if (sideEffects?.onAdd) sideEffects.onAdd(item)
    invalidateResource(plural)
  }
  async function update(name, ns, updates) {
    if (skipRemoteUpdate) return
    if (patchFn) {
      const before = fromCache(name, ns) || {}
      await remotePatch(itemApi(name, ns), patchFn(name, ns, updates, before), kind)
    } else {
      const cur = fromCache(name, ns)        // 拿当前完整对象(替代旧 store-ref)
      if (!cur) { invalidateResource(plural); return }   // 缓存没有 → 失效让其重拉,下次编辑即可
      const merged = { ...cur, ...(beforeSave ? beforeSave(updates) : updates) }
      await remoteUpdate(yamlOf(merged), kind)
    }
    if (sideEffects?.onUpdate) sideEffects?.onUpdate(name, ns)
    invalidateResource(plural)
  }
  async function remove(name, ns) {
    await remoteDelete(itemApi(name, ns))
    if (sideEffects?.onDelete) sideEffects?.onDelete(name, ns)
    invalidateResource(plural)
  }
  return { add, update, delete: remove }
}
```

**关键变化 vs 旧工厂**:
- ❌ 删 `remoteMode` 判断、mock 分支(`else ref.push/splice`)、`ref`(store list ref)、`refetch` 回调、`idxOf`(store ref)。
- ✅ update 改读 **Vue Query 缓存**(`queryClient.getQueryData`)拿当前对象 —— 这是 all-real-data 的真相源,无额外 GET、无视图签名变化、无 store ref。
- ✅ 保留:`invalidateResource`(刷 Vue Query)、`patchFn`(HPA 定向 patch)、`beforeSave`(secrets 编码)、`sideEffects`(service 增减 ns 计数)、`customYaml`/`skipRemoteUpdate`(namespace)、`genExtra`(pdb/priorityclass)。
- ⚠️ `sideEffects` 的 service「ns 计数」:旧实现改 `namespaceList.value`(store ref)。all-real-data 下 namespace 也走 Query —— sideEffects 应改 `queryClient.setQueryData` 更新 namespace query,或干脆删(让 invalidate 重拉)。**rework 时逐个核实 sideEffects 在 Query 模型下是否还有意义/怎么实现。**

## 2. RESOURCE_SPECS(去 `ref` 字段)

每项去掉 `ref`(不再用 store list ref);其余(kind/group/resource/namespaced/mapper/genType/genExtra + hook)不变。16 资源 + ingress 同前。

## 3. 测试重写(`cluster.crud-factory.test.js`)

旧测试是 **mock 模式**(断言 store ref 变化)。all-real-data 下重写为:
- 桩 `remoteCreate/Update/Delete/Patch`(vi.mock 或注入)+ 桩 `queryClient.getQueryData`(返回样当前对象)。
- 断言:① 调用了对应远端原语 + 正确 path/YAML/patch body;② `invalidateResource` 被调(经 `queryClient.invalidateQueries` spy)。
- 保留 `hpaPatchFn` 纯函数测试(不变,它不依赖架构)。
- **新增**「缓存无当前对象 → update 仅 invalidate 不抛」的边界测试。

## 4. 执行路径(新会话,隔离 worktree 从最新 main 拉)

1. 从最新 main(mock-removed)拉新 worktree `feat/crud-factory-realdata`。
2. 把 origin/`worktree-feat+crud-factory` 的 **RESOURCE_SPECS 表 + hook + hpaPatchFn + beforeSave** 搬过来(这些与架构无关,直接复用),`makeCrud` 用上面 §1 的新形态重写。
3. 删 main 上对应 16+ingress 的手写 CRUD(它们已是 mock-removed 的纯远端版,工厂接管)。
4. 重写测试(§3)。
5. gate:`typecheck + build + test:unit + check-await-race + check-missing-value`(沿用本会话建的守门)全绿。
6. **重点手测**:secrets 编辑(beforeSave 编码 + 不丢 data,本会话那个 Critical 的回归)、HPA 编辑(patchFn 不 prune behavior)、service 增删(ns 计数 sideEffect 在 Query 模型下)、ingress rules。
7. 合并 main + push。

## 5. 风险 / 开放点

- **sideEffects(service ns 计数)在 Query 模型下的实现**:是 setQueryData 改 namespace query,还是删(invalidate 重拉即可)。rework 时定。
- **update 缓存未命中**(fromCache 返回 undefined):首次进详情页前缓存可能空。处理:仅 invalidate(下次有缓存再编辑)—— 体验上罕见(编辑发生在详情页已加载后)。
- **bespoke 资源(workload/namespace/PV/SC/roles/pod/crd)保持手写**:同前(Approach 2),不进工厂。它们的 mock-removal 适配由 main 的 mock-removal 工作负责,非本 rework。

## 6. 不变的守门(本会话建,继续用)

- `check-await-race.mjs` + `check-missing-value.mjs`(确定性静态守门)。
- 挂载套件(views/components/modules)—— 验证视图零改动(工厂签名不变)。
- store 实例化测试 —— 验证 return 接线。

---

**执行前置**:新会话从最新 main 拉 worktree;复用 origin/`worktree-feat+crud-factory` 的表/hook;`makeCrud` 用 §1 新形态。本会话的 4 轮 review 教训(secrets 数据丢失 Critical、HPA prune behavior)是 §3/§6 的重点回归项。
