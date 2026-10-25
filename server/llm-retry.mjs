// 共享 LLM 重试梯(2026-10-25 盲区批):从 agent.mjs createAgent 闭包原样抽出。
// 语义逐字不变——agent 主链经 createAgent 消费同一工厂(agent.test.mjs 契约测试零改动全绿
// 即等价性硬证据);本文件不 import 任何本仓模块(零环),六处辅助直呼点(三摘要/凭据解析/
// 蒸馏/模型探测)一律 import makeChatWithRetry 接梯,不再一次即败。
//
// R2(2026-10-13)chat 重试退避梯/预算缺省。依据:sub2api 共享账号限流时段实测分钟级
// (wb-chat-5xx-rootcause 三源实证),旧 [300,1500]×3 总窗 ~2-4s 必灭;6 次尝试名义总额
// 57s + 预算 120s 上限——足够穿过典型限流窗口,又不把单轮挂到无限久。导出供契约测试锁形
// (agent.mjs 同名再导出,契约测试从 agent.mjs import 的既有路径不断)。
export const DEFAULT_RETRY_DELAYS = [1000, 3000, 8000, 15000, 30000]
export const DEFAULT_RETRY_BUDGET_MS = 120000
// env LLM_RETRY_DELAYS_MS="1000,3000,..."(逗号分隔毫秒;非法项丢弃,全非法则用缺省)
function parseRetryDelaysEnv() {
  const raw = process.env.LLM_RETRY_DELAYS_MS
  if (!raw) return null
  const list = raw.split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n >= 0)
  return list.length ? list : null
}
// env LLM_RETRY_BUDGET_MS(正毫秒)。与 delays 同款显式校验而非 `||` 链(R2 审查#1):
// "0" 在 || 链里静默落缺省(运维以为调参死了),"-1" 是 truthy 反而把预算变 -1 →
// 首档即截断 = 静默关掉全部重试(反直觉反转)。非法值告警一次后落缺省。
function parseRetryBudgetEnv() {
  const raw = process.env.LLM_RETRY_BUDGET_MS
  if (!raw) return null
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return n
  console.warn(`[agent] LLM_RETRY_BUDGET_MS="${raw}" 无效(须为正毫秒数),已忽略,用缺省 ${DEFAULT_RETRY_BUDGET_MS}ms`)
  return null
}

