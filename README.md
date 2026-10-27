# 意卷 IntentForm

一句话需求 → 流式生成整份表单 → 逐字段上屏 → 整表门禁 → 一键发布成学生短链 → 手机作答 → 客观判分 → 教师看板与 CSV。

教师端（生成 + 发布 + 看板）与学生端（`/f/:slug` 手机填写）在同一个前端里；服务端零框架（`node:http`），数据落 SQLite。

## 30 秒跑起来

需要 Node ≥ 20.11（`--experimental-strip-types` 直跑 TS）和 pnpm。

```bash
pnpm install
cp .env.example .env          # 只是模板：不填 Key 也能跑，默认 LLM_MODE=replay
pnpm seed                     # 重建 demo 库，打印演示账号与两个学生短链
pnpm dev:server               # http://127.0.0.1:8787
pnpm dev:web                  # http://127.0.0.1:5173
```

> **注意**：服务端**不会自动读 `.env`**（仓库里没有 dotenv，`server/src/env.ts` 只认进程环境变量）。
> 默认的 `replay` / `mock` 模式不需要任何变量，所以上面四步直接能跑；要改配置或填 Key，
> 用 `node --env-file=.env --experimental-strip-types server/src/main.ts` 显式指定，
> 或者直接把变量写在前缀上（`LLM_MODE=live LLM_API_KEY=... pnpm dev:server`）。
> 涉及 Key 的文件建议放在仓库外（例如 `D:/project1/.secrets/intentform.env`），别提交。

浏览器打开 **http://127.0.0.1:5173**（别用 `localhost`：服务端按 `APP_ORIGIN` 校验来源，写死的是 `127.0.0.1:5173`）。

演示账号由 `pnpm seed` 打印，默认：

```
teacher@example.com / intentform-demo
```

## 三条体验路径

| 想干什么 | 怎么走 |
|---|---|
| 只看生成效果 | 打开首页 → 点一个预置需求（初二数学 / 高一英语 / 高二生物）→ 开始生成。中栏逐字段出现，右栏时间线同步推进 |
| 走完整的发布闭环 | 生成完成后点「保存并发布」→ 拿到 `/f/xxxxxxxx` 学生短链 → 手机视口打开作答 → 提交 → 回 `/dashboard` 看这条提交与 CSV |
| 只玩数据（不看生成） | `pnpm seed` 后登录 → `/dashboard`，已有 2 份表单与 30 条提交（全部虚构） |

生成有四种模式，由服务端 `LLM_MODE` 决定，前端顶栏会显示实际生效的那一种：

- `replay`（默认）：按「需求 + 模型 + prompt 版本 + schema 版本」的哈希命中 `fixtures/replays/` 里的录像，逐 chunk 重放，**不需要 Key**；未命中会显式报错。
- `mock`：内置脚本，连网都不出，含一条故意写坏再修复的题，用于确定性演示。
- `live`：真调上游，需要 `LLM_API_KEY`（只在服务端）。
- `record`：把上游 chunk 录成新 fixture。

## 自己怎么验

```bash
pnpm typecheck                  # 4 个包
npx vitest run                  # 52 文件 / 566 用例
pnpm lint                       # oxlint --deny-warnings
node scripts/verify.mjs         # VC1–VC4，HTTP 语义闭环，自起服务 + 临时库
node scripts/browser-closed-loop.mjs   # 真浏览器六步，落八张图到 docs/evidence/
```

`verify.mjs` 不用浏览器、不碰你的 `data/intentform.db`，会自己起一个临时服务再关掉。
`browser-closed-loop.mjs` 需要本机 Chrome（`CHROME_PATH` 可指定；找不到会 `exit 2` 而不是静默跳过），
它启动服务 + vite + headless Chrome，点完六步并把截图写进 `docs/evidence/`。

期望输出：

```
[verify] VC1 发布快照：改草稿不影响已发布版本的收集页 … 通过
[verify] VC2 判分与版本冲突：得分正确 / 旧版提交 409 … 通过
[verify] VC3 学生端零泄漏：响应体不含答案类键 … 通过
[verify] VC4 生成→发布→提交→看板：SSE 组装、得分对账、CSV 表头 … 通过
[verify] 全部通过（4/4）
```

## 目录

```
packages/schema   结构事实源：Zod 定义、校验规则 R1–R8、错误码、publicView、SSE 契约、HTTP 契约
packages/llm      上游 Provider、NDJSON 行切分、逐行校验、修复环、整表门禁、四种模式
server            node:http 服务：鉴权、CSRF、限流、发布快照、提交判分、看板与 CSV
web               React 18 + Vite：三栏生成页、字段渲染（edit/fill 两态）、时间线、看板、学生页
scripts           verify.mjs（HTTP 闭环）、browser-closed-loop.mjs（浏览器闭环）、secret-scan
fixtures/replays  回放录像（ndjson + meta.json）与格式约定
docs              证据、留痕、交付文档（见下）
```

模块依赖是单向的，且被 `AGENTS.md` 钉死：`web` 只能依赖 `schema` 的类型与纯函数（编译期拿不到 Node 类型，也拿不到任何密钥）。

## 配置

全部走环境变量，见 `.env.example`。常改的几个：

| 变量 | 默认 | 说明 |
|---|---|---|
| `LLM_MODE` | `replay` | `live` / `record` / `replay` / `mock` |
| `PORT` | `8787` | 服务端口 |
| `APP_ORIGIN` | `http://127.0.0.1:5173` | 允许的跨站写来源（CSRF 闸），改了要同步改浏览器地址 |
| `DATABASE_PATH` | `./data/intentform.db` | SQLite 文件；`pnpm seed` 会重建 |
| `SESSION_SECRET` | 空 | 空则每次启动随机（重启后会话失效）；生产必须显式给 |
| `WEB_INDEX_HTML` | 空 | 指向 `web/dist/index.html` 时由后端直接托管前端；不配只提供 API |

## 已知限制

不做 Patch（改表单只能整份重发）、版本冲突只在 HTTP 层有自动化证据、演示走 replay/mock 不证明模型输出质量、
只在 Windows + Chrome 156 验证过。完整清单见 `docs/deliverables/参赛说明-意卷IntentForm.pdf` 第 10 页。

## 文档

- `docs/evidence/README.md` —— 两种证据的边界、怎么重跑、本次运行的 commit 戳
- `docs/evidence/video-script.md` —— 七段演示视频的录制清单
- `docs/prompt-log/` —— 每个迭代的提问记录与 summary（含被否决的 AI 建议、真实 bug、偏离计划项）
- `docs/deliverables/` —— 参赛说明 PDF（10 页）与生成脚本
- `AGENTS.md` —— 模块边界、类型契约、提交纪律等硬约束（改代码前先读）
