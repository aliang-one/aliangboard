// src/logic/podLogs.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLogLine, buildLogQuery, compileFilter, highlightSegments, isNearBottom, pushCapped, levelCounts } from './podLogs.js'

test('parseLogLine: 时间戳拆分 + 级别识别（ERROR/WARN/INFO 边界）', () => {
  assert.deepEqual(parseLogLine('2026-08-25T01:02:03.000000001Z error connecting to db'), {
    timestamp: '2026-08-25T01:02:03.000000001Z', level: 'ERROR', message: 'error connecting to db',
  })
  assert.equal(parseLogLine('2026-01-01T00:00:00Z WARNING disk almost full').level, 'WARN')
  assert.equal(parseLogLine('2026-01-01T00:00:00Z warn: retrying').level, 'WARN')
  assert.equal(parseLogLine('2026-01-01T00:00:00Z server started').level, 'INFO')
  // 无时间戳：整行当消息，timestamp 为空串
  assert.deepEqual(parseLogLine('bare message'), { timestamp: '', level: 'INFO', message: 'bare message' })
})

test('buildLogQuery: 默认参数与全量参数', () => {
  const d = buildLogQuery({})
  assert.equal(d.get('timestamps'), 'true')
  assert.equal(d.get('tailLines'), '500')
  assert.equal(d.get('container'), null)
  assert.equal(d.get('follow'), null)
  const full = buildLogQuery({ container: 'main', tailLines: 100, sinceSeconds: 300, previous: true, follow: true })
  assert.equal(full.get('container'), 'main')
  assert.equal(full.get('sinceSeconds'), '300')
  assert.equal(full.get('previous'), 'true')
  assert.equal(full.get('follow'), 'true')
  // sinceSeconds=0 / previous=false / follow=false 不出现
  const zero = buildLogQuery({ sinceSeconds: 0, previous: false, follow: false })
  assert.equal(zero.get('sinceSeconds'), null)
  assert.equal(zero.get('previous'), null)
})

test('compileFilter: 子串不区分大小写 + 级别过滤', () => {
  const f = compileFilter({ search: 'DB', levels: ['ERROR', 'WARN', 'INFO'] })
  assert.equal(f.error, '')
  assert.equal(f.test({ level: 'INFO', message: 'connected to db' }), true)
  assert.equal(f.test({ level: 'INFO', message: 'connected to cache' }), false)
  const errOnly = compileFilter({ levels: ['ERROR'] })
  assert.equal(errOnly.test({ level: 'WARN', message: 'db' }), false)
  assert.equal(errOnly.test({ level: 'ERROR', message: 'x' }), true)
})

test('compileFilter: 正则模式 + 非法正则不崩溃', () => {
  const f = compileFilter({ search: 'err\\d+', useRegex: true })
  assert.equal(f.test({ level: 'INFO', message: 'failed err42 retry' }), true)
  assert.equal(f.test({ level: 'INFO', message: 'failed errX' }), false)
  const bad = compileFilter({ search: '[invalid', useRegex: true })
  assert.notEqual(bad.error, '')            // 有错误提示
  assert.equal(bad.test({ level: 'INFO', message: 'anything' }), true)  // 不过滤
})

test('highlightSegments: 命中拆分 + 零宽匹配安全 + null regex', () => {
  assert.deepEqual(highlightSegments('abc', null), [{ text: 'abc', hit: false }])
  const segs = highlightSegments('a error b error c', /error/gi)
  assert.deepEqual(segs.map(s => ({ hit: s.hit, text: s.text })), [
    { hit: false, text: 'a ' }, { hit: true, text: 'error' }, { hit: false, text: ' b ' },
    { hit: true, text: 'error' }, { hit: false, text: ' c' },
  ])
  const zeroWidth = highlightSegments('abc', /x*/gi)   // 零宽模式不得死循环
  assert.ok(Array.isArray(zeroWidth))
})

test('isNearBottom: 40px 阈值边界', () => {
  const el = { scrollTop: 960, scrollHeight: 1000, clientHeight: 0 }         // 差 40 → true
  assert.equal(isNearBottom(el), true)
  assert.equal(isNearBottom({ scrollTop: 900, scrollHeight: 1000, clientHeight: 0 }), false)
  assert.equal(isNearBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 100 }), true)  // 无滚动
})

test('pushCapped: 截头保尾 + 单值/数组皆可', () => {
  const arr = []
  pushCapped(arr, [1, 2, 3], 5)
  pushCapped(arr, 4, 5)
  assert.deepEqual(arr, [1, 2, 3, 4])
  pushCapped(arr, [5, 6, 7], 5)
  assert.deepEqual(arr, [3, 4, 5, 6, 7])
})

test('levelCounts: 三级计数', () => {
  assert.deepEqual(levelCounts([
    { level: 'ERROR' }, { level: 'ERROR' }, { level: 'WARN' }, { level: 'INFO' }, {},
  ]), { ERROR: 2, WARN: 1, INFO: 1 })
})
