// Deploy 向导 init/sidecar 容器字段校验单源:弹窗实时校验与提交 validate() 共用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareQuantity, quantityValue, validateContainerFields } from './containerValidation.js'

const C = () => ({ name: '', image: 'nginx', command: '', args: '', cpuRequest: '100m', cpuLimit: '250m', memoryRequest: '128Mi', memoryLimit: '256Mi' })

test('compareQuantity: cpu cores/m 归一毫核比较', () => {
  assert.equal(compareQuantity('0.5', '500m', 'cpu'), 0)
  assert.equal(compareQuantity('600m', '0.5', 'cpu'), 1)
  assert.equal(compareQuantity('100m', '0.5', 'cpu'), -1)
})

test('compareQuantity: 内存 Ki/Mi/Gi 归一 Ki 比较', () => {
  assert.equal(compareQuantity('1Gi', '1024Mi', 'memory'), 0)
  assert.equal(compareQuantity('2Gi', '1Gi', 'memory'), 1)
  assert.equal(compareQuantity('512Ki', '1Mi', 'memory'), -1)
})

test('compareQuantity: 空/脏串任一侧 → null(规则跳过)', () => {
  assert.equal(compareQuantity('', '100m', 'cpu'), null)
  assert.equal(compareQuantity('abc', '100m', 'cpu'), null)
})

test('quantityValue: 归一数值', () => {
  assert.equal(quantityValue('0.5', 'cpu'), 500)
  assert.equal(quantityValue('4000m', 'cpu'), 4000)
  assert.equal(quantityValue('1Gi', 'memory'), 1024 * 1024)
})

test('validateContainerFields: 合法容器 → []', () => {
  assert.deepEqual(validateContainerFields({ ...C(), name: 'my-init' }, ['app', 'other']), [])
})

test('validateContainerFields: image 空 → imageRequired', () => {
  const errs = validateContainerFields({ ...C(), image: '' })
  assert.equal(errs.length, 1)
  assert.equal(errs[0].field, 'image')
  assert.equal(errs[0].msgKey, 'deploy.containerFv.imageRequired')
})

test('validateContainerFields: name 非 DNS-1123 → namePattern;与 otherNames 撞 → nameDuplicate(各一条)', () => {
  const bad = validateContainerFields({ ...C(), name: 'Bad_Name' })
  assert.equal(bad[0].field, 'name')
  assert.equal(bad[0].msgKey, 'deploy.containerFv.namePattern')
  const dup = validateContainerFields({ ...C(), name: 'app' }, ['app'])
  assert.equal(dup[0].msgKey, 'deploy.containerFv.nameDuplicate')
  assert.deepEqual(dup[0].params, { name: 'app' })
})

test('validateContainerFields: req > lim → cpuOverLimit / memoryOverLimit(带 req/lim 参数)', () => {
  const errs = validateContainerFields({ ...C(), cpuRequest: '1', cpuLimit: '500m' })
  assert.equal(errs[0].field, 'cpu')
  assert.equal(errs[0].msgKey, 'deploy.containerFv.cpuOverLimit')
  assert.deepEqual(errs[0].params, { req: '1', lim: '500m' })
  const errs2 = validateContainerFields({ ...C(), memoryRequest: '1Gi', memoryLimit: '512Mi' })
  assert.equal(errs2[0].msgKey, 'deploy.containerFv.memoryOverLimit')
})

test('validateContainerFields: lim 为空(未填) → 不比较不报错', () => {
  assert.deepEqual(validateContainerFields({ ...C(), cpuLimit: '', memoryLimit: '' }), [])
})
