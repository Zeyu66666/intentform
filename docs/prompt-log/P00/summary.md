# P00 · 架构约束注入

- 迭代：`I0` · 日期：`2026-10-26` · 涉及模块：仓库整体（`package.json`、`pnpm-workspace.yaml`、`tsconfig.base.json`、`AGENTS.md`、`.githooks/`）
- 会话导出：`raw-20261026-i0-bootstrap.md`（待导出，导出后过 `scripts/secret-scan.mjs` 并人工脱敏）

## 提问

我要求 AI 在**执行模式**下工作，不许输出计划或"下一步建议"，只给可落盘的文件内容与可执行命令。关键约束原文要点：

- 基线：pnpm monorepo、Node 20、TypeScript 全栈；前端 React 18 + Vite + Tailwind + Radix + KaTeX + ECharts；后端 Hono + better-sqlite3 + Zod + argon2 + nanoid。
- LLM 走 OpenAI 兼容协议，上游 SSE 必须手写 `fetch` 流式读取，**不引任何厂商 SDK**。
- 禁用库写死：LangChain、LlamaIndex、Vercel AI SDK、react-jsonschema-form、formily、amis、SurveyJS。
- **新增任何第三方依赖前必须说明理由并等确认，能不装就不装。**
- 一个工作单元 1–3 个 commit，每个 commit 必须能单独通过 `pnpm typecheck`。
- 密钥只存在服务端 `.env`；真实姓名、手机号、学校名不得入库。
- 本次交付：I0 的 4 个 commit（骨架 / 安全底座 / AGENTS.md / CI）。

我同时把两条"元约束"写进了提问里：一是要求 AI 先复述约束并指出与计划冲突的地方，二是在做不到时直接说做不到 + 给替代方案。这两条后续被固化成 `AGENTS.md` 第 8 节。

## AI 修改建议

AI 没有按"先规划再动手"的套路走，而是直接落盘。它给的方案与我预期不同的地方有四处，逐条记录取舍：

1. **零运行时依赖搭骨架**。AI 建议 I0 的 `server` 先不装 Hono，用 `node:http` 写一个 `/healthz` 探活端点，I4 再换 Hono 并保持同一路由契约。我采纳：这样能真正验证 monorepo 的跨包 import 是否通，又不违反"新增依赖要说明理由"。代价是 I4 要重写一次入口，但入口只有 80 行。
2. **`packages/schema` 里只固化稳定公开面**（七种字段种类、布鲁姆层级、`FormSchema` 顶层形状 + `assertNever`），把 discriminated union 的细节留给 I1。我采纳：避免 I0 与 I1 的 diff 互相污染，commit 边界更干净。
3. **gitleaks 不作为硬依赖**。AI 指出 gitleaks 是二进制，评委干净环境不保证有，建议自研 `scripts/secret-scan.mjs`（零依赖）兜 pre-commit 与 CI 的最低要求，装了 gitleaks 就优先用它扫全历史。我采纳，但把"自有规则"扩了一条它没提的：中国大陆手机号与身份证号（对应评审的脱敏要求）。
4. **AI 建议 CI 用 pnpm 9 固定版本**。我否决了这个建议的一半：本机是 pnpm 11，`pnpm-workspace.yaml` 里的 `allowBuilds` 是 pnpm 10+ 的键，pnpm 9 读它会有未知字段风险。最终 CI 用 pnpm 11.24.0（与本机、与 lockfile 一致），README 里注明"pnpm ≥ 9 可用，CI 固定 11.24.0"，并把这条不一致写进本轮风险，而不是假装基线与工具版本完全吻合。

## 我如何引导 AI 修复 Bug

本轮真实发生 4 个 bug，全部是我看 `tsc` 原文报错后把「报错 + 我的判断」一起回喂才修掉的：

1. `TS5083: Cannot read file 'D:/project1/intentform/packages/tsconfig.base.json'`
   AI 第一版在 `packages/*/tsconfig.json` 里写 `extends: "../tsconfig.base.json"`。我指出子包在 `packages/<pkg>/`，上一层是 `packages/`，应该是 `../../tsconfig.base.json`。这是 AI 按"子目录一层"的直觉写的，没数层级。
2. `TS2559: Type 'ProcessEnv' has no properties in common with type 'LlmModeEnv'`
   AI 把 `LlmModeEnv` 定义成 `{ readonly LLM_MODE?: string }`。这是 TypeScript 的 weak type 检测：`process.env` 与该接口没有共同属性。AI 第一反应是让调用方包一层对象，我否决了——那会把环境变量名写错的风险挪到调用处。要求它改成索引签名 `Readonly<Record<string, string | undefined>>`，调用方直接传 `process.env`。
3. 服务起不来：`import.meta.url === \`file://${process.argv[1].replaceAll("\\", "/")}\`` 在 Windows 上恒为 false。
   我贴了启动无输出、`curl` 返回 `000` 的现象，指出 Windows 绝对路径转 URL 是三斜杠 `file:///D:/...`，要求改用 `pathToFileURL()`。AI 改成 `node:url` 的 `pathToFileURL`，问题消失。
4. `SyntaxError: Invalid regular expression: /(?i).../: Invalid group`
   密钥扫描器里我要求"大小写不敏感"，AI 在 JS 正则里写了 PCRE 的 `(?i)` 内联标志。我贴了 Node 的完整堆栈，说明 JS 没有内联标志，要么加 `i`，要么写字符类。它改成 `gi` 标志。
   
   顺着这个 bug 又发现一个误报：`needsApiKey: requiresUpstreamCredentials(llmMode)` 被"Key 赋值"规则误判成泄露。定位方式是把扫描器的输出行号贴回去（`server/src/main.ts:40`）。修法不是加白名单，而是收紧规则语义：环境变量形态必须是大写 `UPPER_SNAKE`，字面量形态必须被引号包裹。这条经验后来写进了 `secret-scan.mjs` 的注释里——**误报会让人关掉整个扫描，所以规则宁窄勿宽**。

## 结果

- 产物：pnpm monorepo 骨架（4 个包的类型契约可编译）、零依赖 `/healthz`、`.gitignore` / `.gitattributes` / `.env.example`（Key 留空）、双钩子（pre-commit 密钥扫描 + commit-msg 规范校验）、零依赖密钥与 PII 扫描器、`AGENTS.md`、Prompt 链归档目录与四段式模板、GitHub Actions。
- 验证：`pnpm typecheck` 4 个包全绿；`/healthz` 返回 `{"ok":true,...,"llmMode":"replay"}`；暂存区扫描 0 命中；人为植入 `sk-...` 与手机号的负例测试能稳定报 3 处。

| commit | message | 说明 |
|---|---|---|
| `e479304` | `chore: init pnpm monorepo (web/server/schema/llm)` | 4 包骨架 + lockfile，typecheck 通过 |
| `60311c4` | `chore(sec): add gitignore, env.example, gitleaks pre-commit` | 安全底座 + 双钩子（含可执行位修正） |
| 待填 | `docs: add AGENTS.md constraints for AI agents [P00]` | 本文件所在的 commit |
| 待填 | `ci: add lint/typecheck/test workflow` | 回放模式 CI |
