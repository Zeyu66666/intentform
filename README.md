# 意卷 IntentForm

> 教师粘贴课程大纲，流式生成可发布的测验或问卷；学生手机作答；客观题自动判分，教师看板与 CSV 一目了然。

2026 第九届「传智杯」AI 创新应用挑战赛（赛道 10039）参赛作品。教师端（生成、发布、看板）与学生端（`/f/:slug` 手机填写）在同一个前端里；服务端是零框架的 `node:http`，数据落在 SQLite，模型调用只发生在服务端。

## 目录

- [产品简介](#产品简介)
- [核心能力](#核心能力)
- [技术栈与架构](#技术栈与架构)
- [快速开始](#快速开始)
- [体验路径](#体验路径)
- [生成模式](#生成模式)
- [验证与质量](#验证与质量)
- [HTTP API](#http-api)
- [配置](#配置)
- [安全设计](#安全设计)
- [已知限制](#已知限制)
- [文档与留痕](#文档与留痕)

## 产品简介

备课出卷的真实成本不在「出题」，而在「把大纲变成一份结构完整、分值合理、能被机器判分的卷子」。IntentForm 把这段工作压缩成一句话：

```
教师                          系统                          学生
────                          ────                          ────
粘贴课程大纲 / 一句话需求
   │
   ├─ 缺槽位 → 意图澄清：1–3 条追问
   ├─ 两阶段蓝图：规划题量 / 题型 / 分值 / 知识点
   ▼
流式生成（SSE 逐字段上屏）
   ├─ 逐行 NDJSON 校验（规则 R1–R8）
   ├─ 出错自动修复（最多 2 轮，错误集必须单调减少）
   ▼
整表门禁 → 保存草稿 → 一键发布 ─────────────→ 手机打开 /f/:slug 作答
   ▼                                              │
客观题自动判分（单/多选、填空、数字题）             ▼
简答题教师人工批改 ←─────────────────────────── 提交
   ▼
看板：得分分布、每题正确率、知识点 × 布鲁姆覆盖矩阵、CSV 导出
```

产品定位是「意图控制的生成系统」而不是「套壳调用大模型」：需求澄清、结构蓝图、Schema 校验、失败修复四层意图控制全部手写，核心链路的每一行都能讲清为什么。

## 核心能力

| 能力 | 说明 |
|---|---|
| 流式生成 | SSE 逐字段上屏，生成过程可观察（阶段、思考、逐题、修复、用量），前端实时渲染 |
| 两阶段生成 | 先出结构蓝图（题量/题型/分值/知识点），确认后再生成整表；偏离蓝图可量化 |
| 意图澄清 | 需求缺槽位（场景、题量、分值、题型、知识点）时先追问 1–3 条，补答并入同一条生成链路 |
| 结构强约束 | Zod Schema + 规则 R1–R8（id 唯一、答案须在选项内、分值合计、LaTeX 可解析、知识点须声明等） |
| 自动修复环 | 逐行校验出错时只回喂出错字段，最多 2 轮；错误集不减少即终止，不静默重试 |
| 发布快照 | 版本追加式写入、写后不改；发布 = 指向某个版本；改草稿不影响已发布卷子与历史提交 |
| 受限修改 | 六种操作（改题干/选项/分值，加、删、移题）+ 单步撤销；一句话改题先给建议、确认后才落库 |
| 作答与收集 | 学生手机端零登录作答；问卷（survey）走收集页闭环，测验（quiz）走自动判分 |
| 判分与统计 | 客观题服务端判分；简答题人工批改；每题正确率、得分分布、覆盖矩阵；CSV 导出 |
| 可复现 | `live` / `record` / `replay` / `mock` 四种模式；默认回放，无需 API Key 即可跑通完整闭环 |

## 技术栈与架构

| 层 | 选型 |
|---|---|
| 运行时 | Node 20 LTS（`>=20.11.0`，靠 `--experimental-strip-types` 直跑 TS）、pnpm（`>=9`） |
| 语言 | TypeScript 全栈，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 前端 | React 18 + Vite 5 + Tailwind 3 + KaTeX（系统字体栈，KaTeX 字体随包发布，不引外部 CDN） |
| 服务端 | 零框架 `node:http` + better-sqlite3（只用预编译语句）+ Zod + `@node-rs/argon2` |
| 模型 | OpenAI 兼容协议，上游 SSE 手写 `fetch` 流式读取，不引任何厂商 SDK |

pnpm workspace 四个包，依赖方向单向且被 `AGENTS.md` 钉死：

```
packages/schema   结构事实源：Zod 定义、规则 R1–R8、错误码、publicView、SSE 契约、HTTP 契约
packages/llm      上游 Provider、NDJSON 行切分、逐行校验、修复环、整表门禁、四种模式
server            node:http 服务：鉴权、CSRF、限流、发布快照、提交判分、看板与 CSV
web               React 18 + Vite：三栏生成页、字段渲染（edit/fill 两态）、时间线、看板、学生页
scripts           verify.mjs（HTTP 闭环）、browser-closed-loop.mjs（浏览器闭环）、secret-scan
fixtures/replays  回放录像（ndjson + meta.json）与格式约定
eval              整份需求达标率评测（30 条需求集 + 判定器）
docs              证据、留痕、交付文档
```

- `@intentform/schema` 不依赖任何 Node / 浏览器 API；
- `@intentform/llm` 只依赖 schema 的类型；
- `@intentform/server` 可以依赖 schema、llm 与 Node 内置；
- `@intentform/web` 只能依赖 schema 的类型与纯函数，编译期拿不到 Node 类型，也拿不到任何密钥。

跨包 import 一律走包名，禁止相对穿透。

## 快速开始

### 前置要求

- Node ≥ 20.11（`.nvmrc` 固定为 `20`）
- pnpm ≥ 9（`packageManager` 固定为 `pnpm@11.24.0`）

### 启动

```bash
pnpm install
pnpm seed                     # 重建 demo 库，打印演示账号与两个学生短链
pnpm dev:server               # http://127.0.0.1:8787
pnpm dev:web                  # http://127.0.0.1:5173
```

四步就够，**不需要 `.env`**：默认 `LLM_MODE=replay`，一个 Key 都不用填。

浏览器打开 **http://127.0.0.1:5173**（不要用 `localhost`：服务端按 `APP_ORIGIN` 校验来源，默认写死的是 `127.0.0.1:5173`）。

演示账号由 `pnpm seed` 打印，默认：

```
teacher@example.com / intentform-demo
```

`pnpm seed` 会重建 `data/intentform.db`，生成 1 份「初二数学 · 二次函数随堂测」、1 份「课程反馈 · 第 3 周」问卷与 30 条虚构提交（24 条测验 + 6 条问卷）。所有内容均为虚构：邮箱用 `example.com` 保留域，学生 IP 用 `192.0.2.0/24`（RFC 5737 文档专用段）。

### 关于 `.env`

服务端**不会自动读取 `.env`**：仓库里没有 dotenv，`server/src/env.ts` 只认进程环境变量。`cp .env.example .env` 拷了也不生效。要使用配置文件请显式指定：

```bash
node --env-file=.env --experimental-strip-types server/src/main.ts
```

或直接把变量写在前缀上：

```bash
LLM_MODE=live LLM_API_KEY=sk-... pnpm dev:server
```

涉及 Key 的文件建议放在仓库外（例如 `D:/project1/.secrets/intentform.env`），不要提交。

## 体验路径

| 想干什么 | 怎么走 |
|---|---|
| 只看生成效果 | 打开首页 → 点一个预置需求（初二数学 / 高一英语 / 高二生物）→ 开始生成。中栏逐字段出现，右栏时间线同步推进 |
| 走完整的发布闭环 | 生成完成后点「保存并发布」→ 拿到 `/f/xxxxxxxx` 学生短链 → 手机视口打开作答 → 提交 → 回 `/dashboard` 看这条提交与 CSV |
| 改一份已发布的表单 | `/dashboard` → 选中表单 →「编辑这份表单的题目与分值」→ 在顶部写一句话（例：把第一题题干改短一点）→「生成改动建议」→ 看人话差异 →「采用并保存」→ 需要时点「撤销上一步」 |
| 看问卷收集页 | 首页把表单类型切到「问卷」→ 生成 → 发布 → 学生端填写 → 看板按字段回收统计（不出现平均分、满分） |
| 只玩数据（不看生成） | `pnpm seed` 后登录 → `/dashboard`，已有 2 份表单与 30 条提交 |

前端路由共五条：`/`（生成页）、`/login`、`/dashboard`（可带表单 id）、`/forms/:id/edit`、`/f/:slug`（学生收集页）。

## 生成模式

由服务端 `LLM_MODE` 决定，前端顶栏显示实际生效的那一种。

| 模式 | 行为 | 需要 Key |
|---|---|---|
| `replay`（默认） | 按「规范化需求 + 模型 + prompt 版本 + schema 版本」的哈希命中 `fixtures/replays/`，逐 chunk 重放 | 否 |
| `mock` | 内置确定性脚本，不出网；含一条故意写坏再被修复的题，用于演示修复环 | 否 |
| `live` | 真实调用上游模型 | 是（`LLM_API_KEY`） |
| `record` | 真实调用并把上游 chunk 录成新 fixture（唯一会写 `fixtures/replays/` 的模式） | 是 |

回放节奏由 `LLM_REPLAY_SPEED` 控制：`1x`（录制视频用）/ `2x` / `instant`（CI 与 `pnpm verify` 用）。

`replay` 模式下游输入**未命中**时明确报错，不回落 mock：服务端返回 `llm_config` 与 `REPLAY_MISS_HINT`，界面提示两条出路（切 `LLM_MODE=mock` 并标注「演示数据」，或切 `record` 录一条）。回放未命中静默降级成假数据是明确禁止的。

## 验证与质量

```bash
pnpm install --frozen-lockfile
pnpm check                      # = lint + typecheck + test
node scripts/secret-scan.mjs    # 工作区密钥扫描
node scripts/secret-scan.mjs --history   # 全历史扫描
pnpm verify                     # = node scripts/verify.mjs，VC1–VC11
node scripts/browser-closed-loop.mjs     # 生产构建 + 真浏览器闭环
pnpm eval                       # 整份需求达标率（默认 replay，不用 Key）
```

| 命令 | 覆盖范围 |
|---|---|
| `pnpm typecheck` | 四个包全量类型检查 |
| `pnpm test` | 67 个测试文件 / 789 条用例（oxlint `--deny-warnings`、Vitest） |
| `node scripts/verify.mjs` | HTTP 语义闭环 VC1–VC11；自起临时服务与临时库，不碰 `data/intentform.db` |
| `node scripts/browser-closed-loop.mjs` | 先构建生产前端、再由同源 Node 托管，用 headless Chrome 点完十步并写截图到 `docs/evidence/`；同时断言首页 CSP 响应头 |
| `pnpm eval` | 30 条需求集的整份达标率，报告写入 `eval/runs/<runId>/` 并更新 `eval/runs/latest.json` |

浏览器闭环需要本机 Chrome（`CHROME_PATH` 可指定；找不到会 `exit 2` 而不是静默跳过）。

`verify.mjs` 期望输出：

```
[verify] VC1 发布快照：改草稿不影响已发布版本的收集页 … 通过
[verify] VC2 判分与版本冲突：得分正确 / 旧版提交 409 … 通过
[verify] VC3 学生端零泄漏：响应体不含答案类键 … 通过
[verify] VC4 生成→发布→提交→看板：SSE 组装、得分对账、CSV 表头 … 通过
[verify] VC5 人工批改：简答录分、待批归零、看板与 CSV 同口径 … 通过
[verify] VC6 受限修改与撤销：PATCH 追加版本、旧 baseVersionId 409、undo 回退 … 通过
[verify] VC7 每题正确率：分母是提交份数、未作答按未答对计、零提交 rate 为 null … 通过
[verify] VC8 意图澄清：缺槽位追问 1–3 条、完整需求不问、补答在事件流里可定位 … 通过
[verify] VC9 两阶段蓝图：规划自洽、补答同源、plan 阶段只在有蓝图时出现 … 通过
[verify] VC10 覆盖矩阵：实际 Schema 的知识点 × 布鲁姆计数与空单元格 … 通过
[verify] VC11 收集页闭环：survey 填写、回收看板与 CSV … 通过
[verify] 全部通过（11/11）
```

`pnpm verify` 证明的是 HTTP 语义闭环，不是浏览器里的真实操作；后者归 `browser-closed-loop.mjs`。两条证据链互不替代。

## HTTP API

服务端路由一览（详细契约见 `packages/schema/src/api.ts`）：

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/auth/login` | 教师登录（argon2 校验，下发 session cookie） |
| `POST` | `/api/auth/logout` | 退出 |
| `GET` | `/api/auth/me` | 当前登录身份 |
| `POST` | `/api/generate` | 流式生成（SSE），限流 |
| `POST` | `/api/clarify` | 意图澄清：只回追问，不调模型、不写库，限流 |
| `POST` | `/api/plan` | 两阶段蓝图：只回结构，不写库，限流 |
| `POST` | `/api/forms` | 保存草稿（新建） |
| `GET` | `/api/forms` | 列出当前教师的表单 |
| `GET` | `/api/forms/:id` | 表单详情（含版本信息） |
| `POST` | `/api/forms/:id/publish` | 发布指定版本快照 |
| `PATCH` | `/api/forms/:id` | 受限修改：六种 op，追加草稿版本；旧 `baseVersionId` 返回 409 |
| `POST` | `/api/forms/:id/undo` | 撤销一步（草稿指针退回父版本） |
| `POST` | `/api/forms/:id/suggest` | 一句话改题 → 操作集建议；不写库，限流 |
| `GET` | `/api/forms/:id/submissions` | 提交列表与统计（得分分布、每题正确率、覆盖矩阵） |
| `GET` | `/api/forms/:id/submissions.csv` | 导出 CSV |
| `POST` | `/api/forms/:id/submissions/:submissionId/grades` | 简答题人工批改 |
| `POST` | `/api/submissions` | 学生提交（匿名，限流） |
| `GET` | `/f/:slug` | 学生收集页（HTML 壳或公开视图 JSON） |
| `GET` | `/healthz` | 健康检查 |

学生端接口只经 `publicView(schema)` 输出：响应里不含 `answer`、`explanation` 等教师侧字段；提交响应只含得分；未发布的表单返回 404。

## 配置

全部走环境变量，模板见 `.env.example`（服务端只读模板里列出的变量）。

**运行与存储**

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_MODE` | `replay` | `live` / `record` / `replay` / `mock` |
| `PORT` | `8787` | 服务端口 |
| `APP_ORIGIN` | `http://127.0.0.1:5173` | 允许的跨站写来源（CORS + CSRF）；生产同源部署留空，按 Host 推断 |
| `DATABASE_PATH` | `./data/intentform.db` | SQLite 文件；`pnpm seed` 会重建 |
| `WEB_INDEX_HTML` | 空 | 指向 `web/dist/index.html` 时由后端同源托管前端；不配只提供 API |

**模型**

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_BASE_URL` | `https://api.deepseek.com/v1` | OpenAI 兼容端点 |
| `LLM_API_KEY` | 空 | 仅服务端；`live` / `record` 缺 Key 启动即报错 |
| `LLM_CHAT_MODEL` | `deepseek-chat` | 生成模型 |
| `LLM_REASONING_MODEL` | `deepseek-reasoner` | 思考可视化用的推理模型 |
| `LLM_TIMEOUT_MS` | `60000` | 单次上游超时 |
| `LLM_MAX_TOKENS` | `4096` | 单次输出上限 |
| `LLM_TEMPERATURE` | `0` | 生成链路固定 0；确定性靠 record/replay，不靠采样参数 |
| `LLM_SEED` | 空 | 上游支持固定 seed 时填写 |
| `LLM_REPLAY_SPEED` | `instant` | `1x` / `2x` / `instant` |

**鉴权与限流**

| 变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_SECRET` | 空 | 空则每次启动随机（重启后会话失效）；`NODE_ENV=production` 下必须显式设置，否则启动即失败 |
| `SESSION_TTL_HOURS` | `72` | 会话有效期 |
| `COOKIE_SECURE` | `false` | 仅 HTTPS 部署开启；本地 `http://127.0.0.1` 必须关闭 |
| `ARGON2_MEMORY_KIB` | `65536` | argon2id 内存成本，下限 8192 |
| `RATE_GENERATE_PER_MIN` | `10` | 生成/澄清/规划的每分钟配额（按来源 IP 哈希） |
| `RATE_SUBMIT_PER_MIN` | `30` | 学生提交每分钟配额 |
| `RATE_SUGGEST_PER_MIN` | `10` | 一句话改题的每分钟配额（服务端识别，模板未列） |

**上限与评测**

| 变量 | 默认 | 说明 |
|---|---|---|
| `DAILY_TOKEN_BUDGET` | `2000000` | 每日 token 预算 |
| `REQUIREMENT_MAX_CHARS` | `4000` | 需求文本上限 |
| `SUBMISSION_MAX_KB` | `64` | 单次提交体积上限 |
| `FIELDS_MAX` | `100` | 单表字段数上限（与 `LIMITS` 同源） |
| `EVAL_REPORT_DIR` | `./eval/reports` | 模板占位：当前 `pnpm eval` 按 `--out` 写报告，默认目录是 `eval/runs/`，该变量尚未被代码读取 |

## 安全设计

| 项 | 做法 |
|---|---|
| 密钥 | 只存在于服务端环境变量；前端零 Key；`.env` 永不入库，只提交 `.env.example` |
| 密码 | `@node-rs/argon2`（预编译二进制，免 node-gyp），成本可配 |
| SQL | better-sqlite3 预编译语句，禁止字符串拼接 |
| XSS | 禁止 `dangerouslySetInnerHTML`；唯一例外是 KaTeX 输出（`trust:false`、`strict`） |
| Prompt 注入 | 用户输入放在定界数据块内；输出只接受 Schema；学生答案永不进入生成链路 |
| 答案泄露 | 学生端只经 `publicView(schema)` 输出；提交响应只含得分；未发布表单 404 |
| 归属 | 每个资源读写都校验 owner，越权返回 403 |
| 发布快照 | `form_versions` 追加式写入、写后不改；提交记录 `form_version_id`，历史判分不受后续修改影响 |
| CSRF | 修改类请求校验 `Origin` + 自定义头；`GET` 一律不拦 |
| 限流 | 生成、澄清、规划、提交、改题建议分窗口计数；超限 429 + `Retry-After` |
| CSP | 只在生产构建下发：`script-src 'self'`；KaTeX 内联样式用 `style-src-attr 'unsafe-inline'` 单独放行 |
| 日志 | 不记录 Key、密码、`Authorization`、完整答卷 |
| 脱敏 | 仓库内不含真实姓名、手机号、学校名、邮箱；导出文件按占位符替换 |

服务端启动日志会打印生效的 `LLM_MODE`、数据库路径、允许来源，以及 `SESSION_SECRET` 是否使用一次性密钥，避免「登录莫名其妙失效」这类无报错故障。

## 已知限制

- 改表单只支持六种受限操作 + 单步撤销，不做通用 Patch；「一句话改题」只给建议，落库仍走同一套操作集。
- 版本冲突只有 HTTP 层自动化证据（VC2/VC6），浏览器里没有真实多窗口并发点击的截图证据。
- `replay` / `mock` 模式证明的是链路通电与确定性，不证明模型输出质量；模型能力以 `eval/runs/latest.json` 指向的 live 报告为准。
- 浏览器闭环目前只在 Windows + Chrome 156 上验证过；其他平台未取得实测证据。
- 学生端作答为匿名短链，不含账号体系与防刷除限流之外的措施。
- 完整缺口清单见 `docs/deliverables/作品介绍-意卷IntentForm-v1.pdf` 附录 A。

## 文档与留痕

- `AGENTS.md` —— 模块边界、类型契约、提交纪律、安全红线（改代码前先读）
- `docs/evidence/README.md` —— 两种证据的边界、怎么重跑、最近一次运行的 commit 戳
- `docs/evidence/video-script.md` —— 七段演示视频的录制清单
- `docs/prompt-log/` —— 每个迭代的提问记录与 summary（含被否决的 AI 建议、真实 bug、偏离计划项）
- `docs/deliverables/` —— 作品介绍 PDF（23 页）与生成脚本
- `fixtures/replays/README.md` —— 回放文件格式与录制约定