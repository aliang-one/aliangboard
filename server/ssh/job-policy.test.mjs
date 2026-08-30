// server/ssh/job-policy.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { resolveJobPolicy } from './job-policy.mjs'

test('默认值;设置>env>默认;越界回落默认', () => {
  assert.deepEqual(resolveJobPolicy(() => null, {}), { ttlMin: 120, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(() => null, { SSH_JOB_TTL_MIN: '60' }), { ttlMin: 60, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.ttlMin' ? '30' : null), { SSH_JOB_TTL_MIN: '60' }),
    { ttlMin: 30, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.maxPerServer' ? '8' : null), {}),
    { ttlMin: 120, maxPerServer: 8 })
  // 越界/NaN 回落
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.ttlMin' ? '0' : null), {}), { ttlMin: 120, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.maxPerServer' ? 'x' : null), {}), { ttlMin: 120, maxPerServer: 4 })
})

// 终审 I3:小数会让远端 `find -mmin +1.5` 报错(被 2>/dev/null 吞)→ 该服务器每轮 sweep 静默
// no-op。设置/env 两路都必须整数化;手改库的非法值按缺省处理,绝不抛(sweep 里抛=清道夫死)。
test('小数回落默认(ttlMin/maxPerServer 两键),find -mmin 永不收到非整数', () => {
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.ttlMin' ? '1.5' : null), {}), { ttlMin: 120, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.ttlMin' ? '0.5' : null), {}), { ttlMin: 120, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.maxPerServer' ? '2.5' : null), {}), { ttlMin: 120, maxPerServer: 4 })
  assert.deepEqual(resolveJobPolicy(() => null, { SSH_JOB_TTL_MIN: '1.5', SSH_JOB_MAX_PER_SERVER: '3.5' }),
    { ttlMin: 120, maxPerServer: 4 })
  // 整数字符串仍正常
  assert.deepEqual(resolveJobPolicy(k => (k === 'ssh.job.ttlMin' ? '90' : null), { SSH_JOB_MAX_PER_SERVER: '6' }),
    { ttlMin: 90, maxPerServer: 6 })
})
