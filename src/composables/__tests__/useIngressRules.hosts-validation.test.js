// ingressHostsErrors(四入口共享校验)单元测试:
//   hostsToK8sSpec 的生成层不变式是「port 不兜底,未填由各入口校验拦截」(useIngressRules spec §3.3)。
//   向导 stepBlockReason 有一份内联版;NsIngress 创建曾完全没拦 → 空端口/命名端口经
//   Number() → NaN/0 → generateYAML `|| 80` → 静默改写 80 端口。本函数是抽出的单源校验。
// 背景:2026-08-17 系统审计 P2-B。
import { test, expect } from 'vitest'
import { ingressHostsErrors } from '../useIngressRules'

const H = (host, paths) => ({ host, tls: false, tlsSecret: '', paths })
const P = (serviceName, servicePort, path = '/') => ({ path, pathType: 'Prefix', serviceName, servicePort })

test('合法规则 → 无错误', () => {
  expect(ingressHostsErrors([H('a.com', [P('svc-a', '80')])])).toEqual([])
})

test('serviceName 为空 → noService', () => {
  const errs = ingressHostsErrors([H('a.com', [P('', '80')])])
  expect(errs).toEqual([{ host: 'a.com', path: '/', reason: 'noService' }])
})

test('端口非纯数字(命名端口 http)→ badPort(生成层只支持 number)', () => {
  const errs = ingressHostsErrors([H('a.com', [P('svc-a', 'http')])])
  expect(errs).toEqual([{ host: 'a.com', path: '/', reason: 'badPort' }])
})

test('端口为空 → badPort(不放行,防 Number(\'\')→0→generateYAML ||80 兜底)', () => {
  const errs = ingressHostsErrors([H('a.com', [P('svc-a', '')])])
  expect(errs[0].reason).toBe('badPort')
})

test('path 为空 → noPath', () => {
  const errs = ingressHostsErrors([H('a.com', [P('svc-a', '80', '')])])
  expect(errs[0].reason).toBe('noPath')
})

test('host 为空的组跳过不校验;有 host 无 path → noPath(对齐向导语义)', () => {
  expect(ingressHostsErrors([H('', [P('', '')])])).toEqual([])
  const errs = ingressHostsErrors([H('a.com', [])])
  expect(errs).toEqual([{ host: 'a.com', path: undefined, reason: 'noPath' }])
})
