// Deploy 向导 init/sidecar 容器字段校验单源:弹窗实时校验与提交 validate() 共用。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compareQuantity, quantityValue, validateContainerFields } from './containerValidation.js'
import { makeSubContainer } from './subContainer.js'

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

test('ports: 残行跳过;containerPort 非数字/越界/协议非法各报对应错', () => {
  const base = () => ({ ...C(), ports: [] })
  assert.deepEqual(validateContainerFields({ ...base(), ports: [{ containerPort: '', protocol: 'TCP' }] }).filter(e => e.field === 'ports'), [])
  const miss = validateContainerFields({ ...base(), ports: [{ containerPort: 'x', protocol: 'TCP' }] })
  assert.equal(miss[0].msgKey, 'deploy.containerFv.portRequired')
  const range = validateContainerFields({ ...base(), ports: [{ containerPort: 70000, protocol: 'TCP' }] })
  assert.equal(range[0].msgKey, 'deploy.containerFv.portRange')
  const proto = validateContainerFields({ ...base(), ports: [{ containerPort: 80, protocol: 'XXX' }] })
  assert.equal(proto[0].msgKey, 'deploy.containerFv.protocolInvalid')
})

test('env: 残行跳过;缺 key 报 envMissingKey;三机制重名报 envNameDuplicate', () => {
  const base = () => ({ ...C(), envVars: [], envCMKeys: [], envSecretKeys: [] })
  assert.deepEqual(validateContainerFields({ ...base(), envVars: [{ key: '', value: '' }] }).filter(e => e.field === 'env'), [])
  const miss = validateContainerFields({ ...base(), envVars: [{ key: '', value: 'v' }, { key: 'A', value: '' }] })
  assert.equal(miss[0].msgKey, 'deploy.containerFv.envMissingKey')
  const dup = validateContainerFields({ ...base(), envVars: [{ key: 'A', value: '1' }], envCMKeys: [{ name: 'A', cmName: 'c', key: 'k' }] })
  assert.equal(dup[0].msgKey, 'deploy.containerFv.envNameDuplicate')
  assert.deepEqual(dup[0].params, { name: 'A' })
})

test('探针: disabled 不报;http/tcp 缺 port 报 probePortRequired;exec 缺命令报 probeCommandRequired', () => {
  const base = () => makeSubContainer()
  const ok = validateContainerFields({ ...base(), image: 'nginx' })
  assert.deepEqual(ok.filter(e => ['liveness', 'readiness', 'startup'].includes(e.field)), [])
  const c1 = { ...base(), image: 'nginx', liveness: { ...base().liveness, enabled: true, type: 'http', port: '' } }
  const e1 = validateContainerFields(c1).find(e => e.field === 'liveness')
  assert.equal(e1.msgKey, 'deploy.containerFv.probePortRequired')
  assert.deepEqual(e1.params, { probe: 'liveness' })
  const c2 = { ...base(), image: 'nginx', startup: { ...base().startup, enabled: true, type: 'exec', execCommand: '' } }
  assert.equal(validateContainerFields(c2).find(e => e.field === 'startup').msgKey, 'deploy.containerFv.probeCommandRequired')
})
