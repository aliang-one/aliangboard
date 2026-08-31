// @-ref 上下文拉取(2026-08-31 从 index.mjs 抽出:deps 注入便于单测,原 T5 内联实现逐字搬迁
// + 审计修复⑤)。POST /conversations 与 run/resumeConversation 的 refreshSystem 每轮共用。
//
// 修复⑤:拉取超时与 not found 分流——此前 catch 一律标「not found / 已删除」,慢集群(>5s)
// 会把「超时」误读成「资源已删」,LLM 可能据此给出错误诊断。withTimeout 输家的 Error 带
// isTimeout 标记供分流;404/网络错误仍标 not found(漂移感知语义不变)。
import { normalizeKind } from './kindAlias.mjs'
import { getApiPath } from './kind-paths.mjs'
import { maskSecretResource } from './secret-mask.mjs'
import { formatRefBlock, createRefContextBudget } from './ref-context.mjs'
import { REFS_CTX_HEADER } from './refs-context.mjs'
import { buildServerRefBlock } from './ssh/ref-block.mjs'

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
  async function fetchRefContext(references, k8sSession) {
    if (!Array.isArray(references) || !references.length) return ''
    const budget = createRefContextBudget()
    // 服务器清单与单个 ref 无关——提到 map 之外取一次,循环内复用
    const sshServerRows = references.some(r => r?.kind === 'server') ? listSshServers({ exposedOnly: true }) : []
    const tasks = references.map(async ref => {
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
    return `\n\n${REFS_CTX_HEADER}${blocks.join('\n\n')}`
  }
  return { fetchRefContext }
}
