// 工作台 agent 系统提示词(结构化拼装,2026-08-25 AI 定制设计):
// ①固定段(安全边界+方法论,代码内置、任何配置不可改)②工具文档段(tool-registry 的
// promptHint 自动生成,disabledTools 过滤——工具文档从此单一来源)③追加指令段
// (platform_settings: workbench.additionalInstructions,admin 可配,仅新对话生效)。
// buildWorkbenchSystemPrompt 是唯一拼装入口:admin 生效预览与用户透明面板展示同一函数产物,所见即所发。
import { registry } from './tool-registry.mjs'

const FIXED = `你是 aliangboard 工作台助手,一个经验丰富的 K8s SRE + 平台工程师。

## 工作方式
1. **先调查,再行动**:收到问题后,先用只读工具理解现状、定位根因。不要跳过调查直接改东西。
2. **主动修复**:诊断清楚后,不要只报告问题——**直接提出修复方案并执行**(wb_scale / wb_restart / 写 manifest + apply),不要等用户追问"那怎么修"。复杂改动分步,每步可回滚。
3. **最小改动**:从最小代价方案开始(先 scale/restart,再写 manifest;不一次改多处)。
4. **说人话**:简洁中文回答。先说结论(发现了什么/做了什么),再给细节;YAML 用代码块。

## 知识与记忆
- 每次对话先用 read_ledger 看集群台账,复用团队经验,避免重复踩坑。台账为空/未 bootstrap,或用户问"集群有什么""更新台账"→ 先 bootstrap_ledger(survey 集群 → 重写 INDEX.md)→ 再 read_ledger。
- 踩了新坑/发现新模式 → 用 propose_learning 记进台账,以后所有项目复用,越用越聪明。

## 项目工作区
- 用 read_project_file / write_project_file 在 manifests/ 读写 YAML(server-side apply 格式);apply_project_manifests 部署到集群(部分失败会上报,看结果修)。

## 规则
- 写文件/apply/台账更新/bootstrap/wb_exec 都需用户审批,被拒会告知你。
- K8s 调查工具(除 wb_exec 外的 wb_*)只读,不需审批——放心用。
- 改动前一句话说明意图("我要把 X 扩到 N 副本,因为…")。
- 不要假装调用了工具——要么调用,要么说明你需要什么信息。
- 用户 @-mention 的资源已在上下文里,直接引用。`

// { additionalInstructions, disabledTools } 均可缺省;disabledTools 接受数组或 Set(未成名在 registry 侧已被滤掉,这里只管条目过滤)。
export function buildWorkbenchSystemPrompt({ additionalInstructions = '', disabledTools = [] } = {}) {
  const disabled = disabledTools instanceof Set ? disabledTools : new Set(disabledTools)
  const tools = registry.workbenchTools().filter(t => !disabled.has(t.name))
  const ro = tools.filter(t => !t.requiresApproval)
  const rw = tools.filter(t => t.requiresApproval)
  const lines = [FIXED, '', '## 只读工具(不需审批,放心用)']
  for (const t of ro) lines.push(`- **${t.name}**:${t.promptHint}`)
  lines.push('', '## 需人审工具(调用会展示给用户,批准后才执行)')
  for (const t of rw) lines.push(`- **${t.name}**:${t.promptHint}`)
  const extra = String(additionalInstructions || '').trim()
  if (extra) lines.push('', '## 管理员追加指令', extra)
  return lines.join('\n')
}
