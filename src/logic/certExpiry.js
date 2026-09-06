// 证书到期纯逻辑:分级 + 铃铛伪事件构造。i18n 由调用方注入 t(纯模块不 import i18n,
// 零依赖 runner 可测;报告形状 = GET /api/cluster-certs 响应)。
export const CERT_WARN_DAYS = 30
export const CERT_CRITICAL_DAYS = 7

export function certSeverity(daysLeft) {
  if (daysLeft == null || Number.isNaN(daysLeft)) return 'unknown'
  if (daysLeft < 0) return 'expired'
  if (daysLeft <= CERT_CRITICAL_DAYS) return 'critical'
  if (daysLeft <= CERT_WARN_DAYS) return 'warn'
  return 'ok'
}

// ≤30 天/已过期的 tls Secret leaf → warning 伪事件(AlertBell 消费)。
// uid = 'cert:'+指纹(跨天稳定 → 标记已读后不复活);无指纹时回退 ns/name 复合。
export function buildCertAlerts(report, { now = Date.now, t = (k, p) => k } = {}) {
  const items = report?.secrets?.items
  if (!Array.isArray(items)) return []
  const out = []
  for (const it of items) {
    const sev = certSeverity(it.daysLeft)
    if (sev !== 'expired' && sev !== 'critical' && sev !== 'warn') continue
    const expired = sev === 'expired'
    out.push({
      uid: `cert:${it.fingerprint256 || `${it.namespace || ''}/${it.name || ''}`}`,
      type: 'warning',
      reason: t(expired ? 'nav.certAlertReasonExpired' : 'nav.certAlertReason'),
      relatedKind: 'Certificate',
      relatedName: it.name || '',
      relatedNamespace: it.namespace || '',
      namespace: it.namespace || '',
      age: expired ? t('nav.certAlertExpiredAge', { days: Math.abs(it.daysLeft) }) : t('nav.certAlertExpiringAge', { days: it.daysLeft }),
      icon: 'key',
      color: expired || sev === 'critical' ? 'error' : 'tertiary',
      _ts: now(),
    })
  }
  return out
}
