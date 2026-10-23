// server/model-context.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { contextWindowFor, estTokens, estTokensFromCounts, countCjkChars, trimBudgetChars, parseWindowInput, resolveWindowTokens } from './model-context.mjs'

test('contextWindowFor:家族 substring 匹配(小写化)', () => {
  assert.equal(contextWindowFor('gpt-4o'), 128_000)
  assert.equal(contextWindowFor('gpt-4o-2024-11-20'), 128_000)
  assert.equal(contextWindowFor('gpt-4.1'), 1_000_000)
  assert.equal(contextWindowFor('gpt-5'), 1_000_000)
  assert.equal(contextWindowFor('o3-mini'), 200_000)
  assert.equal(contextWindowFor('claude-sonnet-4-6'), 200_000)
  assert.equal(contextWindowFor('deepseek-chat'), 128_000)
  assert.equal(contextWindowFor('deepseek-reasoner'), 128_000)
  assert.equal(contextWindowFor('qwen-max'), 128_000)
  assert.equal(contextWindowFor('qwen3-235b-a22b'), 128_000)
  assert.equal(contextWindowFor('qwen-long'), 10_000_000, 'qwen-long 例外:长上下文 10M,不被 qwen 家族吞')
  assert.equal(contextWindowFor('glm-4.5-air'), 128_000)
  assert.equal(contextWindowFor('moonshot-v1-8k'), 128_000)
  assert.equal(contextWindowFor('kimi-k2'), 128_000)
  assert.equal(contextWindowFor('gemini-2.0-flash'), 1_000_000)
  assert.equal(contextWindowFor('doubao-pro-32k'), 128_000)
  assert.equal(contextWindowFor('GPT-4O'), 128_000, '大小写不敏感')
})

test('contextWindowFor:未命中/空 → 默认 200k', () => {
  assert.equal(contextWindowFor('totally-unknown-model'), 200_000)
  assert.equal(contextWindowFor(''), 200_000)
  assert.equal(contextWindowFor(null), 200_000)
  assert.equal(contextWindowFor(undefined), 200_000)
})

// context-assembly-05(2026-09-07 审计批次三):CJK 感知估算。旧 chars/2 折中在纯中文上低估
// ~2 倍(中文≈1字/token 而非 2字/token)——willTrim 漏报、硬裁剪预算超发。模型:cjk≈1 token/字,
// 其余≈1 token/4字符。两入口:estTokens(文本)/estTokensFromCounts(装配侧按块累计计数)。
test('estTokens:CJK 感知——纯中文 1字/token、纯英文 4字符/token、混合加权', () => {
  assert.equal(estTokens(''), 0)
  assert.equal(estTokens('中'.repeat(100)), 100, '纯中文 ≈1 token/字(旧 chars/2 低估 2 倍)')
  assert.equal(estTokens('x'.repeat(100)), 25, '纯英文 ≈1 token/4字符')
  assert.equal(estTokens('中'.repeat(60) + 'x'.repeat(100)), 85, '混合加权(60 + ceil(100/4))')
  assert.equal(estTokens('abc'), 1, '非 CJK 向上取整')
})

test('estTokensFromCounts:计数入口(装配侧累计用;refs 估算等纯计数按非 CJK 计)', () => {
  assert.equal(estTokensFromCounts(0, 0), 0)
  assert.equal(estTokensFromCounts(100, 0), 100)
  assert.equal(estTokensFromCounts(0, 101), 26)   // ceil(101/4)
  assert.equal(estTokensFromCounts(60, 100), 85)
})

test('countCjkChars:CJK/非 CJK 字数分桶(CJK 统一表+假名+谚文+兼容区)', () => {
  assert.deepEqual(countCjkChars(''), { cjk: 0, other: 0 })
  assert.deepEqual(countCjkChars('hello world'), { cjk: 0, other: 11 })
  assert.deepEqual(countCjkChars('中文'), { cjk: 2, other: 0 })
  assert.deepEqual(countCjkChars('修复 nginx 503'), { cjk: 2, other: 10 })  // 12 字符,空格/ASCII 按非 CJK 计
})

// 三态预算判定:同窗口同字符量级下,纯中文不再被低估漏裁;英文/混合口径不再一刀切。
test('预算判定三态:中文超预算被识别(旧算法漏裁);英文/混合按加权口径', () => {
  const budgetTokens = Math.floor(128_000 * 0.7)  // 89_600(contextInfo 同款窗口 70%)
  // 纯中文 9 万字 = 9 万 token > 预算 → 裁(旧 chars/2 估 45k → 漏裁,真实已逼近窗口)
  assert.ok(estTokens('中'.repeat(90_000)) > budgetTokens, '纯中文超预算被识别')
  // 纯英文 32 万字符 = 8 万 token ≤ 预算 → 不裁
  assert.ok(estTokens('x'.repeat(320_000)) <= budgetTokens, '纯英文在预算内')
  // 混合 6 万中文 + 10 万英文 = 6 万 + 2.5 万 = 8.5 万 ≤ 预算 → 不裁(按加权而非一刀切)
  assert.ok(estTokens('中'.repeat(60_000) + 'x'.repeat(100_000)) <= budgetTokens, '混合按加权口径')
})

