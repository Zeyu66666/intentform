# P02 · 流式生成管线（SSE 契约 + Provider + 回放）

- 迭代：`I2` · 日期：`2026-10-26` · 涉及模块：`packages/schema`（契约）、`packages/llm`、`server/src`、`fixtures/replays`
- 会话导出：`raw-20261026-i2-llm.md`（已脱敏；DSH 会话无 `/export`，该文件为提问原文 + 交付动作整理，已在文件头注明）
- 上游依赖：无新增。`packages/llm` 只用 Node 内置 `fetch`/`node:crypto`，`server` 仍零依赖 `node:http`（Hono 留给 I4）。

## 提问

这一轮不是"我问 AI 一段话"，而是我作为 Lead 把 I2 拆成共享任务派给队友 `llm-pipeline`（`context: fresh`，它看不到我的上下文，所以 brief 必须自包含）。给它的 brief 含八项，其中真正决定产出边界的是这几条：

- **写作用域**：只许写 `packages/llm/**`、`server/src/**`、`fixtures/replays/**`；`packages/schema/**` 只读。跨包类型一律走我已经提交的契约，不许自己改。
- **不许任何 git 命令**（`add`/`commit`/`stash`/`checkout`/`reset` 全禁）。提交是 Lead 独占动作，否则 42 个文件会被拆成无法过 typecheck 的碎片。
- **不许新增依赖**；要加必须先说明理由并等我说可以。
- **不许伪造 fixture**：`meta.upstream` 必须如实写，本地 stub 就写 `local-stub:127.0.0.1:<port>`，编造 `api.deepseek.com` 比不写更糟。
- **replay 未命中必须显式报错**，不许静默回落到 mock——"静默假装"是这类项目最容易翻车的地方。
- 交付说明必须贴**验收命令的实际输出**，不是"我跑通了"。

同时我作为契约所有人先做了一件事，排在两人开工之前、单独一个 commit：把《计划 v2.0》§3.6 的 7 类事件抽成 `packages/schema/src/sse-events.ts`，并冻结回放文件约定（`fixtures/replays/README.md`）。

## AI 修改建议

1. **契约放哪个包**：我在 brief 里写的是"契约放 `packages/contracts`"，实际落盘改成 `packages/schema/src/sse-events.ts` 并单独提交。理由：`AGENTS.md` 的模块边界表规定 `web` 只能依赖 `schema` 的类型与纯函数，而网页端必须 `import` 事件类型；新建第 5 个包还要同步改 `tsconfig.base.json` 的 paths 与 workspace 清单，收益为零。这个改动是我自己回退自己的方案，记在这里而不是悄悄改。
2. **AI 提议用 `packages/contracts` 之外的第三份类型副本喂前端**（它的理由是"前端不该依赖服务端契约包"）。我否决：两份类型会在第一次改事件字段时分叉，而分叉的表现是"界面少显示一个字段"，很难在评审前发现。改成单源 + `toSseFrame()` 保证帧格式只写一次。
3. **AI 提议 fixture 校验脚本放 `scripts/check-fixtures.mjs`**，我否决了位置：`AGENTS.md` 规定 `scripts/` 只依赖 Node 内置、不许 import 业务包，而校验要复用 `replayKey()` 与 `validateLine()`。改成 `packages/llm/src/check-fixtures.ts`，由根 `package.json` 挂一个 npm script 调它。
4. **AI 提议给 `thinking` 事件加一个 `reasoning` 原文通道并在时间线里展开**。当时我接受了（I3 里实现了折叠面板），但**审查报告 §2.4 判定这是过度承诺**——模型自述最容易被读成"它真的这样想"，而实际推理过程不可核验。I3 收尾时删掉了原文展开，只保留"推理摘要 N 段"。这条留在这里，因为它是一次真实的先采纳后回退。
5. **AI 提议 `record` 模式缺 Key 时自动降级为 `mock`**。否决，理由与上面的"静默假装"同源：录不到就报 `llm_config`，让人去配 Key。
6. **AI 主动提出「seq 缺口需要超时兜底」**，并建议在 reducer 里直接 `setTimeout`。我采纳问题、否掉实现：reducer 必须保持纯函数（否则时间控制测试要等真实时间），改成 hook 侧派发 `{type:"tick", now}`，阈值 3000ms，无缺口时返回**同一引用**避免每 500ms 重渲染。

## 我如何引导 AI 修复 Bug

本轮 6 个真实问题，全部有报错原文或实测输出：

