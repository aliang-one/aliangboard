# fastMode 高频总时长封顶(稳态半就绪负载不再永久 3s)

- 日期:2026-08-17
- 状态:设计已获用户确认(一句话方案:cap=5min+抑制闩锁)
- 分支:`feat/fastpoll-cap`(worktree,基于本地 main 3eda3d2)
- 前置:`docs/superpowers/specs/2026-08-16-ns-overview-adaptive-polling-design.md`(本特性是其遗留 Important-2 的闭环)

## 1. 问题

稳态半就绪负载(如 crashloop 卡在 ready 1/2:ready<desired 恒成立,但 generation/updated 已收敛)会让 `isWorkloadTransitioning` 永真 → `fastMode` 永真 → NsOverview 页面聚焦期间持续 3s 六路 list 请求 + 徽标长期误显「部署进行中」。

## 2. 设计(已确认)

`useDeployFastPoll(source, { holdMs = 10000, maxFastMs = 300000 })`:

- **封顶 timer**:fast 上升沿启动;到点(默认 5 分钟)强制 `fastMode = false` 并置 `latched = true`,同时清回落 timer
- **抑制闩锁**:latched 期间检测仍 busy 也不再进入 fast(封顶后数据仍 transitioning 会立即重开,白封);卡死负载从此回 30s
- **解除**:某次检测 busy=false → 清闩锁、重新武装;之后新部署正常进 fast
- **短会话重置**:自然收敛回落(10s 保持到点)时清封顶 timer;每次上升沿重置计时——上一会话不占用下一会话额度
- 页面零改动(徽标随 fastMode 自动熄灭);API 仅新增可选参数 `maxFastMs`,默认值即生效;常量 `MAX_FAST_MS = 300000` 导出

状态机全表(busy=检测值):

| 当前态 | busy | 动作 |
|---|---|---|
| slow,未闩锁 | true | 进 fast;启动封顶 timer |
| slow,闩锁 | true | 忽略(维持 30s) |
| 任意,闩锁 | false | 清闩锁(重新武装);fast 态则同时走正常回落 |
| fast | true(持续) | 无动作(封顶 timer 计时中) |
| fast | false | 起 10s 回落 timer(到点 fastMode=false,清封顶 timer) |
| fast,封顶 timer 先到 | — | fastMode=false + latched=true |

## 3. 测试

vitest fake timers 追加用例(既有 5 用例不回归):
1. busy 持续 true:fastMode 立即 true → advance 5min → 强制 false;此后仍 busy 不再 true(闩锁)
2. 闩锁后 busy 变 false → 闩锁解除;再 busy → 正常进 fast
3. 短会话(2min 后收敛+10s 回落)→ 再 busy:完整 5min 额度可用(封顶 timer 已清)
4. 既有用例(hold/取消回落/卸载清理)全绿

## 4. 范围外

- 徽标对「被封顶但仍在部署中」的额外提示(卡片 Updating 状态已可见)
- holdMs/最大封顶的运行时可配 UI
