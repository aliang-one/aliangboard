# 版本机制与更新检测设计(tag 即版本 → 镜像烙版本 → 检测 GitHub tag → 横幅提示)

日期:2026-08-27 · 来源:用户需求(开源平台无版本机制,希望 tag 驱动版本 + 自动检测更新)· 状态:已对齐

## Context / 现状

- CI 已 tag 驱动:`.github/workflows/docker.yml` 在 `v*` tag 触发,产 ghcr 镜像 `latest`/`1.2.3`/`1.2`(origin 已有 v1.0.3–v1.0.7)。
- 缺口:① 版本号没进镜像(package.json 恒 `1.0.0`,Dockerfile 无 ARG,`/api/health` 不带版本);② 无更新检测;③ 前端无处显示自身版本。
- 已裁决:**仅检测+提示**(不做自动升级);提示形态=**横幅一次(可关)+ Settings 常驻**;检测通道=**网关代理**(方案 A,出网能力已被 `/api/registry/tags` 验证)。
- 仓库:https://github.com/aliang-one/aliangboard

## 设计

### 1. 版本注入链路(CI → 镜像 → 运行时)

```
git tag v1.2.3 + push → docker.yml 触发
  └─ build-push-action 加 build-args: VERSION=<metadata-action 解析出的 semver 版本>
       └─ Dockerfile: ARG VERSION=dev / ENV APP_VERSION=${VERSION}
            └─ server/version.mjs 读 process.env.APP_VERSION,默认 'dev'   ← 单一事实源
```

- `docker.yml`:build-push step 加 `build-args: VERSION=${{ steps.meta.outputs.version }}`(tag 构建=纯 semver;workflow_dispatch 手动构建无 semver → 空 → Dockerfile 默认 `dev`)。
- `package.json` 的 `"version"` 不动、不参与(非事实源)。
- `/api/health` 响应加 `version` 字段(`server/version.mjs` 导出):`{ ok, service, time, version }`,向后兼容,探针无感。

### 2. 检测端点 `GET /api/version` + `POST /api/version/check`

新建 `server/routes/version.mjs`(routes/ dispatcher 模式,index.mjs 已 2000+ 行不往里塞),`server/index.mjs` 接线。

- **鉴权**:`requirePlatform`(登录后)——触发出网 fetch 的端点不匿名开放;healthcheck 只打 `/api/health` 不受影响。
- `GET /api/version`:读穿缓存,返回 `{ current, latest, hasUpdate, checkedAt }`。
- `POST /api/version/check`:强制绕过缓存重拉(Settings「立即检查」用;避免 GET 带副作用的语义争议)。
- **检测逻辑**:fetch `https://api.github.com/repos/aliang-one/aliangboard/tags?per_page=100`(undici,10s 超时,`Accept: application/vnd.github+json`);过滤严格 semver(`^v\d+\.\d+\.\d+$`),**在拉到的全量里取最高**(API 按创建时间倒序非 semver 序;`v1.10.0 > v1.9.0` 数值比较);**内存缓存 TTL 1h**(全客户端共享,不碰未认证限流 60/时)。
- **版本号归一化(单一规则)**:比较与持久化一律用**去 `v` 前缀**的规范形(`1.2.3`);展示时前端加 `v` 前缀。meta 注入的 `1.2.3` 与 GitHub tag 的 `v1.2.3` 经此规则天然可比;横幅关闭记录、dismiss 判等都用规范形。
- **比较与降级**:`hasUpdate = latest && current !== 'dev' && semverGt(latest, current)`(dev 不比版本,横幅恒不弹);出网失败/403 限流/解析失败 → 仍 200 返回 `{ latest: null, hasUpdate: false }`,错误态缓存 TTL 5min(避免每次请求都撞 10s 超时)。
- 用户可见文案走 `server/messages/api.mjs` 双语表(新增 `api.version.*`)。

### 3. 前端数据层

- `src/api/client.js`:`getVersion()` / `checkVersion()`(走 `http.js`,自动带平台 token)。
- `src/composables/useAppVersion.js`:`useQuery({ queryKey: ['app-version'], queryFn: getVersion, staleTime: 30 * 60_000 })`(服务端 1h 缓存兜底;refetchOnWindowFocus 用全局默认;手动检查=POST check 后 invalidate)。

