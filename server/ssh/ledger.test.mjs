import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { renderServerLedger } from './ledger.mjs'

const SRV = (over = {}) => ({
  id: 'id-1', name: 'gw-1', host: '10.0.0.5', port: 22, username: 'ops',
  authMethod: 'password', status: 'ok', osId: 'ubuntu', osName: 'Ubuntu 22.04',
  exposeToAi: true, aiApprovalPolicy: 'readonly', notes: '网关部署机\n- nginx 入口',
  clusterRef: 'prod', description: '主力网关', ...over,
})

test('renderServerLedger:全局段+每服务器段;结构层自动;自由层 notes 原样', () => {
  const md = renderServerLedger([SRV()], '网关统一切换在 gw-1')
  assert.ok(md.includes('# SSH 服务器台账'))
  assert.ok(md.includes('网关统一切换在 gw-1'))
  assert.ok(md.includes('### gw-1（10.0.0.5:22）'))
  assert.ok(md.includes('Ubuntu 22.04'))          // osName 进结构层
  assert.ok(md.includes('readonly'))               // 暴露策略进结构层
  assert.ok(md.includes('网关部署机'))             // 自由层原样
  assert.ok(md.includes('- nginx 入口'))
})

test('renderServerLedger:exposedOnly=true 只含暴露服务器;false 全量', () => {
  const srvs = [SRV(), SRV({ id: 'id-2', name: 'dev-1', exposeToAi: false, notes: '' })]
  assert.equal(renderServerLedger(srvs, '', { exposedOnly: true }).includes('dev-1'), false)
  assert.ok(renderServerLedger(srvs, '', { exposedOnly: false }).includes('dev-1'))
})

test('renderServerLedger:未暴露服务器不泄露 host(暴露视图安全)', () => {
  const md = renderServerLedger([SRV(), SRV({ id: 'id-2', name: 'secret-1', host: '192.168.9.9', exposeToAi: false })], '', { exposedOnly: true })
  assert.ok(!md.includes('192.168.9.9'))
})

test('renderServerLedger:空清单/无 notes 的合理退化', () => {
  const empty = renderServerLedger([], '')
  assert.ok(empty.includes('0'))
  const md = renderServerLedger([SRV({ notes: '' })], '')
  assert.ok(md.includes('（暂无备注）'))
})

test('renderServerLedger:unknown 状态与未探测 OS 的占位', () => {
  const md = renderServerLedger([SRV({ status: 'unknown', osId: '', osName: '' })], '')
  assert.ok(md.includes('未测'))
  assert.ok(md.includes('OS 未探测'))
})
