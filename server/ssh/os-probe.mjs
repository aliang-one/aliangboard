// OS 探测纯函数:解析 /etc/os-release 输出 → 归一化发行版 slug(与前端图标资产对齐)。
// 探测命令在 pool.testConnection 成功后执行(池化连接上 exec,静态命令无注入面)。
export const OS_PROBE_COMMAND = 'cat /etc/os-release 2>/dev/null || uname -s'

// os-release 形如:ID=ubuntu / ID="arch" / PRETTY_NAME="Ubuntu 22.04.4 LTS"
export function parseOsRelease(text) {
  const out = { osId: '', osName: '' }
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^(ID|PRETTY_NAME|NAME)=(.*)$/)
    if (!m) continue
    const val = m[2].trim().replace(/^["']|["']$/g, '')
    if (m[1] === 'PRETTY_NAME') out.osName = val
    else if (m[1] === 'ID') out.osId = val
    else if (!out.osName) out.osName = val   // NAME 兜底
  }
  if (!out.osId && out.osName) out.osId = out.osName.toLowerCase().split(/\s+/)[0]
  if (!out.osId) return null
  return out
}

// 归一化到图标 slug(simple-icons 资产名);别名/ID_LIKE 常见值归一,未知 → 'linux'(Tux 兜底)
const SLUG_ALIAS = {
  arch: 'archlinux', endeavouros: 'archlinux', manjaro: 'archlinux',
  kalilinux: 'kalilinux', kali: 'kalilinux',
  opensuse: 'opensuse', 'opensuse-leap': 'opensuse', 'opensuse-tumbleweed': 'opensuse', sles: 'opensuse',
  rhel: 'redhat', redhatenterpriseserver: 'redhat', redhatenterpriseclient: 'redhat',
  raspbian: 'raspberrypi', raspios: 'raspberrypi',
  rocky: 'rockylinux', almalinux: 'almalinux', almalinux: 'almalinux',
  centos: 'centos', centoslinux: 'centos',
  alpine: 'alpinelinux',
  fedora: 'fedora', ubuntu: 'ubuntu', debian: 'debian', gentoo: 'gentoo', nixos: 'nixos',
  darwin: 'apple', macos: 'apple',
  sunos: 'linux', solaris: 'linux', freebsd: 'linux', openbsd: 'linux', netbsd: 'linux',   // 类 Unix 一律 Tux 兜底
}
export function normalizeOsId(rawId, rawName = '') {
  const id = String(rawId || '').trim().toLowerCase()
  if (SLUG_ALIAS[id]) return SLUG_ALIAS[id]
  // ID_LIKE 未单独传,常见派生系按前缀兜底(如 ubuntu-*/debian-*)
  for (const key of Object.keys(SLUG_ALIAS)) {
    if (id && (id.startsWith(key + '-') || id.startsWith(key + '_'))) return SLUG_ALIAS[key]
  }
  if (String(rawName || '').toLowerCase().includes('suse')) return 'opensuse'
  return 'linux'
}
