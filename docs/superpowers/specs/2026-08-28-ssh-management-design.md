# SSH 服务器管理与 AI 工具暴露 — 设计文档

- 日期:2026-08-28
- 状态:已获用户批准(brainstorming 流程,决策见 §2)
- 分支:`worktree-feat-ssh-management`
- 关联:工作台 AI 工具链(`server/tool-registry.mjs`)、pod 终端 WS 架构(`server/index.mjs`)、tmux 持久化范式(`server/tmux-session.mjs`)

## 1. 背景与目标

AliangBoard 目前只能管理 K8s 集群。运维场景经常需要登上集群相关(或无关)的
VM/物理机排查问题。本功能新增:

1. **SSH 服务器清单**:用户保存服务器地址、端口、用户名、凭据(密码/私钥/sudo 密码),
   可选关联某个集群作为语境标签。
2. **工作台 SSH 终端**:在工作台「服务器」tab 一键打开交互式终端(FloatingWindow,可多开),
   **刷新页面不掉线**。
3. **AI 工具暴露(用户可控)**:把 SSH 以 `wb_ssh_exec` / `wb_ssh_read_file` 两个工具暴露给
   工作台 AI agent。**凭据任何情况下不进 LLM 上下文**——AI 只见 id/名称/描述/关联集群,
   执行时由网关侧组装凭据。每台服务器独立开关(默认关闭)+ 独立审批策略。

### 非目标(明确不做)

- 跳板机/堡垒机链(复杂度高,首期不做)
- MCP 外部 API-key agent 暴露 SSH 工具(wb_ 前缀天然只对工作台 agent 可见,现状即边界)
- 远端 tmux 包装持久化模式(网关侧保活已满足需求,作为后续加固选项)
- AI 写远端文件 / `wb_ssh_write_file`(风险大,后续单独裁决)
- SSH 端口转发/隧道

## 2. 已裁决决策

| # | 决策点 | 裁决 |
|---|--------|------|
| 1 | 服务器与集群关系 | 独立清单 + 可选关联(`clusterRef` 纯标签,不强制) |
| 2 | 认证方式 | 密码 + 私钥(可选 passphrase)+ 可选 sudo 密码字段;跳板机不做 |
| 3 | 凭据存储 | 静态加密:AES-256-GCM,密钥独立文件(0600),与 DB 分离 |
| 4 | 终端呈现 | 工作台新「服务器」tab + FloatingWindow 浮动终端(可多开) |
| 5 | AI 审批策略 | 按服务器配置:默认不暴露;暴露后默认每条命令必审批,可放宽 |
| 6 | AI 可见信息 | 仅 id/名称/描述/关联集群;host/端口/用户名/凭据均不进 LLM 上下文 |
| 7 | 首期范围 | 全量:终端 + AI exec + SFTP 浏览/上传/下载 + AI 读文件(分四期交付) |
| 8 | SSH 实现 | `ssh2` npm 库 + 网关内连接池(方案一;系统 ssh+sshpass 因密码过 argv/环境被否) |
| 9 | 会话持久化 | **网关侧保活 + 环形缓冲回放**(远端 tmux 不可假设已装;网关重启=会话终止,诚实降级) |
| 10 | 连接池隔离 | 按「服务器 + 平台用户」隔离,凭据解密后的 Client 不跨用户共享 |

## 3. 总体架构

### 3.1 服务端(`server/ssh/` 新模块)

| 模块 | 职责 |
|------|------|
| `ssh/crypt.mjs` | AES-256-GCM 字段加解密(`encryptField`/`decryptField`,纯函数,可注入 key 便于单测) |
| `ssh/store.mjs` | `ssh_servers` 表 CRUD;**写入时加密、连接时才解密**;API 层永不接触明文凭据 |
| `ssh/routes.mjs` | REST `/api/ssh/servers`(CRUD)+ `/:id/test`(测试连接);仿 `server/routes/` 工厂模式,接入现有鉴权/审计中间件 |
| `ssh/pool.mjs` | 连接池,key=`serverId:userId`;keepalive 15s、无引用空闲 5min 回收、断线自动重连;`keyboard-interactive` 自动应答 |
| `ssh/terminal-sessions.mjs` | 交互会话登记表 `{ sid → { channel, ringBuffer, browserWs, lastActiveAt } }`;浏览器 WS 断开不释放 |
| `ssh/sftp.mjs` | SFTP stat/readdir/读/写(进度事件,对接现有 transfers 进度体系) |

