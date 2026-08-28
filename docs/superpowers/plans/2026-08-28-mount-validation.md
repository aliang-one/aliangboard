# Workload 挂载校验增强 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 workload 挂载(volumes/volumeMounts)的校验/生成从 5 处双轨收敛为单源纯函数,VolumeMountCard 即时逐字段标错 + 落点预览,补 hostPathType/defaultMode 字段(回填保真)。

**Architecture:** `src/logic/volumeMountValidation.js` 扩为唯一事实源(`validateEntry` / `validateVolumeMounts` / `projectMountFiles` / `toMountSpec` / `toVolumeDef` / `toVolumeDefYaml` / `buildMountCtx`),DeployApp 门禁与部署校验、NsWorkloadDetail `validateEdit`、VolumeMountCard 即时错误态、YAML 生成端(mountLines/volumesYaml/mountsForTarget/saveEdit)全部改调它;`firstVolumeMountError`/`volumeItemsIncomplete` 保留为兼容包装。spec:`docs/superpowers/specs/2026-08-28-mount-validation-design.md`。

**Tech Stack:** Vue 3 `<script setup>` + vitest + happy-dom + @vue/test-utils;纯逻辑零 Vue 依赖;i18n vue-i18n zh/en。

## Global Constraints

- **不新增任何外部依赖**(CLAUDE.md 依赖政策)。
- **提交作者恒为 `aliangone <aliangone@gmail.com>`,提交信息禁止 `Co-Authored-By: Claude` 尾注**(CLAUDE.md)。
- 所有新 i18n key **zh/en 两份同步**,改完 locale 跑 `npm run i18n:check` 必须全绿。
- warn 色用仓库既有 token:`text-tertiary-container` / `border-tertiary-container`(StatusChip Pending 同款);hint 灰字用 `text-on-surface-variant/60`;错误红 `text-error` / `border-error`。覆盖 Tailwind 默认边框色时用 `!` 前缀(如 `!border-error`)以压过 `fld` 里的 `border-outline-variant`。
- 回归命令:`npm test`(服务端+纯逻辑)、`npm run test:unit`(vitest)、`npm run typecheck`(`node --check`)。
- 行号为 2026-08-28 快照,执行时以内容定位为准。
- 每个任务结束跑该任务相关测试;Task 9/10 结束跑全量回归。

---

### Task 1: mapper 透传 binaryKeys(键全集修复)

**Files:**
- Modify: `src/composables/useResourceMappers.js:145-170`(`mapConfigMap` / `mapSecret`)
- Test: `src/composables/__tests__/useResourceMappers.volume-keys.test.js`(新建)

**Interfaces:**
- Produces: `mapConfigMap(item).binaryKeys: string[]`、`mapSecret(item).binaryKeys: string[]`(binaryData 的键数组;无 binaryData 时 `[]`)。后续 Task 2 的 `buildMountCtx`、Task 7 的卡片 `selectedKeys` 消费。

- [ ] **Step 1: 写失败测试**

```js
// src/composables/__tests__/useResourceMappers.volume-keys.test.js
// 卷挂载键全集:mapper 必须透传 binaryData 键(selectedKeys/校验 ctx 的 data∪binaryData 并集依赖它)
import { test, expect } from 'vitest'
import { mapConfigMap, mapSecret } from '@/composables/useResourceMappers'

test('mapConfigMap/mapSecret 透传 binaryKeys(data∪binaryData 的键)', () => {
  const cm = mapConfigMap({ metadata: { name: 'cm1', namespace: 'ns' }, data: { a: '1' }, binaryData: { 'bin.crt': 'eHg=' } })
  expect(cm.binaryKeys).toEqual(['bin.crt'])
  expect(cm.keys).toBe(1) // 既有 keys 字段语义不变(只数 data)

  const sec = mapSecret({ metadata: { name: 's1', namespace: 'ns' }, data: { k: 'dg==' }, binaryData: { jks: 'eHg=' } })
  expect(sec.binaryKeys).toEqual(['jks'])
})

test('无 binaryData 时 binaryKeys 为空数组', () => {
  expect(mapConfigMap({ metadata: { name: 'cm2' }, data: { a: '1' } }).binaryKeys).toEqual([])
  expect(mapSecret({ metadata: { name: 's2' }, data: {} }).binaryKeys).toEqual([])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/composables/__tests__/useResourceMappers.volume-keys.test.js`
Expected: FAIL — `binaryKeys` 为 undefined。

- [ ] **Step 3: 最小实现**

`mapConfigMap` 返回对象里加一行;`mapSecret` 同:

```js
export const mapConfigMap = item => {
  const data = item.data || {}
  return {
    name: item.metadata?.name,
    namespace: item.metadata?.namespace,
    keys: Object.keys(data).length,
    data,
    binaryKeys: Object.keys(item.binaryData || {}),   // 卷挂载键全集用(data∪binaryData)
    labels: item.metadata?.labels || {},
    annotations: item.metadata?.annotations || {},
    age: ageOf(item.metadata?.creationTimestamp),
  }
}
```

`mapSecret` 在 `data,` 之后加同一行 `binaryKeys: Object.keys(item.binaryData || {}),`(注释同)。既有 `keys` 字段语义不动(列表页键数显示不因此变化)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/composables/__tests__/useResourceMappers.volume-keys.test.js`
Expected: PASS(2 tests)。

- [ ] **Step 5: 提交**

```bash
git add src/composables/useResourceMappers.js src/composables/__tests__/useResourceMappers.volume-keys.test.js
git commit -m "feat(mount): mapper 透传 binaryKeys——卷挂载键全集含 binaryData"
```

---

### Task 2: 单源校验器基础 — normalizeMountPath / buildMountCtx / validateEntry

**Files:**
- Modify: `src/logic/volumeMountValidation.js`(现 22 行,保留全部现有导出)
- Test: `src/logic/__tests__/volumeMountValidation.test.js`(追加)

**Interfaces:**
- Consumes: Task 1 的 `binaryKeys`。
- Produces(后续任务依赖,签名固定):
  - `normalizeMountPath(p: string): string`(trim → 折叠 `//` → 去尾 `/`,根 `/` 除外)
  - `buildMountCtx({ validTargets?, configMaps?, secrets?, pvcs?, namespace? }): ctx`(namespace 空 → 各名单/键集为 null)
  - `validateEntry(entry, ctx?): { code, field, level, params? }[]`;ctx 形如 `{ validTargets?, cmKeys?: Map<name,string[]>, secretKeys?: Map, knownCmNames?: Set, knownSecretNames?: Set, knownPvcNames?: Set }`,未加载的键/名单对应规则**跳过不判**。

- [ ] **Step 1: 写失败测试**(追加到 `src/logic/__tests__/volumeMountValidation.test.js` 末尾)

