// 自指容器防线(2026-10-24 凭据审计 P0-2,边界面最大缺口):工作台 AI 的免审原语
// (wb_read_pod_file requiresApproval:false / auto 档 wb_exec 免审)可指向网关自身容器——
// 主钥文件(cred-crypt.key/ssh-crypt.key)与 SQLite 都在那,读回内容不经过任何已知值洗涤
// 直达 LLM 上下文,加密/审批/双洗对这条通路零防御。防线:pod 名识别 + 敏感路径 belt。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { selfPodName, isSelfPodTarget, sensitiveGatewayPaths, isSensitiveGatewayPath } from './self-pod-guard.mjs'

test('isSelfPodTarget:pod 名 === HOSTNAME(K8s 容器 hostname=pod 名)即自指', () => {
  const env = { HOSTNAME: 'aliangboard-7d9f6c-xk2pz' }
  assert.equal(isSelfPodTarget('aliangboard-7d9f6c-xk2pz', env), true)
  assert.equal(isSelfPodTarget('other-pod', env), false)
  assert.equal(isSelfPodTarget('', env), false)
  assert.equal(isSelfPodTarget(undefined, env), false)
})

test('isSelfPodTarget:HOSTNAME 缺失/过短(非 K8s 本地 dev)不启用 pod 判定(fail-open 但路径 belt 仍在)', () => {
  assert.equal(isSelfPodTarget('anything', {}), false)
  assert.equal(isSelfPodTarget('ab', { HOSTNAME: 'ab' }), false, '过短 hostname 非 pod 名形态')
})

test('selfPodName:取 HOSTNAME,缺省空串', () => {
  assert.equal(selfPodName({ HOSTNAME: 'p-1' }), 'p-1')
  assert.equal(selfPodName({}), '')
})

test('sensitiveGatewayPaths:从 ALIANG_DB 派生库文件与两把主钥的绝对路径', () => {
  const paths = sensitiveGatewayPaths({ ALIANG_DB: '/data/alias/wb.db' })
  assert.ok(paths.includes('/data/alias/wb.db'))
  assert.ok(paths.includes('/data/alias/cred-crypt.key'))
  assert.ok(paths.includes('/data/alias/ssh-crypt.key'))
  assert.equal(sensitiveGatewayPaths({}).length, 0, '无 ALIANG_DB(测试态)空集')
})

test('isSensitiveGatewayPath:库/主钥路径精确命中,普通路径放行', () => {
  const env = { ALIANG_DB: '/data/wb.db' }
  assert.equal(isSensitiveGatewayPath('/data/wb.db', env), true)
  assert.equal(isSensitiveGatewayPath('/data/cred-crypt.key', env), true)
  assert.equal(isSensitiveGatewayPath('/data/ssh-crypt.key', env), true)
  assert.equal(isSensitiveGatewayPath('/etc/nginx/nginx.conf', env), false)
  assert.equal(isSensitiveGatewayPath('', env), false)
  assert.equal(isSensitiveGatewayPath('/data/other/wb.db', env), false, '仅精确匹配,不 basename 误伤')
})
