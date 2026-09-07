// @-ref 上下文拉取(2026-08-31 从 index.mjs 抽出:deps 注入便于单测,原 T5 内联实现逐字搬迁
// + 审计修复⑤)。POST /conversations 与 run/resumeConversation 的 refreshSystem 每轮共用。
//
// 修复⑤:拉取超时与 not found 分流——此前 catch 一律标「not found / 已删除」,慢集群(>5s)
// 会把「超时」误读成「资源已删」,LLM 可能据此给出错误诊断。withTimeout 输家的 Error 带
// isTimeout 标记供分流;404/网络错误仍标 not found(漂移感知语义不变)。
import { normalizeKind } from './kindAlias.mjs'
import { getApiPath, isClusterScopedKind } from './kind-paths.mjs'
import { maskSecretResource } from './secret-mask.mjs'
import { formatRefBlock, createRefContextBudget } from './ref-context.mjs'
import { REFS_CTX_HEADER, REFS_GUARD_NOTE } from './refs-context.mjs'
import { buildServerRefBlock } from './ssh/ref-block.mjs'
import { canAccessNs, wbToolGate } from './authz.mjs'

// W2 Phase C(Task 6):@mention 引用门单一事实源。fetchRefContext(system 每轮注入)与
// buildRefsContext(首屏 ResourceCard)两份实现逐 ref 调用;不过 → 静默跳过(零注入,不中断)。
//   - @server ref 恒放行(服务器暴露面维持 exposeToAi 闸,此处不再叠门);
//   - k8s ref → canAccessNs(view)(open 集群/admin 全通,allowlist 按授权);
//   - projectClusterId 空(未绑定项目)→ 放行(K8s ref 后续自然标注无集群,不放大也不收紧)。
//   - 集群级 kind(2026-09-07 审计 F5,refs-injection-05)→ wbToolGate.clusterWide(与 wb
//     工具面 Phase C 同门):本无 namespace,旧逻辑统一 canAccessNs → 伪造 ref.namespace
//     (填自己有授权的 ns)即可越过 clusterWide 拒绝越权读取集群级资源。拒绝形状是 throw,
//     此处转 false(静默跳过语义不变);非 PERMISSION_DENIED 异常照抛(fail-open 不可取)。
export function refAllowed(db, principal, ref, projectClusterId) {
  if (!ref || ref.kind === 'server') return true
  if (!projectClusterId) return true
  if (isClusterScopedKind(normalizeKind(ref.kind))) {
    try { wbToolGate(db, principal, projectClusterId).clusterWide('refs'); return true }
    catch (e) { if (e?.code !== 'PERMISSION_DENIED') throw e; return false }
  }
  return canAccessNs(db, principal, projectClusterId, ref.namespace || '', 'view')
}

// 竞速辅助:超时 rejects 带 isTimeout 标记。race 迟到 rejection 被内部 handler 吞掉
// (Promise.race 对两输入都挂 .then),无 unhandledRejection 风险(2026-08-31 实测探针)。
export function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => {
    const e = new Error(`${label} 超时 ${ms}ms`)
    e.isTimeout = true
    rej(e)
  }, ms))])
}

// deps:requestKubernetes(session, path)(index.mjs 单一 K8s 出站收口);
// listSshServers(opts)(db 已绑定的暴露清单读取);refTimeoutMs 单 ref 拉取超时(默认 5s)。
export function createRefContextFetcher({ requestKubernetes, listSshServers, refTimeoutMs = 5000 }) {
  // 并发 fetch 所有 references 的最新资源,拼成 refContext 块。单个 refTimeoutMs 超时;
  // 失败/404 → 标 not found(漂移感知)。CSO #14:每块过 formatRefBlock(围栏头+16KB 截断);
  // budget 每次调用新建 = 每轮对话单轮全部 ref 合计 ≤48KB,超预算的 ref 跳过。
  // gate(Phase C Task 6,可选):{ db, principal, clusterId }——给了则逐 ref 过 refAllowed,
  // 无权 ref 静默跳过(空注入);缺省零过滤(向后兼容旧调用形状)。
  async function fetchRefContext(references, k8sSession, gate = null) {
    if (!Array.isArray(references) || !references.length) return ''
    const budget = createRefContextBudget()
    // 服务器清单与单个 ref 无关——提到 map 之外取一次,循环内复用
    const sshServerRows = references.some(r => r?.kind === 'server') ? listSshServers({ exposedOnly: true }) : []
    const tasks = references.map(async ref => {
      if (gate && !refAllowed(gate.db, gate.principal, ref, gate.clusterId)) return ''
      const label = `[${ref.kind}/${ref.namespace || ''}/${ref.name}]`
      // @server 引用(spec §5):原始值比较(normalizeKind 不识别 server);不依赖 k8sSession——无集群项目可用
      if (ref.kind === 'server') {
        const rows = sshServerRows
        const block = buildServerRefBlock(label, rows, ref)
        if (!budget.take(block.length)) return `${label}: …(引用上下文预算已满,略)`
        return block
      }
      if (!k8sSession) return `${label}: (not found / 无集群)` // guard:K8s ref 无集群逐条标注,不整块吞掉
      // 防御性归一:ref.kind 正常恒为前端 canonical,但库里有旧数据/手改可能 → 与工具链同源归一
      const path = getApiPath(normalizeKind(ref.kind), ref.namespace || '', ref.name)
      if (!path) return `${label}: (不支持的 kind)`
      try {
        const res = await withTimeout(requestKubernetes(k8sSession, path), refTimeoutMs, `ref ${ref.kind}/${ref.name}`)
        const body = maskSecretResource(res?.body)
        const block = formatRefBlock(label, JSON.stringify(body, null, 2))
        if (!budget.take(block.length)) return `${label}: …(引用上下文预算已满,略)`
        return block
      } catch (e) {
        // 修复⑤:超时 ≠ 资源不存在——分流提示,LLM 可稍后重试或改用工具查询
        if (e?.isTimeout) return `${label}: (查询超时,状态未知;稍后重试或用工具查询)`
        return `${label}: (not found / 已删除)`
      }
    })
    const blocks = await Promise.all(tasks)
    // 审计#9:header 后紧随抗注入声明段(数据非指令)再接资源块;声明随 header 恰好注入一次
    return `\n\n${REFS_CTX_HEADER}${REFS_GUARD_NOTE}${blocks.join('\n\n')}`
  }
  return { fetchRefContext }
}
