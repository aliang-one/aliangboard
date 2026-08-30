import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildServerRefBlock } from './ref-block.mjs'

const rows = [{ id: 's1', name: '网关机', host: '10.0.0.1', username: 'ops', description: '入口网关', clusterRef: 'ck-1', osName: 'ubuntu-22.04', status: 'ok', aiApprovalPolicy: 'readonly' }]

test('server ref 块:字段齐全且不含 host/username(脱敏红线)', () => {
  const out = buildServerRefBlock('[server//网关机]', rows, { kind: 'server', namespace: '', name: '网关机' })
  assert.ok(out.includes('网关机') && out.includes('入口网关') && out.includes('ubuntu-22.04') && out.includes('readonly'))
  assert.ok(!out.includes('10.0.0.1'), '块内不得出现 host')
  assert.ok(!out.includes('ops'), '块内不得出现 username')
  assert.ok(out.startsWith('[server//网关机]:'))
})

test('server ref:id 兜底命中;未命中/未暴露清单 → not found 文案', () => {
  assert.ok(buildServerRefBlock('[server//x]', rows, { kind: 'server', namespace: '', name: 's1' }).includes('"name"'))
  const nf = buildServerRefBlock('[server//没了]', rows, { kind: 'server', namespace: '', name: '没了' })
  assert.ok(nf.includes('(not found / 已不可用)'))
  assert.equal(buildServerRefBlock('[server//x]', [], { kind: 'server', namespace: '', name: 'x' }).includes('(not found / 已不可用)'), true)
})
