// W2 审计 B1/B2(2026-09-07)接线守卫:index.mjs 内的调度器/路由面无法直测(import 即起
// 服务),按 wb-tool-gate.test.mjs ② 层先例做静态源码守卫——门/归属接线一旦回退,这里直接红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'index.mjs'), 'utf8')

// B1:定时 reconcile 调度器(RECONCILE_INTERVAL_MS,默认 0=关)以系统身份遍历全部项目幂等
// apply——原状零门零 principal:owner 已失权/禁用的项目仍被系统周期续命 manifests,架空
// W2「缩权即刻生效」(spec §4.5);HTTP 按钮面(workbench-projects reconcile)自 C+D 起有
// 逐文档门,调度器必须同款:owner entitlement(canAccessCluster 现查)+ gateApplyNamespaces。
test('B1 接线守卫:reconcile 调度器先过 owner 门再 reconcileProject', () => {
  const m = src.match(/const tickReconcile = async[\s\S]*?\n {2}\}/)
  assert.ok(m, '未截取到 tickReconcile 函数体(结构漂移请同步守卫)')
  const body = m[0]
  assert.match(body, /canAccessCluster\(/, '调度器必须逐项目过 owner entitlement(canAccessCluster)')
  assert.match(body, /gateApplyNamespaces\(/, '调度器必须逐文档过 gateApplyNamespaces(与 HTTP reconcile 按钮同门)')
  assert.ok(body.indexOf('gateApplyNamespaces') < body.indexOf('reconcileProject'), '门必须在 reconcileProject 之前(先拒后写)')
  assert.match(body, /userId: p\.ownerId/, '授权主体必须是项目 owner(P0-① 同源,不得以系统/admin 身份)')
})

// B2:端口转发 DELETE 原状只过 ns operate 门——同 ns 其他用户可停掉别人的隧道。补归属:
// forwards 记 ownerUserId(平台身份;不得用 k8s token——轮换即自锁,终端记录 rekey 事故前科),
// DELETE 比对 owner 或 admin。listForwards 仍按 token 过滤(会话生命周期,另一维度,维持)。
test('B2 接线守卫:portforward 创建记录 ownerUserId;DELETE 先归属比对再 stopForward', () => {
  assert.match(src, /forwards\.set\(id, \{ server, pf, sessionId, id,[^}]*ownerUserId/, '创建时必须记录平台归属 ownerUserId')
  const del = src.match(/if \(req\.method === 'DELETE' && url\.pathname\.startsWith\('\/api\/portforward\/'\)\)[\s\S]*?\n {2}\}/)
  assert.ok(del, '未截取到 portforward DELETE 块(结构漂移请同步守卫)')
  assert.match(del[0], /ownerUserId/, 'DELETE 必须比对归属(owner 或 admin)')
  assert.ok(del[0].indexOf('ownerUserId') < del[0].indexOf('stopForward'), '归属比对必须在 stopForward 之前(先拒后断)')
})
