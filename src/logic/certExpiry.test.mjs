// 纯逻辑零依赖 runner:分级边界 + 铃铛伪事件构造(uid 稳定性/阈值过滤/i18n 注入)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { certSeverity, buildCertAlerts } from './certExpiry.js'

test('certSeverity 边界:<0 过期;≤7 critical;≤30 warn;>30 ok;null unknown', () => {
  assert.equal(certSeverity(-1), 'expired')
  assert.equal(certSeverity(0), 'critical')
  assert.equal(certSeverity(7), 'critical')
  assert.equal(certSeverity(8), 'warn')
  assert.equal(certSeverity(30), 'warn')
  assert.equal(certSeverity(31), 'ok')
  assert.equal(certSeverity(null), 'unknown')
})

test('buildCertAlerts:仅 expired/critical/warn 进铃铛;uid=cert:指纹(跨天稳定);t 注入', () => {
  const item = (daysLeft) => ({ name: 'tls-web', namespace: 'api', daysLeft, fingerprint256: 'AA:BB:CC' })
  const report = { secrets: { items: [item(45), item(12), item(3), item(-5), item(null)], error: null } }
  const t = (k, p) => `${k}:${JSON.stringify(p || {})}`
  const alerts = buildCertAlerts(report, { now: () => 123, t })
  assert.equal(alerts.length, 3)
  assert.ok(alerts.every(a => a.type === 'warning' && a.icon === 'key' && a.relatedKind === 'Certificate'))
  assert.equal(alerts[0].uid, 'cert:AA:BB:CC') // 12d → warn 档
  assert.equal(alerts[0].color, 'tertiary')
  assert.equal(alerts[1].color, 'error') // 3d → critical
  assert.equal(alerts[2].color, 'error') // -5d → expired
  assert.match(alerts[0].age, /certAlertExpiringAge/)
  assert.match(alerts[2].age, /certAlertExpiredAge/)
  assert.equal(alerts[0]._ts, 123)
  assert.equal(alerts[0].relatedName, 'tls-web')
  assert.equal(alerts[0].relatedNamespace, 'api')
})

test('buildCertAlerts:null/空 report 与缺指纹兜底(namespace/name 复合 uid)', () => {
  assert.deepEqual(buildCertAlerts(null, { t: k => k }), [])
  assert.deepEqual(buildCertAlerts({}, { t: k => k }), [])
  assert.deepEqual(buildCertAlerts({ secrets: { items: [] } }, { t: k => k }), [])
  const alerts = buildCertAlerts({ secrets: { items: [{ name: 's', namespace: 'n', daysLeft: 1 }] } }, { t: k => k })
  assert.equal(alerts[0].uid, 'cert:n/s')
})
