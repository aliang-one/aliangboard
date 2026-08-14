// dev24 wb_top 的数量解析纯函数测试。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseCpu, parseMem, pctOf } from './k8s-quantity.mjs'

test('parseCpu: millicores / 整核 / 小数核 / 非法', () => {
  assert.equal(parseCpu('250m'), 0.25)
  assert.equal(parseCpu('2'), 2)
  assert.equal(parseCpu('1.5'), 1.5)
  assert.equal(parseCpu('0m'), 0)
  assert.equal(parseCpu(''), null)
  assert.equal(parseCpu(null), null)
  assert.equal(parseCpu('abc'), null)
  assert.equal(parseCpu('100M'), null) // 大写 M 非法(只有小写 m)
})

test('parseMem: 二进制后缀 / 裸字节 / 非法', () => {
  assert.equal(parseMem('1Ki'), 1024)
  assert.equal(parseMem('1Mi'), 1024 ** 2)
  assert.equal(parseMem('1.5Gi'), 1.5 * 1024 ** 3)
  assert.equal(parseMem('1Ti'), 1024 ** 4)
  assert.equal(parseMem('128974848'), 128974848)
  assert.equal(parseMem(''), null)
  assert.equal(parseMem('100M'), null) // 十进制后缀不认(K8s 资源 API 只产 Ki/Mi/Gi…)
})

test('pctOf: cpu/内存形态各自匹配;上限缺失或 0 → null', () => {
  assert.equal(pctOf('900m', '1'), 90)       // 0.9 核 / 1 核
  assert.equal(pctOf('250m', '500m'), 50)
  assert.equal(pctOf('2', '1'), 200)          // 超限也如实给
  assert.equal(pctOf('900Mi', '1Gi'), 87)     // 943718400/1073741824 ≈ 87.9 → 87
  assert.equal(pctOf('1Gi', null), null)
  assert.equal(pctOf('1Gi', '0'), null)
  assert.equal(pctOf(null, '1Gi'), null)
})
