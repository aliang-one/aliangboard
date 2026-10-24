// 已知凭据值登记表(2026-10-24 凭据审计 P0-1:值级兜底洗涤)。
// 背景:落库结构化洗涤(persistableTrace/persistableMessages)单点依赖「工具结果 JSON 可解析」,
// 8192/32KB 截断钳制把 JSON 切成裸串后洗涤整体失明,🔓明文随截断残留落库(审计 HIGH)。
// 本表登记当轮运行中确已进入 LLM 上下文的凭据明文值,给持久化边界一个不依赖形状的第二道洗。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
// 非锚定指纹形态(maskValue 产物;FP_RE 本体带 ^$ 锚,只适用于整串断言)
const FP_RE = /\*\*\* \(\d+ chars, #[0-9a-f]{8}\)/
import { rememberCredentialValue, scrubKnownValues, resetCredentialValuesForTest, scrubToPlaceholderValues, currentKnownCredentialValues } from './credential-known-values.mjs'

test('remember + scrub:任意字符串里的确切值洗回 maskValue 指纹(不依赖 JSON 形状)', () => {
  resetCredentialValuesForTest()
  const v = 'ghp_truncated_json_secret'
  assert.equal(rememberCredentialValue(v), true)
  // 截断钳制的产物:半截 JSON 裸串,结构化洗涤对它无能为力
  const truncated = `{"credential":"gh","fields":[{"key":"token","value":"${v.slice(0, 12)}`
  assert.ok(truncated.includes(v.slice(0, 12)))
  const out = scrubKnownValues(`{"credential":"gh","fields":[{"key":"token","value":"${v}"}]}`)
  assert.match(out, FP_RE)
  assert.ok(!out.includes(v), '明文不得残留')
  // 完整值出现在裸串中 → 洗;裸串截断场景(值完整在窗口内)同理
  assert.match(scrubKnownValues(`prefix ${v} suffix`), FP_RE)
})

test('值完整占据被截断 JSON 的一部分时仍洗(截断点在值之后)', () => {
  resetCredentialValuesForTest()
  const v = 'ghp_multi_field_overrun_token_value'
  rememberCredentialValue(v)
  // 模拟 8192 clamp:JSON 在值之后被切
  const cut = JSON.stringify({ credential: 'gh', fields: [{ key: 'token', type: 'password', value: v, plaintext: true }], more: 'x'.repeat(9000) }).slice(0, 120)
  assert.ok(cut.includes(v), '前置条件:明文在截断窗口内')
  assert.match(scrubKnownValues(cut), FP_RE)
})

test('短值(<4 字符)不登记——精确替换会大面积误伤普通文本', () => {
  resetCredentialValuesForTest()
  assert.equal(rememberCredentialValue('abc'), false)
  assert.equal(rememberCredentialValue(''), false)
  assert.equal(rememberCredentialValue(null), false)
  assert.equal(rememberCredentialValue(12345), false)
  assert.equal(scrubKnownValues('abc in text'), 'abc in text', '未登记值不洗')
})

test('多值同串:长值优先洗,短值(长值子串)不得破坏长值匹配', () => {
  resetCredentialValuesForTest()
  const long = 'ghp_aaabbbcccdddeee'
  const short = 'ccc'   // long 的子串;但短于 4 不登记,换一个 ≥4 的包含关系
  const inner = 'bbcc'
  rememberCredentialValue(long)
  const registered = rememberCredentialValue(inner)
  // inner 是 long 子串且 ≥4:若先洗 inner,long 被切碎 → 长值洗不掉。期望长值先洗。
  if (registered) {
    const out = scrubKnownValues(`x ${long} y`)
    assert.ok(!out.includes(long), '长值须被洗掉')
    assert.match(out, FP_RE)
  }
})

test('重复登记幂等;登记表有界(超上限逐出最旧)', () => {
  resetCredentialValuesForTest()
  const v = 'ghp_dup_value_check'
  assert.equal(rememberCredentialValue(v), true)
  assert.equal(rememberCredentialValue(v), true, '重复登记返回 true,不重复占位')
  // 逐出:登记 520 个不同值(上限 512),最早的 v 应被逐出
  for (let i = 0; i < 520; i++) rememberCredentialValue(`evict-value-${i}-padding`)
  assert.equal(scrubKnownValues(`x ${v} y`), `x ${v} y`, '最旧值被逐出后不再洗')
})

test('scrubKnownValues 幂等:洗过的指纹再洗不变', () => {
  resetCredentialValuesForTest()
  const v = 'ghp_idempotent_check'
  rememberCredentialValue(v)
  const once = scrubKnownValues(`token=${v}`)
  const twice = scrubKnownValues(once)
  assert.equal(once, twice)
  assert.match(once, FP_RE)
})

test('空串/非字符串输入原样返回', () => {
  resetCredentialValuesForTest()
  rememberCredentialValue('ghp_some_value')
  assert.equal(scrubKnownValues(''), '')
  assert.equal(scrubKnownValues(null), '')
  assert.equal(scrubKnownValues(undefined), '')
})

// ref 溯源(P0 args 面):pendingApproval 的 args 落库不能指纹化——resume 要按原 args 重新
// 执行,指纹会把命令跑坏。正确形态=洗回 {{cred:名#字段}} 占位符:落库无明文(红线7),
// resume 时占位符经 substitute 重新物化(功能不破)。
test('带 ref 登记:scrubToPlaceholderValues 把值洗回占位符形态', () => {
  resetCredentialValuesForTest()
  rememberCredentialValue('ghp_placeholder_roundtrip', 'gh#token')
  const out = scrubToPlaceholderValues('echo ghp_placeholder_roundtrip | docker login')
  assert.equal(out, 'echo {{cred:gh#token}} | docker login')
  // 无 ref 的登记值不参与占位符洗(没有可物化的来源,洗回占位符会让 resume 拒执行)
  rememberCredentialValue('ghp_no_ref_value_here')
  const out2 = scrubToPlaceholderValues('x ghp_no_ref_value_here y')
  assert.ok(out2.includes('ghp_no_ref_value_here'), '无 ref 值保持原样(交由指纹洗兜底)')
})

test('currentKnownCredentialValues 带 ref 字段(登记点溯源断言用)', () => {
  resetCredentialValuesForTest()
  rememberCredentialValue('ghp_with_ref_check', 'src#field')
  const e = currentKnownCredentialValues().find(p => p.value === 'ghp_with_ref_check')
  assert.equal(e.ref, 'src#field')
  resetCredentialValuesForTest()
  rememberCredentialValue('ghp_without_ref_check')
  const e2 = currentKnownCredentialValues().find(p => p.value === 'ghp_without_ref_check')
  assert.equal(e2.ref, undefined)
})
