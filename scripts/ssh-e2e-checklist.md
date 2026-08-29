# SSH 功能手测清单(需真实 sshd;CI 不覆盖正向路径)

本地联调环境(任选其一):
- docker run -d --name ab-sshd -p 2222:22 -e PASSWORD_ACCESS=true -e USER_PASSWORD=pass123 -e USER_NAME=ops linuxserver/openssh-server:latest
- 或对任一已有 VM/物理机。

## T1 管理
- [ ] 添加服务器(password 认证)→ 列表出现,「已录入」徽标正确
- [ ] 添加服务器(privateKey 认证,带 passphrase)→ 保存成功
- [ ] 编辑:密码留空保存 → 试连仍通(留空=保持语义)
- [ ] 测试连接:错误密码 → 「认证被拒」;错误端口 → 「不可达」;正确 → 「连接成功」
- [ ] 删除服务器 → 列表消失
- [ ] 非管理员登录 → 服务器 tab 只读(无新增/编辑/删除按钮),终端/文件可用

## T2 终端
- [ ] 打开终端 → 登录提示符出现,tab 补全/方向键/vim 可用
- [ ] **刷新页面 → 从服务器 tab 重新打开终端 → 历史回放出现,续跑同一 shell(ps 可见同一会话)**
- [ ] 最小化终端窗口 → 后台 `yes > /dev/null` 类长驻命令不被打断(最小化保持连接)
- [ ] 双开两台服务器终端 → 各自独立;关闭浮窗再开 → 新会话(或回放,依网关保活窗口)
- [ ] 首连后检查 DB:`hostKeyFingerprint` 已写入;人为改指纹 → 重连被拒且 UI 提示
- [ ] 网关重启 → 终端收到「会话已终止」提示

## T3 AI
- [ ] 无暴露服务器:agent 工具列表无 wb_ssh_exec/wb_ssh_read_file;提示词无服务器段
- [ ] 零暴露部署回归:未配置任何 SSH 服务器时,对话创建与 admin AI 配置页正常(ssh_servers 表缺失/清单读取失败降级为空清单,见 3d702d5)
- [ ] 暴露一台(always):「去 xx 看看磁盘」→ 审批弹窗显示服务器名+命令;拒绝 → agent 收到拒绝
- [ ] 策略改 readonly:「看看内存」免审批直跑;「重启 nginx」走审批
- [ ] 策略 none:写命令直跑(审计可见)
- [ ] sudo:true 且已存 sudo 密码 → sudo -S 生效;未存 → agent 收到明确报错
- [ ] 服务器名重名(两台同名)→ agent 收到候选清单并询问
- [ ] 审计:audit_log 出现 ssh.exec(server/命令/退出码),无凭据明文

## T4 SFTP
- [ ] 文件浏览:目录导航/面包屑/空目录提示
- [ ] 下载 10MB 文件 → 进度条推进,内容一致(md5)
- [ ] 上传 10MB 文件 → 进度推进,远端 md5 一致
- [ ] 中文文件名 roundtrip 正常

## 指纹/密钥边界
- [ ] 删除 data/ssh-crypt.key → 列表标记「凭据不可用」,试连/终端均报「凭据密钥不可用」;恢复密钥后复原

## 已知延后项(backlog,终审 2026-08-28 裁决不阻塞合并)

- [ ] routes.mjs 两处 writeAudit 直调(文件内 audit 助手是 `?.` 保护形态,统一之)
- [ ] 试连 unreachable 文案内插原始 ssh2 错误文本(可只留 errorKind+本地化壳)
- [ ] 前端清除主机密钥指纹后未 invalidateQueries(列表指纹列短暂陈旧)
- [ ] 编辑表单 authMethod 切换但不带新凭据 → 可存出「必败」行(建议联动校验)
- [ ] 编辑表单无法显式清除已存 sudo 密码(store 支持 null,表单不发)
- [ ] 审批挂起期间策略被改为 none + 用户拒绝 → denied-resume 二道闸会放行(建议 checkpoint 过的调用 denied resume 恒拒)
- [ ] 分类器短旗标组合(date -us/dmesg -cc)与 ping -f 不拦(审批闸非沙箱,显式可扩展 deny 表)
- [ ] 手测清单全部条目(需真实 SSH 服务器环境)
- [ ] 已知偶发:两个 spawn 真网关的集成测试(routes.test/ws-handshake.test)在全量并跑高负载下偶发竞态失败(单跑/复跑均绿,2026-08-28 合并日复现一次;必要时加启动重试或串行标注)

## 已完成(2026-08-29 二轮清理)
- [x] exec-bridge 测试隔离(ALIANG_DB 临时目录+失败早暴露)——正式网关运行中亦可全量验证
- [x] routes.mjs 试连审计统一走 audit 助手(reason 字段入审计)
- [x] 主机密钥清除后 invalidateQueries(指纹列即时刷新)
