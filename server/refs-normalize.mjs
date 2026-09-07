// refs 归一 + 换绑锚定辅助(2026-09-07 审计批次二 Task 6:refs-injection-02 + gap3-01)。
//
// ①refs-injection-02:references 数量/形状/字节此前零校验——巨数组慢耗网关+集群 API,且每轮
//   LLM 前 refreshSystem 全量重拉放大。归一门:create/messages/edit 三入口共用本模块
//   normalizeReferences(条数>20 / 元素非对象或 kind/namespace/name 非 string / 总字节>64KB
//   → 抛 refsError,路由层转 400 i18n message)。刻意 400 而非静默截断:静默丢引用会让
//   AI 上下文与用户所见漂移(用户以为自己 @ 了,AI 看不见)。
// ②gap3-01:项目换绑集群后存量 @refs 静默在新集群解析(同名串味/缺失误报已删/卡片恒显旧快照)。
//   裁决=显式作废优于静默清出(保留历史透明度):refs 落库盖 clusterId 戳;run/resume 装配
//   refreshSystem 前 splitStaleRefs 比对戳与当下 project.clusterId,不一致 → 停用(不重拉)
//   + 注入作废注记(buildStaleRefsNote);老行无戳视作当前集群(向后兼容)。
//   @server 引用(kind==='server')不盖戳:平台 SSH 清单域,clusterRef 是纯标签非硬关联
//   (spec §1),无戳 = 永不作废,不随项目换绑停用。
//
// 错误形状:normalizeReferences 返回 { ok, error } 而非 throw——路由层要拿 error.code 查
// wbc i18n 表(三入口都要 sendJson 400,throw 会被外层 catch 转成 500 语义)。

// ── ① 归一上限(与搜索 slice(0,50) 同量级的防御口径)──
export const REFS_MAX_ITEMS = 20
export const REFS_MAX_BYTES = 64 * 1024

// 三入口统一归一:输入校验 + 白名单字段裁剪。
// - undefined/null(键缺省)→ { ok: true, refs: null }:调用方语义「无 refs」,沿用既有
//   缺省行为(edit 锚沿用、create 落 null)——这不是畸形,是合法的可选载荷。
// - 非数组(字符串/对象等)→ refsInvalid:旧 edit 路径把非数组静默当缺省,等于把畸形当合法,
//   审计明说须拒。
// - 元素裁成 { kind, namespace, name }:多余字段(clusterId/resource 等)在 create/messages
//   入口本来就不该由客户端携带——戳由服务端盖,resource 由服务端 enrich,客户端塞什么都不算数。
export function normalizeReferences(references) {
  if (references === undefined || references === null) return { ok: true, refs: null }
  if (!Array.isArray(references)) return { ok: false, code: 'wbc.refsInvalid' }
  if (references.length > REFS_MAX_ITEMS) return { ok: false, code: 'wbc.refsTooMany' }
  const refs = []
  for (const r of references) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, code: 'wbc.refsInvalid' }
    if (typeof r.kind !== 'string' || typeof r.namespace !== 'string' || typeof r.name !== 'string') {
      return { ok: false, code: 'wbc.refsInvalid' }
    }
    refs.push({ kind: r.kind, namespace: r.namespace, name: r.name })
  }
  // 字节上限:防止正常条数但巨 name/namespace 的慢载荷;按归一后形状计量(客户端多余字段
  // 已剥,不为其买单)。JSON.stringify 对已白名单的 string 字段安全无异常。
  if (Buffer.byteLength(JSON.stringify(refs), 'utf8') > REFS_MAX_BYTES) {
    return { ok: false, code: 'wbc.refsTooLarge' }
  }
  return { ok: true, refs }
}

// ── ② 落库盖戳 ──
// stampRefs:refs 盖当前集群戳(clusterId=身份比对键,clusterName=ResourceCard 徽标展示值,
// 盖戳时刻一并落库——agent 层无 req/集群名可能已变,展示值必须定格在创建时)。
// - kind==='server' 原样返回(不参与锚定,见文件头注)。
// - preserve=true(edit 沿用锚 refs 路径):已有 string 戳的 ref 保留原戳——换绑后编辑旧消息,
//   锚 refs 的语义是「当时引用的就是旧集群资源」,静默改锚成新集群戳会伪造「这是新集群的引用」;
//   无戳(存量老行)补当前戳。resource 载荷原样保留(ResourceCard 数据不丢)。
// - preserve=false(create/messages 新提及):一律盖当前戳——重 @ 同名 ref 即重锚定当前集群,
//   这是「请让用户重新 @」注记指引的正路,不重锚定则换绑后旧 ref 永久停用无法自救。
export function stampRefs(refs, clusterId, clusterName = '', { preserve = false } = {}) {
  if (!Array.isArray(refs)) return refs
  return refs.map(r => {
    if (!r || typeof r !== 'object' || r.kind === 'server') return r
    // 未绑定项目(clusterId='')不盖戳:ref 从未在任何集群锚定过(也无从拉取),换绑后按
    // 「无戳=当前集群」激活,优于伪造一个空串戳让后续绑定恒 mismatch。
    if (!clusterId) return r
    if (preserve && typeof r.clusterId === 'string') return r
    const out = { ...r, clusterId }
    // 展示名:盖新戳时附带;preserve 保留原戳时原 clusterName(若有)已随 r 原样保留。
    if (clusterName) out.clusterName = clusterName
    return out
  })
}

// ── ② 换绑比对(run/resume 每次装配前)──
// 返回 { active, stale }:stale = 有 string 戳且 ≠ 当前 clusterId;无戳(存量老行/server ref)
// 恒 active(向后兼容/平台域豁免)。纯字符串比对,零集群 API 调用(便宜;且 detached agent
// 也不该为上下文装配多打一跳)。
export function splitStaleRefs(refs, currentClusterId) {
  const active = []
  const stale = []
  for (const r of (Array.isArray(refs) ? refs : [])) {
    if (r && typeof r === 'object' && typeof r.clusterId === 'string' && r.clusterId !== currentClusterId) stale.push(r)
    else active.push(r)
  }
  return { active, stale }
}

// 作废注记(LLM 上下文注入段;inline 中文=服务端 LLM-context 既有惯例,见 REFS_GUARD_NOTE/
// 「(not found / 已删除)」——detached run 无 req,不走 wbc i18n 表)。
// 每行格式对齐 brief 语义:「(引用创建于集群 X,项目已换绑,已停用,请让用户重新 @)」;
// X 取 clusterName(缺失回退 id,老行补戳时无名)。调用方每 run 计算一次、闭包内复用同一
// 字符串(refreshSystem 每轮重建时追加同一常量段,不随轮数膨胀)。
export function buildStaleRefsNote(staleRefs) {
  if (!staleRefs.length) return ''
  const lines = staleRefs.map(r => {
    const label = `[${r.kind}/${r.namespace || ''}/${r.name}]`
    const from = r.clusterName || r.clusterId
    return `${label}: (引用创建于集群 ${from},项目已换绑,已停用,请让用户重新 @)`
  })
  return `\n\n已停用的过时引用(项目已换绑集群,以下引用不再注入,需重新 @ 以在新集群锚定):\n${lines.join('\n')}`
}
