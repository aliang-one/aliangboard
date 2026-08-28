// SFTP 原语测试:readdir 排序/类型标记、readFile 截断语义(超限早结算,不挂)、statSize、withSftp 会话关闭。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { withSftp, sftpReaddir, sftpReadFile, sftpStatSize } from './sftp.mjs'

function fakeSftp() {
  return {
    readdir: (p, cb) => cb(null, [
      { filename: 'zz.txt', attrs: { isDirectory: () => false } },
      { filename: 'etc', attrs: { isDirectory: () => true } },
      { filename: 'a.txt', attrs: { isDirectory: () => false } },
    ]),
    stat: (p, cb) => cb(null, { size: 12345 }),
    createReadStream: (p) => ({
      on(ev, fn) {
        if (ev === 'data') setImmediate(() => fn(Buffer.from('hello-sftp-content')))
        if (ev === 'end') setImmediate(fn)
        if (ev === 'close') setImmediate(fn)
        return this
      },
      destroy() {},
    }),
    end: test.mock.fn(),
  }
}

test('withSftp: 成功路径 finally 关闭会话', async () => {
  const s = fakeSftp()
  const out = await withSftp({ sftp: cb => cb(null, s) }, x => { assert.equal(x, s); return 'ok' })
  assert.equal(out, 'ok')
  assert.equal(s.end.mock.callCount(), 1)
})

test('withSftp: fn 抛错也关会话且 reject', async () => {
  const s = fakeSftp()
  await assert.rejects(withSftp({ sftp: cb => cb(null, s) }, () => { throw new Error('boom') }), /boom/)
  assert.equal(s.end.mock.callCount(), 1)
})

test('withSftp: sftp 打开失败 reject', async () => {
  await assert.rejects(withSftp({ sftp: cb => cb(new Error('no-sftp')) }, () => {}), /no-sftp/)
})

test('sftpReaddir: 目录在前 + 名字排序 + 类型标记', async () => {
  const entries = await withSftp({ sftp: cb => cb(null, fakeSftp()) }, s => sftpReaddir(s, '/'))
  assert.deepEqual(entries, [
    { name: 'etc', type: 'dir' },
    { name: 'a.txt', type: 'file' },
    { name: 'zz.txt', type: 'file' },
  ])
})

test('sftpReadFile: maxBytes 截断标记;小文件完整', async () => {
  const s = fakeSftp()
  const r1 = await sftpReadFile(s, '/a.txt', 1024)
  assert.equal(r1.content, 'hello-sftp-content')
  assert.equal(r1.truncated, false)
  assert.equal(r1.size, 18)
  const r2 = await sftpReadFile(s, '/a.txt', 4)
  assert.equal(r2.content, 'hell')
  assert.equal(r2.truncated, true)
  assert.equal(r2.size, 18)
})

test('sftpReadFile: 流错误 reject', async () => {
  const s = {
    createReadStream: () => ({
      on(ev, fn) {
        if (ev === 'error') setImmediate(() => fn(new Error('No such file')))
        return this
      },
      destroy() {},
    }),
  }
  await assert.rejects(sftpReadFile(s, '/x', 10), /No such file/)
})

test('sftpStatSize: 返回 st.size', async () => {
  assert.equal(await sftpStatSize(fakeSftp(), '/a.txt'), 12345)
})
