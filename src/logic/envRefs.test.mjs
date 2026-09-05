// 环境变量域单源:统一行模型 <-> K8s env/envFrom 的往返与校验。
// spec: docs/superpowers/specs/2026-09-05-container-env-editor-design.md
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ENV_ROW_TYPES, makeEnvRow, makeEnvFromRow,
  envRowsToSpec, envRowsFromSpec, envFromRowsToSpec, envFromRowsFromSpec,
  envRefErrors, duplicateEnvNames, envRowCount, envSectionEmpty, rowNonEmpty,
  ENV_TYPE_LABEL_KEYS, ENV_FIELD_LABEL_KEYS,
} from './envRefs.js'
import { readFileSync } from 'node:fs'

test('i18n 标签键表:每个键在 zh/en locale 均存在(门禁 dangling 防线)', () => {
  const flat = (o, p = '') => Object.entries(o).flatMap(([k, v]) => typeof v === 'object' ? flat(v, p + k + '.') : [p + k])
  const zh = new Set(flat(JSON.parse(readFileSync(new URL('../locales/zh.json', import.meta.url), 'utf8'))))
  const en = new Set(flat(JSON.parse(readFileSync(new URL('../locales/en.json', import.meta.url), 'utf8'))))
  for (const key of [...Object.values(ENV_TYPE_LABEL_KEYS), ...Object.values(ENV_FIELD_LABEL_KEYS)]) {
    assert.ok(zh.has(key), `zh 缺 ${key}`)
    assert.ok(en.has(key), `en 缺 ${key}`)
  }
})

