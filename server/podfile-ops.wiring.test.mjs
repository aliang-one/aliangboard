// podfile 三件套接线守卫(源码断言,防线非行为测试):podfile exec 需真集群,行为面由
// file-ops.test.mjs(校验/归类纯逻辑)+ sshfile-ops(同源逻辑的 DI 行为)覆盖;本守卫
// 锁 index.mjs 的接线不回归——动作分派/门序/审计/命令构造四处缺一即红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'index.mjs'), 'utf8')

// 截取 podfile 分支段落(podfile → 下一个出口分支 terminals),断言只作用于本分支
const start = src.indexOf("startsWith('/api/podfile/')")
const end = src.indexOf("startsWith('/api/terminals/", start) > 0 ? src.indexOf("startsWith('/api/terminals/", start) : src.length
assert.ok(start > 0 && end > start, 'podfile 分支定位失败')
const seg = src.slice(start, end)

test('三动作分派存在,且在统一授权门之后(门先行,见 w2b-coverage)', () => {
  for (const a of ['mkdir', 'delete', 'rename']) {
    assert.ok(seg.includes(`action === '${a}'`), `podfile ${a} 分派缺失`)
  }
  const gateIdx = seg.indexOf('gateK8sSession(')
  const opsIdx = seg.indexOf("action === 'mkdir'")
  assert.ok(gateIdx > 0 && gateIdx < opsIdx, '三件套必须在 gateK8sSession 之后执行')
})

test('校验先行:deleteTargetError/entryNameError 在 exec 之前,失败 400 + denied 审计', () => {
  assert.ok(seg.includes('deleteTargetError(path)'), 'delete 根守卫缺失')
  assert.ok(seg.includes('entryNameError(name)'), 'mkdir/rename 名字校验缺失')
  const vIdx = seg.indexOf('entryNameError(name)')
  const execIdx = seg.indexOf('POD_OP_ARGV')
  assert.ok(vIdx > 0 && vIdx < execIdx, '校验必须在 exec 之前')
  assert.ok(seg.includes("msg(req, vErr === 'root' ? 'api.fileOpRefuseRoot' : 'api.fileOpBadName')"))
  assert.ok(/result: 'denied'/.test(seg.slice(vIdx, execIdx)), '校验失败须落 denied 审计')
})

test('命令构造走 POD_OP_ARGV(位置参数,路径不进命令字符串)+ 统一超时', () => {
  assert.ok(seg.includes("POD_OP_ARGV[action](target)") || seg.includes('POD_OP_ARGV.rename(path, target)'), 'POD_OP_ARGV 接线缺失')
  assert.ok(!/`mkdir|`rm |`mv /.test(seg), '禁止模板串拼接命令(注入面)')
  assert.ok(seg.includes('timeoutMs: 30000'), 'exec 须带超时(30s)')
})

test('审计闭环:ok + denied(exec 失败)+ gateway 异常三路都写', () => {
  assert.ok(/tool: 'podfile_' \+ action, result: 'ok'/.test(seg), 'ok 审计缺失')
  assert.ok(/reason: 'exec'/.test(seg) && /result: 'denied'/.test(seg), 'exec 失败审计缺失')
  assert.ok(/reason: 'gateway'/.test(seg), '网关异常审计缺失')
})

test('file-ops.mjs 导入接线(与 sshfile 同源)', () => {
  assert.ok(src.includes("from './file-ops.mjs'"), 'index.mjs 未导入 file-ops')
  assert.ok(src.includes('entryNameError') && src.includes('joinDirName') && src.includes('classifyOpFailure'))
})
