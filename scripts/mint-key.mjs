// 临时:给 walking skeleton 的 live smoke 签一把 API key(T13 管理 UI 前用)。
// 用法: node scripts/mint-key.mjs <clusterId> <owner> <namespace> <sa-name> [tier=read|operator|admin]
// 打印明文 key(仅此次)。前提:集群已在该平台注册,且集群凭据对 <namespace>/<sa-name> 有 create serviceaccounts/token。
import { DatabaseSync } from 'node:sqlite'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createApiKeysSchema, mintKey } from '../server/auth-keys.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.ALIANG_DB || join(__dirname, '..', 'data', 'aliangboard.db')
const db = new DatabaseSync(dbPath)
createApiKeysSchema(db) // 幂等

const [clusterId, owner, namespace, sa, tier = 'read'] = process.argv.slice(2)
if (!clusterId || !owner || !namespace || !sa) {
  console.error('用法: node scripts/mint-key.mjs <clusterId> <owner> <namespace> <sa-name> [tier]')
  console.error('  clusterId 从平台的「集群」页拿(或 SELECT id,name FROM clusters)。')
  process.exit(1)
}
const cluster = db.prepare('SELECT id, name FROM clusters WHERE id=?').get(clusterId)
if (!cluster) { console.error(`✗ 集群 ${clusterId} 不存在(先在平台加集群)`); process.exit(1) }

const k = mintKey(db, { owner, clusterId, boundSA_namespace: namespace, boundSA_name: sa, tier, label: 'smoke-test', createdBy: 'mint-key-script' })
console.log(`✓ 集群: ${cluster.name} (${clusterId})`)
console.log(`✓ 绑定 SA: ${namespace}/${sa}  tier: ${tier}`)
console.log(`✓ 明文 key(仅此次可见,复制保存):`)
console.log(`    ${k.plaintext}`)
console.log(`  prefix: ${k.prefix}`)
console.log(`\n冒烟测试(确保 gateway 在跑: npm run server):`)
console.log(`  curl -s -H "Authorization: Bearer ${k.plaintext}" \\`)
console.log(`    "http://127.0.0.1:8787/api/key/${clusterId}/namespaces/${namespace}/pods/<某个pod>/logs?container=<c>&tail=50"`)
console.log(`\n查审计:`)
console.log(`  node -e "import('node:sqlite').then(({DatabaseSync})=>{const db=new DatabaseSync('${dbPath}');console.log(db.prepare('SELECT seq,status,tool,result,reason FROM audit_log ORDER BY seq DESC LIMIT 5').all())})"`)
