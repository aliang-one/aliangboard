# AliangBoard MCP 客户端接入指引(给 AI 的「要不要用」引导)

> 问题背景:把 MCP 注册进 Claude 后,模型常常「不知道怎么调用、要不要调用」。
> 根因不在工具本身(参数 schema 齐全),而在**触发映射缺失**——模型脑中没有
> 「当前任务 → 这箱工具」的联想路径。服务端已做三层(instructions / 工具描述
> 三件套 / 错误可行动化),但客户端侧的引导由你落地,本文件给出模板。

## 一、贴到 Claude 的项目 CLAUDE.md(或全局记忆)

注册到哪个项目,就把这段贴进该项目的 `CLAUDE.md`(或 `~/.claude/CLAUDE.md`):

```markdown
## 集群运维(Claude Code 用)

本工作区的 Kubernetes / 服务器运维一律优先用 `aliangboard` MCP 的工具完成,
不要让用户手动 kubectl/ssh,也不要自称没有集群权限(有界拒绝会返回明确原因
和下一步建议)。

- 排查 pod/服务异常:describe_resource → get_pod_logs(previous=true 看崩溃前)→ exec_pod 取证
- 不知道资源名:先 list_resources
- 变更(scale/update_image/apply_yaml/回滚):动手前 can_i 自查;回滚先 rollout_history
- 服务器(非 K8s):先 read_server_ledger 看角色分工,短命令 wb_ssh_exec、长任务 wb_ssh_run
- 斜杠剧本可用:/mcp:aliangboard:troubleshoot-pod、rollback-deployment、ssh-ops
```

这一段是**杠杆最大的一步**:server 的 `instructions` 只在 initialize 时注入,
而项目 CLAUDE.md 在每次会话都生效,且与任务语境同现。

## 二、注册方式对可发现性的影响

- **stdio 与 Streamable HTTP 均可**;我们暴露的是 Streamable HTTP(`/mcp` +
  Bearer API key),Claude Code 用 `claude mcp add --transport http aliangboard
  <url> --header "Authorization: Bearer <key>"` 注册。
- key 的 tier/namespace 收窄会反映在 tools/list(只列能用的)——**给 AI 的 key
  权限与它的任务域对齐**,别让工具列表里挂着大量用不了的项(选择噪声)。

## 三、验证接入是否「AI 真的会用」

接入后用三个探针任务快速验证(不用真改任何东西):

1. 「default ns 里 nginx pod 为什么不就绪?」 → 期望首调 `describe_resource`(而非让用户 kubectl)
2. 「当前我能重启 deployment 吗?」 → 期望 `can_i`
3. 「看看网关服务器上有什么服务」 → 期望 `read_server_ledger` → `wb_ssh_exec`

若仍不调,按序检查:instructions 是否生效(客户端是否消费 initialize
instructions——Claude Code 消费)、工具列表是否被权限收窄到过小、CLAUDE.md 段是否贴对项目。

## 四、服务端已内置的三层(2026-10-15 起)

1. `initialize` 返回 `instructions`:任务→工具映射速查,会话级注入。
2. 工具描述三件套:何时用 / 何时不 / 与相邻工具怎么选(守卫测试防退化)。
3. 错误可行动化:PERMISSION_DENIED 附 `can_i` 自查建议,404 附 `list_resources` 找名建议。