1. **`ERR_MODULE_NOT_FOUND`：`pnpm dev:server` 从 I0 起就是坏的。**
   队友起服务时报：`Cannot find module 'D:\project1\intentform\packages\schema\src\latex' imported from ...\packages\schema\src\index.ts`。Node ESM 不做后缀补全，而 `tsc`/Vite 的 bundler 解析能容忍无后缀 import——所以这条从 I0 就存在，只是没人真正跑过服务。
   我的处理：写一次性脚本（`.tmp/add-ts-ext.py`，已 gitignore）给 `packages/schema/src`、`packages/llm/src`、`server/src` 全部相对 import 补 `.ts`（15 个文件，幂等），并加 `allowImportingTsExtensions: true`（必须配已有的 `noEmit: true` 才合法）。修完实测 `curl /healthz` 有响应、123 条测试不变。
   教训写进本文件：**"类型检查通过"不等于"能启动"**，二者的解析规则不同。

2. **`react-in-jsx-scope` 让 lint 从绿变红。**
   新建 `web/src/App.tsx` 后 `pnpm lint` 报 6 条 warning，`--deny-warnings` 下直接失败。根因是项目用 `jsx: react-jsx` 自动运行时，而 oxlint 默认按旧运行时要求显式 import React。
   我的决定：只对 `web/**` 关掉 `react/react-in-jsx-scope` 与 `react/jsx-uses-react`（`overrides` 里），**不在全局关**——关全局会把将来某处真的漏 import 也一起放行。

3. **`secret-scan` 两次拦下我自己的提交（都是误报，但处理方式不同）。**
   第一次：`provider.test.ts` 里 `const API_KEY = "sk-test-SECRET-0123456789"` 被 `[llm-api-key]` 命中。改成 `"test-key-not-a-real-secret"` 并加 `secret-scan:allow` 注释——比放宽规则好，规则被放宽一次就再也回不去了。
   第二次：`testing/record-fixtures.ts` 里 `const STUB_API_KEY = "..."` 被 `[llm-api-key-env]` 命中**变量名**。改名为 `STUB_CREDENTIAL`（同为假值），同样加 allow 注释。

4. **逐 commit typecheck 连挂两轮，暴露 commit 分组错误。**
   我写的核心检查脚本（`.tmp/check-commit.sh`，worktree + junction 复用 `node_modules`，避免每个 commit 重装依赖）报出：
   - `packages/llm typecheck: src/testing/record-fixtures.ts(26,30): error TS2307: Cannot find module '../generate.ts'` —— `testing/` 被塞进了 sources 那个 commit，而它依赖下一个 commit 的 `generate.ts`；
   - `web typecheck: src/render/fill-plan.test.ts(6,31): error TS2307: Cannot find module '../stream/__fixtures__/fake-frames'` —— 我把假帧目录单独放进了 render commit，但假帧的测试要 import `frames.ts`。
   处理：`git reset --soft` 两次重排分组（① `testing/` 并入 server 协议 commit；② web 侧改成 stream → render → panels 的顺序，假帧随 stream 一起走）。重排后 7 个 commit 全部 `OK`。
   教训：**"文件是一起写出来的"和"commit 能单独编译"是两件事**，顺序必须按依赖方向排，不能按主题排。

5. **端到端回放首次未命中——哈希对文本零容忍。**
   我按计划用 `PORT=8903 LLM_MODE=replay` 起服务，`curl` 打进去，回到的是 `llm_config`「回放未命中」。排查不是代码问题：我手打的需求文案与 preset 原文差几个字，而回放键 = `sha256(规范化需求 + 模型 + prompt 版本 + schema 版本)`。改用 `node` 把 `GENERATE_PRESETS` 第一条原文写成请求体文件后再打，命中：19 帧、`done.stats.fields=9`。
   这条直接改了产品设计：三条预置需求按钮的文案与 fixture 必须**同一串字符**，所以 `GENERATE_PRESETS` 被放进 `packages/schema`（前后端共享），并在测试里把三条 requirement 的长度钉死为 `[76, 78, 97]`。

6. **整表门禁：加了检查却没人能证明它真的拦得住。**
   审查报告问题 12 指出 `generate.ts` 全程没有 `validateForm` 调用——逐行校验通过就直接发 `done`。我补了 `packages/llm/src/publish-gate.ts`，但"看代码像对的"不算证据，于是补了两条**通过公开 API** 的测试：survey 需求 + 判分题 → 终态必须是 `error` 且**没有 `done`**；答案 id 越界 → 必须先发 `field_error` 再终结。两条都过之后才提交。

## 结果

