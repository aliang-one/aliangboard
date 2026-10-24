// MCP 面工具元数据(2026-10-24 凭据审计 P2):workbench 注册表的描述里广告了
// {{cred:}} 占位符注入,但 MCP/API-key 面的执行分派绕开 registry exec(apiKeyTools.callTool /
// sshBridge.exec,零 substitute)——占位符在该面按字面落进目标机 shell。描述必须按 principal
// 收口:广告句剥离 + 固定说明替换。
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { TOOL_META, stripCredInjectionNote } from './mcp.mjs'

const INJECTION_FACES = ['exec_pod', 'wb_exec', 'wb_ssh_exec']

test('TOOL_META:注入族工具描述不含 {{cred 广告句,带字面执行说明', () => {
  for (const name of INJECTION_FACES) {
    const meta = TOOL_META[name]
    assert.ok(meta, `${name} 应在 META`)
    assert.ok(!meta.description.includes('{{cred'), `${name} 描述不得广告占位符注入(该面字面执行): ${meta.description.slice(-120)}`)
    assert.ok(meta.description.includes('工作台'), `${name} 描述带「仅工作台会话生效」说明`)
  }
})

test('TOOL_META:非注入族工具描述零改动(剥离只影响命中句)', () => {
  assert.ok(TOOL_META.get_pod_logs.description.includes('pod'), '无关工具描述原样')
  assert.ok(!stripCredInjectionNote('普通描述,无广告句').includes('工作台'), '无广告句不追加说明')
})

test('stripCredInjectionNote:g 标志 RE lastIndex 不跨调用串扰(先长后短广告句序列全剥离)', () => {
  const long = `前缀 ${'x'.repeat(400)}。命令支持 {{cred:凭据名#字段}} 占位符注入(平台执行时替换)。`
  const short = '开头 {{cred:a#b}} 就有广告。'
  const first = stripCredInjectionNote(long)
  const second = stripCredInjectionNote(short)
  assert.ok(!first.includes('{{cred'), '第一个剥离')
  assert.ok(!second.includes('{{cred'), '第二个也剥离(g RE lastIndex 串扰会漏这个)')
  assert.ok(second.startsWith('凭据占位符注入仅在'), '整句剥离后仅剩固定说明')
})
