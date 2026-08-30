// CSO 2026-08-30 #9:NODE_TLS_REJECT_UNAUTHORIZED 是进程级开关 —— 为 K8s 自签开的门
// 会顺手关掉 LLM/GitHub 等全部出站 TLS 校验。改为 buildCallContext 内按会话生效。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCallContext, getDispatcher } from './call-context.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

test('index.mjs 不再设置进程级 NODE_TLS_REJECT_UNAUTHORIZED(静态守卫)', () => {
  const src = readFileSync(join(ROOT, 'server/index.mjs'), 'utf8')
  assert.ok(!src.includes('NODE_TLS_REJECT_UNAUTHORIZED'), '禁止进程级 TLS 开关(CSO #9)')
})

test('K8S_INSECURE_SKIP_TLS_VERIFY=true → 仅 K8s call context 变 insecure(会话级)', () => {
  const prev = process.env.K8S_INSECURE_SKIP_TLS_VERIFY
  process.env.K8S_INSECURE_SKIP_TLS_VERIFY = 'true'
  try {
    const ctx = buildCallContext({ apiServer: 'https://k.example:6443', authHeader: 'Bearer x', insecure: false })
    assert.equal(ctx.insecure, true)
    // dispatcher 按 insecure 构建:与 getDispatcher({insecure:true,...}) 同缓存签名(同一实例)
    assert.equal(ctx.dispatcher, getDispatcher({ ca: null, cert: null, key: null, insecure: true }))
  } finally {
    if (prev === undefined) delete process.env.K8S_INSECURE_SKIP_TLS_VERIFY
    else process.env.K8S_INSECURE_SKIP_TLS_VERIFY = prev
  }
})

test('env 未设时 insecure 跟随显式入参(默认 false)', () => {
  const prev = process.env.K8S_INSECURE_SKIP_TLS_VERIFY
  delete process.env.K8S_INSECURE_SKIP_TLS_VERIFY
  try {
    const ctx = buildCallContext({ apiServer: 'https://k.example:6443', authHeader: 'Bearer x', insecure: false })
    assert.equal(ctx.insecure, false)
  } finally {
    if (prev !== undefined) process.env.K8S_INSECURE_SKIP_TLS_VERIFY = prev
  }
})

test('env 未设 + 显式入参 insecure:true → ctx.insecure===true(env 不该能关掉显式 insecure)', () => {
  const prev = process.env.K8S_INSECURE_SKIP_TLS_VERIFY
  delete process.env.K8S_INSECURE_SKIP_TLS_VERIFY
  try {
    const ctx = buildCallContext({ apiServer: 'https://k.example:6443', authHeader: 'Bearer x', insecure: true })
    assert.equal(ctx.insecure, true)
  } finally {
    if (prev !== undefined) process.env.K8S_INSECURE_SKIP_TLS_VERIFY = prev
  }
})
