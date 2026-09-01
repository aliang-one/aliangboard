// buildWbCtx 形状守卫(2026-09-01 接线事故根治):ssh/sshJobs 桥必须装配进 ctx 内。
// 事故:生产者把 `ssh:`/`sshJobs:` 写成返回值顶层兄弟键,消费方(workbench-agent)只解构
// `const { ctx }` 后读 `ctx.ssh` → 恒 undefined → exposedCount 恒 0 → 9 个 SSH 工具在
// 工作台对话中被无条件剔除(提示词却烘焙了服务器清单 → AI 自相矛盾拒答)。
// index.mjs 是入口(import 即起服务)无法直接单测 → 按 route-auth-map.test.mjs 先例做
// 静态源码守卫:装配形状一旦回退,这里直接红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'index.mjs'), 'utf8')

// 截取 buildWbCtx 函数体:函数在 createHandler 内为 2 空格缩进,体内闭合均 ≥4 空格,
// 故首个「\n + 恰好 2 空格 + }」即函数收尾。
const regionMatch = src.match(/function buildWbCtx\([\s\S]*?\n {2}\}/)

test('守卫前置:index.mjs 存在 buildWbCtx(结构未漂移)', () => {
  assert.ok(regionMatch, '未匹配到 buildWbCtx 函数体——函数签名/缩进层级变了,请更新本守卫的截取方式')
})

const region = regionMatch ? regionMatch[0] : ''

test('ssh/sshJobs 桥必须装配进 ctx 内(ctx.ssh = / ctx.sshJobs =)', () => {
  assert.match(
    region,
    /ctx\.ssh\s*=\s*createSshAgentBridge\(/,
    'ctx.ssh 未挂进 ctx——workbench-agent/agent-runner 双消费方都读 ctx.ssh,挂外层 = exposedCount 恒 0 = 9 个 SSH 工具被永久剔除(2026-09-01 事故)'
  )
  assert.match(
    region,
    /ctx\.sshJobs\s*=\s*createSshJobBridge\(/,
    'ctx.sshJobs 未挂进 ctx——wb_ssh_run/job_* 的动态审批与执行将全部失效'
  )
})

test('禁止顶层兄弟键形态回归(ssh:/sshJobs: 不得作为 buildWbCtx 返回值直接属性)', () => {
  assert.doesNotMatch(
    region,
    /^ {6}ssh:\s*createSshAgentBridge/m,
    '检测到顶层 `ssh: createSshAgentBridge` 兄弟键——这正是让工作台 SSH 工具全灭的事故形态'
  )
  assert.doesNotMatch(
    region,
    /^ {6}sshJobs:\s*createSshJobBridge/m,
    '检测到顶层 `sshJobs: createSshJobBridge` 兄弟键——同上,必须挂在 ctx 内'
  )
})
