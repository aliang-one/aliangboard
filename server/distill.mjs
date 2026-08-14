// 台账自我学习:distill job。从 workbench_history + audit_log 蒸馏持久知识 → 合并进 learnings.md。
// 核心原则:① 知识≠能力(不发明能力,只蒸馏用法知识,每条带证据)② 合并去重不堆叠(产合并后 learnings)。
// llmClient / db 注入,便于单测。ledger 文件经 workbench-repos 读。
import { readFile as wbReadFile } from './workbench-repos.mjs'

const DEFAULTS = { maxAudit: 100, maxHistory: 60, maxHistoryChars: 800, maxIndexChars: 8000 }

// 收集蒸馏原料(该集群近期 audit + 该集群项目的 history + 当前台账)。纯查询 + 读文件。
// 只取 finalized audit 行(reserve 的 started 行是重复证据,会翻倍 prompt 且让 seq 引用混乱);
// 带 source/owner 供归因(工作台 AI vs MCP key vs 直接调用)。
// watermark(maxAuditSeq/lastHistoryTs)给调度器做"无新料跳过"判定,不进 LLM prompt。
export async function gatherDistillMaterial(db, clusterId, ledgerRepo, opts = {}) {
  const { maxAudit, maxHistory, maxHistoryChars, maxIndexChars } = { ...DEFAULTS, ...opts }
  const audit = db.prepare(
    `SELECT seq,ts,status,tool,verb,resource,namespace,result,reason,requestSummary,source,owner FROM audit_log WHERE clusterId=? AND status='finalized' ORDER BY seq DESC LIMIT ?`
  ).all(clusterId, maxAudit).reverse() // 最旧在前(便于 LLM 阅读)
  const history = db.prepare(
    `SELECT h.role,h.content,h.ts,p.name AS projectName FROM workbench_history h
     JOIN workbench_projects p ON h.projectId = p.id WHERE p.clusterId = ? ORDER BY h.ts DESC LIMIT ?`
  ).all(clusterId, maxHistory).reverse()
  let currentLearnings = '', currentIndex = ''
  try { currentLearnings = await wbReadFile(ledgerRepo, 'learnings.md') } catch { /* 还没有 */ }
  try { currentIndex = await wbReadFile(ledgerRepo, 'INDEX.md') } catch { /* 还没有 */ }
  // 长内容截断(防 prompt 膨胀):对话单条截,INDEX 整体截;learnings 不截(去重合并要看全)。
  for (const h of history) { if ((h.content || '').length > maxHistoryChars) h.content = h.content.slice(0, maxHistoryChars) + '…(截断)' }
  if (currentIndex.length > maxIndexChars) currentIndex = currentIndex.slice(0, maxIndexChars) + '\n…(截断)'
  return {
    audit, history, currentLearnings, currentIndex,
    watermark: {
      maxAuditSeq: audit.length ? Number(audit[audit.length - 1].seq) || 0 : 0,
      lastHistoryTs: history.length ? Number(history[history.length - 1].ts) || 0 : 0,
    },
  }
}

// 无新料判定:水位(最大 audit seq + 最新 history ts)与上次蒸馏一致 → false。
// seq 全局单调、history 只追加,两个水位足以判定"自上次蒸馏后没有新证据"。
export function isNewMaterial(watermark, lastStats) {
  const last = lastStats?.watermark
  if (!last) return true // 从未蒸馏过
  return (watermark.maxAuditSeq || 0) !== (last.maxAuditSeq || 0) || (watermark.lastHistoryTs || 0) !== (last.lastHistoryTs || 0)
}

// 把原料格式成 LLM [system, user] 消息。
export function buildDistillPrompt(material, clusterName) {
  // 归因前缀:workbench:owner(工作台 AI 以哪个 admin 身份)/ mcp|agent|direct:owner(哪个 key 的调用者)。
  const who = a => a.source ? `${a.source}${a.owner ? ':' + a.owner : ''}` : (a.owner || '')
  const fmtAudit = (material.audit || []).map(a =>
    `[#${a.seq} ${who(a)} ${a.tool || a.verb || ''} ${a.resource || ''}${a.namespace ? ` ns=${a.namespace}` : ''}${a.result ? ` → ${a.result}` : ''}${a.reason ? ` (${a.reason})` : ''}${a.requestSummary ? ` ${a.requestSummary}` : ''}]`
  ).join('\n')
  const fmtHistory = (material.history || []).map(h =>
    `${h.projectName ? `[${h.projectName}] ` : ''}${h.role}: ${h.content}`
  ).join('\n')
  const system = `你是 aliangboard 的台账蒸馏器。任务:从近期操作审计 + 项目对话里,蒸馏出"持久、可复用"的用法知识(团队怎么用、踩过什么坑、什么模式有效),合并进集群台账 learnings.md。

铁律:
1. 只产"知识"(怎么用/踩坑/模式),绝不发明"能力"(集群能干啥——那以 INDEX.md 为准,只读引用)。
2. 每条结论末尾必须标证据:\`(证据: audit#seq 或 [项目]对话; 置信度: 高|中|低)\`。无证据的不写。
3. 合并去重:拿现有 learnings.md + 新原料,产出【合并后】的 learnings.md——语义重复的合并,不堆叠、不重复;过时/被推翻的可删。
4. 输出:纯 markdown,顶部 '# Learnings' 标题,每条一行 '- <结论> _(证据:...; 置信度:...)_'。只输出 learnings.md 内容,不要解释。`
  const user = `集群:${clusterName || '(未知)'}

# 当前 INDEX.md(能力事实,只读引用,勿改)
${material.currentIndex || '(台账未 bootstrap,无 INDEX.md)'}

# 当前 learnings.md(合并去重的对象)
${material.currentLearnings || '(空)'}

# 近期操作审计(audit,真实操作证据)
${fmtAudit || '(无)'}

# 近期项目对话
${fmtHistory || '(无)'}

请产出合并去重后的 learnings.md。`
  return [{ role: 'system', content: system }, { role: 'user', content: user }]
}

// 跑一次蒸馏。返回 { proposed(新 learnings.md), summary, stats, material }。llmClient 注入(可单测)。
// material 可预制传入(调度器先 gather 判水位,无新料则跳过、不重复查询);不传则内部 gather。
export async function runDistill({ llmClient, db, clusterId, ledgerRepo, clusterName, opts, material }) {
  material = material || await gatherDistillMaterial(db, clusterId, ledgerRepo, opts)
  const messages = buildDistillPrompt(material, clusterName)
  const msg = await llmClient.chat({ messages })
  const proposed = stripFences(String(msg.content || ''))
  const lines = proposed.split('\n').filter(l => l.trim().startsWith('- '))
  return {
    proposed,
    summary: `${lines.length} 条 learnings`,
    stats: {
      audit: material.audit.length, history: material.history.length,
      hadLearnings: !!(material.currentLearnings && material.currentLearnings.trim()), learnedLines: lines.length,
      watermark: material.watermark,
    },
    material,
  }
}

// 去 ```markdown 围栏(有些 LLM 会包),保证末尾换行。
function stripFences(text) {
  let t = String(text).trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```$/, '')
  return t.trimEnd() + '\n'
}
