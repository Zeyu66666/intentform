# `fixtures/replays/` · 回放 fixture 的目录约定

> 契约文件。改这里的任何一条，等于改 `AGENTS.md` §7 里"不可擅自更改的协议"。
> 实现方：`packages/llm`（录制 / 回放 / 键计算）。使用方：`server`（`replay` 模式）、`scripts/eval`（I6）。

## 1. 目录内容

```
fixtures/replays/
├── README.md                 ← 本文件（约定，不是 fixture）
├── <hash>.ndjson             ← 上游 chunk 流（一行一个 chunk）
└── <hash>.meta.json          ← 该 fixture 的来源元数据（评审用它判断 fixture 是否真实）
```

一个 `<hash>` 必须同时有 `.ndjson` 与 `.meta.json`，缺一个视为损坏，`replay` 模式必须报错而不是静默回落。

## 2. `<hash>` 怎么算

```
key     = normalize(requirement) + "\u0000" + model + "\u0000" + promptVersion + "\u0000" + "v" + schemaVersion
<hash>  = sha256(key) 的**完整 64 位小写十六进制**
```

- `normalize(requirement)`：`NFC` → 换行统一为 `\n` → 行内连续空格/制表符/全角空格折叠为一个半角空格 → 每行去首尾空白 → 连续 3 行以上空行折叠为 1 个空行 → 整体去首尾空白。
  **先规范化再入 hash**：否则教师多打一个空格就换一个键，回放必然未命中（`AGENTS.md` §7）。
- `model` 用请求里真正发给上游的模型名（如 `deepseek-chat`），不是"chat 模型"这类别名。
- `promptVersion` 是 `prompts/*.md` 文件名里的版本号（如 `generate.v1`），不是 commit hash。
- `schemaVersion` 取 `@intentform/schema` 的 `SCHEMA_VERSION`，前面加 `v`。FormSchema 形状变了，旧 fixture 的合法性不能复用。
- **不截断 hash**。截断到 16 位看起来好看，但一旦两条 fixture 撞前缀，回放会静默播放错误的流。

## 3. `<hash>.ndjson` 的格式

**不是** SSE 事件（那是 `@intentform/schema` 的 `sse-events.ts`）。这里是上游原始增量，用来原样重放给 `LineSplitter`：

```
{"d":"{\"type\":\"section\",\"id\":\"sec1\"","dt":0}
{"d":"...\"}\n{\"type\":\"single\",","dt":128}
{"d":"...\"}\n","dt":37}
```

| 字段 | 类型 | 含义 |
|---|---|---|
| `d` | `string` | 上游返回的 `choices[0].delta.content` 原文，**原样保留**（含 `\n` 与中文，不转义成 `\uXXXX` 之外的形式——`JSON.stringify` 的默认行为即可） |
| `dt` | `int ≥ 0` | 该 chunk 到达前相对上一 chunk 的延迟（毫秒）。`1x` 按它播放，`2x` 除以 2，`instant` 忽略 |

约束：

- 文件以 `\n` 结尾，一首一尾不留空行；空文件视为损坏。
- 一行一个 JSON 对象，不允许数组包装、不允许注释。
- `dt` 之和 + 首行延迟 = 录制时的总耗时；`meta.totalMs` 必须与之相差不超过 10%（CI 校验，防止手改文件）。

## 4. `<hash>.meta.json` 的格式

```json
{
  "recordedAt": "2026-10-26T09:12:33.000Z",
  "model": "deepseek-chat",
  "promptVersion": "generate.v1",
  "schemaVersion": 1,
  "requirementHash": "<64 位 hash，等于文件名>",
  "requirementPreview": "规范化后需求的前 80 个字符",
  "chunks": 42,
  "totalMs": 8100,
  "usage": { "promptTokens": 812, "completionTokens": 1904 },
  "upstream": "openai-compatible:api.deepseek.com",
  "mode": "record"
}
```

- **必填**：`recordedAt`、`model`、`promptVersion`、`schemaVersion`、`requirementHash`、`chunks`、`totalMs`、`usage`、`upstream`、`mode`。
  前四项就是《计划 v2.0》§3.7 要求的那组，用来证明 fixture 来自真实运行；后六项是我们加的，用来让人在评审时不读代码也能判断这份文件可不可信。
- `recordedAt` 必须是录制那一刻的 UTC 时间（`toISOString()`），**不允许手填未来时间**。
- `upstream` 记录实际打到的上游主机（`openai-compatible:<host>`）。若用本地 OpenAI 兼容 stub 录的，就写 `local-stub:<host:port>`——**如实标注**。评审看到 `local-stub` 会知道这不是真实模型输出，看到 `openai-compatible:api.deepseek.com` 才知道是。编造这一行比没有这一行更糟。
- `mode` 只能是 `record`。`mock` 产出的流不许进 `fixtures/replays/`（mock 是确定性模板，不是录制）。
- `usage` 从上游 `usage` 字段取；上游没给就写 `{ "promptTokens": 0, "completionTokens": 0 }` 并在 `meta` 里补 `"usageSource": "estimated"`。

## 5. 命名与预算

- 仓库里的 fixture 上限 3 条（I2 收口标准），对应生成页的 3 个「预置需求」按钮。加第 4 条要先改计划。
- 每条 fixture 的 `.ndjson` 不得大于 256 KB；超了说明录了一段超长输出，应当拆需求而不是放宽上限。
- fixture 与需求文本必须一一对应：`requirementPreview` 改不了 hash，改动需求文本必然要重录。

## 6. 校验命令

```bash
# 目录自检（I2 收口后可用）
node scripts/check-fixtures.mjs
```

自检项：`<hash>` 与 `requirementHash` 一致、有 `.ndjson` 必有 `.meta.json`、`chunks` 等于行数、`totalMs` 与 `dt` 之和相差 ≤10%、`mode` 为 `record`、文件大小 ≤256 KB。

> 说明：`scripts/check-fixtures.mjs` 由 I2 的 `llm-pipeline` 一并交付（挂在 `pnpm check` 之后的可选步骤，不进 CI 必需路径）。
