// server/model-context.mjs
// 模型上下文窗口表 + token 估算 + 硬裁剪预算派生(spec 2026-08-28 §4.1,单一事实源)。
// 条目取家族保守下限:低估只影响展示偏小,高估才有真实溢出风险(由 provider 报错兜底)。
// 未命中默认 200k(spec D1)。substring 匹配,长前缀在前防短名误吞。
const DEFAULT_WINDOW_TOKENS = 200_000

// [子串, 窗口 tokens]——匹配用 String(model).toLowerCase().includes(子串)
const MODEL_WINDOWS = [
  ['gpt-4.1', 1_000_000],
  ['gpt-5', 1_000_000],
  ['gemini', 1_000_000],
  ['gpt-4o', 128_000],
  ['gpt-4-turbo', 128_000],
  ['gpt-4', 128_000],
  ['o1', 200_000],
  ['o3', 200_000],
  ['o4', 200_000],
  ['claude', 200_000],
  ['deepseek', 128_000],
  // qwen-long 例外(spec 明示不并入 qwen 家族):长上下文档位,真实 10M;须列在 'qwen' 前防 substring 吞
  ['qwen-long', 10_000_000],
  ['qwen', 128_000],
  ['glm', 128_000],
  ['moonshot', 128_000],
  ['kimi', 128_000],
  ['doubao', 128_000],
]

export function contextWindowFor(modelName) {
  const m = String(modelName || '').toLowerCase()
  if (!m) return DEFAULT_WINDOW_TOKENS
  for (const [frag, win] of MODEL_WINDOWS) {
    if (m.includes(frag)) return win
  }
  return DEFAULT_WINDOW_TOKENS
}

// 混合估算(中文≈1字/token、英文≈4字符/token 的折中);UI 标注「估算」
export function estTokens(chars) {
  return Math.ceil(Number(chars || 0) / 2)
}

// 硬裁剪预算(spec D4):窗口 70% 折算字符;60K 固定线退役
export function trimBudgetChars(windowTokens) {
  return Math.floor(Number(windowTokens || DEFAULT_WINDOW_TOKENS) * 0.7 * 2)
}
