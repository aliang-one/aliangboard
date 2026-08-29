// 工作台 AI 定制配置(单一来源,2026-08-25 设计):admin 经 /api/admin/workbench-ai-config 写入
// platform_settings 两键;提示词拼装(workbench-prompt)/工具过滤(agent-runner)/透明面板三处消费,
// 不存在"面板显示的和实际发的不一致"。垃圾值兜底照 getPresenceConfig 的 clamp 模式。
import { registry } from './tool-registry.mjs'

const MAX_INSTRUCTIONS = 4000

function readSetting(db, key) {
  try { return db.prepare('SELECT value FROM platform_settings WHERE key=?').get(key)?.value ?? null } catch { return null }
}

export function getWorkbenchAiConfig(db) {
  let disabled = []
  try {
    const parsed = JSON.parse(readSetting(db, 'workbench.disabledTools') || '[]')
    if (Array.isArray(parsed)) disabled = parsed.filter(x => typeof x === 'string')
  } catch { disabled = [] } // 垃圾 JSON → 空
  const known = new Set(registry.workbenchTools().map(t => t.name))
  const disabledTools = [...new Set(disabled)].filter(n => known.has(n)) // 未成名静默忽略(与 toolDefsFor 同语义)
  // 项目记忆开关(T2,2026-08-29):仅字面 'false' 关闭,缺键/垃圾值兜底 true
  const projectMemory = readSetting(db, 'workbench.projectMemory') !== 'false'
  return { additionalInstructions: String(readSetting(db, 'workbench.additionalInstructions') || '').slice(0, MAX_INSTRUCTIONS), disabledTools, projectMemory }
}

// PUT 校验:必须数组且每项为已成名。失败给 detail(route 层转 i18n 400),不给整段 message。
export function validateDisabledTools(input) {
  if (input == null) return { ok: true, value: [] }
  if (!Array.isArray(input)) return { ok: false, detail: { type: 'notArray' } }
  const known = new Set(registry.workbenchTools().map(t => t.name))
  for (const n of input) {
    if (typeof n !== 'string' || !known.has(n)) return { ok: false, detail: { type: 'unknown', name: String(n).slice(0, 60) } }
  }
  return { ok: true, value: [...new Set(input)] }
}

export function clampInstructions(input) {
  return String(input ?? '').slice(0, MAX_INSTRUCTIONS)
}
