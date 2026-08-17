# fastMode 高频总时长封顶(稳态半就绪负载不再永久 3s)

- 日期:2026-08-17
- 状态:设计已获用户确认(一句话方案:cap=5min+抑制闩锁)
- 分支:`feat/fastpoll-cap`(worktree,基于本地 main 3eda3d2)
- 前置:`docs/superpowers/specs/2026-08-16-ns-overview-adaptive-polling-design.md`(本特性是其遗留 Important-2 的闭环)

## 1. 问题

稳态半就绪负载(如 crashloop 卡在 ready 1/2:ready<desired 恒成立,但 generation/updated 已收敛)会让 `isWorkloadTransitioning` 永真 → `fastMode` 永真 → NsOverview 页面聚焦期间持续 3s 六路 list 请求 + 徽标长期误显「部署进行中」。

## 2. 设计(已确认 + 两处加固)

`useDeployFastPoll(source, { holdMs = 10000, maxFastMs = 300000 })`:

- **封顶 timer**:fast 真上升沿(slow→fast)启动;到点(默认 5 分钟)强制 `fastMode = false` 并置 `suppressed = true`,同时清回落 timer
- **抖动不续命**(加固①):fast 期间 busy 抖动(true→false→true,10s 保持期内 re-trigger)**不重置**封顶 timer——封顶按「整段突发」计;否则卡死负载的计数抖动会让 5 分钟永远到不了
- **抑制期**:suppressed 期间 rising 边沿被忽略(维持 30s),且会取消进行中的解除计时
- **解除**(加固②):需**连续 holdMs(10s)平静**(busy 持续 false)才清 suppressed 重新武装;单次 false 抖动不算——之后新部署正常进 fast 且额度完整
- **短会话重置**:自然收敛回落(10s 保持到点)时清封顶 timer——上一会话不占用下一会话额度
- 页面零改动(徽标随 fastMode 自动熄灭);API 仅新增可选参数 `maxFastMs`,默认值即生效;常量 `MAX_FAST_MS = 300000` 导出

状态机全表(busy=检测值;fall timer=10s 平静计时,兼做收敛保持与抑制解除):

| 当前态 | busy | 动作 |
|---|---|---|
| slow,未抑制 | true | 进 fast;启动封顶 timer |
| slow/fast,抑制期 | true | 忽略 rising;若解除计时进行中则取消 |
| 任意 | false | 起 fall timer(若未在计);到点:fastMode=false、清封顶 timer、清 suppressed |
| fast(含 10s 保持期内 re-trigger) | true | 清 fall timer;**不重置封顶 timer** |
| fast,封顶 timer 先到 | — | fastMode=false + suppressed=true、清 fall timer |

## 3. 测试

vitest fake timers 追加用例(既有 6 用例不回归):
1. busy 持续 true 满 5min → 强制回落并进入抑制;抑制期 rising 被忽略(含「短暂平静 5s 后又 busy」取消解除计时的场景)
2. 连续 10s 平静 → 抑制解除;再 busy 正常进 fast 且有完整 5min 额度
3. **抖动不续命**:fast 期间 busy 每 3s 抖动一轮(false 瞬时→true),30 轮后封顶计时不被重置,累计 5min 照样触发
4. 既有用例(上升沿立即/收敛保持/保持期内取消回落/连续收敛不叠加/卸载清理)全绿

## 4. 范围外

- 徽标对「被封顶但仍在部署中」的额外提示(卡片 Updating 状态已可见)
- holdMs/最大封顶的运行时可配 UI
