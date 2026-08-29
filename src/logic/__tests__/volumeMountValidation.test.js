// 向导 step2 门禁纯函数:卷必须映射到容器(来源/mountPath/target 三查),堵静默丢弃洞。
import { test, expect } from 'vitest'
import { firstVolumeMountError, volumeItemsIncomplete, normalizeMountPath, buildMountCtx, validateEntry, validateVolumeMounts, firstError, firstVolumeMountError as fvme, projectMountFiles, toMountSpec, toVolumeDef, toVolumeDefYaml, defaultModeToInt } from '@/logic/volumeMountValidation'

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
  expect(firstVolumeMountError([{ ...base }, { ...base, name: 'vol-2', pvcName: '', mountPath: '/data2' }], OK)).toEqual({ key: 'deploy.volumeSourceRequired', n: 2 })
})

test('mountPath:空或非斜杠开头 → deploy.volumeMountRequired', () => {
  expect(firstVolumeMountError([{ ...base, mountPath: '' }], OK)).toEqual({ key: 'deploy.volumeMountRequired', n: 1 })
  expect(firstVolumeMountError([{ ...base, mountPath: 'data' }], OK)).toEqual({ key: 'deploy.volumeMountRequired', n: 1 })
})

test('target 悬空(容器已删/无镜像)→ deploy.volumeTargetInvalid', () => {
  expect(firstVolumeMountError([{ ...base, target: 'sidecar:9' }], OK)).toEqual({ key: 'deploy.volumeTargetInvalid', n: 1 })
})

test('items 半填:key-only/path-only → volumeItemsIncomplete;全空行忽略', () => {
  const it = (key, path) => ({ key, path })
  expect(volumeItemsIncomplete({ items: [it('k', '')] })).toBe(true)
  expect(volumeItemsIncomplete({ items: [it('', 'p')] })).toBe(true)
  expect(volumeItemsIncomplete({ items: [it('', ''), it('k', 'p')] })).toBe(false)
  expect(volumeItemsIncomplete({})).toBe(false)
  expect(firstVolumeMountError([{ ...base, items: [{ key: 'k', path: '' }] }], OK)).toEqual({ key: 'deploy.volumeItemsIncomplete', n: 1 })
  expect(firstVolumeMountError([{ ...base, items: [{ key: '', path: '' }] }], OK)).toBe(null)
})

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
const entryBase = { name: 'vol-1', target: 'main', type: 'pvc', mountPath: '/data', subPath: '', readOnly: false, pvcName: 'my-pvc', hostPath: '', hostPathType: '', server: '', nfsPath: '', cmName: '', secretName: '', defaultMode: '', items: [] }
const codes = iss => iss.map(i => i.code)
const ENTRY_CTX = buildMountCtx({ namespace: 'ns', validTargets: ['main'], configMaps: [{ name: 'cm', namespace: 'ns', data: { k1: '1', k2: '2' } }], secrets: [], pvcs: [{ name: 'my-pvc', namespace: 'ns' }] })

test('validateEntry: 合法条目零 issue;pvc 名单命中不报', () => {
  expect(validateEntry({ ...entryBase }, ENTRY_CTX)).toEqual([])
})

test('validateEntry: 来源必填/target 悬空/items 半填(收编旧 4 规则)', () => {
  expect(codes(validateEntry({ ...entryBase, pvcName: '' }, ENTRY_CTX))).toContain('sourceRequired')
  expect(codes(validateEntry({ ...entryBase, target: 'sidecar:9' }, ENTRY_CTX))).toContain('targetInvalid')
  expect(codes(validateEntry({ ...entryBase, items: [{ key: 'k', path: '' }] }, ENTRY_CTX))).toContain('itemsIncomplete')
})

test('validateEntry: mountPath 根/反斜杠/归一 hint', () => {
  const r = codes(validateEntry({ ...entryBase, mountPath: '/' }, ENTRY_CTX))
  expect(r).toContain('mountPathRoot')
  expect(codes(validateEntry({ ...entryBase, mountPath: 'C:\\data' }, ENTRY_CTX))).toContain('mountPathBackslash')
  expect(codes(validateEntry({ ...entryBase, mountPath: '/data/' }, ENTRY_CTX))).toContain('mountPathNormalized')
})

test('validateEntry: 系统路径三档(/proc error、/etc/hosts error、/etc warn、/var/run/secrets error)', () => {
  expect(codes(validateEntry({ ...entryBase, mountPath: '/proc' }, ENTRY_CTX))).toContain('systemPathRuntime')
  expect(codes(validateEntry({ ...entryBase, mountPath: '/etc/hosts' }, ENTRY_CTX))).toContain('systemPathEtc')
  expect(codes(validateEntry({ ...entryBase, mountPath: '/etc' }, ENTRY_CTX))).toContain('systemPathShadow')
  expect(codes(validateEntry({ ...entryBase, mountPath: '/var/run/secrets/kubernetes.io' }, ENTRY_CTX))).toContain('systemPathSaToken')
})