- **WS 端点**:`/api/ssh/terminal?session=<平台token>&serverId=…&sid=…`,鉴权同 `/api/exec`
  (`sessions` 表 token + TTL);帧协议复用 1-byte 通道号,新增下行 `CH_REPLAY = 6`
  (现有下行占用:STDOUT=1/STDERR=2/EXIT=3/ERROR=4/MODE=5)。
- **AI 工具**:`wb_ssh_exec`、`wb_ssh_read_file` 注册进 `server/tool-registry.mjs` 的
  **WB(workbench)工具组**;MCP 侧 `effectiveTools` 过滤天然不可见,无需额外代码。

### 3.2 前端

| 组件 | 职责 |
|------|------|
| `WorkbenchShell.vue` | tab 序列追加「服务器」(现有:项目/配置/全局/记录) |
| `views/workbench/WorkbenchServers.vue` | DataTable 清单 + 新增/编辑 Modal(`SshServerForm`)+ 测试连接按钮 + 「暴露给 AI」开关与审批策略下拉 |
| `components/ssh/SshTerminal.vue` | xterm v6 + `code-theme.js` 主题 + fit addon;WS 状态机含 `replayed` 态(回放后接续) |
| `FloatingWindow` 集成 | 终端窗口多开,每窗一个 sid,与 pod 终端体验一致 |
| SFTP 文件浏览 | FloatingWindow 文件浏览器(复用现有文件浏览窗口化模式)+ 传输进度复用 transfers 体系 |
| 数据层 | Vue Query,key 约定 `['ssh','servers']`;不新建 Pinia CRUD store(符合数据层重构方向) |

## 4. 数据模型

```sql
CREATE TABLE IF NOT EXISTS ssh_servers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 22,
  username TEXT NOT NULL,
  authMethod TEXT NOT NULL CHECK (authMethod IN ('password','privateKey')),
  encPassword      TEXT,   -- AES-256-GCM 密文(authMethod=password 时必填)
  encPrivateKey    TEXT,   -- AES-256-GCM 密文 PEM(authMethod=privateKey 时必填)
  encPassphrase    TEXT,   -- AES-256-GCM 密文,私钥 passphrase(可选)
  encSudoPassword  TEXT,   -- AES-256-GCM 密文,仅供 AI exec 的 sudo -S(可选)
  hostKeyFingerprint TEXT, -- 首连记录的 SSH host key 指纹(SHA256);变更即 hard-fail
  description TEXT,
  clusterRef  TEXT,       -- 可选关联集群名(纯标签,AI 语境解析用)
  exposeToAi INTEGER NOT NULL DEFAULT 0,
  aiApprovalPolicy TEXT NOT NULL DEFAULT 'always' CHECK (aiApprovalPolicy IN ('always','readonly','none')),
  tags TEXT,              -- JSON 数组字符串
  createdBy TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
)
```

- `id`:`crypto.randomUUID()`。
- 加密密钥:`data/ssh-crypt.key`,32 字节随机,首次使用自动生成,权限 0600,
  与 DB 文件分离——**库文件单独泄露拿不到任何凭据**;密钥丢失 = 凭据不可解,需重录。
- `host/port/username` 明文(与 `clusters` 表 `apiServer` 同级;`hasPassword`/`hasPrivateKey`
  等布尔由是否非空派生)。

## 5. 安全边界

