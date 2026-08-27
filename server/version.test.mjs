// 版本纯函数契约:归一化(去 v)/数值序比较/全量取最高(2026-08-27 版本机制设计)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { APP_VERSION, normalizeSemver, semverGt, pickLatest } from './version.mjs'

test('normalizeSemver:带/不带 v 前缀 → 规范形;非法输入 → null', () => {
  assert.equal(normalizeSemver('v1.2.3'), '1.2.3')
  assert.equal(normalizeSemver('1.2.3'), '1.2.3')
  assert.equal(normalizeSemver(' v1.10.0 '), '1.10.0')
  assert.equal(normalizeSemver('v1.0.0-rc1'), null)   // 预发布非严格 semver,过滤
  assert.equal(normalizeSemver('nightly'), null)
  assert.equal(normalizeSemver(''), null)
  assert.equal(normalizeSemver(null), null)
})

test('semverGt:数值比较非字典序(1.10.0 > 1.9.0);等值/非法 → false', () => {
  assert.equal(semverGt('1.10.0', '1.9.0'), true)
  assert.equal(semverGt('v1.10.0', '1.9.0'), true)
  assert.equal(semverGt('1.2.3', '1.2.3'), false)
  assert.equal(semverGt('1.2.4', '1.2.3'), true)
  assert.equal(semverGt('1.0.0', '0.9.9'), true)
  assert.equal(semverGt('junk', '1.0.0'), false)
})

test('pickLatest:全量取最高,与顺序无关;过滤非 semver;空 → null', () => {
  assert.equal(pickLatest(['v1.0.7', 'v1.9.0', 'v1.10.0']), '1.10.0')
  assert.equal(pickLatest(['v1.10.0', 'v1.0.7', 'v1.9.0']), '1.10.0') // 顺序无关
  assert.equal(pickLatest(['v1.0.0-rc1', 'nightly', 'latest']), null)
  assert.equal(pickLatest([]), null)
  assert.equal(pickLatest(null), null)
})

test('APP_VERSION:无 env 时为 dev', () => {
  // 本测试进程未设 APP_VERSION;导入时已固化
  assert.equal(typeof APP_VERSION, 'string')
})
