// sshExecCommand:一次性 shell 命令(上传预检用)——正常收集 / exec 错误 / 超时 / 同步抛,全部结算不悬挂。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'node:events'
import { sshExecCommand } from './exec.mjs'

function fakeClient(impl) { return { exec: impl } }

test('sshExecCommand: stdout/stderr 收集,close 结算(含退出码回传——文件三件套按码归类)', async () => {
  const client = fakeClient((cmd, cb) => {
    assert.match(cmd, /echo hi/)
    const s = new EventEmitter()
    s.stderr = new EventEmitter()
    cb(null, s)
    setImmediate(() => { s.emit('data', Buffer.from('hi\n')); s.stderr.emit('data', Buffer.from('oops')); s.emit('close', 0) })
  })
  const r = await sshExecCommand(client, 'echo hi', { timeoutMs: 1000 })
  assert.deepEqual(r, { stdout: 'hi\n', stderr: 'oops', code: 0 })
})

test('sshExecCommand: exec 回调错误 → null(不抛)', async () => {
  const client = fakeClient((cmd, cb) => cb(new Error('no channel')))
  assert.equal(await sshExecCommand(client, 'x', { timeoutMs: 1000 }), null)
})

test('sshExecCommand: 超时 → null,stream 被 destroy', async () => {
  let destroyed = false
  const client = fakeClient((cmd, cb) => {
    const s = new EventEmitter()
    s.stderr = new EventEmitter()
    s.destroy = () => { destroyed = true }
    cb(null, s)   // 永不 close
  })
  const r = await sshExecCommand(client, 'x', { timeoutMs: 20 })
  assert.equal(r, null)
  assert.equal(destroyed, true)
})

test('sshExecCommand: client.exec 同步抛 → null(不抛)', async () => {
  const client = fakeClient(() => { throw new Error('socket gone') })
  assert.equal(await sshExecCommand(client, 'x', { timeoutMs: 1000 }), null)
})

// 文件三件套(2026-09-08):退出码/信号语义——非零透传,信号杀(code=null)按 1 归失败
test('sshExecCommand: close(1) → code=1;信号杀(close(null, SIGKILL))→ code=1', async () => {
  const mk = codeArgs => fakeClient((cmd, cb) => {
    const s = new EventEmitter()
    s.stderr = new EventEmitter()
    cb(null, s)
    setImmediate(() => s.emit('close', ...codeArgs))
  })
  assert.equal((await sshExecCommand(mk([1]), 'x', { timeoutMs: 1000 })).code, 1)
  assert.equal((await sshExecCommand(mk([null, 'SIGKILL']), 'x', { timeoutMs: 1000 })).code, 1)
  assert.equal((await sshExecCommand(mk([]), 'x', { timeoutMs: 1000 })).code, 0)
})
