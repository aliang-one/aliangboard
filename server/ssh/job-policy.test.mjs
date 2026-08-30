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
