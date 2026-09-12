// server/credential-parse.mjs
// 凭据智能粘贴解析(2026-09-12 spec §9):任意文本 → 字段袋草稿。纯函数,llmClient 注入可 mock。
// 照 distill.mjs 模式:buildXxxPrompt → llmClient.chat({messages}) → 容错解析 → 硬钳。
// 产出绝不落库——落库只能走 POST /api/workbench/credentials(人工确认后)。
const SYS = `你是 aliangboard 的凭据解析器。任务:把用户粘贴的任意文本解析成一条凭据草稿。

输出契约(只输出 JSON,不要解释,不要 markdown 围栏以外的文字):
{"name":"简短名称(≤80,如 github-token/服务器名)","description":"一句话描述","tags":["至多8个短标签"],"fields":[{"key":"字段名(英文小写,≤64)","type":"text|password","value":"值"}]}

字段 type 判定指南(从严):
- password/secret/token/key/passphrase/私钥/密码/密钥/凭证 类含义,或你拿不准是否敏感 → "password"
- 明确无敏感性(host/port/路径/用户名/备注/URL 等) → "text"
- 忘掉原文里的一切格式(表格/冒号/k=v/自由文本),按语义归入 fields;原文里没有的信息不要发明。`

export function buildCredentialParsePrompt(rawText) {
  return [
    { role: 'system', content: SYS },
    { role: 'user', content: String(rawText ?? '') },
  ]
}

// 容错解析:```json 围栏剥离(兼容裸 JSON 与围栏外杂文)→ JSON.parse → 失败则截取首个 { 到末个 } 重试
export function parseCredentialJson(text) {
  let t = String(text ?? '').trim()
  const fence = /^```(?:json|js)?\s*\n?([\s\S]*?)\n?```$/.exec(t)
  if (fence) t = fence[1].trim()
  const tryParse = s => { try { const v = JSON.parse(s); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null } catch { return null } }
  let v = tryParse(t)
  if (v) return v
  const first = t.indexOf('{'), last = t.lastIndexOf('}')
  if (first >= 0 && last > first) v = tryParse(t.slice(first, last + 1))
  return v
}

function clampDraft(raw) {
  const str = (x, max) => String(x ?? '').trim().slice(0, max)
  const fields = [], seen = new Set()
  let dropped = 0
  for (const f of Array.isArray(raw.fields) ? raw.fields : []) {
    const key = str(f?.key, 64)
    const value = typeof f?.value === 'string' ? f.value : (f?.value == null ? '' : String(f.value))
    const type = f?.type === 'text' ? 'text' : 'password'   // 未识别从严归一 password
    // 掩码形态值(用户把详情页指纹粘回/LLM 回声)视为无效——对齐 §5.4 掩码回写拒收,计数丢弃
    if (!key || value.length > 16384 || value.startsWith('*** (') || seen.has(key.toLowerCase())) { dropped++; continue }
    seen.add(key.toLowerCase())
    fields.push({ key, type, value })
    if (fields.length >= 32) break
  }
  if (Array.isArray(raw.fields) && fields.length + dropped < raw.fields.length) dropped = raw.fields.length - fields.length
  return {
    draft: {
      name: str(raw.name, 80) || '未命名凭据',
      description: str(raw.description, 500),
      tags: (Array.isArray(raw.tags) ? raw.tags : []).map(tg => str(tg, 24)).filter(Boolean).slice(0, 8),
      fields,
    },
    dropped,
  }
}

export async function runCredentialParse({ llmClient, rawText }) {
  const reply = await llmClient.chat({ messages: buildCredentialParsePrompt(rawText) })
  const parsed = parseCredentialJson(reply?.content)
  if (!parsed) return { ok: false, error: 'parse-failed' }
  const { draft, dropped } = clampDraft(parsed)
  return { ok: true, draft, dropped }
}
