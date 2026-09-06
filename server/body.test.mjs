// readBody 契约:空体→{};有效 JSON→对象;非 JSON(二进制等)→抛 400 可读错误而非 V8 SyntaxError 泄漏。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { Readable } from 'node:stream'
import { readBody } from './body.mjs'

test('readBody: 空体 → {}', async () => {
  assert.deepEqual(await readBody(Readable.from([])), {})
})

test('readBody: 有效 JSON → 对象', async () => {
  assert.deepEqual(await readBody(Readable.from([Buffer.from('{"a":'), Buffer.from('1}')])), { a: 1 })
})

test('readBody: 二进制体 → 抛 400 可读错误(不泄漏 V8 SyntaxError)', async () => {
  const binary = Buffer.from('x' + String.fromCharCode(0xef, 0x63, 0x60, 0x43, 0xff))
  await assert.rejects(
    () => readBody(Readable.from([binary])),
    e => e.status === 400 && !/Unexpected token/.test(e.message) && /JSON/.test(e.message),
  )
})

// 大小上限(2026-09-06 审计#10):readBody 是全端点共用入口,旧实现 for-await 无界缓冲——
// 恶意/异常客户端可灌巨体撑内存。契约:超限即 413 且立刻停读(不再继续缓冲)。
test('readBody: 超过大小上限 → 抛 413 且立即停读', async () => {
  let delivered = 0
  const req = new Readable({
    read() {
      delivered += 1024 * 1024
      this.push(Buffer.alloc(1024 * 1024, 97))
      if (delivered > 20 * 1024 * 1024) this.push(null) // 防桩失控:20MB 后收流
    },
  })
  let destroyed = false
  req.on('error', () => { destroyed = true })
  await assert.rejects(() => readBody(req), e => e.status === 413)
})

test('readBody: 恰好在上限内 → 正常解析(边界不受罚)', async () => {
  const big = JSON.stringify({ pad: 'x'.repeat(1024 * 1024) })
  assert.ok((await readBody(Readable.from([Buffer.from(big)]))).pad.length === 1024 * 1024)
})