test('validateEntry: items path 非法/重复/key 不存在/隐藏其余 key', () => {
  const cm = { ...entryBase, type: 'configMap', cmName: 'cm', pvcName: '', items: [{ key: 'k1', path: 'conf/app.yml' }] }
  const result = validateEntry(cm, ENTRY_CTX)
  expect(result.length).toBe(2) // hints: itemsHideRest, readOnlySuggested
  expect(codes(result)).toContain('itemsHideRest')
  expect(codes(result)).toContain('readOnlySuggested')
  // 多级相对 path 合法(无 path 错误)
  expect(codes(validateEntry({ ...cm, items: [{ key: 'k1', path: '/abs' }] }, ENTRY_CTX))).toContain('itemPathInvalid')
  expect(codes(validateEntry({ ...cm, items: [{ key: 'k1', path: '../x' }] }, ENTRY_CTX))).toContain('itemPathInvalid')
  expect(codes(validateEntry({ ...cm, items: [{ key: 'k1', path: 'a.yml' }, { key: 'k2', path: 'a.yml' }] }, ENTRY_CTX))).toContain('itemPathDuplicate')
  expect(codes(validateEntry({ ...cm, items: [{ key: 'nope', path: 'a.yml' }] }, ENTRY_CTX))).toContain('itemKeyMissing')
  const hidden = validateEntry({ ...cm, items: [{ key: 'k1', path: 'a.yml' }] }, ENTRY_CTX)
  expect(hidden.find(i => i.code === 'itemsHideRest').params).toEqual({ n: 1 })
})

test('validateEntry: 全空 items 行忽略(与生成端一致)', () => {
  const cm = { ...entryBase, type: 'configMap', cmName: 'cm', pvcName: '', items: [{ key: '', path: '' }] }
  expect(validateEntry(cm, ENTRY_CTX).filter(i => i.code.startsWith('item'))).toEqual([])
})

test('validateEntry: 来源在名单中不存在 → sourceNotFound;名单未加载不判', () => {
  expect(codes(validateEntry({ ...entryBase, pvcName: 'ghost' }, ENTRY_CTX))).toContain('sourceNotFound')
  expect(codes(validateEntry({ ...entryBase, pvcName: 'ghost' }, { validTargets: ['main'] }))).not.toContain('sourceNotFound')
})

test('validateEntry: subPath 绝对路径/.. → subPathInvalid;指向卷内不存在 → subPathNotInVolume;合法 → 单文件 hint', () => {
  const cm = { ...entryBase, type: 'configMap', cmName: 'cm', pvcName: '' }
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
  expect(codes(validateEntry({ ...entryBase, type: 'nfs', pvcName: '', server: '1.2.3.4', nfsPath: '' }, ENTRY_CTX))).toContain('nfsPathRoot')
  expect(codes(validateEntry({ ...entryBase, type: 'nfs', pvcName: '', server: '1.2.3.4', nfsPath: 'share' }, ENTRY_CTX))).toContain('nfsPathInvalid')
  expect(codes(validateEntry({ ...entryBase, type: 'hostPath', pvcName: '', hostPath: '/var/run/docker.sock' }, ENTRY_CTX))).toContain('hostPathSensitive')
  expect(codes(validateEntry({ ...entryBase, type: 'hostPath', pvcName: '', hostPath: '/data/app' }, ENTRY_CTX))).not.toContain('hostPathSensitive')
})

test('validateEntry: secret 未只读 hint;defaultMode 非法 error、宽松 hint、0400/0640 静默', () => {
  const sec = { ...entryBase, type: 'secret', pvcName: '', secretName: 's', readOnly: true }
  expect(codes(validateEntry(sec, ENTRY_CTX))).not.toContain('readOnlySuggested')
  expect(codes(validateEntry({ ...sec, readOnly: false }, ENTRY_CTX))).toContain('readOnlySuggested')
  expect(codes(validateEntry({ ...sec, defaultMode: '999' }, ENTRY_CTX))).toContain('defaultModeInvalid')
  expect(codes(validateEntry({ ...sec, defaultMode: '0644' }, ENTRY_CTX))).toContain('defaultModePermissive')
  expect(codes(validateEntry({ ...sec, defaultMode: '0400' }, ENTRY_CTX))).not.toContain('defaultModePermissive')
})

test('validateEntry: 级别标注正确(error/warn/hint)', () => {
  const iss = validateEntry({ ...entryBase, mountPath: '/proc' }, ENTRY_CTX)
  expect(iss.find(i => i.code === 'systemPathRuntime').level).toBe('error')
  expect(validateEntry({ ...entryBase, mountPath: '/etc' }, ENTRY_CTX).find(i => i.code === 'systemPathShadow').level).toBe('warn')
})

// —— validateVolumeMounts(spec §4 规则 13-16)——
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
  expect(fvme([{ ...base, mountPath: '/proc' }], ['main'])).toEqual({ key: 'deploy.volumeSystemPathRuntime', n: 1 }) // MOUNT_GATE_KEYS 为默认映射(Task 9 起并入 systemPathRuntime)
  const KEYS = { systemPathRuntime: 'deploy.volumeSystemPathRuntime' }
  expect(fvme([{ ...base, mountPath: '/proc' }], ['main'], KEYS)).toEqual({ key: 'deploy.volumeSystemPathRuntime', n: 1 })
  expect(fvme([{ ...base, mountPath: '/data/' }], ['main'])).toBe(null) // hint 不拦
})

// —— projectMountFiles ——
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

// —— Task 5: 生成侧单源 toMountSpec / toVolumeDef / toVolumeDefYaml ——
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

// —— Task 9: 门禁映射完备性 ——
test('门禁映射表:MOUNT_GATE_KEYS 覆盖全部 error 级 code(GATE_KEY ∪ 新键)', async () => {
  const { ERROR_CODES, MOUNT_GATE_KEYS } = await import('@/logic/volumeMountValidation')
  for (const c of ERROR_CODES) expect(MOUNT_GATE_KEYS[c], `missing gate key for ${c}`).toBeTruthy()
})
