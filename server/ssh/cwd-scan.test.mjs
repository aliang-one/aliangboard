// cwd 三件套(2026-10-04 终端标签页「+」新建终端):旁路扫描 stdout 里的终端标题序列,
// 维护会话 lastCwd——零注入(绝不往 stdin 写探测命令),拿不到就降级默认目录。
//   OSC 7(权威):ESC ] 7 ; file://host/path BEL|ST —— 专为 cwd 设计的转义序列
//   OSC 0/2(启发式):bash 默认 PS1 上报的标题「user@host:路径」,须形似路径才采信
//   (vim/less 也会设标题,垃圾标题必须拒收)。序列可能被 WS 帧任意切断,跨 chunk 边界须缓冲。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { createCwdScanner, sanitizeCwd, buildCdCommand } from './cwd-scan.mjs'

// —— createCwdScanner:push 喂 stdout 块,返回「本次更新的新 cwd」(无变化/无效返回 null) ——

test('scanner:OSC 7(BEL 终止)解出绝对路径', () => {
  const s = createCwdScanner()
  const next = s.push(Buffer.from("foo\r\n\x1b]7;file://web1/var/log/nginx\x07$ "))
  assert.equal(next, '/var/log/nginx')
  assert.equal(s.get(), '/var/log/nginx')
})

test('scanner:OSC 7(ST 终止 ESC\\)与 percent-decode', () => {
  const s = createCwdScanner()
  // 源文件 UTF-8:中文字面量经 Buffer.from 得到真实 UTF-8 字节流(\xNN 转义反而是单码点假流)
  const next = s.push(Buffer.from('\x1b]7;file://h/my%20dir/中文\x1b\\'))
  assert.equal(next, '/my dir/中文')
})

test('scanner:OSC 0/2 启发式——剥 user@host: 前缀采信 ~ 与 / 起头路径', () => {
  const s = createCwdScanner()
  assert.equal(s.push(Buffer.from('\x1b]0;root@web1:~/projects\x07')), '~/projects')
  assert.equal(s.push(Buffer.from('\x1b]2;root@web1:/etc/nginx\x07')), '/etc/nginx')
})

test('scanner:垃圾标题拒收(vim/less/无路径形态不采信,不覆盖已有 cwd)', () => {
  const s = createCwdScanner()
  assert.equal(s.push(Buffer.from('\x1b]0;root@web1:~/projects\x07')), '~/projects')
  assert.equal(s.push(Buffer.from('\x1b]0;main.py [+] - vim\x07')), null, 'vim 标题不是路径')
  assert.equal(s.push(Buffer.from('\x1b]0;root@web1\x07')), null, '无冒号无路径')
  assert.equal(s.push(Buffer.from('\x1b]0;/var/log\x07')), '/var/log', '裸绝对路径可采信')
  assert.equal(s.get(), '/var/log', '垃圾标题未覆盖,后续有效路径正常更新')
})

test('scanner:OSC 7 权威优先——无效启发式标题之后来一条 OSC 7 照常生效', () => {
  const s = createCwdScanner()
  s.push(Buffer.from('\x1b]0;~/a\x07'))
  // OSC 7 的 path 段恒为绝对路径(file URI 语义),不带 ~
  assert.equal(s.push(Buffer.from('\x1b]7;file://h/b\x07')), '/b')
})

test('scanner:跨 chunk 切断——ESC 在块尾/序列中途断开仍能解出', () => {
  const s = createCwdScanner()
  assert.equal(s.push(Buffer.from('output...\x1b')), null)
  assert.equal(s.push(Buffer.from(']7;file://web1/srv')), null)
  assert.equal(s.push(Buffer.from('/app\x07prompt: ')), '/srv/app')
})

test('scanner:同值不重复上报(cwd 未变返回 null)', () => {
  const s = createCwdScanner()
  s.push(Buffer.from('\x1b]7;file://h/x\x07'))
  assert.equal(s.push(Buffer.from('\x1b]7;file://h/x\x07')), null)
})

test('scanner:超长序列丢弃不撑爆缓冲(无终止符的假 OSC)', () => {
  const s = createCwdScanner()
  const junk = Buffer.alloc(64 * 1024, 0x61)   // 64KB 无 ESC 无终止垃圾
  assert.equal(s.push(junk), null)
  const after = s.push(Buffer.from('\x1b]7;file://h/ok\x07'))
  assert.equal(after, '/ok', '垃圾倾倒后照常工作')
})

test('scanner:OSC 7 path 非法(非 / 开头/控制字符)拒收', () => {
  const s = createCwdScanner()
  assert.equal(s.push(Buffer.from('\x1b]7;file://hrelative\x07')), null)
  assert.equal(s.push(Buffer.from('\x1b]7;file://h/a\x1b[31mb\x07')), null, '含控制字符')
})

// —— sanitizeCwd:URL query 传入的起始目录校验(注入防线:控制字符一律拒) ——

test('sanitizeCwd:合法绝对/家目录路径放行(去首尾空白)', () => {
  assert.equal(sanitizeCwd('/var/log'), '/var/log')
  assert.equal(sanitizeCwd('~/projects/app'), '~/projects/app')
  assert.equal(sanitizeCwd('  /x  '), '/x')
})

test('sanitizeCwd:相对路径/空/超长/控制字符一律 null(防终端转义注入)', () => {
  assert.equal(sanitizeCwd(''), null)
  assert.equal(sanitizeCwd(null), null)
  assert.equal(sanitizeCwd('var/log'), null, '相对路径不可用')
  assert.equal(sanitizeCwd('/va\nr'), null, '值中间藏换行(trim 救不了)必须拒')
  assert.equal(sanitizeCwd('/var;\x1b[31m'), null)
  assert.equal(sanitizeCwd('~\x07'), null)
  assert.equal(sanitizeCwd('/' + 'a'.repeat(4097)), null, '超长拒收')
  assert.equal(sanitizeCwd('/' + 'a'.repeat(4095)), '/' + 'a'.repeat(4095), '总长 4096 恰好放行')
})

// —— buildCdCommand:生成注入 shell 的 cd 命令(引号安全;~ 前缀须免引号保 tilde 展开) ——

test('buildCdCommand:绝对路径单引号包裹,内嵌单引号转义', () => {
  assert.equal(buildCdCommand("/var/log"), "cd -- '/var/log'")
  assert.equal(buildCdCommand("/srv/my'app"), "cd -- '/srv/my'\\''app'")
})

test('buildCdCommand:~ 路径保住免引号前缀(~/ 不加引号,rest 单引号包裹)', () => {
  assert.equal(buildCdCommand('~'), 'cd -- ~')
  assert.equal(buildCdCommand('~/projects'), "cd -- ~/'projects'")
  assert.equal(buildCdCommand("~/my'dir"), "cd -- ~/'my'\\''dir'")
})
