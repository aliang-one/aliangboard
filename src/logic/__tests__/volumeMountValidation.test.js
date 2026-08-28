// 向导 step2 门禁纯函数:卷必须映射到容器(来源/mountPath/target 三查),堵静默丢弃洞。
import { test, expect } from 'vitest'
import { firstVolumeMountError, volumeItemsIncomplete, normalizeMountPath, buildMountCtx, validateEntry } from '@/logic/volumeMountValidation'

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
