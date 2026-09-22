// server/secret-mask.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { maskSecretResource, MASK_PATTERN, logSafeCommand, logSafeFacet } from './secret-mask.mjs'
import { createHash } from 'node:crypto'

const b64 = s => Buffer.from(s, 'utf8').toString('base64')
const secret = () => ({ kind: 'Secret', apiVersion: 'v1', metadata: { name: 'db-cred', namespace: 'ns1' },
  data: { username: b64('admin'), password: b64('s3cr3t-pass') }, stringData: { token: 'plain-token' } })

test('Secret:data/stringData 值掩码为指纹形态,字段名保留', () => {
  const s = secret()
  const out = maskSecretResource(s)
  assert.notEqual(out, s, '返回新对象')
  assert.deepEqual(Object.keys(out.data).sort(), ['password', 'username'], '字段名保留')
  assert.match(out.data.username, MASK_PATTERN)
  assert.match(out.data.password, MASK_PATTERN)
  assert.match(out.stringData.token, MASK_PATTERN)
  // N 与指纹内容:b64('admin') 解码后 5 chars;sha1(b'admin') 前 8 hex 可独立验证
  assert.ok(out.data.username.includes('(5 chars,'))
  assert.equal(out.data.username, `*** (5 chars, #${createHash('sha1').update('admin').digest('hex').slice(0, 8)})`)
  // stringData 未编码:原文 'plain-token' 11 chars,指纹=sha1 原文
  assert.ok(out.stringData.token.includes('(11 chars,'))
})

test('非 Secret 资源:原引用返回,零改动', () => {
  const pod = { kind: 'Pod', metadata: { name: 'p1' }, spec: { containers: [] } }
  assert.equal(maskSecretResource(pod), pod)
  const nil = maskSecretResource(null)
  assert.equal(nil, null)
})

test('幂等:掩码形状再掩原样返回', () => {
  const once = maskSecretResource(secret())
  const twice = maskSecretResource(once)
  assert.deepEqual(twice, once)
  assert.equal(twice.data.username, once.data.username)
})

test('不 mutate 入参', () => {
  const s = secret()
  const before = s.data.password
  maskSecretResource(s)
  assert.equal(s.data.password, before, '原对象未变')
})

test('防御:非字符串值归一;不可 base64 解码回退原文长度', () => {
  const out = maskSecretResource({ kind: 'Secret', data: { weird: 12345, bad: '!!!not-base64!!!' } })
  assert.match(String(out.data.weird), MASK_PATTERN)
  assert.ok(out.data.bad.includes('(16 chars,'), '原文长度回退')
})

test('MASK_PATTERN 形状自锁', () => {
  assert.ok(MASK_PATTERN.test('*** (24 chars, #a1b2c3d4)'))
  assert.ok(!MASK_PATTERN.test('*** (24 chars, a1b2c3d4)'))
  assert.ok(!MASK_PATTERN.test('YWJjZA=='))
})

// ═══ C1(2026-09-20 final review):execCapture 日志面只许见占位符版命令 ═══
// 红线 8:审计/审批卡/日志只见占位符版。execWithCredInjection 把 __credLog={command:占位符版,
// scrub} 随 lane 线下传;两个纯 helper 是 execCapture 两个 console.error 站点的唯一日志侧消费点。
test('logSafeCommand:有 credLog 用占位符版;无 credLog 原样(其余调用方零行为变化)', () => {
  const credLog = { command: 'echo {{cred:gh#token}}', scrub: () => 'x' }
  assert.equal(logSafeCommand(['sh', '-c', 'echo ghp_materialized_secret'], credLog), 'echo {{cred:gh#token}}',
    'cmd= 面恒占位符版(物化值不进日志)')
  assert.equal(logSafeCommand('ls -la', null), 'ls -la', '无 credLog(非注入路径)原样')
  assert.equal(logSafeCommand('ls -la', {}), 'ls -la', 'credLog 缺 command 键也原样(防御)')
})

test('logSafeFacet:有 scrub 先洗后用;无 credLog 原样;跨截断点的物化值不残留', () => {
  const SECRET = 'ghp_materialized_secret'
  const scrub = s => String(s).split(SECRET).join('*** (23 chars, #ab12cd34)')
  const credLog = { command: 'x', scrub }
  // hint 面:错误文案含物化值(如 exec 错误回显 URL)→ 洗净
  assert.ok(!logSafeFacet(`Unexpected 500 at /exec?cmd=echo+${SECRET}`, credLog).includes(SECRET))
  // head 面:调用方先 logSafeFacet(整段) 再 slice —— 跨 80 字符截断点的物化值不会以半截明文存活
  const head = logSafeFacet(`prefix ${SECRET} suffix-and-more-text-beyond-eighty-charsAAAAAAAAAAAAAAAAAAAAAA`, credLog).slice(0, 80)
  assert.ok(!head.includes(SECRET) && !head.includes('ghp_mat'), `切片后无物化值残段,实际:${head}`)
  assert.match(head, /\*\*\* \(23 chars/, '整值洗成指纹')
  // 无 credLog:原样(其余 execCapture 调用方日志行为不变)
  assert.equal(logSafeFacet(SECRET, null), SECRET)
  assert.equal(logSafeFacet(null, null), '')
})