- 产物：冻结的 7 类 SSE 事件契约（8 个事件 Zod schema + `createSseSequencer` + 帧编解码）、回放文件约定、三条预置需求、OpenAI 兼容 Provider（手写 SSE reader）、NDJSON `LineSplitter`（含 UTF-8 多字节截断）、逐行校验与两轮单调修复、整表发布门禁、四种模式来源（live/record/replay/mock）、`/api/generate` 的 HTTP 边界（64KiB 上限、写头前校验、断开 abort 上游、心跳、终态唯一、`x-intentform-llm-mode` 响应头）、3 条回放 fixture。
- 验证：`pnpm typecheck` 4 包全过；`npx vitest run` **316 条通过 / 28 文件**；`npx oxlint --deny-warnings packages server web scripts` **0 警告 0 错误**；`pnpm --filter @intentform/web build` 成功（`index-*.js` 约 505 kB，有 >500kB 提示，未拆包，理由见 P03）；7 个 commit 逐个在 worktree 里单独通过 `pnpm typecheck`。
- 端到端实测（replay，非 mock）：
  ```
  curl -s -N -X POST http://127.0.0.1:8903/api/generate \
    -H 'content-type: application/json' --data-binary @.tmp/body.json
  → 19 帧：phase(understand/plan/generate/validate/done) + thinking×3 + field×9 + usage + done
  → done: {"versionId":"gen_58a60b53f8803e5b","stats":{"fields":9,"errors":0,"repairs":0,"ms":14}}
  → 响应头 x-intentform-llm-mode: replay
  ```

| commit | message | 说明 |
|---|---|---|
| `f6d36a0` | `feat(schema): freeze SSE event contract for generate stream [P02]` | 7 类事件 + `seq` 校验器 + 帧编解码；`LIMITS.rawLineMax=2000` |
| `c57bc65` | `docs(fixtures): freeze replay fixture and meta.json convention [P02]` | 回放键算法、`meta.json` 必填字段、`upstream` 如实标注规则 |
| `5d4f06f` | `feat(schema): share three generate presets between UI and fixtures [P02]` | 三条预置需求，文案与 fixture 同源 |
| `135f9c4` | `feat(llm): openai-compatible provider with manual SSE reader [P02]` | `provider`/`json`/`logger`/`config`/`line-splitter`/`validate-line` |
| `47788f4` | `feat(llm): record, replay and mock sources with replay key hashing [P02]` | `sources`/`fixtures`/`replay-key`/`prompt`/`check-fixtures` |
| `8a29fd1` | `feat(server): /api/generate SSE event protocol with whole-form publish gate [P02]` | `generate` + `publish-gate` + `sse-writer` + 路由 + `main.ts` |
| `653d4d7` | `test(fixtures): record three replay fixtures for generate [P02]` | 3 组 `.ndjson` + `.meta.json`（`upstream: local-stub:127.0.0.1:8903`） |

### 相对《计划 v3.0》的偏离（3 处）

| # | 偏离 | 理由 |
|:--:|---|---|
| 1 | 新增 `packages/llm/src/publish-gate.ts`（计划只写"整表发布门禁 6 条判据"） | 门禁要能被单测直接盯住，塞进 `generate.ts` 会让它藏在异步生成器第 270 行。文件头写清了 I2 阶段哪几条恒不触发（`E_SCORE_SUM`/`E_KP_UNKNOWN`），没有假装全覆盖。 |
| 2 | `/api/generate` 增加 `x-intentform-llm-mode` 响应头 | §2.6 要求界面能分辨 live/replay/mock，而 7 类事件载荷是冻结契约。走 HTTP 头不动事件，`server` + `web` 各加一个测试。 |
| 3 | 预置需求放 `packages/schema/src/presets.ts` 而非 `web/src` | 需求文本要进回放哈希，fixture 录制脚本与按钮必须读同一份常量。放 web 里必然出现两份，改一个错别字就回放未命中。 |

### 已知缺口（带进 I4 / I6）

1. **3 条 fixture 都是"干净生成"**：`field_error` 与 `repair` 只在单测与脚本化来源里覆盖过一次，真实回放里没有坏行。要演示修复环（I6）必须补一条**故意含坏行**的录制，否则修复环在演示里无法出现。
2. **录制上游是本地 stub**：本机无 `LLM_API_KEY`，3 条 fixture 走的是真实 `record` 代码路径 + 本地 OpenAI 兼容 stub，`meta.upstream` 如实写 `local-stub:127.0.0.1:8903`。有 Key 后必须重录，`meta` 才能写 `openai-compatible:api.deepseek.com`。
3. **survey 契约仍未修**（审查问题 10）：`types.ts` 里 `answer` 对 four 种判分字段都是必填，所以"无答案的选择题"在 `survey` 里无法合法表达，`E_ANSWER_MISSING` 无从触发。I2 的门禁只做到"survey 里不许出现判分题"，没有改 DSL。
4. **整表门禁的 meta 是候选壳**：`title`/`totalScore`/`objectives` 由节点反推（所以两条规则恒不触发），真实元信息要等 I4 的整表编辑器。
5. **主 chunk 未拆**：约 505 kB，超过 500 kB 提示线。

### 脱敏记录

`raw-20261026-i2-llm.md` 中无需替换的个人信息：无真实姓名、手机号、学校名、邮箱、账号或 API Key。文中的 `127.0.0.1:8903`、`D:\project1\intentform` 为本地回环端口与仓库路径，属于可公开的工程信息；测试里的 Key 均为形如 `test-key-not-a-real-secret` 的假值。
