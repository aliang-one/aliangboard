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

// ── 上文窗口显式配置(admin LLM 配置「上文大小」字段,2026-10-23)──
// 上限 100M:合法输入钳制(防手滑 1e15 类;qwen-long 真实 10M 已留足余量)。
export const MAX_WINDOW_TOKENS = 100_000_000
// 下界 1000:亚千 token 窗口无现实意义,且 window=1 会使 trimBudgetChars=0——0 被 agent-runner
// 的 falsy 展开静默替换为缺省 60000,与余量表(contextInfo 按 0 下发)口径分裂(审查 2026-10-23)。
export const MIN_WINDOW_TOKENS = 1000

// 用户输入 → 归一化正整数 token;非法(空/单位不符/负零/小数余/超界)→ null(交路由 400,不抛错)。
// 十进制(LLM 惯例):K=1_000、M=1_000_000(claude 的 200K = 200,000;非 K8s 的 Ki 二进制)。
// 容忍大小写与首尾空白;"0.5M"=500_000 合法,"1.5"/"0.1234K" 非整数 token 非法。
export function parseWindowInput(raw) {
  const s = String(raw ?? '').trim().toLowerCase()
  const m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s)
  if (!m) return null
  const mult = m[2] === 'k' ? 1_000 : m[2] === 'm' ? 1_000_000 : 1
  const n = Number(m[1]) * mult
  const rounded = Math.round(n)
  if (Math.abs(n - rounded) > 1e-6) return null // 小数余位非零 → 非整数 token(容差防 0.1*1000 类浮点误伤)
  if (!Number.isSafeInteger(rounded) || rounded < MIN_WINDOW_TOKENS || rounded > MAX_WINDOW_TOKENS) return null
  return rounded
}

// 窗口解析单源(全部消费点经此):显式配置 >0 优先,否则回落模型名推导(含默认 200k)。
// override 容忍数字/数字字符串/''/null/undefined(settings 原样与测试桩两种形态)。
export function resolveWindowTokens(overrideTokens, modelName) {
  const n = Number(overrideTokens)
  return Number.isFinite(n) && n > 0 ? n : contextWindowFor(modelName)
}

// CJK 感知估算(context-assembly-05,2026-09-07 审计批次三):旧 chars/2 折中在纯中文上低估
// ~2 倍(中文≈1字/token 而非 2字/token)——willTrim 漏报、硬裁剪预算超发。模型:cjk≈1 token/字,
// 其余≈1 token/4字符(ASCII/JSON 主体)。两入口:estTokens(整段文本)/estTokensFromCounts
// (装配侧按块累计计数,refs 体积估算等纯计数成分按非 CJK 计)。UI 标注「估算」不变。
// 范围(escape 明示):CJK 标点+假名 \u3000-\u30FF / 扩展A \u3400-\u4DBF / 统一表意
// \u4E00-\u9FFF / 谚文音节 \uAC00-\uD7AF / 兼容表意 \uF900-\uFAFF——覆盖中/日/韩正文;
// 不含全角 ASCII \uFF00-\uFFEF(量小且与英文同密度级,按「其余」计不影响估算量级)。
const CJK_CHAR = /[\u3000-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/g
export function countCjkChars(text) {
  // 契约:text-only(旧 estTokens(chars:number) 签名已退役)。数字入参会经 String(n) 被当
  // 文本估成 n.length 个 token(如 0→1)——刻意不静默归零:数字入参=调用方形状错误,静默 0 会
  // 掩盖漏改的消费方(低报余量比形状断言更危险)。当前无数字消费方(grep 在案)。
  const s = String(text ?? '')
  const cjk = (s.match(CJK_CHAR) || []).length
  return { cjk, other: s.length - cjk }
}

export function estTokensFromCounts(cjkChars, otherChars) {
  return Math.ceil((Number(cjkChars) || 0) + (Number(otherChars) || 0) / 4)
}

export function estTokens(text) {
  const { cjk, other } = countCjkChars(text)
  return estTokensFromCounts(cjk, other)
}

// 硬裁剪预算(spec D4;context-assembly-05 校准):窗口 70% 折算字符,按最坏密度(CJK 1 token/字)
// 计——旧 ×2(2字/token 折中)对纯中文超发 2 倍,硬裁兜底失效才轮到 provider 报错。英文为主的
// 长上下文会偏保守(提前裁),硬裁只丢旧轮且摘要链路兜底,宁保守勿溢出。60K 固定线退役不变。
export function trimBudgetChars(windowTokens) {
  return Math.floor(Number(windowTokens || DEFAULT_WINDOW_TOKENS) * 0.7)
}
