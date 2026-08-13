// server/ingress-controller-templates.test.mjs
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { loadAll as yamlLoadAll } from 'js-yaml'
import { INGRESS_CONTROLLER_TEMPLATES } from './manifests/ingress-controllers/catalog.mjs'
import { listControllerTemplates, readControllerManifest } from './ingress-controller-templates.mjs'

const REQUIRED = ['id', 'labelKey', 'descKey', 'notesKey', 'version', 'source', 'variant', 'controller', 'defaultClassName', 'file']

test('catalog: 每条字段齐全 + id 唯一', () => {
  const ids = new Set()
  for (const t of INGRESS_CONTROLLER_TEMPLATES) {
    for (const k of REQUIRED) assert.ok(t[k], `catalog ${t.id} 缺字段 ${k}`)
    assert.ok(!ids.has(t.id), `重复 id: ${t.id}`); ids.add(t.id)
  }
})

test('listControllerTemplates: 不泄露 file 字段', () => {
  for (const t of listControllerTemplates()) assert.ok(!('file' in t), `list 不应含 file: ${t.id}`)
})

test('readControllerManifest: 未知 id 抛错', () => {
  assert.throws(() => readControllerManifest('no-such'), /未知/)
})

test('清单有效性门禁: 每条可解析 + 资源≥4 + 含 IngressClass 且 controller 一致', () => {
  for (const t of INGRESS_CONTROLLER_TEMPLATES) {
    const text = readControllerManifest(t.id)
    assert.match(text, new RegExp(t.controller), `${t.id}: 清单文本未含 controller 串 ${t.controller}`)
    const objs = []; yamlLoadAll(text, o => o && objs.push(o))
    assert.ok(objs.length >= 4, `${t.id}: 资源数 ${objs.length} < 4(疑似截断)`)
    const ics = objs.filter(o => o.kind === 'IngressClass')
    assert.ok(ics.length >= 1, `${t.id}: 清单未含 IngressClass`)
    for (const ic of ics) assert.equal(ic.spec?.controller, t.controller, `${t.id}: IngressClass.spec.controller 与 catalog 不一致`)
  }
})
