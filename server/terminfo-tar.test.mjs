// 守卫:server/bin/ab-terminfo.tar 必须含 pane/Terminal 链路需要的全部 terminfo 条目。
// 背景:tmux pane 内 TERM 取 default-terminal(裸 screen),若 tar 缺 s/screen 且镜像无系统
// terminfo → shell 行编辑(上箭头)错乱(2026-08-26 终端补全/方向键修复)。
// 零依赖:ustar 头 512 字节纯 JS 解析,不 spawn tar。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ustar 条目名列表(name@0 len100, size@124 octal, typeflag@156;512 对齐;全零头=归档结束)
function ustarEntries(buf) {
  const names = []
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512)
    if (header.every(b => b === 0)) break
    const name = header.subarray(0, 100).toString('utf8').replace(/\0[\s\S]*$/, '')
    const sizeStr = header.subarray(124, 136).toString('utf8').replace(/\0[\s\S]*$/, '').trim()
    const size = parseInt(sizeStr, 8) || 0
    if (name) names.push(name)
    off += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

test('ustarEntries: 解析当前 tar,五个必备条目齐全(含 s/screen)', () => {
  const tar = readFileSync(join(import.meta.dirname, 'bin', 'ab-terminfo.tar'))
  const names = ustarEntries(tar)
  // 现有条目守住(回归防线:别在重打包时丢条目)
  for (const must of ['x/xterm-256color', 'x/xterm', 't/tmux-256color', 's/screen-256color']) {
    assert.ok(names.includes(must), `tar must contain ${must}; got: ${names.join(', ')}`)
  }
  // 本次修复新增:pane TERM=screen 时的兜底(conf 注入失败但 terminfo 已注入的场景)
  assert.ok(names.includes('s/screen'), `tar must contain s/screen (pane TERM fallback); got: ${names.join(', ')}`)
})