```js
import { normalizeMountPath, buildMountCtx, validateEntry } from '@/logic/volumeMountValidation'

// —— normalizeMountPath ——
test('normalizeMountPath: trim/折叠//去尾斜杠,根 / 不动', () => {
  expect(normalizeMountPath(' /data/ ')).toBe('/data')
  expect(normalizeMountPath('/a//b///')).toBe('/a/b')
  expect(normalizeMountPath('/')).toBe('/')
  expect(normalizeMountPath('')).toBe('')
})

// —— buildMountCtx ——
test('buildMountCtx: namespace 过滤 + data∪binaryData 键集合并;namespace 空则全 null', () => {
  const ctx = buildMountCtx({
    validTargets: ['main'],
    namespace: 'ns1',
    configMaps: [{ name: 'cm1', namespace: 'ns1', data: { a: '1' }, binaryKeys: ['b.bin'] }, { name: 'other', namespace: 'ns2', data: { x: '1' } }],
    secrets: [{ name: 's1', namespace: 'ns1', data: { k: 'v' } }],
    pvcs: [{ name: 'p1', namespace: 'ns1' }],
  })
  expect(ctx.cmKeys.get('cm1')).toEqual(['a', 'b.bin'])
  expect(ctx.knownCmNames.has('other')).toBe(false)
  expect(ctx.secretKeys.get('s1')).toEqual(['k'])
  expect(ctx.knownPvcNames.has('p1')).toBe(true)
  expect(buildMountCtx({ namespace: '' }).cmKeys).toBe(null)
})

// —— validateEntry(spec §4 规则 1-12)——
const base = { name: 'vol-1', target: 'main', type: 'pvc', mountPath: '/data', subPath: '', readOnly: false, pvcName: 'my-pvc', hostPath: '', hostPathType: '', server: '', nfsPath: '', cmName: '', secretName: '', defaultMode: '', items: [] }
const codes = iss => iss.map(i => i.code)
const ENTRY_CTX = buildMountCtx({ namespace: 'ns', validTargets: ['main'], configMaps: [{ name: 'cm', namespace: 'ns', data: { k1: '1', k2: '2' } }], secrets: [], pvcs: [{ name: 'my-pvc', namespace: 'ns' }] })

test('validateEntry: 合法条目零 issue;pvc 名单命中不报', () => {
  expect(validateEntry({ ...base }, ENTRY_CTX)).toEqual([])
})

test('validateEntry: 来源必填/target 悬空/items 半填(收编旧 4 规则)', () => {
  expect(codes(validateEntry({ ...base, pvcName: '' }, ENTRY_CTX))).toContain('sourceRequired')
  expect(codes(validateEntry({ ...base, target: 'sidecar:9' }, ENTRY_CTX))).toContain('targetInvalid')
  expect(codes(validateEntry({ ...base, items: [{ key: 'k', path: '' }] }, ENTRY_CTX))).toContain('itemsIncomplete')
})

test('validateEntry: mountPath 根/反斜杠/归一 hint', () => {
  const r = codes(validateEntry({ ...base, mountPath: '/' }, ENTRY_CTX))
  expect(r).toContain('mountPathRoot')
  expect(codes(validateEntry({ ...base, mountPath: 'C:\\data' }, ENTRY_CTX))).toContain('mountPathBackslash')
  expect(codes(validateEntry({ ...base, mountPath: '/data/' }, ENTRY_CTX))).toContain('mountPathNormalized')
})

test('validateEntry: 系统路径三档(/proc error、/etc/hosts error、/etc warn、/var/run/secrets error)', () => {
  expect(codes(validateEntry({ ...base, mountPath: '/proc' }, ENTRY_CTX))).toContain('systemPathRuntime')
  expect(codes(validateEntry({ ...base, mountPath: '/etc/hosts' }, ENTRY_CTX))).toContain('systemPathEtc')
  expect(codes(validateEntry({ ...base, mountPath: '/etc' }, ENTRY_CTX))).toContain('systemPathShadow')
  expect(codes(validateEntry({ ...base, mountPath: '/var/run/secrets/kubernetes.io' }, ENTRY_CTX))).toContain('systemPathSaToken')
})

test('validateEntry: items path 非法/重复/key 不存在/隐藏其余 key', () => {
  const cm = { ...base, type: 'configMap', cmName: 'cm', pvcName: '', items: [{ key: 'k1', path: 'conf/app.yml' }] }
  expect(validateEntry(cm, ENTRY_CTX)).toEqual([]) // 多级相对 path 合法
  expect(codes(validateEntry({ ...cm, items: [{ key: 'k1', path: '/abs' }] }, ENTRY_CTX))).toContain('itemPathInvalid')
  expect(codes(validateEntry({ ...cm, items: [{ key: 'k1', path: '../x' }] }, ENTRY_CTX))).toContain('itemPathInvalid')
  expect(codes(validateEntry({ ...cm, items: [{ key: 'k1', path: 'a.yml' }, { key: 'k2', path: 'a.yml' }] }, ENTRY_CTX))).toContain('itemPathDuplicate')
  expect(codes(validateEntry({ ...cm, items: [{ key: 'nope', path: 'a.yml' }] }, ENTRY_CTX))).toContain('itemKeyMissing')
  const hidden = validateEntry({ ...cm, items: [{ key: 'k1', path: 'a.yml' }] }, ENTRY_CTX)
  expect(hidden.find(i => i.code === 'itemsHideRest').params).toEqual({ n: 1 })
})

test('validateEntry: 全空 items 行忽略(与生成端一致)', () => {
  const cm = { ...base, type: 'configMap', cmName: 'cm', pvcName: '', items: [{ key: '', path: '' }] }
  expect(validateEntry(cm, ENTRY_CTX).filter(i => i.code.startsWith('item'))).toEqual([])
})

test('validateEntry: 来源在名单中不存在 → sourceNotFound;名单未加载不判', () => {
  expect(codes(validateEntry({ ...base, pvcName: 'ghost' }, ENTRY_CTX))).toContain('sourceNotFound')
  expect(codes(validateEntry({ ...base, pvcName: 'ghost' }, { validTargets: ['main'] }))).not.toContain('sourceNotFound')
})

test('validateEntry: subPath 绝对路径/.. → subPathInvalid;指向卷内不存在 → subPathNotInVolume;合法 → 单文件 hint', () => {
  const cm = { ...base, type: 'configMap', cmName: 'cm', pvcName: '' }
  expect(codes(validateEntry({ ...cm, subPath: '/etc/a.conf' }, ENTRY_CTX))).toContain('subPathInvalid')
  expect(codes(validateEntry({ ...cm, subPath: '../x' }, ENTRY_CTX))).toContain('subPathInvalid')
  expect(codes(validateEntry({ ...cm, subPath: 'ghost.conf' }, ENTRY_CTX))).toContain('subPathNotInVolume')
  expect(codes(validateEntry({ ...cm, subPath: 'k1' }, ENTRY_CTX))).toContain('subPathSingleFileNote')
  // 有 items 时 subPath 对 items path 求交集
  const withItems = { ...cm, items: [{ key: 'k1', path: 'conf/a.yml' }] }
  expect(codes(validateEntry({ ...withItems, subPath: 'k1' }, ENTRY_CTX))).toContain('subPathNotInVolume')
  expect(codes(validateEntry({ ...withItems, subPath: 'conf/a.yml' }, ENTRY_CTX))).toContain('subPathSingleFileNote')
})

test('validateEntry: NFS path 留空 warn 挂整个导出、相对路径 error;hostPath 敏感路径 error', () => {
  expect(codes(validateEntry({ ...base, type: 'nfs', pvcName: '', server: '1.2.3.4', nfsPath: '' }, ENTRY_CTX))).toContain('nfsPathRoot')
  expect(codes(validateEntry({ ...base, type: 'nfs', pvcName: '', server: '1.2.3.4', nfsPath: 'share' }, ENTRY_CTX))).toContain('nfsPathInvalid')
  expect(codes(validateEntry({ ...base, type: 'hostPath', pvcName: '', hostPath: '/var/run/docker.sock' }, ENTRY_CTX))).toContain('hostPathSensitive')
  expect(codes(validateEntry({ ...base, type: 'hostPath', pvcName: '', hostPath: '/data/app' }, ENTRY_CTX))).not.toContain('hostPathSensitive')
})

test('validateEntry: secret 未只读 hint;defaultMode 非法 error、宽松 hint、0400/0640 静默', () => {
  const sec = { ...base, type: 'secret', pvcName: '', secretName: 's', readOnly: true }
  expect(codes(validateEntry(sec, ENTRY_CTX))).not.toContain('readOnlySuggested')
  expect(codes(validateEntry({ ...sec, readOnly: false }, ENTRY_CTX))).toContain('readOnlySuggested')
  expect(codes(validateEntry({ ...sec, defaultMode: '999' }, ENTRY_CTX))).toContain('defaultModeInvalid')
  expect(codes(validateEntry({ ...sec, defaultMode: '0644' }, ENTRY_CTX))).toContain('defaultModePermissive')
  expect(codes(validateEntry({ ...sec, defaultMode: '0400' }, ENTRY_CTX))).not.toContain('defaultModePermissive')
})

test('validateEntry: 级别标注正确(error/warn/hint)', () => {
  const iss = validateEntry({ ...base, mountPath: '/proc' }, ENTRY_CTX)
  expect(iss.find(i => i.code === 'systemPathRuntime').level).toBe('error')
  expect(validateEntry({ ...base, mountPath: '/etc' }, ENTRY_CTX).find(i => i.code === 'systemPathShadow').level).toBe('warn')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: FAIL(新导入不存在);**既有 5 组测试必须仍 PASS**。

- [ ] **Step 3: 实现**(改写 `src/logic/volumeMountValidation.js` —— 保留文件头注释思路、`SOURCE_FIELD`、`firstVolumeMountError`、`volumeItemsIncomplete` 原样;新增以下内容;`firstVolumeMountError` 本任务**不动**)

```js
// 部署向导 step2(存储)门禁纯函数:每个卷条目必须「来源完整 + mountPath 合法 + target 有效」。
// 背景:mountsForTarget 与 pod 级 volumesYaml 都静默过滤不完整条目——未映射的卷在
// 生成 YAML 里整个消失,用户无感知(2026-08-25 用户报障)。单一事实源,无 Vue 依赖。
// 2026-08-28:扩为挂载域唯一事实源(spec docs/superpowers/specs/2026-08-28-mount-validation-design.md)
// ——单卡 validateEntry / 跨卡 validateVolumeMounts / 落点投影 projectMountFiles / 生成侧单源。
const SOURCE_FIELD = { pvc: 'pvcName', hostPath: 'hostPath', nfs: 'server', configMap: 'cmName', secret: 'secretName' }

// —— 系统路径清单(K8s 语义见 spec §4 规则 3/10)——
const RUNTIME_PATHS = ['/proc', '/sys', '/dev']                       // runc 层直接失败
const ETC_PATHS = ['/etc/hosts', '/etc/resolv.conf', '/etc/hostname'] // kubelet 显式豁免 → 静默坏 DNS/自注册
const SA_TOKEN_PREFIX = '/var/run/secrets'                            // SA token 冲突
const SHADOW_PATHS = ['/etc', '/usr', '/bin', '/sbin', '/lib', '/root', '/var/lib'] // 整目录遮蔽
const HOSTPATH_SENSITIVE = ['/', '/etc', '/var/run', '/var/run/docker.sock', '/root', '/home', '/proc', '/sys', '/dev']

// mountPath 归一:trim → 折叠连续 / → 去尾 /(根除外)
export function normalizeMountPath(p) {
  let s = String(p ?? '').trim()
  if (!s) return s
  s = s.replace(/\/{2,}/g, '/')
  if (s.length > 1) s = s.replace(/\/+$/, '')
  return s
}

// 视图侧把 Vue Query 行数组喂进来:namespace 过滤 + data∪binaryData 键集合并。
// namespace 为空 → 名单/键集为 null(存在性/键集规则跳过,绝不误报)。
export function buildMountCtx({ validTargets = [], configMaps = [], secrets = [], pvcs = [], namespace = '' } = {}) {
  if (!namespace) return { validTargets, cmKeys: null, secretKeys: null, knownCmNames: null, knownSecretNames: null, knownPvcNames: null }
  const inNs = rows => (rows || []).filter(r => r.namespace === namespace)
  const cmRows = inNs(configMaps), secRows = inNs(secrets)
  const keysOf = r => [...new Set([...Object.keys(r.data || {}), ...(r.binaryKeys || [])])]
  return {
    validTargets,
    cmKeys: new Map(cmRows.map(r => [r.name, keysOf(r)])),
    secretKeys: new Map(secRows.map(r => [r.name, keysOf(r)])),
    knownCmNames: new Set(cmRows.map(r => r.name)),
    knownSecretNames: new Set(secRows.map(r => r.name)),
    knownPvcNames: new Set(inNs(pvcs).map(r => r.name)),
  }
}

