// CSO 2026-08-30 #4:pod 日志/exec/读文件此前零脱敏 —— 注入指令可让 SA token(JWT)
// 明文进 LLM 请求与 trace 落库。maskSecretResource 只认 Secret 对象,盖不住自由文本。
import test from 'node:test'
import assert from 'node:assert/strict'
import { maskSensitiveText } from './secret-mask.mjs'
import { podPathDenied, safePodPath } from './api-key-tools.mjs'

test('maskSensitiveText:JWT/PEM/AKIA 打码,普通日志原样', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Ik1ZS0VZIn0.eyJpc3MiOiJrdWJlcm5ldGVzIn0.SflKxwRJSMeKKF2QT4'
  assert.equal(maskSensitiveText(`token: ${jwt}`), 'token: [redacted-jwt]')
  assert.equal(maskSensitiveText('-----BEGIN RSA PRIVATE KEY-----\nabc\ndef\n-----END RSA PRIVATE KEY-----'), '[redacted-private-key]')
  assert.equal(maskSensitiveText('key AKIAIOSFODNN7EXAMPLE'), 'key [redacted-aws-key]')
  assert.equal(maskSensitiveText('postgres FATAL: password authentication failed'), 'postgres FATAL: password authentication failed')
})

test('podPathDenied:/proc /sys /dev /run/secrets /var/run/secrets 拒绝', () => {
  for (const p of ['/proc/self/environ', '/proc/1/cmdline', '/sys/fs/cgroup', '/dev/urandom', '/run/secrets/x', '/var/run/secrets/kubernetes.io/serviceaccount/token']) assert.equal(podPathDenied(p), true, p)
  for (const p of ['/etc/nginx/nginx.conf', '/var/log/app.log', '/home/app/.env.production']) assert.equal(podPathDenied(p), false, p)
})

// 终审 R1:归一化防绕过——白名单允许 . .. //,前缀正则原会被以下形态骗过
test('podPathDenied:归一化后拒绝 //、./、../ 绕过形态', () => {
  for (const p of [
    '//run/secrets/x',
    '/run//secrets/x',
    '/etc/../run/secrets/kubernetes.io/serviceaccount/token',
    '/var/./run/secrets/x',
    '/proc/../proc/self/environ',
  ]) assert.equal(podPathDenied(p), true, p)
  // 对照:归一化后仍合法的路径继续放行
  assert.equal(podPathDenied('/etc/nginx/../nginx/nginx.conf'), false)
})

test('safePodPath 行为不变(既有字符白名单仍生效)', () => {
  assert.throws(() => safePodPath('a;rm'), Error)
})
