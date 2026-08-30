# SSH 异步任务运维清单(2026-08-30 特性:wb_ssh_run / wb_ssh_job_* / admin job-policy)

本清单承接规格 §8,面向上线与日常运维。每条带验证命令或页面路径。

## 1. 集群实例镜像更新(SSH 桥基线)

集群内实例需更新到含本特性(SSH 桥已在 origin/main)的镜像后,异步任务工具才可用。

```bash
docker pull ghcr.io/aliangone/aliangboard:main   # 或对应 sha-<短> tag
docker compose up -d                              # 或 kubectl rollout restart deploy/aliangboard
```

验证:页面 → 管理后台 → AI/透明面板(`GET /api/workbench/ai-config`),工具清单出现
`wb_ssh_run / wb_ssh_job_out / wb_ssh_job_write / wb_ssh_job_list / wb_ssh_job_kill`
(零暴露服务器时不出现,属正常——工具按 SSH 清单裁剪)。

## 2. 登记美国服务器并暴露 AI(策略建议 readonly)

页面 → 服务器 tab → 新增:host=美国服务器,认证按实情(password/privateKey)。
暴露 AI 勾选;审批策略建议 **readonly**(长任务启动按命令文本分类:只读免审,其余展示人审)。

验证:`POST /api/ssh/servers/<id>/test`(服务器列表页「测试连接」按钮)→ 连接成功 + OS 识别。

## 3. 工作台链路验证(需 LLM 已配置)

页面 → 工作台 → 项目对话,输入「读一下服务器台账」。AI 调用 `read_server_ledger` 应返回
含上述服务器的 Markdown(凭据/host 不出现)。异步任务侧验证:让 AI 在该服务器
`wb_ssh_run` 一条 `sleep 30`,随后 `wb_ssh_job_list` 应能看到 jobId 且 RUNNING。
自动化脚本:`node scripts/ssh-jobs-e2e.mjs`(8 步断言,需 QA 网关+sshd+LLM)。

## 4. 僵尸进程清理(上线前一次性)

- 僵尸网关 PID 2118725(worktree 已删):`ps -p 2118725` 确认后 `kill 2118725`。
- :5199 僵尸 preview:`ss -ltnp | grep 5199` 找 PID 后 kill。
(历史教训:运行时实例错配/僵尸实例会吃请求造成「成功刷新丢」假象。)

## 5. 任务产物位置与清理语义

- 远端目录:`/tmp/.ab-job/<jobId>/`(out/stdin/pid/meta);**Linux-only**(setsid/timeout 依赖)。
- 清理:TTL 默认 120min,网关对近活跃服务器周期 sweep;进程重启当轮不扫(名单在内存)。
- admin 可调:`PUT /api/admin/ssh-job-policy {"ttlMin":60,"maxPerServer":N,"maxOutMb":M}`,
  查看用 `GET /api/admin/ssh-job-policy`;≤60s 生效。
- 页面:管理后台 → SSH 任务策略(如未展示 UI,直接走上述端点)。

## 6. 已知边界

- **Linux-only**:非 Linux 服务器 `wb_ssh_run` 返回明确报错(远端不支持 setsid/timeout)。
- **无 sudo 长任务**:sudo 密码会与交互应答抢 stdin,启动即拒,提示走一次性 `wb_ssh_exec`。
- **输出 64MB 封顶**(admin 可调,上限 512):超出终止任务并记 exitCode=141。
- key 通道(MCP/API-key)fail-closed:`wb_ssh_job_write/kill` 恒拒不可列;`wb_ssh_run` 按服务器
  策略(none 放行 / readonly 仅只读命令 / always 拒)。
- 注入防线:jobId 非 UUID(如 `../../etc`)在桥内 `validateJobId` 硬拒。

## e2e 运行记录(2026-08-30,本 worktree)

`node scripts/ssh-jobs-e2e.mjs` → **SKIP:QA 网关不可达(127.0.0.1:8788 无实例)**。
本机 22 端口虽开放,但为宿主真实 sshd,无 QA 凭据(qa/qa-pass),不可用于测试。
脚本语法 `node --check` 通过;8 步断言逻辑完整(含注入防线步)。待 QA 环境
(临时库网关 + sshd 容器 `docker run -d -p 2223:22 -e PASSWORD_ACCESS=true -e USER_NAME=qa
-e USER_PASSWORD=qa-pass linuxserver/openssh-server` + LLM 配置)就绪后重跑:
`SSHJOBS_E2E_HOST=<host> SSHJOBS_E2E_PORT=<port> node scripts/ssh-jobs-e2e.mjs`。