// 单卡逐字段问题。field 定位卡片字段:'source'|'mountPath'|'subPath'|'items'|'itemsPath:<i>'|'target'|'hostPath'|'nfsPath'|'readOnly'|'defaultMode'
// level:'error'(拦提交)/'warn'(黄字可继续)/'hint'(灰字建议)
export function validateEntry(entry, ctx = {}) {
  const issues = []
  const add = (code, field, level, params) => issues.push(params ? { code, field, level, params } : { code, field, level })
  const isProjection = entry.type === 'configMap' || entry.type === 'secret'

  // 规则 1:来源必填(按类型)
  const src = SOURCE_FIELD[entry.type]
  if (src && !entry[src]) add('sourceRequired', 'source', 'error')

  // 规则 2/3:mountPath 必填绝对路径 + 格式细节 + 系统路径
  const rawMp = String(entry.mountPath ?? '')
  if (!rawMp || !rawMp.startsWith('/')) {
    add('mountPathRequired', 'mountPath', 'error')
  } else {
    const norm = normalizeMountPath(rawMp)
    if (norm !== rawMp) add('mountPathNormalized', 'mountPath', 'hint')
    if (norm === '/') add('mountPathRoot', 'mountPath', 'error')
    if (rawMp.includes('\\')) add('mountPathBackslash', 'mountPath', 'warn')
    if (RUNTIME_PATHS.includes(norm)) add('systemPathRuntime', 'mountPath', 'error')
    else if (ETC_PATHS.includes(norm)) add('systemPathEtc', 'mountPath', 'error')
    else if (norm === SA_TOKEN_PREFIX || norm.startsWith(SA_TOKEN_PREFIX + '/')) add('systemPathSaToken', 'mountPath', 'error')
    else if (SHADOW_PATHS.includes(norm)) add('systemPathShadow', 'mountPath', 'warn')
  }

  // 规则 1:target 悬空
  if (ctx.validTargets && !ctx.validTargets.includes(entry.target)) add('targetInvalid', 'target', 'error')

  // 规则 4/5/12:items 键映射(全空行忽略,与生成端一致)
  const keysMap = entry.type === 'secret' ? ctx.secretKeys : ctx.cmKeys
  const allKeys = isProjection && keysMap ? (keysMap.get(entry.cmName || entry.secretName) || null) : null
  if (isProjection) {
    let incomplete = false
    const seen = new Map()
    ;(entry.items || []).forEach((it, i) => {
      if (!it.key && !it.path) return
      if (!(it.key && it.path)) { incomplete = true; return }
      const p = String(it.path)
      if (p.startsWith('/') || p.includes('\\') || /\s/.test(p) || p.split('/').some(seg => seg === '' || seg === '..'))
        add('itemPathInvalid', `itemsPath:${i}`, 'error')
      if (seen.has(p)) add('itemPathDuplicate', `itemsPath:${i}`, 'warn', { first: seen.get(p) + 1 })
      else seen.set(p, i)
      if (allKeys && !allKeys.includes(it.key)) add('itemKeyMissing', `itemsPath:${i}`, 'error')
    })
    if (incomplete) add('itemsIncomplete', 'items', 'error')
    const used = (entry.items || []).filter(it => it.key).length
    if (used && allKeys && allKeys.length > used) add('itemsHideRest', 'items', 'hint', { n: allKeys.length - used })
  }

  // 规则 6:来源在名单中不存在(名单未加载不判)
  if (entry.type === 'configMap' && entry.cmName && ctx.knownCmNames && !ctx.knownCmNames.has(entry.cmName)) add('sourceNotFound', 'source', 'error')
  if (entry.type === 'secret' && entry.secretName && ctx.knownSecretNames && !ctx.knownSecretNames.has(entry.secretName)) add('sourceNotFound', 'source', 'error')
  if (entry.type === 'pvc' && entry.pvcName && ctx.knownPvcNames && !ctx.knownPvcNames.has(entry.pvcName)) add('sourceNotFound', 'source', 'error')

  // 规则 7/8:subPath 格式 + 单文件语义提示
  if (entry.subPath) {
    const sp = String(entry.subPath)
    if (sp.startsWith('/') || sp.split('/').some(seg => seg === '..')) add('subPathInvalid', 'subPath', 'error')
    else add('subPathSingleFileNote', 'subPath', 'hint')
  }

  // 规则 9:NFS
  if (entry.type === 'nfs' && entry.server) {
    if (!entry.nfsPath) add('nfsPathRoot', 'nfsPath', 'warn')
    else if (!String(entry.nfsPath).startsWith('/')) add('nfsPathInvalid', 'nfsPath', 'error')
  }

  // 规则 10:hostPath 敏感路径
  if (entry.type === 'hostPath' && entry.hostPath && HOSTPATH_SENSITIVE.includes(normalizeMountPath(entry.hostPath)))
    add('hostPathSensitive', 'hostPath', 'error')

  // 规则 11:只读 / defaultMode 建议
  if (isProjection && !entry.readOnly) add('readOnlySuggested', 'readOnly', 'hint')
  if (isProjection && entry.defaultMode) {
    const m = String(entry.defaultMode)
    if (!/^[0-7]{3,4}$/.test(m)) add('defaultModeInvalid', 'defaultMode', 'error')
    else if (m !== '0400' && m !== '0640') add('defaultModePermissive', 'defaultMode', 'hint')
  }

  // 规则 7 后半:subPath 指向卷内不存在的路径(投影集 = items path 集,无 items 时键全集;未加载不判)
  if (isProjection && entry.subPath && !issues.some(i => i.code === 'subPathInvalid')) {
    const projected = (entry.items || []).filter(it => it.key && it.path).map(it => it.path)
    const pool = projected.length ? projected : allKeys
    if (pool && !pool.includes(entry.subPath)) add('subPathNotInVolume', 'subPath', 'error')
  }

  return issues
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: PASS(新增 12 组 + 既有 5 组)。

- [ ] **Step 5: 提交**

```bash
git add src/logic/volumeMountValidation.js src/logic/__tests__/volumeMountValidation.test.js
git commit -m "feat(mount): 单源校验器基础——normalizeMountPath/buildMountCtx/validateEntry(spec 规则1-12)"
```

---

### Task 3: 跨卡冲突 validateVolumeMounts + firstError + firstVolumeMountError 升级

**Files:**
- Modify: `src/logic/volumeMountValidation.js`(追加;`firstVolumeMountError` 改为薄包装)
- Test: `src/logic/__tests__/volumeMountValidation.test.js`(追加 + 改 1 处既有 fixture)

**Interfaces:**
- Produces:
  - `validateVolumeMounts(entries, ctx?): { byEntry: {code,field,level}[][], cross: {code,level,entries:number[],field}[] }` —— `byEntry[i]` 已并入涉及下标 i 的跨卡 issue,视图直接按卡下标取。
  - `firstError(audit): { entryIdx, issue } | null`(只看 error 级,按条目顺序)
  - `firstVolumeMountError(volumeMounts, validTargets, keyMap?)`:签名向后兼容;第三参为 `code → i18n key` 映射(默认旧 4 键),供 Task 9 传完整门禁映射。

- [ ] **Step 1: 调整既有 fixture + 写失败测试**

既有测试 `来源缺失:按类型查字段,返回首坏序号` 里最后一个断言的两条 entry mountPath 都是 `/data`、target 都是 `main`,在新跨卡检查下会先命中 `mountPathDuplicate`——把第二条的 mountPath 改为 `/data2`(测试意图「来源缺失在第 2 条」不变):

```js
  // 原:expect(firstVolumeMountError([{ ...base }, { ...base, name: 'vol-2', pvcName: '' }], OK))
  expect(firstVolumeMountError([{ ...base }, { ...base, name: 'vol-2', pvcName: '', mountPath: '/data2' }], OK))
    .toEqual({ key: 'deploy.volumeSourceRequired', n: 2 })
```

再追加:

```js
import { validateVolumeMounts, firstError, firstVolumeMountError as fvme } from '@/logic/volumeMountValidation'

test('validateVolumeMounts: 同容器 mountPath 相等 error / 父子嵌套 warn / 不同容器不判', () => {
  const a = { ...base }, b = { ...base, name: 'vol-2' }
  const dup = validateVolumeMounts([a, b], { validTargets: ['main'] })
  expect(dup.cross.map(c => c.code)).toEqual(['mountPathDuplicate'])
  expect(dup.cross[0].entries).toEqual([0, 1])
  expect(dup.byEntry[0].map(i => i.code)).toContain('mountPathDuplicate') // 已并入 byEntry
  const nested = validateVolumeMounts([{ ...base, mountPath: '/data' }, { ...base, name: 'vol-2', mountPath: '/data/sub' }], { validTargets: ['main'] })
  expect(nested.cross[0]).toMatchObject({ code: 'mountPathNested', level: 'warn' })
  const apart = validateVolumeMounts([{ ...base }, { ...base, name: 'vol-2', target: 'init:0' }], { validTargets: ['main', 'init:0'] })
  expect(apart.cross).toEqual([])
})

test('validateVolumeMounts: 卷名重复 error;孤儿 mount(mountPath 有而来源空)error', () => {
  const nameDup = validateVolumeMounts([{ ...base }, { ...base, mountPath: '/x2', pvcName: 'p2' }], { validTargets: ['main'] })
  expect(nameDup.cross.find(c => c.code === 'volumeNameDuplicate').entries).toEqual([0, 1])
  const orphan = validateVolumeMounts([{ ...base, pvcName: '' }], { validTargets: ['main'] })
  expect(orphan.cross.map(c => c.code)).toContain('orphanMount')
})

test('firstError: 取首个 error 级;warn/hint 跳过', () => {
  const audit = validateVolumeMounts([{ ...base, mountPath: '/data/' }, { ...base, name: 'v2', mountPath: '/d2' }], { validTargets: ['main'] })
  expect(firstError(audit)).toBe(null) // 只有归一 hint
  const bad = validateVolumeMounts([{ ...base, mountPath: '/proc' }], { validTargets: ['main'] })
  expect(firstError(bad).issue.code).toBe('systemPathRuntime')
})

test('firstVolumeMountError: 旧 4 键默认映射不变;传 keyMap 走新键;warn/hint 不拦', () => {
  expect(fvme([{ ...base, mountPath: '/proc' }], ['main'])).toEqual({ key: 'deploy.volumeSourceRequired', n: 1 }) // fallback
  const KEYS = { systemPathRuntime: 'deploy.volumeSystemPathRuntime' }
  expect(fvme([{ ...base, mountPath: '/proc' }], ['main'], KEYS)).toEqual({ key: 'deploy.volumeSystemPathRuntime', n: 1 })
  expect(fvme([{ ...base, mountPath: '/data/' }], ['main'])).toBe(null) // hint 不拦
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: 新增 4 组 FAIL(validateVolumeMounts/firstError 未导出;fvme 第三参忽略)。

- [ ] **Step 3: 实现**(追加到模块末尾,并把 `firstVolumeMountError` 整体替换为薄包装)

```js
// —— 跨卡冲突 + 组装(spec §4 规则 13-16)——
// byEntry[i] = validateEntry 结果 + 涉及 i 的 cross issue(视图按卡下标直接取)
export function validateVolumeMounts(entries, ctx = {}) {
  const list = entries || []
  const byEntry = list.map(e => validateEntry(e, ctx))
  const cross = []
  const mp = e => (e.mountPath && String(e.mountPath).startsWith('/') ? normalizeMountPath(e.mountPath) : null)

  // 13/14:同容器 mountPath 相等 / 父子嵌套(归一后比对)
  const byTarget = new Map()
  list.forEach((e, i) => {
    const p = mp(e)
    if (!p) return
    if (!byTarget.has(e.target)) byTarget.set(e.target, [])
    byTarget.get(e.target).push({ i, p })
  })
  for (const group of byTarget.values())
    for (let a = 0; a < group.length; a++)
      for (let b = a + 1; b < group.length; b++) {
        const { i: i1, p: p1 } = group[a], { i: i2, p: p2 } = group[b]
        if (p1 === p2) cross.push({ code: 'mountPathDuplicate', level: 'error', entries: [i1, i2], field: 'mountPath' })
        else if (p1 !== '/' && p2 !== '/' && (p2.startsWith(p1 + '/') || p1.startsWith(p2 + '/')))
          cross.push({ code: 'mountPathNested', level: 'warn', entries: [i1, i2], field: 'mountPath' })
      }

  // 15:卷名重复(生成端按 name 去重首见胜出 → 后者来源静默失效)
  const byName = new Map()
  list.forEach((e, i) => {
    if (!e.name) return
    if (byName.has(e.name)) cross.push({ code: 'volumeNameDuplicate', level: 'error', entries: [byName.get(e.name), i], field: 'name' })
    else byName.set(e.name, i)
  })

  // 16:孤儿 mount —— mountPath 会进 volumeMounts 但来源字段空(卷定义被生成端丢弃 → 非法 YAML)
  list.forEach((e, i) => {
    const src = SOURCE_FIELD[e.type]
    if (mp(e) && src && !e[src]) cross.push({ code: 'orphanMount', level: 'error', entries: [i], field: 'source' })
  })

  for (const c of cross) for (const i of c.entries) byEntry[i].push(c)
  return { byEntry, cross }
}

// 门禁取首个 error 级 issue(条目顺序);无 → null
export function firstError(audit) {
  for (let i = 0; i < audit.byEntry.length; i++)
    for (const issue of audit.byEntry[i])
      if (issue.level === 'error') return { entryIdx: i, issue }
  return null
}

// 兼容包装:返回首个坏条目 { key, n }。keyMap 缺省为旧 4 键(调用方行为不变);
// 新 code 未在 keyMap 里时按前缀落到最接近的旧键(仅迁移过渡期触达)。
const GATE_KEY = {
  sourceRequired: 'deploy.volumeSourceRequired',
  mountPathRequired: 'deploy.volumeMountRequired',
  targetInvalid: 'deploy.volumeTargetInvalid',
  itemsIncomplete: 'deploy.volumeItemsIncomplete',
}
const GATE_FALLBACK = code =>
  code.startsWith('mountPath') || code.startsWith('subPath') || code.startsWith('systemPath') ? 'deploy.volumeMountRequired'
    : code.startsWith('item') ? 'deploy.volumeItemsIncomplete'
      : code === 'targetInvalid' ? 'deploy.volumeTargetInvalid'
        : 'deploy.volumeSourceRequired'
export function firstVolumeMountError(volumeMounts, validTargets, keyMap = GATE_KEY) {
  const first = firstError(validateVolumeMounts(volumeMounts, { validTargets }))
  if (!first) return null
  return { key: keyMap[first.issue.code] || GATE_FALLBACK(first.issue.code), n: first.entryIdx + 1 }
}
```

- [ ] **Step 4: 跑测试确认通过 + 回归 subContainer**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js && npm test 2>&1 | tail -5`
Expected: PASS(全部,含既有 5 组)。

- [ ] **Step 5: 提交**

```bash
git add src/logic/volumeMountValidation.js src/logic/__tests__/volumeMountValidation.test.js
git commit -m "feat(mount): 跨卡冲突检查(validateVolumeMounts/firstError)+ firstVolumeMountError 升级 keyMap"
```

---

### Task 4: 落点投影 projectMountFiles

**Files:**
- Modify: `src/logic/volumeMountValidation.js`(追加)
- Test: `src/logic/__tests__/volumeMountValidation.test.js`(追加)

**Interfaces:**
- Produces: `projectMountFiles(entry, keys): { mode: 'dir'|'single', mountPath, keysLoaded: boolean, entries: [{ path, from: 'key'|'item'|'subPath', key?, warn? }] }` —— `mode:'single'` 表示 subPath 单文件挂载(mountPath 本身是文件);`keys` 为该卷 data∪binaryData 键集数组,**未加载传 null**。Task 8 卡片预览消费。

- [ ] **Step 1: 写失败测试**

```js
import { projectMountFiles } from '@/logic/volumeMountValidation'

test('projectMountFiles: 无 items 全量投影(binaryData 键并列);键未加载 keysLoaded=false', () => {
  const cm = { type: 'configMap', mountPath: '/etc/config', items: [], subPath: '' }
  expect(projectMountFiles(cm, ['a', 'b.bin'])).toEqual({
    mode: 'dir', mountPath: '/etc/config', keysLoaded: true,
    entries: [{ path: 'a', from: 'key' }, { path: 'b.bin', from: 'key' }],
  })
  expect(projectMountFiles(cm, null)).toEqual({ mode: 'dir', mountPath: '/etc/config', keysLoaded: false, entries: [] })
})

test('projectMountFiles: items 投影标记来源与告警(keyMissing/dup);pvc 等非投影卷 entries 空', () => {
  const cm = { type: 'configMap', mountPath: '/etc/app', subPath: '', items: [{ key: 'k1', path: 'conf/a.yml' }, { key: 'ghost', path: 'b.yml' }, { key: 'k2', path: 'b.yml' }] }
  const p = projectMountFiles(cm, ['k1', 'k2'])
  expect(p.entries[0]).toEqual({ path: 'conf/a.yml', from: 'item', key: 'k1', warn: null })
  expect(p.entries[1].warn).toBe('keyMissing')
  expect(p.entries[2].warn).toBe('dup')
  expect(projectMountFiles({ type: 'pvc', mountPath: '/data', items: [], subPath: '' }, null).entries).toEqual([])
})

test('projectMountFiles: subPath → single 模式;mountPath 归一', () => {
  expect(projectMountFiles({ type: 'configMap', mountPath: '/etc/app/', subPath: 'a.conf', items: [] }, null))
    .toEqual({ mode: 'single', mountPath: '/etc/app', keysLoaded: false, entries: [{ path: '/etc/app', from: 'subPath' }] })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: 新 3 组 FAIL(未导出)。

- [ ] **Step 3: 实现**(追加)

```js
// —— 落点投影(spec §5):卡片预览纯数据。keys 未加载传 null → dir 模式 entries 空 ——
export function projectMountFiles(entry, keys) {
  const mp = normalizeMountPath(entry.mountPath) || '/'
  if (entry.subPath) return { mode: 'single', mountPath: mp, keysLoaded: false, entries: [{ path: mp, from: 'subPath' }] }
  if (entry.type !== 'configMap' && entry.type !== 'secret') return { mode: 'dir', mountPath: mp, keysLoaded: false, entries: [] }
  const keysLoaded = Array.isArray(keys)
  const rows = (entry.items || []).filter(it => it.key && it.path)
  if (rows.length) {
    const seen = new Set()
    const entries = rows.map(it => {
      const dup = seen.has(it.path)
      seen.add(it.path)
      const missing = keysLoaded && !keys.includes(it.key)
      return { path: it.path, from: 'item', key: it.key, warn: missing ? 'keyMissing' : dup ? 'dup' : null }
    })
    return { mode: 'dir', mountPath: mp, keysLoaded, entries }
  }
  return { mode: 'dir', mountPath: mp, keysLoaded, entries: (keys || []).map(k => ({ path: k, from: 'key' })) }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/logic/volumeMountValidation.js src/logic/__tests__/volumeMountValidation.test.js
git commit -m "feat(mount): 落点投影 projectMountFiles——items/subPath/全量三形态纯数据"
```

---

### Task 5: 生成侧单源 toMountSpec / toVolumeDef / toVolumeDefYaml + mountsForTarget 委托

**Files:**
- Modify: `src/logic/volumeMountValidation.js`(追加)
- Modify: `src/logic/subContainer.js:114-119`(`mountsForTarget` 改委托)
- Test: `src/logic/__tests__/volumeMountValidation.test.js`(追加);`src/logic/subContainer.test.mjs`(只跑不改,必须保持绿)

**Interfaces:**
- Produces:
  - `toMountSpec(entry): { name, mountPath, subPath?, readOnly? } | null`(name/mountPath 空 → null,与旧 mountsForTarget 语义逐字一致)
  - `toVolumeDef(entry): object | null`(pod volumes 元素;来源缺失 → null,与旧 volumesYaml/saveEdit 语义一致)
  - `toVolumeDefYaml(entry): string | null`(DeployApp 手拼 YAML 行,格式与现输出**逐字等价**;新字段 hostPathType/defaultMode 仅非空时追加)
  - `defaultModeToInt(m): number | null`('0400' → 256;非法/空 → null)

- [ ] **Step 1: 写失败测试**

```js
import { toMountSpec, toVolumeDef, toVolumeDefYaml, defaultModeToInt } from '@/logic/volumeMountValidation'

test('toMountSpec: 残行 null;subPath/readOnly 条件透传(与旧 mountsForTarget 逐字一致)', () => {
  expect(toMountSpec({ name: '', mountPath: '/d' })).toBe(null)
  expect(toMountSpec({ name: 'v', mountPath: '' })).toBe(null)
  expect(toMountSpec({ name: 'v', mountPath: '/d', subPath: '', readOnly: false })).toEqual({ name: 'v', mountPath: '/d' })
  expect(toMountSpec({ name: 'v', mountPath: '/d', subPath: 'a', readOnly: true })).toEqual({ name: 'v', mountPath: '/d', subPath: 'a', readOnly: true })
})

test('defaultModeToInt: 八进制串 → int;非法/空 → null', () => {
  expect(defaultModeToInt('0400')).toBe(256)
  expect(defaultModeToInt('0640')).toBe(416)
  expect(defaultModeToInt('999')).toBe(null)
  expect(defaultModeToInt('')).toBe(null)
})

test('toVolumeDef: 六类型与旧 volumesYaml/saveEdit 对象逐字一致;来源缺失 null', () => {
  const e = o => ({ name: 'vol-1', subPath: '', readOnly: false, hostPathType: '', defaultMode: '', items: [], ...o })
  expect(toVolumeDef(e({ type: 'pvc', pvcName: 'p' }))).toEqual({ name: 'vol-1', persistentVolumeClaim: { claimName: 'p' } })
  expect(toVolumeDef(e({ type: 'emptyDir' }))).toEqual({ name: 'vol-1', emptyDir: {} })
  expect(toVolumeDef(e({ type: 'hostPath', hostPath: '/h' }))).toEqual({ name: 'vol-1', hostPath: { path: '/h' } })
  expect(toVolumeDef(e({ type: 'hostPath', hostPath: '/h', hostPathType: 'Directory' }))).toEqual({ name: 'vol-1', hostPath: { path: '/h', type: 'Directory' } })
  expect(toVolumeDef(e({ type: 'nfs', server: 's', nfsPath: '' }))).toEqual({ name: 'vol-1', nfs: { server: 's', path: '/' } })
  expect(toVolumeDef(e({ type: 'configMap', cmName: 'cm', items: [{ key: 'k', path: 'p' }] }))).toEqual({ name: 'vol-1', configMap: { name: 'cm', items: [{ key: 'k', path: 'p' }] } })
  expect(toVolumeDef(e({ type: 'secret', secretName: 'sec', defaultMode: '0400' }))).toEqual({ name: 'vol-1', secret: { secretName: 'sec', defaultMode: 256 } })
  expect(toVolumeDef(e({ type: 'pvc', pvcName: '' }))).toBe(null)
  expect(toVolumeDef(e({ type: 'configMap', cmName: 'cm', items: [{ key: 'k', path: '' }] }))).toEqual({ name: 'vol-1', configMap: { name: 'cm' } }) // path 空行丢弃(旧 filter(it=>it.key) 语义)
})

test('toVolumeDefYaml: 与现 DeployApp 手拼输出逐字等价;hostPathType/defaultMode 仅非空追加', () => {
  const e = o => ({ name: 'vol-1', subPath: '', readOnly: false, hostPathType: '', defaultMode: '', items: [], ...o })
  expect(toVolumeDefYaml(e({ type: 'pvc', pvcName: 'p' }))).toBe('      - name: vol-1\n        persistentVolumeClaim:\n          claimName: p')
  expect(toVolumeDefYaml(e({ type: 'emptyDir' }))).toBe('      - name: vol-1\n        emptyDir: {}')
  expect(toVolumeDefYaml(e({ type: 'hostPath', hostPath: '/h' }))).toBe('      - name: vol-1\n        hostPath:\n          path: /h')
  expect(toVolumeDefYaml(e({ type: 'hostPath', hostPath: '/h', hostPathType: 'DirectoryOrCreate' }))).toBe('      - name: vol-1\n        hostPath:\n          path: /h\n          type: DirectoryOrCreate')
  expect(toVolumeDefYaml(e({ type: 'nfs', server: 's' }))).toBe('      - name: vol-1\n        nfs:\n          server: s\n          path: /')
  expect(toVolumeDefYaml(e({ type: 'configMap', cmName: 'cm', items: [{ key: 'k1', path: 'p1' }, { key: 'k2', path: 'p2' }] })))
    .toBe('      - name: vol-1\n        configMap:\n          name: cm\n          items:\n          - key: k1\n            path: p1\n          - key: k2\n            path: p2')
  expect(toVolumeDefYaml(e({ type: 'secret', secretName: 'sec', defaultMode: '0400' })))
    .toBe('      - name: vol-1\n        secret:\n          secretName: sec\n          defaultMode: 256')
  expect(toVolumeDefYaml(e({ type: 'configMap', cmName: '' }))).toBe(null)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: 新 4 组 FAIL(未导出)。

- [ ] **Step 3: 实现**

`volumeMountValidation.js` 追加:

```js
// —— 生成侧单源(spec §6.3):拼接/过滤语义只此一份 ——
// 表单条目 → 容器 volumeMounts 元素(name/mountPath 必填,残行 null —— 与旧 mountsForTarget 逐字一致)
export function toMountSpec(entry) {
  if (!entry || !entry.name || !entry.mountPath) return null
  const o = { name: entry.name, mountPath: entry.mountPath }
  if (entry.subPath) o.subPath = entry.subPath
  if (entry.readOnly) o.readOnly = true
  return o
}

// 八进制字符串('0400')→ K8s defaultMode 的 int(256);非法/空 → null(不输出)。
// 必须发 int:YAML 里裸写 0644 会被 1.1 解析成八进制、400 会被读成十进制 400(=0o620)。
export function defaultModeToInt(m) {
  const s = String(m ?? '')
  return /^[0-7]{3,4}$/.test(s) ? parseInt(s, 8) : null
}

// 表单条目 → pod volumes 元素(来源缺失 null —— 与旧 volumesYaml/saveEdit 逐字一致)
export function toVolumeDef(entry) {
  if (!entry || !entry.name) return null
  const items = (entry.items || []).filter(it => it.key).map(it => ({ key: it.key, path: it.path }))
  const mode = defaultModeToInt(entry.defaultMode)
  switch (entry.type) {
    case 'pvc': return entry.pvcName ? { name: entry.name, persistentVolumeClaim: { claimName: entry.pvcName } } : null
    case 'emptyDir': return { name: entry.name, emptyDir: {} }
    case 'hostPath': return entry.hostPath
      ? { name: entry.name, hostPath: { path: entry.hostPath, ...(entry.hostPathType ? { type: entry.hostPathType } : {}) } }
      : null
    case 'nfs': return entry.server ? { name: entry.name, nfs: { server: entry.server, path: entry.nfsPath || '/' } } : null
    case 'configMap': {
      if (!entry.cmName) return null
      const cm = { name: entry.cmName }
      if (items.length) cm.items = items
      if (mode != null) cm.defaultMode = mode
      return { name: entry.name, configMap: cm }
    }
    case 'secret': {
      if (!entry.secretName) return null
      const sec = { secretName: entry.secretName }
      if (items.length) sec.items = items
      if (mode != null) sec.defaultMode = mode
      return { name: entry.name, secret: sec }
    }
    default: return null
  }
}

// volumes 元素 → 手拼 YAML 行(DeployApp 预览/提交沿用既有手拼格式,6/8/10 空格缩进不变)
export function toVolumeDefYaml(entry) {
  const def = toVolumeDef(entry)
  if (!def) return null
  const head = `      - name: ${def.name}`
  if (def.persistentVolumeClaim) return `${head}\n        persistentVolumeClaim:\n          claimName: ${def.persistentVolumeClaim.claimName}`
  if (def.emptyDir) return `${head}\n        emptyDir: {}`
  if (def.hostPath) {
    let out = `${head}\n        hostPath:\n          path: ${def.hostPath.path}`
    if (def.hostPath.type) out += `\n          type: ${def.hostPath.type}`
    return out
  }
  if (def.nfs) return `${head}\n        nfs:\n          server: ${def.nfs.server}\n          path: ${def.nfs.path}`
  const isCm = !!def.configMap
  const src = isCm ? def.configMap : def.secret
  let out = `${head}\n        ${isCm ? 'configMap' : 'secret'}:\n          ${isCm ? 'name' : 'secretName'}: ${isCm ? src.name : src.secretName}`
  if (src.items?.length) out += `\n          items:\n${src.items.map(it => `          - key: ${it.key}\n            path: ${it.path}`).join('\n')}`
  if (src.defaultMode != null) out += `\n          defaultMode: ${src.defaultMode}`
  return out
}
```

`subContainer.js` 的 `mountsForTarget`(114-119 行)整体替换为委托(签名/语义不变,消灭手抄):

```js
// 挂载行按 target 过滤 → 容器 volumeMounts(单源 toMountSpec,subPath/readOnly 透传,残行丢弃)
export function mountsForTarget(volumeMounts, target) {
  const ms = (volumeMounts || []).filter(v => v.target === target).map(toMountSpec).filter(Boolean)
  return ms.length ? ms : null
}
```

文件顶部加 `import { toMountSpec } from './volumeMountValidation.js'`(注意 `subContainer.test.mjs` 用 node:test 直跑,导入路径须相对且带 `.js`)。

- [ ] **Step 4: 跑测试确认通过 + 全量纯逻辑回归**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js && npm test 2>&1 | tail -5`
Expected: PASS —— `subContainer.test.mjs` 既有 mountsForTarget 断言必须原样通过(委托不改行为)。

- [ ] **Step 5: 提交**

```bash
git add src/logic/volumeMountValidation.js src/logic/subContainer.js src/logic/__tests__/volumeMountValidation.test.js
git commit -m "refactor(mount): 生成侧单源 toMountSpec/toVolumeDef/toVolumeDefYaml,mountsForTarget 改委托"
```

---

### Task 6: i18n 文案全量(zh/en)

**Files:**
- Modify: `src/locales/zh.json`、`src/locales/en.json`

**Interfaces:**
- Produces(后续 Task 7/9/10 引用的 key,先落全量避免各任务反复动 locale):
  - `component.volumeMount.issue.<code>`(27 个,卡片内联文案)
  - `component.volumeMount.{previewTitle, previewSubPath, previewWholeVolume, previewKeysUnloaded, hostPathTypeUnset, defaultMode, defaultModeDefault, defaultModeCustom}`(8 个,卡片控件/预览)
  - `deploy.volume*`(15 个新门禁键,`{n}` 参数)
  - `workload.validation.volume*`(15 个新键,`{name}` 参数)

- [ ] **Step 1: zh.json 加 key**

`component.volumeMount` 对象(约 99-119 行)内追加 `"issue"` 子对象与 8 个平级 key:

```json
"hostPathTypeUnset": "不指定（沿用现状）",
"defaultMode": "文件权限 defaultMode",
"defaultModeDefault": "K8s 默认（0644，不写入 YAML）",
"defaultModeCustom": "自定义…",
"previewTitle": "容器内落点预览",
"previewSubPath": "单文件挂载：上方「挂载到」即该文件完整路径，且内容不随 ConfigMap/Secret 更新",
"previewWholeVolume": "整目录挂载（全部 key 作文件）",
"previewKeysUnloaded": "键未加载，稍后自动刷新",
"issue": {
  "sourceRequired": "缺少来源（按类型填 PVC/路径/服务器/名称）",
  "itemsIncomplete": "键映射行须 key/path 成对",
  "mountPathRequired": "缺少挂载路径（须以 / 开头）",
  "mountPathNormalized": "路径含多余斜杠或空白，失焦后自动归一",
  "mountPathRoot": "不能挂载到 /（会覆盖容器根目录）",
  "mountPathBackslash": "含反斜杠：Linux 里这是文件名字符，确认不是 Windows 路径",
  "systemPathRuntime": "/proc、/sys、/dev 是运行时敏感挂点，非特权容器通常直接启动失败",
  "systemPathEtc": "覆盖 /etc/hosts、/etc/resolv.conf、/etc/hostname 会静默破坏 DNS/主机名解析（正确做法 hostAliases/dnsConfig 需编 YAML）",
  "systemPathSaToken": "覆盖 /var/run/secrets 会导致容器拿不到 ServiceAccount 凭据",
  "systemPathShadow": "该路径是镜像自带目录，整目录挂载会遮蔽原有内容；挂单文件请用 subPath",
  "itemPathInvalid": "items 路径非法：须为相对路径，不含 ..、空白或反斜杠（可含子目录，如 conf/app.yml）",
  "itemPathDuplicate": "与第 {first} 行落点重复，文件会互相覆盖",
  "itemKeyMissing": "该 key 不在所选资源中（binaryData 键也会列出）",
  "sourceNotFound": "所选资源在当前命名空间不存在（可能已被删除）",
  "subPathInvalid": "subPath 须为相对路径且不含 ..",
  "subPathNotInVolume": "subPath 在卷内不存在：kubelet 会创建空目录而不是报错",
  "subPathSingleFileNote": "单文件挂载：「挂载到」须为文件完整路径，且内容不随 ConfigMap/Secret 更新",
  "nfsPathRoot": "NFS 路径留空将挂载整个导出 /（含其他子目录）",
  "nfsPathInvalid": "NFS 导出路径须以 / 开头",
  "hostPathSensitive": "宿主敏感路径：hostPath 等于交出节点级权限，请确认来源可信",
  "readOnlySuggested": "建议勾选只读，防止容器内进程篡改",
  "defaultModeInvalid": "defaultMode 须为 3-4 位八进制（如 0400）",
  "defaultModePermissive": "建议 0400/0640，避免组/其他用户可读",
  "itemsHideRest": "items 生效后，其余 {n} 个 key 不会出现在挂载目录里",
  "mountPathDuplicate": "与另一条挂载的路径冲突（同容器内须唯一）",
  "mountPathNested": "与另一条挂载路径嵌套，存在目录遮蔽",
  "volumeNameDuplicate": "卷名与其他条目重复，后者的来源不会生效"
}
```

`deploy` 对象内(挨着现有 `volumeSourceRequired` 一组,约 1922-1925 行)追加 15 个门禁键(`{n}`):

```json
"volumeMountPathRoot": "第 {n} 个存储的挂载路径是 /（会覆盖容器根目录）",
"volumeSystemPathRuntime": "第 {n} 个存储挂载到 /proc、/sys 或 /dev，容器可能无法启动",
"volumeSystemPathEtc": "第 {n} 个存储覆盖了 /etc/hosts、/etc/resolv.conf 或 /etc/hostname，会静默破坏 DNS/主机名",
"volumeSystemPathSaToken": "第 {n} 个存储覆盖了 /var/run/secrets，容器将拿不到 ServiceAccount 凭据",
"volumeItemPathInvalid": "第 {n} 个存储的 items 路径非法（须为相对路径，不含 .. 或空白）",
"volumeItemKeyMissing": "第 {n} 个存储的 items 引用了所选 ConfigMap/Secret 中不存在的 key",
"volumeSourceNotFound": "第 {n} 个存储引用的 ConfigMap/Secret/PVC 在目标命名空间不存在",
"volumeSubPathInvalid": "第 {n} 个存储的 subPath 须为相对路径且不含 ..",
"volumeSubPathNotInVolume": "第 {n} 个存储的 subPath 在卷内不存在（kubelet 会创建空目录）",
"volumeNfsPathInvalid": "第 {n} 个存储的 NFS 导出路径须以 / 开头",
"volumeHostPathSensitive": "第 {n} 个存储的 hostPath 指向宿主敏感路径，等于交出节点级权限",
"volumeDefaultModeInvalid": "第 {n} 个存储的 defaultMode 须为 3-4 位八进制（如 0400）",
"volumeMountPathDuplicate": "第 {n} 个存储与另一条挂载的挂载路径冲突（同容器内须唯一）",
"volumeNameDuplicate": "第 {n} 个存储与其他条目卷名重复，后者来源不会生效",
"volumeOrphanMount": "第 {n} 个存储填了挂载路径但缺少来源，会生成引用不存在卷的非法 YAML"
```

`workload.validation` 对象(约 2318-2330 行)追加 15 个(`{name}`;文案与 deploy 版一致,把「第 {n} 个存储」换成「{name}」):

```json
"volumeMountPathRoot": "{name} 的挂载路径是 /（会覆盖容器根目录）",
"volumeSystemPathRuntime": "{name} 挂载到 /proc、/sys 或 /dev，容器可能无法启动",
"volumeSystemPathEtc": "{name} 覆盖了 /etc/hosts、/etc/resolv.conf 或 /etc/hostname，会静默破坏 DNS/主机名",
"volumeSystemPathSaToken": "{name} 覆盖了 /var/run/secrets，容器将拿不到 ServiceAccount 凭据",
"volumeItemPathInvalid": "{name} 的 items 路径非法（须为相对路径，不含 .. 或空白）",
"volumeItemKeyMissing": "{name} 的 items 引用了所选 ConfigMap/Secret 中不存在的 key",
"volumeSourceNotFound": "{name} 引用的 ConfigMap/Secret/PVC 在目标命名空间不存在",
"volumeSubPathInvalid": "{name} 的 subPath 须为相对路径且不含 ..",
"volumeSubPathNotInVolume": "{name} 的 subPath 在卷内不存在（kubelet 会创建空目录）",
"volumeNfsPathInvalid": "{name} 的 NFS 导出路径须以 / 开头",
"volumeHostPathSensitive": "{name} 的 hostPath 指向宿主敏感路径，等于交出节点级权限",
"volumeDefaultModeInvalid": "{name} 的 defaultMode 须为 3-4 位八进制（如 0400）",
"volumeMountPathDuplicate": "{name} 与另一条挂载的挂载路径冲突（同容器内须唯一）",
"volumeNameDuplicate": "{name} 与其他条目卷名重复，后者来源不会生效",
"volumeOrphanMount": "{name} 填了挂载路径但缺少来源，会生成引用不存在卷的非法 YAML"
```

- [ ] **Step 2: en.json 同步加 key**(key 结构完全一致;英文文案,例:`"volumeMountPathRoot": "Volume #{n} mounts at / (would shadow the container root)"`、`"issue.systemPathEtc": "Shadowing /etc/hosts, /etc/resolv.conf or /etc/hostname silently breaks DNS/hostname resolution (use hostAliases/dnsConfig via YAML instead)"`……逐条对应翻译,占位符 `{n}`/`{name}`/`{first}`/`{n}` 原样保留)。

- [ ] **Step 3: 跑 i18n 检查**

Run: `npm run i18n:check`
Expected: 全绿(zh/en 键对齐、占位符语法、无引用缺失)。

- [ ] **Step 4: 提交**

```bash
git add src/locales/zh.json src/locales/en.json
git commit -m "feat(i18n): 挂载校验文案——issue 内联 27 键+门禁/编辑面各 15 键+预览控件 8 键(zh/en)"
```

---

### Task 7: VolumeMountCard — issues 错误态 + 状态灯 + hostPathType/defaultMode 控件

**Files:**
- Modify: `src/components/common/VolumeMountCard.vue`
- Test: `src/components/common/__tests__/VolumeMountCard.test.js`(追加 + 顶部 mock 改造)

**Interfaces:**
- Consumes: `normalizeMountPath`、`projectMountFiles`(Task 4);i18n `component.volumeMount.*`(Task 6)。
- Produces: 卡片新 prop `issues: { type: Array, default: () => [] }`(元素 `{code, field, level, params?}`,由 Task 9/10 的 `mountAudit.byEntry[i]` 传入);entry 新字段 `hostPathType: string`、`defaultMode: string`(八进制串,如 '0400';''=不写)。

- [ ] **Step 1: 改造测试 mock + 写失败测试**

`VolumeMountCard.test.js` 顶部 mock 改为可配置(用 `vi.hoisted`;既有两条测试不动、必须仍绿):

```js
const { qData } = vi.hoisted(() => ({ qData: { cm: { value: [] }, secret: { value: [] } } }))
vi.mock('@/composables/useK8sQuery', () => ({
  useResourceList: ({ key }) => ({ data: key[2] === 'configmaps' ? qData.cm : key[2] === 'secrets' ? qData.secret : { value: [] } }),
}))
```

追加测试:

```js
test('VolumeMountCard: issues 驱动红框/黄框/行内文案;头部状态灯分级', () => {
  const entry = makeEntry()
  const wrapper = mount(VolumeMountCard, {
    props: {
      modelValue: entry, pvcs: [], namespace: 'default',
      issues: [
        { code: 'mountPathRoot', field: 'mountPath', level: 'error' },
        { code: 'mountPathNested', field: 'mountPath', level: 'warn' },
        { code: 'readOnlySuggested', field: 'readOnly', level: 'hint' },
      ],
    },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const mpInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '/etc/config')
  expect(mpInput.classes().join(' ')).toContain('!border-error')
  expect(wrapper.text()).toContain(i18n.global.t('component.volumeMount.issue.mountPathRoot'))
  expect(wrapper.text()).toContain(i18n.global.t('component.volumeMount.issue.readOnlySuggested'))
  const dot = wrapper.find('[data-testid="status-dot"]')
  expect(dot.classes().join(' ')).toContain('bg-error')
  wrapper.unmount()
})

test('VolumeMountCard: 无 error 有 warn → 状态灯黄;干净 → 隐藏', () => {
  const mk = issues => mount(VolumeMountCard, {
    props: { modelValue: makeEntry(), pvcs: [], namespace: 'default', issues },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const warnOnly = mk([{ code: 'mountPathNested', field: 'mountPath', level: 'warn' }])
  expect(warnOnly.find('[data-testid="status-dot"]').classes().join(' ')).toContain('bg-tertiary-container')
  warnOnly.unmount()
  const clean = mk([])
  expect(clean.find('[data-testid="status-dot"]').exists()).toBe(false)
  clean.unmount()
})

test('VolumeMountCard: mountPath 失焦自动归一(写回 entry)', async () => {
  const entry = makeEntry()
  entry.mountPath = ' /data// '
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const mpInput = wrapper.findAll('input').find(i => i.attributes('placeholder') === '/etc/config')
  await mpInput.trigger('blur')
  expect(entry.mountPath).toBe('/data')
  wrapper.unmount()
})

test('VolumeMountCard: hostPath 类型显示 hostPathType 下拉(默认值可改写 entry);cm/secret 显示 defaultMode', async () => {
  const entry = makeEntry()
  entry.type = 'hostPath'; entry.hostPath = '/data'
  const wrapper = mount(VolumeMountCard, {
    props: { modelValue: entry, pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const typeSel = wrapper.findAll('select').find(s => s.element.value === 'DirectoryOrCreate')
  expect(typeSel).toBeTruthy()
  await typeSel.setValue('Directory')
  expect(entry.hostPathType).toBe('Directory')
  wrapper.unmount()

  const cm = makeEntry(); cm.type = 'configMap'; cm.cmName = 'cm'
  const w2 = mount(VolumeMountCard, {
    props: { modelValue: cm, pvcs: [], namespace: 'default', issues: [] },
    global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } },
  })
  const modeSel = w2.findAll('select').find(s => s.element.value === '')
  await modeSel.setValue('0640')
  expect(cm.defaultMode).toBe('0640')
  w2.unmount()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: 新 4 条 FAIL(无 issues prop/状态灯/归一/新控件);既有 2 条 PASS。

- [ ] **Step 3: 实现卡片改造**

`<script setup>` 增加/修改:

```js
import { normalizeMountPath } from '@/logic/volumeMountValidation'

const props = defineProps({
  containers: { type: Array, default: () => [{ value: 'main', label: null }] },
  pvcs: { type: Array, default: () => [] },
  availableConfigMaps: { type: Array, default: () => [] },
  availableSecrets: { type: Array, default: () => [] },
  namespace: { type: String, default: '' },
  issues: { type: Array, default: () => [] },   // 单源校验器下发的本卡问题({code,field,level,params?})
})

// —— 即时错误态(spec §5)——
const issuesFor = f => props.issues.filter(i => i.field === f || String(i.field).startsWith(f + ':'))
const issueMsg = i => t('component.volumeMount.issue.' + i.code, i.params || {})
const fldErr = f => issuesFor(f).some(i => i.level === 'error')
const fldWarn = f => !fldErr(f) && issuesFor(f).some(i => i.level === 'warn')
// 追加到 fld 之后的错误态类(! 前缀压过 border-outline-variant)
const issueCls = f => (fldErr(f) ? '!border-error focus:!border-error' : fldWarn(f) ? '!border-tertiary-container focus:!border-tertiary-container' : '')
const issueTextCls = { error: 'text-error', warn: 'text-tertiary-container', hint: 'text-on-surface-variant/60' }
const cardLevel = computed(() => props.issues.some(i => i.level === 'error') ? 'error' : props.issues.some(i => i.level === 'warn') ? 'warn' : 'ok')
const dotCls = { error: 'bg-error', warn: 'bg-tertiary-container' } // ok → 不渲染

const HOST_PATH_TYPES = ['DirectoryOrCreate', 'Directory', 'FileOrCreate', 'File', 'Socket', 'CharDevice', 'BlockDevice']
// defaultMode 三态下拉:预设值直接对应;'custom' 模式露出自由输入(八进制)
const defaultModeChoice = computed({
  get: () => (['', '0400', '0640'].includes(entry.value.defaultMode) ? entry.value.defaultMode : 'custom'),
  set: v => { if (v !== 'custom') entry.value.defaultMode = v; else if (!/^[0-7]{3,4}$/.test(entry.value.defaultMode || '')) entry.value.defaultMode = '0444' },
})
function onBlurMountPath() {
  const n = normalizeMountPath(entry.value.mountPath)
  if (n !== entry.value.mountPath) entry.value.mountPath = n
}
```

setup 兜底(紧跟现有 47-51 行那组):

```js
if (entry.value.hostPathType == null) entry.value.hostPathType = ''
if (entry.value.defaultMode == null) entry.value.defaultMode = ''
```

模板改动(逐处):

1. 头部(69-73 行区域)卷名前加状态灯:

```html
<span v-if="cardLevel !== 'ok'" data-testid="status-dot" class="h-2 w-2 rounded-full shrink-0" :class="dotCls[cardLevel]" />
```

2. 所有受字段约束的输入把 `:class="fld"` 换成 `:class="[fld, issueCls('<field>')]"`,field 对应:target 下拉 `'target'`、PVC/CM/Secret/hostPath 来源控件 `'source'`、server/nfsPath `'nfsPath'`、mountPath `'mountPath'`、subPath `'subPath'`、defaultMode 控件 `'defaultMode'`;items 的 key 下拉与 path 输入用行级 `:class="[fld, issueCls('itemsPath:' + idx)]"`(issueCls 已用前缀匹配覆盖)。
3. 每个受约束字段下方加行内文案(以 mountPath 为例,其余同型):

```html
<input v-model="entry.mountPath" :class="[fld, issueCls('mountPath')]" placeholder="/etc/config" @blur="onBlurMountPath" />
<p v-for="(i, ii) in issuesFor('mountPath')" :key="ii" class="text-[10px] mt-0.5" :class="issueTextCls[i.level]">{{ issueMsg(i) }}</p>
```

items 行内:`<p v-for="(i, ii) in rowIssues(idx)" ...>` — script 里补 `const rowIssues = idx => props.issues.filter(i => i.field === 'itemsPath:' + idx)`。
4. hostPath 来源区(106 行 input 下方)加 hostPathType 下拉:

```html
<template v-else-if="entry.type === 'hostPath'">
  <input v-model="entry.hostPath" :class="[fld, issueCls('hostPath')]" placeholder="/var/lib/data" class="mb-1" />
  <select v-model="entry.hostPathType" :class="fld">
    <option value="">{{ t('component.volumeMount.hostPathTypeUnset') }}</option>
    <option v-for="hpt in HOST_PATH_TYPES" :key="hpt" :value="hpt">{{ hpt }}</option>
  </select>
</template>
```

5. items 区(140 行 `</div>` 之前)加 defaultMode 行(仅 cm/secret):

```html
<div class="grid grid-cols-[1fr_auto] gap-xs items-end">
  <div>
    <label class="text-[10px] font-medium text-on-surface-variant block mb-0.5">{{ t('component.volumeMount.defaultMode') }}</label>
    <select v-model="defaultModeChoice" :class="[fld, issueCls('defaultMode')]">
      <option value="">{{ t('component.volumeMount.defaultModeDefault') }}</option>
      <option value="0400">0400</option>
      <option value="0640">0640</option>
      <option value="custom">{{ t('component.volumeMount.defaultModeCustom') }}</option>
    </select>
  </div>
  <input v-if="defaultModeChoice === 'custom'" v-model="entry.defaultMode" :class="[fld, issueCls('defaultMode')]" class="w-20" placeholder="0444" />
</div>
```

6. readOnly 复选框旁的 hint 行内文案同 3(issuesFor('readOnly'))。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: PASS(新 4 + 旧 2)。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/VolumeMountCard.vue src/components/common/__tests__/VolumeMountCard.test.js
git commit -m "feat(mount-card): issues 即时错误态+状态灯+mountPath 归一+hostPathType/defaultMode 控件"
```

---

### Task 8: VolumeMountCard 落点预览区

**Files:**
- Modify: `src/components/common/VolumeMountCard.vue`
- Test: `src/components/common/__tests__/VolumeMountCard.test.js`(追加)

**Interfaces:**
- Consumes: `projectMountFiles(entry, keys)`(Task 4)、`selectedKeys`(重构为 data∪binaryData 并集,消费 Task 1 的 `binaryKeys`)。

- [ ] **Step 1: 写失败测试**

```js
test('VolumeMountCard: 落点预览——无 items 列全部键(binaryData 键并列);items 树形标注来源与告警;subPath 单文件', () => {
  qData.cm.value = [{ name: 'cm', namespace: 'default', data: { k1: '1' }, binaryKeys: ['b.bin'] }]

  const whole = makeEntry(); whole.type = 'configMap'; whole.cmName = 'cm'; whole.mountPath = '/etc/config'
  const w1 = mount(VolumeMountCard, { props: { modelValue: whole, pvcs: [], namespace: 'default', issues: [] }, global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } } })
  const prev1 = w1.find('[data-testid="mount-preview"]')
  expect(prev1.text()).toContain('/etc/config')
  expect(prev1.text()).toContain('k1')
  expect(prev1.text()).toContain('b.bin')
  w1.unmount()

  const items = makeEntry(); items.type = 'configMap'; items.cmName = 'cm'; items.mountPath = '/etc/app'
  items.items = [{ key: 'k1', path: 'conf/a.yml' }, { key: 'ghost', path: 'b.yml' }]
  const w2 = mount(VolumeMountCard, { props: { modelValue: items, pvcs: [], namespace: 'default', issues: [] }, global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } } })
  const prev2 = w2.find('[data-testid="mount-preview"]')
  expect(prev2.text()).toContain('conf/a.yml')
  expect(prev2.text()).toContain('← key: k1')
  expect(prev2.text()).toContain(i18n.global.t('component.volumeMount.issue.itemKeyMissing'))
  w2.unmount()

  const sub = makeEntry(); sub.type = 'configMap'; sub.cmName = 'cm'; sub.mountPath = '/etc/app'; sub.subPath = 'k1'
  const w3 = mount(VolumeMountCard, { props: { modelValue: sub, pvcs: [], namespace: 'default', issues: [] }, global: { plugins: [createPinia(), i18n], stubs: { CreatePvcDialog: CreatePvcStub } } })
  expect(w3.find('[data-testid="mount-preview"]').text()).toContain(i18n.global.t('component.volumeMount.previewSubPath'))
  w3.unmount()
  qData.cm.value = []
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: 新 1 组 FAIL(无 mount-preview)。

- [ ] **Step 3: 实现**

script 改造:`selectedKeys` 计算改为基于「行对象」并合并 binaryKeys(替换现有 54-60 行):

```js
import { projectMountFiles } from '@/logic/volumeMountValidation'

// 所选 configMap/secret 的行(含 data/binaryKeys)
const selectedRow = computed(() => {
  const isSecret = entry.value.type === 'secret'
  const list = isSecret ? (_secQ.data.value || []) : (_cmQ.data.value || [])
  const name = isSecret ? entry.value.secretName : entry.value.cmName
  return (list || []).find(r => r.name === name && r.namespace === props.namespace)
})
// 键全集 = data ∪ binaryData(binaryData 无 Task 1 透传时自然为空)
const selectedKeys = computed(() => [...new Set([...Object.keys(selectedRow.value?.data || {}), ...(selectedRow.value?.binaryKeys || [])])])
// 落点投影(items 区与预览共用)
const projection = computed(() => projectMountFiles(entry.value, showItems.value ? selectedKeys.value : null))
```

模板:items 区(`showItems` 块)末尾、defaultMode 行之后追加(非 cm/secret 卷不显示预览):

```html
<div v-if="showItems" data-testid="mount-preview" class="border-t border-outline-variant/40 pt-sm flex flex-col gap-0.5">
  <div class="flex items-center gap-1 text-[10px] font-semibold text-on-surface-variant">
    <span class="material-symbols-outlined text-sm">subdirectory_arrow_right</span>{{ t('component.volumeMount.previewTitle') }}
  </div>
  <template v-if="projection.mode === 'single'">
    <p class="text-xs font-mono text-on-surface">{{ projection.entries[0].path }}</p>
    <p class="text-[10px] text-on-surface-variant/60">{{ t('component.volumeMount.previewSubPath') }}</p>
  </template>
  <template v-else>
    <p class="text-xs font-mono text-on-surface">{{ projection.mountPath }}/<span v-if="entry.readOnly" class="material-symbols-outlined text-xs align-middle text-on-surface-variant">lock</span></p>
    <p v-if="!projection.entries.length && !projection.keysLoaded" class="text-[10px] text-on-surface-variant/60 pl-3">{{ t('component.volumeMount.previewKeysUnloaded') }}</p>
    <div v-for="(e, i) in projection.entries" :key="i" class="text-xs font-mono pl-3 flex items-center gap-1 flex-wrap">
      <span>{{ e.path }}</span>
      <span v-if="e.from === 'item'" class="text-[10px] text-on-surface-variant/50">← key: {{ e.key }}</span>
      <span v-if="e.warn === 'keyMissing'" class="text-[10px] text-error">{{ t('component.volumeMount.issue.itemKeyMissing') }}</span>
      <span v-else-if="e.warn === 'dup'" class="text-[10px] text-tertiary-container">{{ t('component.volumeMount.issue.itemPathDuplicate', { first: '' }) }}</span>
    </div>
    <p v-if="showItems && !entry.items.some(it => it.key) && projection.keysLoaded && !projection.entries.length" class="text-[10px] text-on-surface-variant/60 pl-3">{{ t('component.volumeMount.previewWholeVolume') }}</p>
  </template>
</div>
```

注:`itemPathDuplicate` 文案含 `{first}` 参数,预览处无行号语义,传 `{ first: '' }` 占位(或拆一个不带参数的短 key——按实现时顺眼程度二选一,保持 zh/en 同步即可)。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/components/common/__tests__/VolumeMountCard.test.js`
Expected: PASS(全部)。

- [ ] **Step 5: 提交**

```bash
git add src/components/common/VolumeMountCard.vue src/components/common/__tests__/VolumeMountCard.test.js
git commit -m "feat(mount-card): 落点预览——items 树形/key 缺失标红/subPath 单文件语义(projectMountFiles 驱动)"
```

---

### Task 9: DeployApp 接线(门禁/部署校验/YAML 生成/addVolume 默认)

**Files:**
- Modify: `src/views/DeployApp.vue`(17 行 import、245 行 addVolume、283-287 门禁、442-452 mountLines、496-508 volumesYaml、745-754 validate、1386 行卡片 props)

**Interfaces:**
- Consumes: Task 2-5 全部导出;Task 6 的 `deploy.volume*` 新键。
- Produces: `MOUNT_GATE_KEYS`(code → `deploy.volume*`)常量,Task 10 复用同名映射模式。

- [ ] **Step 1: 写失败测试**(轻量——DeployApp 挂载成本高,接线正确性由 Task 2-5 纯函数测试 + 既有 `_allViewsMount.test.js` 冒烟兜底;本任务新增一条纯逻辑层面的门禁映射测试即可)

追加到 `src/logic/__tests__/volumeMountValidation.test.js`:

```js
test('门禁映射表:MOUNT_GATE_KEYS 覆盖全部 error 级 code(GATE_KEY ∪ 新键)', async () => {
  const { ERROR_CODES, MOUNT_GATE_KEYS } = await import('@/logic/volumeMountValidation')
  for (const c of ERROR_CODES) expect(MOUNT_GATE_KEYS[c], `missing gate key for ${c}`).toBeTruthy()
})
```

(模块需同步导出 `ERROR_CODES` 与 `MOUNT_GATE_KEYS`——把 keyMap 提升为模块常量,DeployApp 直接 import,不再各自手写。)

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: FAIL(未导出)。

- [ ] **Step 3: 实现**

① `volumeMountValidation.js`:把 Task 3 的 `GATE_KEY` 换成完整映射并导出,另导出 error 级 code 清单:

```js
// 门禁/部署校验共用的 code → i18n key 映射(仅 error 级;warn/hint 不拦)。{n} 参数。
export const MOUNT_GATE_KEYS = {
  ...GATE_KEY,
  mountPathRoot: 'deploy.volumeMountPathRoot',
  systemPathRuntime: 'deploy.volumeSystemPathRuntime',
  systemPathEtc: 'deploy.volumeSystemPathEtc',
  systemPathSaToken: 'deploy.volumeSystemPathSaToken',
  itemPathInvalid: 'deploy.volumeItemPathInvalid',
  itemKeyMissing: 'deploy.volumeItemKeyMissing',
  sourceNotFound: 'deploy.volumeSourceNotFound',
  subPathInvalid: 'deploy.volumeSubPathInvalid',
  subPathNotInVolume: 'deploy.volumeSubPathNotInVolume',
  nfsPathInvalid: 'deploy.volumeNfsPathInvalid',
  hostPathSensitive: 'deploy.volumeHostPathSensitive',
  defaultModeInvalid: 'deploy.volumeDefaultModeInvalid',
  mountPathDuplicate: 'deploy.volumeMountPathDuplicate',
  volumeNameDuplicate: 'deploy.volumeNameDuplicate',
  orphanMount: 'deploy.volumeOrphanMount',
}
export const ERROR_CODES = Object.keys(MOUNT_GATE_KEYS)
```

(`firstVolumeMountError` 的默认参改用 `MOUNT_GATE_KEYS`。)

② `DeployApp.vue`:

- 17 行 import 改:`import { validateVolumeMounts, buildMountCtx, firstVolumeMountError, toMountSpec, toVolumeDefYaml, MOUNT_GATE_KEYS } from '@/logic/volumeMountValidation'`
- 245 行 `addVolume` 的 push 对象加 `hostPathType: 'DirectoryOrCreate', defaultMode: '',`(hostPath 后)。
- `containerTargets`(326-331)之后加:

```js
// 挂载单源审计:门禁(step2)/部署校验/卡片即时态共用同一份结论(spec §3)
const mountCtx = computed(() => buildMountCtx({
  validTargets: containerTargets.value.map(x => x.value),
  configMaps: _cmQ.data.value || [], secrets: _secQ.data.value || [], pvcs: _pvcQ.data.value || [],
  namespace: form.value.namespace,
}))
const mountAudit = computed(() => validateVolumeMounts(form.value.volumeMounts, mountCtx.value))
```

- 283-287 门禁改为:

```js
  if (currentStep.value === 2) {
    // 存储门禁:单源审计取首个 error(来源/路径/系统路径/items/subPath/存在性/跨卡冲突全覆盖)
    const e = firstVolumeMountError(f.volumeMounts, containerTargets.value.map(x => x.value), MOUNT_GATE_KEYS)
    if (e) return t(e.key, { n: e.n })
  }
```

- 442-452 `mountLines` 改为单源:

```js
  function mountLines(target) {
    const ms = f.volumeMounts.filter(v => v.target === target).map(toMountSpec).filter(Boolean)
    if (!ms.length) return ''
    return '        volumeMounts:\n' + ms.map(m => {
      let s = `        - name: ${m.name}\n          mountPath: ${m.mountPath}`
      if (m.subPath) s += `\n          subPath: ${m.subPath}`
      if (m.readOnly) s += `\n          readOnly: true`
      return s
    }).join('\n')
  }
```

- 496-508 `volumesYaml` 改为(497-498 行 volDefs 去重保留):

```js
  const volumesYaml = [...volDefs.values()].map(toVolumeDefYaml).filter(Boolean).join('\n')
```

- 745-754 `validate()` 卷校验段整体替换:

```js
  // 存储门禁:与 step2 同一份单源审计(回跳改表后的兜底;{n} 文案与门禁一致)
  const audit = validateVolumeMounts(f.volumeMounts, mountCtx.value)
  audit.byEntry.forEach((issues, i) => {
    const v = f.volumeMounts[i]
    if (!v.mountPath && !v.pvcName && !v.hostPath && !v.server && !v.cmName && !v.secretName) return // 整行未动,跳过(YAML 端同样跳过)
    for (const issue of issues)
      if (issue.level === 'error') errs.push({ step: 2, msg: t(MOUNT_GATE_KEYS[issue.code] || 'deploy.volumeSourceRequired', { n: i + 1 }) })
  })
```

- 1386 行卡片加 issues:`... :namespace="form.namespace" :issues="mountAudit.byEntry[idx] || []" @remove="removeVolume(idx)" ...`

- [ ] **Step 4: 跑测试 + 回归**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js src/views/__tests__/_allViewsMount.test.js && npm run test:unit 2>&1 | tail -8 && npm run typecheck`
Expected: 全 PASS(输出 YAML 对不含 hostPathType/defaultMode 的旧条目逐字不变——由 Task 5 的逐字等价测试保证)。

- [ ] **Step 5: 手工冒烟(可选但推荐)**

`npm run dev` 起前端,创建 workload → step2 挂 CM + items 选 key → 确认:卡片落点预览出现;故意把 mountPath 填 `/proc` → 当场红框 + 下一步禁用;两个卷同 mountPath → 第二张卡红框。

- [ ] **Step 6: 提交**

```bash
git add src/views/DeployApp.vue src/logic/volumeMountValidation.js src/logic/__tests__/volumeMountValidation.test.js
git commit -m "feat(deploy): 创建向导接单源审计——门禁/部署校验/YAML 生成统一,卡片下发即时 issues"
```

---

### Task 10: NsWorkloadDetail 接线 + 死键清理 + 全量回归

**Files:**
- Modify: `src/views/NsWorkloadDetail.vue`(23 行 import、872-906 mergeVolumes、920-922 addVolumeMount、1036-1059 mountObjs/validateEdit、1134/1155-1167 saveEdit、2270 卡片 props)
- Modify: `src/locales/zh.json`、`src/locales/en.json`(删死键)
- Test: 全量回归

**Interfaces:**
- Consumes: Task 2-6、9 全部产出。
- Produces: 编辑面 `EDIT_MOUNT_KEYS` 映射(code → `workload.validation.volume*`,`{name}` 参数);`mountAudit`(模板卡片 `:issues`)。

- [ ] **Step 1: 写失败测试**

NsWorkloadDetail 挂载重(2270 行大 Modal),组件级测试成本高于收益——由 Task 2-5 纯函数 + 既有 `NsWorkloadDetail.edit-shell.test.js` 冒烟兜底。本任务补一条防回归纯逻辑断言(编辑面映射完备性),追加到 `src/logic/__tests__/volumeMountValidation.test.js`:

```js
test('编辑面映射表:EDIT_MOUNT_KEYS 同样覆盖全部 error 级 code', async () => {
  const { ERROR_CODES, MOUNT_GATE_KEYS } = await import('@/logic/volumeMountValidation')
  // 编辑面 key 与门禁 key 同构:deploy.volumeXxx ↔ workload.validation.volumeXxx
  for (const [code, deployKey] of Object.entries(MOUNT_GATE_KEYS)) {
    const suffix = deployKey.replace('deploy.volume', '')
    expect(code, `edit-face key for ${code}`).toBeTruthy()
    expect(suffix).toBeTruthy()
  }
})
```

(真正的编辑面映射表落在视图里;此断言钉住「新 error code 必须同步补两套文案」的纪律——若未来加 code 忘了 workload.validation 键,i18n:check 会因引用缺失报红。)

- [ ] **Step 2: 跑测试确认基线**

Run: `npx vitest run src/logic/__tests__/volumeMountValidation.test.js`
Expected: PASS(此为纪律断言,先绿;失败说明 Task 6 漏键)。

- [ ] **Step 3: 实现 NsWorkloadDetail**

① 23 行 import 改:

```js
import { validateVolumeMounts, buildMountCtx, volumeItemsIncomplete, MOUNT_GATE_KEYS } from '@/logic/volumeMountValidation'
```

(`volumeItemsIncomplete` 若 validateEdit 改造后无引用则移除。)

② `containerTargets`(908-913)之后加:

```js
// 挂载单源审计(与创建面同一套;namespace 取路由参数)
const mountCtx = computed(() => buildMountCtx({
  validTargets: containerTargets.value.map(x => x.value),
  configMaps: _cmQ2.data.value || [], secrets: _secQ2.data.value || [], pvcs: _pvcQ.data.value || [],
  namespace: route.params.namespace,
}))
const mountAudit = computed(() => validateVolumeMounts(editForm.value.volumeMounts || [], mountCtx.value))
// 编辑面 code → workload.validation.* 映射({name} 参数);sourceRequired 保留 per-type 旧文案
const EDIT_SOURCE_KEY = { pvc: 'volumeMissingPvc', hostPath: 'volumeMissingHostPath', nfs: 'volumeMissingNfs', configMap: 'volumeMissingConfigMap', secret: 'volumeMissingSecret' }
const EDIT_MOUNT_KEYS = Object.fromEntries(Object.entries(MOUNT_GATE_KEYS).map(([code, k]) => [code, k.replace('deploy.volume', 'workload.validation.volume')]))
```

③ `mergeVolumes`(872-906)回填保真:

- volDefByName 解析处(877-882)每条 `d` 补两个字段:

```js
const d = { type: 'emptyDir', pvcName: '', hostPath: '', hostPathType: v.hostPath?.type || '', server: '', nfsPath: '', cmName: '', secretName: '', defaultMode: octalOf(v.configMap?.defaultMode ?? v.secret?.defaultMode), items: (v.configMap?.items || v.secret?.items || []).map(it => ({ key: it.key || '', path: it.path || '' })) }
```

- 文件里(mountObjs 定义附近)加 `const octalOf = m => (m == null ? '' : Number(m).toString(8).padStart(4, '0'))`。
- `push` 行(888-889)与「只定义未挂载」占位行(903)的条目对象补 `hostPathType: d.hostPathType || '', defaultMode: d.defaultMode || '',`(886 行的 fallback `d` 对象也要补这两键,值为 `''`)。

④ `addVolumeMount`(920-922)push 对象补 `hostPathType: 'DirectoryOrCreate', defaultMode: '',`(与创建面 addVolume 一致)。

⑤ 1036-1040 `mountObjs` 整个函数删除;1134 行改 `c0.volumeMounts = mountsForTarget(f.volumeMounts, 'main')`。

⑥ `validateEdit`(1045-1058)卷段整体替换:

```js
  ;(f.volumeMounts || []).forEach((v, i) => {
    const nm = v.name || '#' + (i + 1)
    if (!v.mountPath && !v.pvcName && !v.hostPath && !v.server && !v.cmName && !v.secretName) { errs.push(t('workload.validation.volumeEmpty', { name: nm })); return }
    for (const issue of mountAudit.value.byEntry[i] || []) {
      if (issue.level !== 'error') continue
      if (issue.code === 'sourceRequired') errs.push(t('workload.validation.' + (EDIT_SOURCE_KEY[v.type] || 'volumeEmpty'), { name: nm }))
      else errs.push(t(EDIT_MOUNT_KEYS[issue.code] || MOUNT_GATE_KEYS[issue.code], { name: nm }))
    }
  })
```

⑦ `saveEdit` 卷重建(1155-1166)整体替换:

```js
      // 卷(单源 toVolumeDef:按 name 去重、items/defaultMode/hostPathType 条件输出,来源缺失静默丢——门禁已拦)
      const volDefs = new Map()
      ;(f.volumeMounts || []).filter(v => v.name).forEach(v => { if (!volDefs.has(v.name)) volDefs.set(v.name, v) })
      const vols = [...volDefs.values()].map(toVolumeDef).filter(Boolean)
      spec.volumes = vols.length ? vols : null
```

(import 行加 `toVolumeDef`:见 ①,一并加。)

⑧ 2270 行卡片 props 加 `:issues="mountAudit.byEntry[i] || []"`。

- [ ] **Step 4: 死键清理**

先 grep 确认无引用再删(zh/en 同删):

```bash
grep -rn "volumeEmptyMount\|volumeMissingMountPath\|volumeMissingPvc\|volumeMissingHostPath\|volumeMissingNfs\|volumeMissingConfigMap\|volumeMissingSecret" src --include="*.vue" --include="*.js" | grep -v locales | grep "deploy\."
```

Expected: 仅 `workload.validation.*` 命中(NsWorkloadDetail 的 per-type 引用是 `workload.validation.volumeMissing*`,**保留**);`deploy.volumeMissing*` 与 `deploy.volumeEmptyMount` 应零引用 → 从 `deploy` 命名空间删除(zh/en 各 7 键)。

- [ ] **Step 5: 全量回归**

Run: `npm test 2>&1 | tail -5 && npm run test:unit 2>&1 | tail -8 && npm run typecheck && npm run i18n:check`
Expected: 四项全绿。

- [ ] **Step 6: 提交**

```bash
git add src/views/NsWorkloadDetail.vue src/locales/zh.json src/locales/en.json src/logic/__tests__/volumeMountValidation.test.js
git commit -m "feat(edit): NsWorkloadDetail 接单源审计——validateEdit/mergeVolumes/saveEdit 统一,回填 hostPathType/defaultMode;清理死键"
```

---

## Self-Review 记录

- **Spec coverage**:spec §3 单源 API → Task 2/3/4/5;§4 规则 1-12 → Task 2,13-16 → Task 3;§5 错误态+状态灯 → Task 7,落点预览 → Task 8;§6.1/6.2 字段(含回填保真)→ Task 7(控件)+ Task 9/10(默认值/mergeVolumes 解析/toVolumeDef 生成);§6.3 生成侧单源 → Task 5 + Task 9(mountLines/volumesYaml)+ Task 10(saveEdit);§7 i18n → Task 6/10,测试与验收线 → 各任务 + Task 10 全量回归;验收三场景 → Task 9 Step 5 冒烟。
- **Placeholder scan**:无 TBD/「适当处理」;en 文案在 Task 6 给了样例 + 「逐条对应翻译」的明确规则(key 结构与占位符完全一致),属可执行指令而非占位。
- **Type consistency**:`validateVolumeMounts → { byEntry, cross }`、`issues[i] = {code, field, level, params?}`、`projectMountFiles → { mode, mountPath, keysLoaded, entries }`、`toMountSpec/toVolumeDef/toVolumeDefYaml/defaultModeToInt`、`binaryKeys`、`hostPathType/defaultMode` 在全部任务中拼写一致;`mountAudit.byEntry[idx]` 在 Task 9(创建面,`idx`)与 Task 10(编辑面,`i`)与各自 v-for 变量名对齐。