// chat 容错(2026-09-06「对话尾巴不展示」排查;2026-09-09 审计 F1 按类别分流;2026-10-13
// R2 梯扩容):首 token 前(未吐任何 delta/reasoning)失败自动重试——sub2api/litellm 类代理
// 的瞬时 400/502 多发生在建连/首 token。已吐 delta 后失败不重试:流式重试从头再吐,前端已
// 拼接的内容会重复。chat 是纯生成调用(无副作用),重试安全。分流:
//   5xx/网络/429 → 退避梯(默认 6 次尝试,名义总额 57s;R2 依据 2026-10-13 实证:共享账号
//     池限流时段分钟级,旧 [300,1500]×3 总窗 ~2-4s 必灭。429 旧归「单次立即重试」的裁决
//     被现实推翻——429 已是主导故障形态,与 5xx 同梯;服务端 Retry-After(llm 层附挂
//     e.retryAfterMs)是等待下限,jitter 只作用梯值不得压低下限);
//   其余 4xx → 保持单次立即重试(便宜;sub2api/litellm 瞬时 400 在案,勿按状态码武断放弃);
//   取消/换绑(CancelledError/InvalidatedError)→ 绝不重试;超时类(Idle/StreamDeadline)
//     → 单次立即重试(多重退避会把单轮挂到数十分钟)。
// 预算上限:梯按「名义值」累计(max(梯值, Retry-After 下限)),超预算(默认 120s)即定性
// 失败——防长梯/大 Retry-After 把单轮挂死;jitter 的实际睡眠与记账解耦,超幅有界(≤0.5×梯值)。
// 梯中转为确定性 4xx/超时类 → 先给一次**不等待的免费重试**(与初始同类错误「单次立即重试」
// 对齐——F1:sub2api/litellm 瞬时 400 在案),再犯即定性抛出:这两类不会自愈,继续梯等待
// 只是拖时间。免费重试失败也定性(e3 原样上抛,不再续梯)。
// 等待可中断(R2 审查#2):梯睡眠是裸 setTimeout 时,120s 的 Retry-After 下限能睡过用户的
// 「停止」与密钥换绑(run 循环的 shouldAbort 检查点只在轮间/工具前)——按 ≤waitSliceMs
// 分片睡眠、片间查 shouldAbort,取消延迟从「整笔等待」降到 ≤1s。shouldAbort 缺省时零行为差异。
// retryDelays/retryBudgetMs/sleepFn/waitSliceMs 为测试缝(注入 [0,0] 与假 sleep 跳过真实等待);
// 生产缺省 DEFAULT_RETRY_DELAYS,env LLM_RETRY_DELAYS_MS("1000,3000,...")/
// LLM_RETRY_BUDGET_MS 可调(与 LLM_TIMEOUT_MS 同风格,免发版调参)。
export function makeChatWithRetry({ chat, retryDelays, retryBudgetMs, sleepFn, waitSliceMs = 1000, shouldAbort } = {}) {
  const RETRY_DELAYS = retryDelays || parseRetryDelaysEnv() || DEFAULT_RETRY_DELAYS
  const RETRY_BUDGET = Number.isFinite(retryBudgetMs) && retryBudgetMs >= 0
    ? retryBudgetMs
    : (parseRetryBudgetEnv() ?? DEFAULT_RETRY_BUDGET_MS)
  const errKind = (e) => {
    if (e?.name === 'CancelledError' || e?.name === 'InvalidatedError') return 'cancel'
    // AbortSignal.timeout(非流式 chat 总限)也产 TimeoutError——归超时类(单次),否则 3×120s
    if (e?.name === 'IdleTimeoutError' || e?.name === 'StreamDeadlineError' || e?.name === 'TimeoutError') return 'timeout'
    const s = Number(e?.status)
    if (s >= 500) return 'transient'
    if (s === 429) return 'rate'
    if (s >= 400) return 'client'
    return 'network'
  }
  const sleep = sleepFn || (ms => new Promise(r => setTimeout(r, ms)))
  // 分片可中断等待:每片前查 shouldAbort;末片后再查一次(覆盖「最后一小片睡完才取消」)。
  async function sleepInterruptible(ms) {
    let left = ms
    while (left > 0) {
      if (shouldAbort && await shouldAbort()) throw new Error('对话已取消,中止重试等待')
      const chunk = Math.min(waitSliceMs, left)
      await sleep(chunk)
      left -= chunk
    }
    if (shouldAbort && await shouldAbort()) throw new Error('对话已取消,中止重试等待')
  }
  return async function chatWithRetry(messages, tools, opts = {}) {
    let sawDelta = false
    const wrapped = {}
    if (opts?.onDelta) wrapped.onDelta = t => { sawDelta = true; opts.onDelta(t) }
    if (opts?.onReasoning) wrapped.onReasoning = t => { sawDelta = true; opts.onReasoning(t) }
    try {
      return await chat(messages, tools, wrapped)
    } catch (e) {
      if (sawDelta) throw e
      const kind = errKind(e)
      if (kind === 'cancel') throw e
      if (kind === 'transient' || kind === 'network' || kind === 'rate') {
        let last = e
        let spent = 0
        let freebieUsed = false
        for (const d of RETRY_DELAYS) {
          // Retry-After 是服务端下限;jitter 只扰梯值,实际等待 = max(jitter(梯), 下限)
          const floor = Number(last?.retryAfterMs) || 0
          const account = Math.max(d, floor)
          if (spent + account > RETRY_BUDGET) break
          spent += account
          await sleepInterruptible(Math.max(Math.round(d * (0.5 + Math.random())), floor))
          try { return await chat(messages, tools, wrapped) } catch (e2) {
            if (sawDelta) throw e2
            const k2 = errKind(e2)
            if (k2 === 'cancel') throw e2
            if (k2 === 'client' || k2 === 'timeout') {
              // 梯中确定性错误:一次不等待的免费重试(瞬时 400 在案),再犯即定性
              if (freebieUsed) throw e2
              freebieUsed = true
              try { return await chat(messages, tools, wrapped) } catch (e3) {
                if (sawDelta) throw e3
                if (errKind(e3) === 'cancel') throw e3
                throw e3
              }
            }
            last = e2
          }
        }
        throw last
      }
      return await chat(messages, tools, wrapped)
    }
  }
}