| 层 | 规则 |
|----|------|
| 静态 | 四个 `enc*` 字段全部 AES-256-GCM;密钥独立文件 0600 |
| 传输 | REST 永不回传凭据,只回 `hasPassword`/`hasPrivateKey`/`hasSudoPassword` 布尔;编辑表单不回填,留空 = 不修改 |
| 内存 | 解密只发生在连接建立瞬间,凭据闭包在 pool 内部;日志/审计/工具结果/错误消息全部脱敏(不含密码/私钥) |
| AI 可见 | LLM 上下文仅 id/name/description/clusterRef;host/port/username/凭据不进提示词 |
| AI 凭据 | `wb_ssh_exec` 入参仅 `server + command`;网关侧查库解密组装,工具结果仅 `exitCode/stdout/stderr/durationMs` |
| 审批 | 默认 `always`;`readonly` = 网关侧纯函数分类器放行只读命令(§6.2);`none` = 免审批(高危显式项,审计照常) |
| sudo | `sudo:true` 时包 `sudo -S -p '' sh -c <command>`,密码写 **stdin**(不进远端 argv/ps);未存 sudo 密码 → 结构化报错 |
| 主机密钥 | 首连记录指纹;后续连接指纹不符 → hard-fail,界面提示人工确认(确认后清除旧指纹重连重录,防 MITM) |
| 审计 | `ssh.server.created/updated/deleted/tested`、`ssh.terminal.opened/closed`、`ssh.exec`(服务器名/命令/退出码/时长)、`ssh.readfile`,入现有链式哈希 audit_log |

**依赖例外**:`ssh2`(^1.17.0,纯 JS)须登记进 CLAUDE.md 依赖表,rationale:
「SSH 客户端唯一可行的纯 JS 实现(shell 通道 + SFTP + password/keyboard-interactive/私钥认证);
系统 ssh 无法安全支持密码认证(sshpass 密码过 argv/环境变量),容器还须加装系统包」。

## 6. 终端会话(刷新不掉线)

### 6.1 生命周期

1. 前端点「打开终端」→ 生成/复用 `sid`(localStorage 按 serverId 记)→ WS 升级。
2. 网关从 pool 取(或建)该 `serverId:userId` 的 SSH Client → 开 shell 通道(PTY;
   初始 cols/rows 经 WS 查询参数传入,后续由 RESIZE 帧同步)→ 登记 terminal-sessions。
   `sid` 为 `crypto.randomUUID()`。
3. 浏览器 WS 断开(刷新/断网/关 tab):**shell 通道不死**,输出持续写环形缓冲(4000 行),
   `lastActiveAt` 持续更新。
4. 重连:同 `sid` → 网关先发 `CH_REPLAY`(缓冲快照)再转直播流;前端状态机
   `connecting → replayed → open`。
5. 回收:无浏览器连接且空闲 > 10 分钟 → 关 shell 通道并从登记表移除。
6. 网关重启:内存态会话全死;前端收到 `CH_ERROR` 提示「会话已终止,点击重连」→ 新 sid 新会话。

### 6.2 只读命令分类器(`ssh/readonly-classifier.mjs`,纯函数)

- 解析首 token(跳过 `VAR=x` 前缀形式)命中允许清单:`cat ls ps df free head tail grep find
  uname who uptime date id hostname wc du stat env printenv systemctl status journalctl
  dmesg netstat ss ip route ping`。**curl/wget 明确不入清单**(可 POST/上传,存在外带数据风险);
  实现期用例表为最终事实源,**含管道时每一段都必须只读才放行**。
- 出现 `;` `&&` `||` 反引号 `$(...)` `>` `>>` 换行 → 一律判非只读(走审批)。
- 注释/引号包裹的混淆输入按字面处理,清单外即拒绝。
- 全部行为有用例表单测(含绕过尝试)。

## 7. AI 工具

### 7.1 `wb_ssh_exec`

入参 `{ server: id或name, command, timeoutSec?, sudo? }`,执行流:

1. 解析 `server`(id 优先,name 兼容);未暴露 → 拒绝(错误信息不泄露该机存在细节);
   name 命中多台 → 返回候选清单让 AI 澄清,**不猜**。
2. 按该机 `aiApprovalPolicy` 分流:
   - `always`:走现有 checkpoint/pending_approval 审批链,审批 Modal 显示服务器名 + 命令;
   - `readonly`:分类器判只读 → 免审批直接执行,否则走审批;
   - `none`:直接执行(审计照常)。
3. pool 复用连接 → exec 通道;超时默认 30s(入参可调,硬上限 120s)。
4. 返回 `{ exitCode, stdout(32KB 截断,同现有 trace 约定), stderr, durationMs, timedOut? }`。
5. `sudo:true` → `sudo -S -p '' sh -c <command>` + stdin 喂密码;未配 → 结构化报错。

### 7.2 `wb_ssh_read_file`

入参 `{ server, path, maxBytes? = 64KB }`;SFTP 读,utf8 返回 + 截断标注。
审批:天然只读 → `readonly`/`none` 免审批,`always` 仍需审批(与 exec 同一策略键)。