### 4. 更新横幅 `UpdateBanner.vue`

- 挂 `AppLayout.vue` 集群健康横幅同位置(TopNavBar 下方),视觉同款、primary/info 色(非 error 色):图标 + 「发现新版本 v1.1.0」 + 链接 + 关闭 ✕。
- 链接指向 **tags 页**(`https://github.com/aliang-one/aliangboard/tags`)——项目暂不建 GitHub Release,releases 页会是空的,tags 页恒有内容。
- 渲染条件:`hasUpdate === true` 且未关闭过该版本;未登录不渲染。
- 关闭持久化:`localStorage['ab.updateBannerDismissed'] = '1.1.0'`(规范形,去 v 前缀)——只记版本号,更新版本再弹(「横幅一次」=每版本一次)。

### 5. Settings「关于」tab

现有 tab 机制加 `about`:

| 行 | 内容 |
|---|---|
| 当前版本 | `v1.2.3`(font-mono;dev 构建显示 `dev` + 灰色「开发构建」标) |
| 最新版本 | `v1.3.0`;检测失败显示「检测失败(内网/限流)」灰字 |
| 操作 | 「立即检查」按钮(转圈态)→ POST check → 刷新 |
| 升级指引 | 可复制 kubectl 一行(`kubectl set image deployment/aliangboard aliangboard=ghcr.io/aliang-one/aliangboard:<最新版> -n aliangboard`)+ tags 链接(deployment.yaml 现为 `latest` 单副本,锁版本/升级均可用此命令) |

i18n:zh/en 全量新增键(`settings.about.*` / `layout.updateBanner.*`),过 `npm run i18n:check` 门禁。

### 6. 错误处理汇总

| 场景 | 行为 |
|---|---|
| 网关出网失败 / 403 限流 / GitHub 5xx | 端点仍 200,`latest: null`;横幅不弹;Settings 显示「检测失败」;错误态缓存 5min |
| dev 构建 | `latest` 照常拉取展示,`hasUpdate` 恒 false |
| 前端 query 网络失败 | 静默(横幅条件渲染不成立,无 toast 打扰) |
| 未登录 | query 不启用,无横幅 |

## 测试(TDD)

- **服务端** `server/routes/version.test.mjs`(node --test,mock `globalThis.fetch`,npm test 自动收):
  - semver 取最高边界:`v1.10.0 > v1.9.0`;非 semver(`v1.0.0-rc1`/`nightly`)过滤;空列表/全非 semver → null。
  - 缓存:TTL 内二次请求不打 fetch;`check` 绕过;错误态 5min 短 TTL。
  - 降级:fetch 抛错/403/超时 → 200 + `latest: null`。
  - `hasUpdate`:dev 恒 false;`current > latest` false;未登录 401。
- **前端** vitest:
  - `UpdateBanner`:有更新未关→渲染;关闭→写 localStorage 且消失;`hasUpdate=false`/`latest=null`→不渲染;同版本已关→不渲染。
  - Settings about tab:渲染当前版本;「立即检查」调 POST 后刷新。
- **CI 文件**:docker.yml/Dockerfile 改动极小(build-args 一行 + ARG/ENV 两行),无本地可跑测试,靠下次发版 tag 实跑验证。

## 验证

门禁四连(typecheck/i18n:check/test/test:unit);发版手测:打 tag → Actions 构建日志确认 `VERSION=` 传入 → 起该镜像 `curl /api/health` 看 version → 登录看 Settings 关于 tab + 横幅(先用假 current 验证 hasUpdate 弹横幅,再关横幅验证 localStorage)。

## 明确不做(YAGNI)

- 不做自动升级/一键改 Deployment(仅提示;运维自行 kubectl)。
- 不校验 tag 必须打在 main(信任 `v*` tag;GitHub API 不直接给 tag 所属分支,校验成本高收益低)。
- 不做 Release notes 展示(需先建 Release 发布流程;端点形状向前兼容,留作 follow-up 升级到 /releases/latest)。
- tags 超 100 个的分页拉取(YAGNI,几年后再说)。
