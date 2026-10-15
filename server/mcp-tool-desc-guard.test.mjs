// 工具描述可发现性守卫(2026-10-15):AI 客户端「要不要调用」依赖 description 里的
// 触发锚点(何时用/与相邻工具怎么选)。本守卫防退化:registry 每条 description 必须含
// 至少一个触发锚点;关键路径工具钉特定锚点(与 MCP_INSTRUCTIONS 速查互为印证)。
// 锚点词表刻意宽松(防退化而非风格强制);新增工具漏写场景句会被此测试拦下。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { registry } from './tool-registry.mjs'

const ANCHORS = ['何时', '场景', '优先', '先', '更', '入口', '首选', '排查', '排障', '用于', '适用', '不知道', '之前', '别用', '验证', '问题']

test('全部注册工具 description 含触发锚点(何时/对比/入口类措辞)', () => {
  const missing = registry.all().filter(t => !ANCHORS.some(a => (t.description || '').includes(a)))
    .map(t => t.name)
  assert.deepEqual(missing, [], `这些工具的 description 缺「何时用/怎么选」锚点,AI 不会想起它们: ${missing.join(', ')}`)
})

test('关键路径工具钉特定锚点(与 instructions 速查一致)', () => {
  const meta = registry.toMeta()
  assert.ok(meta.describe_resource.description.includes('排查') || meta.describe_resource.description.includes('首选'), 'describe_resource=排查入口')
  assert.ok(meta.can_i.description.includes('之前') || meta.can_i.description.includes('先'), 'can_i=变更前自查')
  assert.ok(meta.rollout_undo.description.includes('rollout_history'), 'rollout_undo 指向先取 history')
  assert.ok(meta.list_resources.description.includes('不知道') || meta.list_resources.description.includes('先'), 'list_resources=找名字入口')
  assert.ok(meta.read_server_ledger.description.includes('先'), 'read_server_ledger=服务器问题先读台账')
})