### 7.3 系统提示注入

构建 agent 系统提示时查 `exposeToAi = 1` 清单,注入:

- 可用服务器表(id/名称/描述/关联集群);
- 使用指引:「用户提到某台服务器时用 wb_ssh_exec;凭据你不可见、无需询问,平台会自动鉴权」;
- **零暴露 → 不注入清单,且两个工具不出现在工具列表**(工具列表构建处按存在性过滤)。

## 8. SFTP 文件传输(浏览器侧,非 AI)

- 入口:「服务器」tab 行操作「文件」→ FloatingWindow 文件浏览器(SFTP readdir,面包屑导航)。
- 上传:浏览器 → 网关 → SFTP write;进度事件复用现有 transfers 进度体系;默认上限 512MB。
- 下载:SFTP read → 网关流式回传浏览器(进度同上)。
- 不设远端路径白名单:用户本就持有该机完整凭据,面板定位是运维便利而非权限边界。

## 9. 错误处理

| 场景 | 处理 |
|------|------|
| 测试连接 | 结构化结果:不可达(timeout/ECONNREFUSED)/ 认证失败 / 主机密钥变更 / 成功(含指纹) |
| keyboard-interactive | `tryKeyboard: true` + handler 自动应答同一密码(ssh2 已知坑,首日处理) |
| 主机密钥变更 | hard-fail;前端确认框「主机密钥已变更,确认信任并更新?」→ 清旧指纹重连重录 |
| crypt key 丢失/损坏 | 连接与测试均报「凭据密钥不可用,请重新录入」;清单页该行标「凭据不可用」 |
| exec 超时 | 通道 close,`exitCode = null` + `timedOut: true` |
| SFTP | ENOENT/EACCES 等映射可读消息;上传超限前置校验 |
| 连接池断线 | 自动重连(指数退避,上限 3 次);终端场景断线 → `CH_ERROR` + 前端提示重连 |

## 10. 测试策略

- **零依赖单测**(纯逻辑):crypt roundtrip(临时 key 注入);只读分类器用例表
  (清单内/外、管道混合、`;`/`&&`/反引号/`$()`/重定向/换行注入、VAR 前缀);
  环形缓冲「写 N 行 → 快照 → 续写 → 重连回放断言」;store 落库密文 + API 脱敏断言;
  pool key 与空闲回收逻辑。**ssh2 mock 按其真实 API 形状编写,不凭猜**。
- **vitest 组件测**:`WorkbenchServers` 表单校验/暴露开关/审批策略联动;
  `SshTerminal` 重连回放状态机(mock WS)。
- **活体回归**:测试脚本注释附本地 sshd 容器一行命令
  (`docker run -d -p 2222:22 …`),配手测清单(需真实服务器/容器环境)。
- 基线:`npm test` + `npm run test:unit` + `npm run typecheck` 照常全绿。

## 11. 分期交付(每期独立可合并)

| 期 | 内容 | 交付物 |
|----|------|--------|
| T1 | 服务端底座 + 管理页 | crypt/store/routes/test-connection + `WorkbenchServers.vue`(CRUD+测试连接+暴露开关)+ CLAUDE.md 依赖登记 |
| T2 | 终端 | pool + `/api/ssh/terminal` WS + 环形缓冲回放 + `SshTerminal.vue` + FloatingWindow 集成 |
| T3 | AI exec | `wb_ssh_exec` + 只读分类器 + 审批接入 + 系统提示注入 |
| T4 | SFTP + AI 读文件 | `sftp.mjs` + 文件浏览/上传/下载(进度)+ `wb_ssh_read_file`(共用 sftp.mjs,故与 T4 同期) |

各期完成标准:对应测试全绿 + 该期手测清单通过(需服务器环境的项显式标注留待用户)。

## 12. i18n 与惯例

- 新增视图路由 meta `titleKey`(`nav`/`workbench.servers` 命名空间),zh/en 双语同步;
  消息值含 `@` 须转义 `{'@'}`、含 HTML 须 v-html(既有约定)。
- 提交:作者 `aliangone`,禁 Co-Authored-By 尾注;`docs/superpowers/` 路径 `git add -f`。
- 终端主题单一来源 `src/styles/code-theme.js`;字号阶梯遵守 token 约定。
