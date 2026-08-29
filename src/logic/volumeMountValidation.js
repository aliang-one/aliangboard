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

// items 键映射半填:key/path 须成对;全空行忽略(与 YAML 生成 it.key 过滤的「整行空=跳过」语义一致)
export function volumeItemsIncomplete(entry) {
  return (entry?.items || []).some(it => (it.key || it.path) && !(it.key && it.path))
}

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
  if (rawMp.includes('\\')) add('mountPathBackslash', 'mountPath', 'warn')
  if (!rawMp || !rawMp.startsWith('/')) {
    add('mountPathRequired', 'mountPath', 'error')
  } else {
    const norm = normalizeMountPath(rawMp)
    if (norm !== rawMp) add('mountPathNormalized', 'mountPath', 'hint')
    if (norm === '/') add('mountPathRoot', 'mountPath', 'error')
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
  if (isProjection) {
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
export function firstVolumeMountError(volumeMounts, validTargets, keyMap = MOUNT_GATE_KEYS) {
  const first = firstError(validateVolumeMounts(volumeMounts, { validTargets }))
  if (!first) return null
  return { key: keyMap[first.issue.code] || GATE_FALLBACK(first.issue.code), n: first.entryIdx + 1 }
}

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
  const items = (entry.items || []).filter(it => it.key && it.path).map(it => ({ key: it.key, path: it.path }))
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