test('makeEnvRow: 五类型字段形状', () => {
  assert.deepEqual(makeEnvRow('value'), { name: '', type: 'value', value: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('configMapKeyRef'), { name: '', type: 'configMapKeyRef', cmName: '', key: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('secretKeyRef'), { name: '', type: 'secretKeyRef', secretName: '', key: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('fieldRef'), { name: '', type: 'fieldRef', fieldPath: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('resourceFieldRef'), { name: '', type: 'resourceFieldRef', resource: '', containerName: '', divisor: '', passthrough: undefined })
  assert.deepEqual(makeEnvRow('nonsense'), makeEnvRow('value'))
})

test('envRowsToSpec: 五类型 → K8s env,保序,无名/不完整行跳过', () => {
  const rows = [
    { name: 'A', type: 'value', value: 'plain' },
    { name: '', type: 'value', value: 'no-name' },          // 无名跳过
    { name: 'B', type: 'configMapKeyRef', cmName: 'cm1', key: 'k1' },
    { name: 'C', type: 'configMapKeyRef', cmName: '', key: 'k2' }, // 不完整跳过
    { name: 'D', type: 'secretKeyRef', secretName: 's1', key: 'sk' },
    { name: 'E', type: 'fieldRef', fieldPath: 'metadata.name' },
    { name: 'F', type: 'resourceFieldRef', resource: 'requests.cpu' },
    { name: 'G', type: 'resourceFieldRef', resource: 'limits.memory', containerName: 'main', divisor: '1m' },
  ]
  assert.deepEqual(envRowsToSpec(rows), [
    { name: 'A', value: 'plain' },
    { name: 'B', valueFrom: { configMapKeyRef: { name: 'cm1', key: 'k1' } } },
    { name: 'D', valueFrom: { secretKeyRef: { name: 's1', key: 'sk' } } },
    { name: 'E', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
    { name: 'F', valueFrom: { resourceFieldRef: { resource: 'requests.cpu' } } },
    { name: 'G', valueFrom: { resourceFieldRef: { resource: 'limits.memory', containerName: 'main', divisor: '1m' } } },
  ])
})

test('envRowsToSpec: 直填空串显式产出(value: "")', () => {
  assert.deepEqual(envRowsToSpec([{ name: 'EMPTY', type: 'value', value: '' }]), [{ name: 'EMPTY', value: '' }])
})

test('往返无损:全类型 spec → rows → spec 恒等(含顺序)', () => {
  const env = [
    { name: 'A', value: 'x' },
    { name: 'B', valueFrom: { configMapKeyRef: { name: 'cm', key: 'k' } } },
    { name: 'C', valueFrom: { secretKeyRef: { name: 's', key: 'k', optional: true } } },
    { name: 'D', valueFrom: { fieldRef: { fieldPath: 'status.podIP', apiVersion: 'v1' } } },
    { name: 'E', valueFrom: { resourceFieldRef: { resource: 'requests.cpu', divisor: '1m' } } },
  ]
  assert.deepEqual(envRowsToSpec(envRowsFromSpec(env)), env)
})

test('往返无损:未知 valueFrom 形态整体透传', () => {
  const env = [{ name: 'X', valueFrom: { futureRef: { thing: 1 } } }]
  assert.deepEqual(envRowsToSpec(envRowsFromSpec(env)), env)
  const rows = envRowsFromSpec(env)
  assert.equal(rows[0].type, 'value')
  assert.deepEqual(rows[0].passthrough, { valueFrom: { futureRef: { thing: 1 } } })
})

test('envFrom: 多行保序往返 + prefix 条目级剩余键保留 + 未知形态透传', () => {
  const arr = [
    { prefix: 'MY_', configMapRef: { name: 'cm1' } },
    { secretRef: { name: 's1' } },
    { configMapRef: { name: 'cm2' } },
  ]
  const rows = envFromRowsFromSpec(arr)
  assert.deepEqual(rows[0], { kind: 'configmap', name: 'cm1', passthrough: { prefix: 'MY_' } })
  assert.equal(rows[1].kind, 'secret')
  assert.deepEqual(envFromRowsToSpec(rows), arr)
  const weird = [{ unknownRef: { x: 1 } }]
  assert.deepEqual(envFromRowsToSpec(envFromRowsFromSpec(weird)), weird)
})

test('envFrom: 空名行跳过、kind 归一', () => {
  assert.deepEqual(envFromRowsToSpec([
    { kind: 'configmap', name: '' },
    { kind: 'secret', name: ' s2 ' },
    { kind: 'weird', name: 'w1' }, // 未知 kind 按 configMapRef 兜底
  ]), [{ secretRef: { name: 's2' } }, { configMapRef: { name: 'w1' } }])
})

test('envRefErrors: 空行跳过、半行报 missing(name 缺失排首位)', () => {
  const errs = envRefErrors([
    { name: '', type: 'value', value: '' },                                    // 空行
    { name: 'OK', type: 'value', value: '' },                                  // 直填允许空值
    { name: 'H1', type: 'value', value: 'v' },
    { name: '', type: 'configMapKeyRef', cmName: 'cm', key: 'k' },             // 缺 name
    { name: 'H2', type: 'secretKeyRef', secretName: 's', key: '' },            // 缺 key
    { name: 'H3', type: 'fieldRef', fieldPath: '' },                           // 缺 fieldPath
    { name: '', type: 'resourceFieldRef', resource: '', containerName: '' },   // 全空行 → 跳过(五类型同政策)
    { name: '', type: 'resourceFieldRef', resource: '', containerName: 'c1' }, // 部分填写 → 仍报错
  ])
  assert.deepEqual(errs, [
    { index: 3, name: '', type: 'configMapKeyRef', missing: ['name'] },
    { index: 4, name: 'H2', type: 'secretKeyRef', missing: ['key'] },
    { index: 5, name: 'H3', type: 'fieldRef', missing: ['fieldPath'] },
    { index: 7, name: '', type: 'resourceFieldRef', missing: ['name', 'resource'] },
  ])
})

test('duplicateEnvNames / 计数 / 空判', () => {
  assert.equal(duplicateEnvNames([{ name: 'A' }, { name: ' a ' }, { name: 'B' }]), 'A')
  assert.equal(duplicateEnvNames([{ name: '' }, { name: 'B' }]), null)
  assert.equal(envRowCount([{ name: 'A' }, { name: '' }, { name: 'C' }], [{ kind: 'configmap', name: 'cm' }]), 3)
  assert.equal(envSectionEmpty([], []), true)
  assert.equal(envSectionEmpty([{ name: '', type: 'value', value: '' }], []), true)
  assert.equal(envSectionEmpty([{ name: '', type: 'value', value: 'v' }], []), false)
  assert.equal(envSectionEmpty([], [{ kind: 'configmap', name: '' }]), true)
  assert.equal(rowNonEmpty(null), false)
})
