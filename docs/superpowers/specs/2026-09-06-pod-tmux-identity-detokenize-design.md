# Pod 终端 tmux 身份去 token 化设计

- 日期:2026-09-06
- 状态:已裁决(方案 A1,用户 2026-09-06 批准)
- 关联:`docs/superpowers/specs/2026-09-05-terminal-lifecycle-design.md`(生命周期总设计,本篇是其 §8 P2 的身份部分);事故线 `ssh-session-loss-incident`「D1 tmux 身份去 token 化」

## 1. 问题

Pod 持久终端的 tmux 身份完全派生自 K8s session token:

- socket 名 `tmuxLabel(token)` = `ab` + sha256(token) 前 8 位
- session 名 `tmuxSessionName(token, sid)` = `ab{hash8(token)}-{sid}`

而 K8s token 必然轮换:重连集群当场删旧行(CSO #11,`auth.mjs` connect-cluster),TTL 到期由 sessionSweeper 周期删行。轮换后新 token 算出的 socket/名全新 → `has-session` miss → `new-session` 全新 shell。表现为 **「chip 还在,内容变成新 shell,历史无感归零」**。

rekey(v1.0.22 引入的 DB 记录迁移)在此流程下结构性失效:

1. 前置校验 `isKnownSessionToken` 查 `sessions` 表,而轮换**当场**删了旧行 → 恒 403;
2. 即使迁移成功,rekey 只迁 `terminals`/`file_browsers` 行,远端 tmux 仍在旧 socket 里,身份断裂照旧。

## 2. 裁决:身份锚 = 平台 userId(方案 A1)

tmux 的 socket 与 session 名改从**平台 userId**(platform_users.id,UUID,跨轮换/跨重启稳定)派生:

```
tmuxLabel(anchor)        = 'ab' + sha256(anchor) 前 8 位      // anchor = userId
tmuxSessionName(anchor, sid) = 'ab' + hash8(anchor) + '-' + sid
```

- 函数签名不变(本就接受任意字符串做锚),仅调用点把 token 换成 userId;
- 隔离语义不变:一平台用户一 tmux socket(今天只是拿 token 当用户的代理);
- `handleExec` 已能拿到 `session.userId`(W2-0 起 sessions 行带 userId)——身份锚零新增依赖;
- token 轮换与 tmux 彻底解耦:rekey 只需迁 DB 行,远端 tmux 天然不动。

### 否决的备选

- **A2(token 锚 + rekey 时 rename-session)**:改名只在同一 socket 内有效;轮换后 socket 名本身变了,新 token 的 exec 找不到旧 socket——死路。
- **B(全局单 socket + 纯 sid)**:丢失 per-user socket 隔离(有意设计),跨用户会话名可见面变大。

## 3. 配套:轮换墓碑表(解 rekey 死结)

轮换/TTL 过期不再硬删 `sessions` 行,改为「先落墓碑、再删行」:

```sql
CREATE TABLE IF NOT EXISTS rotated_sessions (
  token      TEXT PRIMARY KEY,
  userId     TEXT NOT NULL,
  rotatedAt  INTEGER NOT NULL
)
```

- 写入点:①connect-cluster 轮换(auth.mjs,替换现 DELETE);②sessionSweeper 的 TTL 过期删行(逐行落墓碑);
- 读取点:`isKnownSessionToken` = `sessions` 行 **OR** `rotated_sessions` 行(rotatedAt 在 7 天内);
- 清扫:7 天后随墓碑清理(与窗口记录 30d 保留语义对齐;7 天 = 会话策略校验上限,三方自洽同 lifecycle spec O1);
- 安全收紧:rekey 处理时校验「from 的属主 == 当前平台用户」(live session 的 userId 或墓碑行 userId 必须等于 ps.userId)——墓碑化后旧 token 可被出示,属主校验防「猜 token 吸收他人记录」的旧攻击面回潮。

> 注:rekey 仍只迁 DB 行;D1 之后远端 tmux 不再依赖 token,无需任何远端动作——这正是 A1 消灭死结的方式。

## 4. 改动面

| 位置 | 改动 |
|---|---|
| `server/tmux-session.mjs` | 纯函数签名不动;`hashToken`/`tmuxLabel`/`tmuxSessionName` 文档锚语义改 userId;测试补「同用户不同 token → 同名」「不同用户 → 不同名」 |
| `server/index.mjs` handleExec | `tmuxLabel(token)`/`tmuxSessionName(token, sid)` → `tmuxLabel(session.userId)`/`tmuxSessionName(session.userId, sid)`;idleTracker meta 存 userId(替代 token) |
| `server/index.mjs` idle sweeper | label 由 `meta.userId` 派生 |
| `server/index.mjs` DELETE/kill 路径(2000-2005 区) | 同上换锚;`meta.userId` 来源 = 建 tracker 时的 session.userId |
| `server/routes/auth.mjs` connect-cluster | 轮换删行前落墓碑(`rotated_sessions`) |
| `server/index.mjs` sessionSweeper | TTL 过期删行前落墓碑;周期清 7d 外墓碑 |
| `server/window-records.mjs` | `isKnownSessionToken` 扩墓碑表;rekey 处理加属主校验(ps.userId vs 墓碑/live 行 userId) |
| schema | `rotated_sessions` 建表(try-ALTER 风格同既有);清扫入 sessionSweeper |

## 5. 升级语义(一次性损失,已裁决接受)

升级(拉新镜像/重启网关)后,存量 pod 的 tmux 会话活在旧 `ab{hash8(token)}` socket 里,新锚下 `has-session` miss → 各终端首次重连得全新 shell 一次。跨 socket 物理不可迁移(tmux 会话无法跨 socket 搬运);此后该 pod 在整个生命周期内身份稳定,直至 pod 重启(丢失=既有已知限制,非本设计引入)。

## 6. 测试计划

| 层 | 用例 |
|---|---|
| tmux-session 纯函数 | 锚无关性:同 userId 不同 token 上下文 → label/name 相同;不同 userId → 不同;含旧形态回归 |
| rotated_sessions 路由流(spawn 网关) | 连接→开终端→重连集群(轮换)→rekey 200 且 DB 行迁移;伪造 from(他人 token/墓碑外 token)→ 403;墓碑 7d 外 → 403 |
| sessionSweeper | TTL 过期行落墓碑后才删;墓碑 7d 清扫 |
| 回归 | 既有 rekey/isKnownSessionToken 用例全绿 |

## 7. 非目标

- SSH 侧 TerminalService(身份已是 sid 锚,无 token 问题;其内存态/持久化属 lifecycle spec §8 P2/P3 另批)
- tmux 失败降级策略(#5,已知取舍)
- 跨 socket 存量 tmux 迁移(物理不可行,§5)
