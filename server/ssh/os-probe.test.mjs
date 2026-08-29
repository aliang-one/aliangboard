import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { parseOsRelease, normalizeOsId, OS_PROBE_COMMAND } from './os-probe.mjs'

const UBUNTU = `PRETTY_NAME="Ubuntu 22.04.4 LTS"\nNAME="Ubuntu"\nVERSION_ID="22.04"\nVERSION="22.04.4 LTS (Jammy Jellyfish)"\nID=ubuntu\nID_LIKE=debian\n`
const ARCH = `NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\nID=arch\nBUILD_ID=rolling\nANSI_COLOR="38;2;23;147;209"\n`
const OPENSUSE = `NAME="openSUSE Leap"\nID="opensuse-leap"\nPRETTY_NAME="openSUSE Leap 15.5"\n`

test('parseOsRelease: ubuntu 全字段;引号剥离;PRETTY_NAME 优先于 NAME', () => {
  const r = parseOsRelease(UBUNTU)
  assert.deepEqual(r, { osId: 'ubuntu', osName: 'Ubuntu 22.04.4 LTS' })
})

test('parseOsRelease: arch 无 VERSION 行也可;opensuse-leap 带引号 ID', () => {
  assert.equal(parseOsRelease(ARCH).osId, 'arch')
  const r = parseOsRelease(OPENSUSE)
  assert.equal(r.osId, 'opensuse-leap')
  assert.equal(r.osName, 'openSUSE Leap 15.5')
})

test('parseOsRelease: 无 os-release 输出(uname 兜底串)→ null;空 → null', () => {
  assert.equal(parseOsRelease('Linux'), null)
  assert.equal(parseOsRelease(''), null)
  assert.equal(parseOsRelease(null), null)
})

test('normalizeOsId: 常见别名归一到图标 slug', () => {
  assert.equal(normalizeOsId('arch'), 'archlinux')
  assert.equal(normalizeOsId('kali'), 'kalilinux')
  assert.equal(normalizeOsId('opensuse-leap'), 'opensuse')
  assert.equal(normalizeOsId('rhel'), 'redhat')
  assert.equal(normalizeOsId('raspbian'), 'raspberrypi')
  assert.equal(normalizeOsId('alpine'), 'alpinelinux')
  assert.equal(normalizeOsId('rocky'), 'rockylinux')
  assert.equal(normalizeOsId('darwin'), 'apple')
  assert.equal(normalizeOsId('ubuntu'), 'ubuntu')
})

test('normalizeOsId: 未知/带后缀 → 前缀归一或 Tux 兜底', () => {
  assert.equal(normalizeOsId('ubuntu-pro'), 'ubuntu')
  assert.equal(normalizeOsId('mysteryos'), 'linux')
  assert.equal(normalizeOsId(''), 'linux')
  assert.equal(normalizeOsId('', 'openSUSE something'), 'opensuse')   // NAME 兜底
})

test('OS_PROBE_COMMAND: 静态命令(无注入面)', () => {
  assert.equal(OS_PROBE_COMMAND, 'cat /etc/os-release 2>/dev/null || uname -s')
})
