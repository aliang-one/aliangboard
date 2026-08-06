// 台账自我学习:distill job。从 workbench_history + audit_log 蒸馏持久知识 → 合并进 learnings.md。
// 核心原则:① 知识≠能力(不发明能力,只蒸馏用法知识,每条带证据)② 合并去重不堆叠(产合并后 learnings)。
// llmClient / db 注入,便于单测。ledger 文件经 workbench-repos 读。
import { readFile as wbReadFile } from './workbench-repos.mjs'

const DEFAULTS = { maxAudit: 100, maxHistory: 60 }

// 收集蒸馏原料(该集群近期 audit + 该集群项目的 history + 当前台账)。纯查询 + 读文件。
export async function gatherDistillMaterial(db, clusterId, ledgerRepo, opts = {}) {
  const { maxAudit, maxHistory } = { ...DEFAULTS, ...opts }
  const audit = db.prepare(
    `SELECT seq,ts,status,tool,verb,resource,namespace,result,reason,requestSummary FROM audit_log WHERE clusterId=? ORDER BY seq DESC LIMIT ?`
  ).all(clusterId, maxAudit).reverse() // 最旧在前(便于 LLM 阅读)
  const history = db.prepare(
    `SELECT h.role,h.content,h.ts,p.name AS projectName FROM workbench_history h
     JOIN workbench_projects p ON h.projectId = p.id WHERE p.clusterId = ? ORDER BY h.ts DESC LIMIT ?`
  ).all(clusterId, maxHistory).reverse()
  let currentLearnings = '', currentIndex = ''
  try { currentLearnings = await wbReadFile(ledgerRepo, 'learnings.md') } catch { /* 还没有 */ }
  try { currentIndex = await wbReadFile(ledgerRepo, 'INDEX.md') } catch { /* 还没有 */ }
  return { audit, history, currentLearnings, currentIndex }
}

// 把原料格式成 LLM [system, user] 消息。
export function buildDistillPrompt(material, clusterName) {
  const fmtAudit = (material.audit || []).map(a =>
    `[#${a.seq} ${a.status || ''} ${a.tool || a.verb || ''} ${a.resource || ''}${a.namespace ? ` ns=${a.namespace}` : ''}${a.result ? ` → ${a.result}` : ''}${a.reason ? ` (${a.reason})` : ''}${a.requestSummary ? ` ${a.requestSummary}` : ''}]`
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
export async function runDistill({ llmClient, db, clusterId, ledgerRepo, clusterName, opts }) {
  const material = await gatherDistillMaterial(db, clusterId, ledgerRepo, opts)
  const messages = buildDistillPrompt(material, clusterName)
  const msg = await llmClient.chat({ messages })
  const proposed = stripFences(String(msg.content || ''))
  const lines = proposed.split('\n').filter(l => l.trim().startsWith('- '))
  return {
    proposed,
    summary: `${lines.length} 条 learnings`,
    stats: { audit: material.audit.length, history: material.history.length, hadLearnings: !!(material.currentLearnings && material.currentLearnings.trim()), learnedLines: lines.length },
    material,
  }
}

// 去 ```markdown 围栏(有些 LLM 会包),保证末尾换行。
function stripFences(text) {
  let t = String(text).trim()
  if (t.startsWith('```')) t = t.replace(/^```(?:markdown|md)?\s*\n?/, '').replace(/\n?```$/, '')
  return t.trimEnd() + '\n'
}
