# AGENTS.md · 给 AI 编码代理的硬约束

> 这份文件是**约束**，不是建议。任何 AI 会话开始前先读它；与它冲突的指令一律先停下来说明冲突，不允许自行取舍。
> 每次迭代的 Prompt 链记录在 `docs/prompt-log/Pxx/summary.md`，本文件是那条链的"宪法"。

## 1. 项目与不可协商的技术基线

- 产品：**意卷 IntentForm** —— 教师粘贴课程大纲 → 流式生成可发布测验（含 LaTeX）→ 学生手机作答 → 自动判分 + 看板。
- 运行时：Node 20 LTS（`engines: >=20.11.0`）、pnpm（`engines: >=9`）、TypeScript 全栈、pnpm monorepo。
- 版本锁定三件套：`.nvmrc`（`20`）、`package.json` 的 `engines` 与 `packageManager`。三者必须一致，改一个就同步改另外两个。
- 前端：React 18 + Vite + Tailwind + Radix + KaTeX + ECharts。**系统字体栈，KaTeX 字体随包发布，不引外部 CDN**——除 live 模式外复现过程零外网依赖。
- 后端：Hono + better-sqlite3（只用预编译语句，版本固定在有 Node 20 预编译包的版本上）+ Zod + **`@node-rs/argon2`（预编译二进制，免 node-gyp；备选 `crypto.scrypt`）** + nanoid。
  不用 `argon2`：它要靠 node-gyp 在评委机器上现场编译，那是「10 分钟复现」最大的不确定项。
- LLM：OpenAI 兼容协议；上游 SSE **手写 `fetch` 流式读取**，不引任何厂商 SDK。

### 1.1 禁用库（硬性）

`LangChain`、`LlamaIndex`、`Vercel AI SDK`、`react-jsonschema-form`、`formily`、`amis`、`SurveyJS`。

理由：核心链路（Schema DSL、逐行校验、修复环、Patch 应用器、流式解析）必须手写且可解释，用来对冲评审的"框架拼装"质疑。发现自己在 import 上述任意一个包，就是走错了路。

### 1.2 新增依赖的流程

新增任何第三方依赖前，必须先用一句话说明「现有手写能力为什么不够」，等人类确认。能不装就不装。
需要构建脚本（postinstall）的依赖，必须在 `pnpm-workspace.yaml` 的 `allowBuilds` 里逐项登记并写明理由，**禁止全量放行**。

## 2. 模块边界（谁能 import 谁）

| 包 | 路径 | 可以依赖 | 禁止依赖 |
|---|---|---|---|
| `@intentform/schema` | `packages/schema` | 仅 KaTeX 解析器（I1 起） | 任何 Node / 浏览器 API、server、web、llm |
| `@intentform/llm` | `packages/llm` | `schema` 的类型 | server、web、数据库 |
| `@intentform/server` | `server` | `schema`、`llm`、Node 内置、后端依赖 | `web` |
| `@intentform/web` | `web` | `schema` 的类型与纯函数 | `server`、`llm`、Node 内置、任何密钥 |
| 脚本 | `scripts` | Node 内置 | 三个业务包（评测脚本除外，允许 import `llm`） |

跨包 import 一律走包名（`@intentform/schema`），禁止 `../../packages/schema/src/...` 这类相对穿透。

## 3. 类型契约先行

