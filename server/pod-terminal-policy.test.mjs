// Pod 终端空闲回收策略解析(2026-09-05「终端与会话」配置页):设置 > env > 默认。
// 键 pod.terminal.idleReapMin(分钟,整数 0~10080,0=禁用);env IDLE_TTL_MS(毫秒)兜底。
// 镜像 ssh/reap-policy resolvePolicy 风格:非法落库值 warn 按缺省,绝不抛(sweep 里抛=清道夫死)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { POD_TERMINAL_POLICY_DEFAULT, resolvePodTerminalPolicy } from './pod-terminal-policy.mjs'

test('优先级:设置 > env > 默认(30min);env 毫秒→分钟向下取整', () => {
  assert.equal(POD_TERMINAL_POLICY_DEFAULT.idleReapMin, 30)
  assert.equal(resolvePodTerminalPolicy(() => null, {}).idleReapMin, 30)
  assert.equal(resolvePodTerminalPolicy(() => null, { IDLE_TTL_MS: '900000' }).idleReapMin, 15)   // 15min
  assert.equal(resolvePodTerminalPolicy(() => null, { IDLE_TTL_MS: '910000' }).idleReapMin, 15)   // floor
  // 设置压过 env
  assert.equal(
    resolvePodTerminalPolicy(k => (k === 'pod.terminal.idleReapMin' ? '45' : null), { IDLE_TTL_MS: '900000' }).idleReapMin,
    45)
})

test('0=禁用可经设置写入;env 0/负数不产生禁用语义(env 只兜底正数)', () => {
  assert.equal(resolvePodTerminalPolicy(k => (k === 'pod.terminal.idleReapMin' ? '0' : null), {}).idleReapMin, 0)
  assert.equal(resolvePodTerminalPolicy(() => null, { IDLE_TTL_MS: '0' }).idleReapMin, 30)
  assert.equal(resolvePodTerminalPolicy(() => null, { IDLE_TTL_MS: '-5' }).idleReapMin, 30)
  assert.equal(resolvePodTerminalPolicy(() => null, { IDLE_TTL_MS: 'NaN' }).idleReapMin, 30)
  // 亚分钟 env(如 30s)取整为 0 会误读成「禁用」→ 至少 1 分钟
  assert.equal(resolvePodTerminalPolicy(() => null, { IDLE_TTL_MS: '30000' }).idleReapMin, 1)
})

test('非法落库值 warn 后按缺省,绝不抛;非整数/负数/超界同论', () => {
  for (const bad of ['x', '', '-1', '1.5', '10081']) {
    assert.equal(resolvePodTerminalPolicy(k => (k === 'pod.terminal.idleReapMin' ? bad : null), {}).idleReapMin, 30, `bad=${bad}`)
  }
})

test('getFn 抛异常不炸解析(按缺省处理)', () => {
  assert.equal(resolvePodTerminalPolicy(() => { throw new Error('db gone') }, {}).idleReapMin, 30)
})
