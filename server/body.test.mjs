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