1. 先给 `type` / `interface` / Zod schema，再给实现；先给错误码枚举，再给抛错逻辑。
2. 联合类型的分派必须用穷举 `switch` + `assertNever`，不允许 `default: return null`。
3. `tsconfig.base.json` 里 `strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 已开，**禁止在业务代码里用 `as any` / `@ts-ignore` / `@ts-expect-error` 绕过**。确实需要时，必须在同一行写注释说明为什么类型系统在这里说谎。
4. 公共 API 的入参用 `readonly`，返回值不要泄漏可变内部状态。

## 4. 提交纪律（评审直接看这一项）

1. 一个工作单元 = 1–3 个 commit；**每个 commit 必须能单独通过 `pnpm typecheck`**。
2. commit message 格式：`type(scope): subject`，type 限 `feat fix chore docs test refactor perf build ci style revert`。
3. `feat` / `fix` / `test` 必须带标签：`[Pxx]`（对应 Prompt 链）或 `[AI-TEST]`（AI 生成的测试 / AI 测试发现的缺陷修复）。`chore` / `docs` / `ci` 不强制，但与某次会话相关时也带上。
   scope 只允许小写字母、数字、连字符。这条由 `.githooks/commit-msg` 强制，不是自觉遵守。
4. 禁止 `git commit --amend` 已推送的提交、禁止 squash、禁止 force push、禁止修改提交日期。
5. 单个 diff 超过 300 行时，用 `git add -p` 按模块拆分。
6. 首个 commit 不含功能代码（只有工程骨架）。

## 5. 安全红线

| 项 | 红线 |
|---|---|
| 密钥 | 只存在于服务端 `.env`；前端零 Key；`.env` 永不入库；只提交 `.env.example` |
| 日志 | 不记录 Key、密码、`Authorization`、完整答卷 |
| SQL | 只用 better-sqlite3 预编译语句，禁止字符串拼接 |
| XSS | 禁止 `dangerouslySetInnerHTML`，唯一例外是 KaTeX 输出（`trust:false`、`strict`） |
| 注入 | 用户输入放在定界数据块内；输出只接受 Schema；学生答案**永不**进入生成链路 |
| 答案泄露 | 学生端接口**只能**经过 `publicView(schema)` 输出，学生端路由里禁止直接读 `schema_json`；提交响应只含得分，不含 `answer` / `explanation`；未发布表单返回 404 |
| 发布快照 | `form_versions` 追加式写入、写后不改；发布 = 把某个 version 写入 `forms.published_version_id`；提交记录 `form_version_id`。发布后再改 Schema 不得影响历史提交的判分与统计 |
| 归属 | 每个资源读写都校验 owner；越权返回 403 而不是 404 之外的模糊处理 |
| 脱敏 | 真实姓名、手机号、学校名、邮箱不得进入仓库（含 `docs/prompt-log/*/raw-*.md`）。导出文件用**占位符替换**（如 `[REDACTED-NAME]`），不整段删除，并在 `summary.md` 末尾记一行「替换了哪几类信息」 |
| Cookie | session cookie 为 `httpOnly + SameSite=Lax`；`Secure` 仅 HTTPS 部署时开启（`COOKIE_SECURE`），本地 `http://localhost` 下必须关闭，否则登录直接失效 |
| CSP | 只在**生产构建**下发 CSP：`script-src 'self'`；KaTeX 需要的内联样式用 `style-src-attr 'unsafe-inline'` 单独放行，**不放开 `script-src`**；Vite 开发模式不加严格 CSP，E2E 一律跑生产构建 |

改动涉及上述任一项时，必须在同一 commit 里附上对应的验证命令或测试。

## 6. 完成定义（DoD）

声称"做完了"之前，以下命令必须全部通过，并且输出贴进会话：

```bash
pnpm install --frozen-lockfile
pnpm check                      # = lint + typecheck + test
node scripts/secret-scan.mjs
node scripts/secret-scan.mjs --history
```

**`pnpm verify` 不是上面这几条的同义词。** 它按计划 §7 的语义跑 VC1–VC3 三条验证用例（大纲→测验、作答→判分→看板、对抗输入），I4 才落地；在那之前它只会明确报错并提示改用 `pnpm check`。别把 `check` 当成「一条命令跑通生成→渲染→提交」的验收。

涉及外部调用的功能，必须同时提供 `LLM_MODE=replay` 或 `mock` 路径，并在该路径下验证一遍。

## 7. 不可擅自更改的协议

- SSE 事件只有 7 类：`phase`、`thinking`、`field`、`field_error`、`repair`、`usage`、`done`/`error`。每个事件带**递增 `seq`**（用于排序与回放）。
- 心跳 15 秒发一次，用 **SSE 注释行**（`:` 开头），**不算事件类型**——不要为了心跳去扩事件枚举。
- 生成链路用 **NDJSON**（每行一个完整事件），不返回整段 JSON。理由是每行可独立校验、独立渲染、独立修复，不需要部分 JSON 解析。
- 修复环最多 2 轮，且错误集合必须**单调减少**，否则终止。
- 回放键 = `hash(规范化需求 + 模型 + prompt 版本 + schema 版本)`，回放文件在 `fixtures/replays/<hash>.ndjson`，旁附 `<hash>.meta.json`（`recordedAt`、`model`、`promptVersion`、`usage`，用来证明 fixture 来自真实 live 运行）。
  需求必须**规范化**（去首尾空白、内部连续空白折叠、换行统一）后才入 hash，否则多打一个空格就换一个键。
- 回放节奏由 `LLM_REPLAY_SPEED` 控制：`1x`（录制视频用）/`2x`/`instant`（CI 与 `pnpm verify` 用）。
- replay 模式下自由输入**未命中**时，界面必须明确提示「回放模式仅支持预置需求，配置 Key 后切换到 live」并回落到 mock（标注「演示数据」），**禁止静默假装成真实生成**。
- 字段 `id` 稳定，Patch 以字段 id 寻址，不使用数组下标。`id` 必须匹配 `^[a-z0-9_-]{3,32}$`。
- 语义规则 R1–R8 与错误码（`E_DUP_ID`、`E_ANSWER_NOT_IN_OPTIONS`、`E_MULTI_ANSWER_INVALID`、`E_OPTIONS_INVALID`、`E_ANSWER_MISSING`、`E_SCORE_SUM`、`E_SURVEY_HAS_ANSWER`、`E_LATEX_INVALID`、`E_BLOOM_INVALID`、`E_KP_UNKNOWN`）以计划 v1.1 附录 A.2 为唯一来源，改规则前先改附录。每个错误码要配一句固定的修复提示文案，它是 repairer 回喂模型的依据。
- 长度与数量上限集中在 `packages/schema` 的 `LIMITS`，server 与 web 共用同一份数字，禁止在别处另写一套。

改这些等于改产品定位，先停下来问人类。

## 8. 说话方式

- 做不到就说做不到 + 给替代方案，不要硬圆。
- 不确定的事实（库行为、版本特性、官方要求）先查证再写，不要用"通常"、"一般"糊过去。
- 不要产出计划、路线图、优先级建议；要可落盘的文件内容和可执行命令。
