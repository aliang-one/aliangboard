// 文件三件套(2026-09-08)纯逻辑:名字/路径校验 + 失败归类。
// pod(podfile exec)与 SSH(sshfile exec)两侧共用——单一事实源,双侧路由行为测试引用。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  entryNameError, deleteTargetError, normalizeFsPath, joinDirName,
  classifyOpFailure, POD_OP_ARGV, sshOpCommand,
} from './file-ops.mjs'

test('entryNameError:空/./..//与\\ 都拒;正常名放行', () => {
  assert.equal(entryNameError(''), 'empty')
  assert.equal(entryNameError('  '), 'empty')
  assert.equal(entryNameError(undefined), 'empty')
  assert.equal(entryNameError('.'), 'dot')
  assert.equal(entryNameError('..'), 'dot')
  assert.equal(entryNameError('a/b'), 'slash')
  assert.equal(entryNameError('a\\b'), 'slash')
  assert.equal(entryNameError('数据 logs'), null)
  assert.equal(entryNameError('app-2026.log'), null)
})

test('deleteTargetError:根(/ 与等价形态)拒;深路径放行', () => {
  assert.equal(deleteTargetError('/'), 'root')
  assert.equal(deleteTargetError('//'), 'root')
  assert.equal(deleteTargetError('///'), 'root')
  assert.equal(deleteTargetError(''), 'root')
  assert.equal(deleteTargetError(' / '), 'root')       // 尾斜杠归一后=根
  assert.equal(deleteTargetError('/var/log'), null)
  assert.equal(deleteTargetError('/data/'), null)      // 尾斜杠归一
})

test('normalizeFsPath/joinDirName:归一尾斜杠;根目录拼接不带双斜杠', () => {
  assert.equal(normalizeFsPath('/var/log/'), '/var/log')
  assert.equal(normalizeFsPath('/'), '')
  assert.equal(joinDirName('/', 'newdir'), '/newdir')
  assert.equal(joinDirName('/data', 'logs'), '/data/logs')
  assert.equal(joinDirName('/data/', 'logs'), '/data/logs')
})

test('classifyOpFailure:exit 0=无错;mkdir 已存在=409;其余=400+stderr 透出', () => {
  assert.equal(classifyOpFailure('mkdir', 0, ''), null)
  assert.equal(classifyOpFailure('delete', 0, 'whatever'), null)
  // busybox/coreutils 文案均含 exists
  const exists = classifyOpFailure('mkdir', 1, "mkdir: can't create directory '/x': File exists")
  assert.equal(exists.status, 409)
  const perm = classifyOpFailure('delete', 1, 'rm: /etc/x: Permission denied')
  assert.equal(perm.status, 400)
  assert.match(perm.message, /Permission denied/)
  const noMsg = classifyOpFailure('rename', 1, '')
  assert.equal(noMsg.status, 400)
  assert.match(noMsg.message, /exit=1/)
})

test('POD_OP_ARGV:位置参数姿势($1/$2),路径不进命令字符串(防注入)', () => {
  assert.deepEqual(POD_OP_ARGV.mkdir('/data/x'), ['sh', '-c', 'mkdir "$1"', 'mkdir', '/data/x'])
  assert.deepEqual(POD_OP_ARGV.delete('/data/x'), ['sh', '-c', 'rm -rf -- "$1"', 'rm', '/data/x'])
  assert.deepEqual(POD_OP_ARGV.rename('/data/a', '/data/b'), ['sh', '-c', 'mv -- "$1" "$2"', 'mv', '/data/a', '/data/b'])
})

test('sshOpCommand:shellQuote 包裹,路径含单引号也安全', () => {
  assert.equal(sshOpCommand('mkdir', '/data/x'), `mkdir '/data/x'`)
  assert.equal(sshOpCommand('delete', '/data/x'), `rm -rf -- '/data/x'`)
  assert.equal(sshOpCommand('rename', '/data/a', '/data/b'), `mv -- '/data/a' '/data/b'`)
  // 引号逃逸:it's → 'it'\\''s'
  assert.equal(sshOpCommand('mkdir', `/d/it's`), `mkdir '/d/it'\\''s'`)
})
