// 真 tls.createServer + 提交夹具:严/宽双拨语义端到端(端口/证书/CA 全真实,离线可跑)。
// hostname-mismatch 不设端到端用例:探测接口不为测试开 servername 口子;
// 该错误码(ERR_TLS_CERT_ALTNAME_INVALID)已被归因表单测覆盖(规划阶段 tls 直测实证)。
// 生命周期:每个用例 finally 里 close 自己的 server——监听中的 server 会让 node --test 的
// event loop 永不排空(规划期首版挂在 process 'exit' 上,死锁 2min 超时的教训)。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import * as tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { probeConnection } from './cluster-certs.mjs'

const FX = join(dirname(fileURLToPath(import.meta.url)), 'test-fixtures', 'certs')
const read = f => readFileSync(join(FX, f))
const CA1 = read('ca1.pem').toString('utf8')
const CA2 = read('ca2.pem').toString('utf8')

function serve() {
  return new Promise(resolve => {
    const server = tls.createServer({ key: read('leaf1.key'), cert: read('leaf1.pem') }, s => s.end('hi'))
    // URL host = 127.0.0.1(可拨);身份校验走夹具里的 IP SAN(IP Address:127.0.0.1),
    // apiServer URL 的 hostname 在 probeConnection 里同时充当拨号 host 与校验名,故不可用假域名。
    server.listen(0, '127.0.0.1', () => resolve({ server, url: new URL(`https://127.0.0.1:${server.address().port}`) }))
  })
}
const closeServer = ({ server }) => new Promise(r => server.close(() => r()))
const PROBE = (url, ca, insecure = false) => probeConnection(tls.connect, { apiServer: url, ca, insecure, timeout: 3000, now: Date.now })

test('严拨通过(存储 CA=签发 CA)→ trusted,peerChain 含 leaf 描述符', async () => {
  const ctx = await serve()
  try {
    const r = await PROBE(ctx.url, CA1)
    assert.equal(r.trust, 'trusted')
    assert.equal(r.reachable, true)
    assert.match(r.peerChain[0].subject, /api\.demo\.local/)
    assert.ok(r.peerChain[0].sans.some(s => s.includes('api.demo.local')))
  } finally { await closeServer(ctx) }
})

test('CA 失配(存储 CA=ca2,服务端链锚定 ca1)→ ca-mismatch + reasonCode', async () => {
  const ctx = await serve()
  try {
    const r = await PROBE(ctx.url, CA2)
    assert.equal(r.trust, 'ca-mismatch')
    assert.equal(r.reachable, true)
    assert.equal(r.reasonCode, 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
  } finally { await closeServer(ctx) }
})

test('insecure 会话(无 CA 校验语义)→ unverified,仍报 peer 链', async () => {
  const ctx = await serve()
  try {
    const r = await PROBE(ctx.url, null, true)
    assert.equal(r.trust, 'unverified')
    assert.ok(r.peerChain.length >= 1)
  } finally { await closeServer(ctx) }
})

test('端口拒连 → unreachable', async () => {
  const ctx = await serve()
  const url = ctx.url
  await closeServer(ctx) // 拿一个已关闭端口
  const r = await PROBE(url, CA1)
  assert.equal(r.trust, 'unreachable')
  assert.equal(r.reachable, false)
})
