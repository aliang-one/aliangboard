# Secret 值脱敏(工具层全掩码 + 值指纹 + 存量清洗) 设计

- 日期:2026-08-28
- 状态:已评审(brainstorming 三问定案),待实施
- 范围:AI 工作台工具链 + MCP 暴露层的 Secret 明文治理

## 1. 背景与问题

`wb_get_resource` / `wb_describe_resource` / MCP `get_resource` / `get_resource_yaml` / `describe_resource` / **@-mention 注入(fetchRefContext)** 六条路径读到 Secret 时,`data`/`stringData` 明文全程流转:进 LLM 请求(第三方 API 出域)、进 conv.trace 落库、进 SSE、进 ToolCallModal 展示。历史对话的 trace 里已积累明文。

## 2. 决策记录(brainstorming 定案)

| # | 决策 | 选择 |
|---|------|------|
| D1 | 脱敏口径 | **工具层全掩码 + 值指纹**:字段名保留,值 → `*** (<N> chars, #<fp8>)`;N=base64 解码后字符数(解码失败回退原文长度),fp8=sha1(解码后字节)前 8 hex。AI 保留 key 名核对/同值比对/长度判断能力,只断明文通路。核明文去平台 Secret 页面(既有成熟脱敏展示) |
| D2 | 掩码边界 | **MCP 一致掩码**(安全边界统一;`reveal_secret` 显式 admin 档工具记 backlog 不做) |
| D3 | 存量明文 | **启动时后台异步清洗**(幂等可重入,非阻塞;audit_log 不动——审计凭证+hash 链不可改写) |

## 3. 架构

### 3.1 掩码函数:`server/secret-mask.mjs`(新,纯函数)

```js
maskSecretResource(resource)   // kind==='Secret' → 新对象,data/stringData 值替换为掩码形状;
                               // 非 Secret → 原引用返回(零开销);不 mutate 入参
MASK_PATTERN                    // 掩码形状正则(幂等判据+测试用)
```

- 值处理:非字符串 `String()` 归一;`Buffer.from(v, 'base64')` 尝试解码(容量:值可能几 KB,sha1 开销可忽略)。
- **幂等**:已是掩码形状的值再掩不变(清洗可重入;实现上 decode 失败回退原文长度路径天然收敛——掩码串非合法 base64?**设计为**:先 `MASK_PATTERN.test(v)` 命中则原样返回该值,显式幂等短路)。

### 3.2 工具层接入(五条新增路径)

| 路径 | 文件:位置 |
|------|-----------|
| `wb_get_resource` / `wb_describe_resource` | `server/index.mjs` buildWbCtx 内,返回前 `maskSecretResource(body)` |
| MCP `get_resource` / `get_resource_yaml` / `describe_resource` | `server/api-key-tools.mjs` 同款;yaml 工具在 `yamlDump(body)` 前掩 |
| @-mention 注入 | `fetchRefContext`(index.mjs)拉到的 body 掩后再拼 context——前端 ResourceCard 展示同源因此安全 |
| 工具描述提示 | `server/tool-registry.mjs` get_resource/describe_resource/get_resource_yaml 的 description 追加一句:「Secret values are returned as masked fingerprints (length + sha1-8); check plaintext in the platform Secrets page」——LLM 知道语义并引导用户 |

不做:apply_yaml 用户自提交内容不掩(用户自己的输入回显);list 类只回名字无需;Pod env 明文/annotation heuristic 扫描(误报无底洞)backlog。

### 3.3 存量清洗:`server/secret-scrub.mjs`(新)

```js
scrubSecrets(db)   // 扫 workbench_conversations.trace + workbench_messages.trace:
                   // JSON.parse → 逐事件 result.resource.kind==='Secret' → maskSecretResource 重掩 → 写回
                   // 返回 { rowsScanned, eventsMasked }
```

- 幂等(掩码形状短路);单行 parse 失败跳过并 console.warn,不阻塞。
- 挂载:`server/index.mjs` 启动序列 `salvageInterrupted(db)` 之后,`setTimeout(scrub, 2000)` 异步跑,console 输出统计;不 await(非阻塞启动)。
- **audit_log 不动**(凭证+hash 链)。

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| data 值非字符串 | String() 归一后掩 |
| base64 不可解码 | N 回退原文长度,指纹用原文字节 |
| trace 行 JSON 损坏 | 跳过 + console.warn |
| 掩码函数抛错(防御) | 工具调用失败按既有错误链路返回(不静默放明文) |

## 5. 测试计划

- **secret-mask 单测**:掩码形状(key 保留+指纹格式)/非 Secret 原引用/非字符串值/解码回退/幂等(双跑不变)/不 mutate 入参
- **MCP 侧**:mock requestFn 返回 Secret → `get_resource`/`get_resource_yaml` 值为掩码形状、字段名在、明文不在
- **wb 侧活体 e2e**:k8s mock 返回 Secret → wb_get_resource 工具结果 + @secret refContext 均无明文(复用 wb-roundtrip harness,新增 secret 场景)
- **清洗**::memory: 预置明文 trace → 跑 → 掩码;再跑 → eventsMasked=0(幂等);损坏行跳过
- **回归**:既有 1355+ 单测全绿(掩码不破坏非 Secret 路径)

## 6. 开放问题

无(三问全定案;reveal_secret/heuristic 扫描已记 backlog)。