test('trimBudgetChars:按 CJK 最坏密度校准(1 token/字;旧 ×2 对纯中文超发 2 倍)', () => {
  assert.equal(trimBudgetChars(200_000), 140_000)   // 200k 窗口 → 140k token 预算 → 140k 字符(CJK 最坏)
  assert.equal(trimBudgetChars(128_000), 89_600)
  assert.equal(trimBudgetChars(1_000_000), 700_000)
})

// ── 上文窗口显式配置(admin LLM 配置「上文大小」字段,2026-10-23)──
// parseWindowInput:用户输入("1M"/"200K"/"131072")→ 归一化正整数 token;非法 → null(交路由 400,不抛错)。
// 十进制(LLM 惯例):K=1_000、M=1_000_000(claude 的 200K = 200,000,非 K8s 的 Ki 二进制)。
test('parseWindowInput:M/K 单位与裸数字(十进制 K=1000、M=1e6;大小写/首尾空白容忍)', () => {
  assert.equal(parseWindowInput('1M'), 1_000_000)
  assert.equal(parseWindowInput('1m'), 1_000_000, '小写单位同义')
  assert.equal(parseWindowInput('200K'), 200_000)
  assert.equal(parseWindowInput('200k'), 200_000)
  assert.equal(parseWindowInput('131072'), 131_072, '裸数字=token 原值')
  assert.equal(parseWindowInput(' 128K '), 128_000, '容忍首尾空白')
  assert.equal(parseWindowInput('0.5M'), 500_000, '小数×单位取整后为整数即合法')
  assert.equal(parseWindowInput('2M'), 2_000_000)
  assert.equal(parseWindowInput('1000'), 1000, '恰在下界')
})

test('parseWindowInput:非法输入一律 null', () => {
  assert.equal(parseWindowInput(''), null)
  assert.equal(parseWindowInput('   '), null)
  assert.equal(parseWindowInput(null), null)
  assert.equal(parseWindowInput(undefined), null)
  assert.equal(parseWindowInput('abc'), null)
  assert.equal(parseWindowInput('1T'), null, '只认 K/M')
  assert.equal(parseWindowInput('1e6'), null, '不解析科学计数法')
  assert.equal(parseWindowInput('-200K'), null, '负数')
  assert.equal(parseWindowInput('0'), null, '0 token 无意义')
  assert.equal(parseWindowInput('1.5'), null, '无单位小数=非整数 token')
  assert.equal(parseWindowInput('0.1234K'), null, '×单位后仍有小数余 → 非法')
})

test('parseWindowInput:范围钳制 1000..100M(下界防 budgetChars=0 被 runner falsy 回落、与余量表口径分裂;100M 留足 qwen-long 10M 余量)', () => {
  assert.equal(parseWindowInput('100M'), 100_000_000, '上界恰好在界内')
  assert.equal(parseWindowInput('101M'), null, '超上界')
  assert.equal(parseWindowInput('100000001'), null, '裸数字同受上界钳制')
  assert.equal(parseWindowInput('1'), null, '下界外:trimBudgetChars(1)=0 会被 agent-runner falsy 展开静默替换 60000')
  assert.equal(parseWindowInput('999'), null, '下界外')
})

test('resolveWindowTokens:显式配置优先;空/非法回落 contextWindowFor(模型名推导)', () => {
  assert.equal(resolveWindowTokens(1_000_000, 'qwen-max'), 1_000_000, '显式配置压过模型推导(128k)')
  assert.equal(resolveWindowTokens(1_000_000, ''), 1_000_000, '无模型名也用显式值')
  assert.equal(resolveWindowTokens('1000000', 'qwen-max'), 1_000_000, '数字字符串容忍(settings 原样形态)')
  assert.equal(resolveWindowTokens(null, 'qwen-max'), 128_000, '空 → 回落模型推导')
  assert.equal(resolveWindowTokens(undefined, 'qwen-max'), 128_000)
  assert.equal(resolveWindowTokens('', 'qwen-max'), 128_000, '空串(清除态)回落')
  assert.equal(resolveWindowTokens(0, 'qwen-max'), 128_000, '0 视为未配置')
  assert.equal(resolveWindowTokens(null, 'totally-unknown'), 200_000, '回落链尾:未命中模型 → 默认 200k')
})
