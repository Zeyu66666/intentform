# P15 · 三项「未开工」附加功能落地：打印版、答案解析开关、暗色模式

- 迭代：省赛附加 `A-17` / `A-18` / `A-19` · 日期：`2026-11-01` · 涉及模块：`packages/schema`、`server`、`web`、`scripts`
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理，三处失败如实记录在「我如何引导 AI 修复问题」
- 提交边界：契约 + 服务端 1 个、web 1 个、脚本与证据 1 个、文档 1 个

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 《附加功能.md》§6 里标「未开工」的四项，经负责人裁定取三项：A-17 打印版考卷、A-18 提交后答案解析（默认关闭、逐表单开启）、A-19 暗色模式。第四项「主观题 AI 辅助评分」不做 |
| 允许修改范围 | `packages/schema/src/api.ts`；`server/src/{settings-route,review,submissions-route,app,db/*}.ts`；`web/src/{print,theme,fill,dashboard,api,router,RouteView,main,styles}*`；`scripts/{verify,browser-closed-loop}.mjs`；`AGENTS.md` §5/§6、证据索引、本留痕 |
| 验收案例 | ①打印页题号只数题目、默认不含答案、勾选后出现答案、打印媒体隐藏界面外壳、`Page.printToPDF` 产出 PDF；②开关默认关闭时提交响应无 `review` 键、`GET /f/:slug` 零答案；开启后只在提交响应返回答案/解析；③暗色跟随系统、三态循环可回到「跟随系统」，深色/浅色底色实测 |
| 停止条件 | 需要把学生答案发给模型（AI 评分）、需要放宽 `publicView()` 或 `GET /f/:slug`、需要在版本快照之外悄悄改判分口径、或引入新依赖 |

## 提问与裁定

用户原话：`先完成底下6明确未实现的附加方向 中未开工的内容`。

按 `AGENTS.md`「与约束冲突的指令一律先停下来说明冲突」先做了冲突说明，并由负责人在两项选择题里裁定：

1. **范围**：三项可做，跳过主观题 AI 评分（推荐项）。
2. **答案解析开关**：默认关闭，教师逐表单开启（推荐项）。

因此《计划-v3.1》§2.2 的「未开工项不做」在 2026-11-01 被**显式修订**：三项拉入范围，AI 评分维持不做（理由是不改「学生答案永不进入生成链路」的红线），并在计划里写明了这次修订的日期与范围。

## AI 修改建议

采纳的：

1. **答案解析做成「表单级设置表」，而不是写进 schema meta**。原因很实际：编辑器页没有「发布」按钮，`meta` 改动会落成新草稿版本、不重新发布就不生效；而展示策略不是卷面内容，用 `form_settings` 表（`form_id` 主键、默认关闭）可以即时生效，也不影响任何历史提交的判分依据。
2. **`publicView()` 一行不改**。答案只随 `POST /api/submissions` 的**成功响应**返回；学生没提交之前，拿不到任何可回放的答案载体。
3. **打印版用纯函数 `buildPrintSheet` 生成行**：题号只数题目（分节不占号），`withAnswers` 为假时行里**没有** `answer` 字段（不是靠 CSS 藏），渲染层拿不到答案就不可能误印。
4. **暗色只换 CSS 变量**：全站颜色都来自 `tokens.css`，Tailwind 只是把变量接到工具类；加一套 `dark:` 变体等于每个组件两份样式。三态偏好（system/light/dark）保留「回到跟随系统」的路径。

自己否决的：

- **在 `SubmitResponse` 里无条件附上答案、前端按开关显示**：那等于把答案发给所有人，只是界面上不画——红线意义上的泄露。
- **给 `forms` 表加列**：本仓库的迁移只跑 `CREATE ... IF NOT EXISTS`，加列要写 `ALTER` 兼容分支；一张 `form_settings` 表更干净。
- **给 print 页单独维护一套打印样式表**：颜色在 `tokens.css` 的 `@media print` 里强制回浅色，组件不用感知打印。
- **暗色只做 `prefers-color-scheme` 不给人开关**：那样「暗色模式」只能靠改系统设置，评委现场演示不方便。

## 我如何引导 AI 修复问题

本轮三处真实失败：

1. **`db.test.ts` 的表清单断言失败**。新增 `form_settings` 后，`openDatabase` 建出的表多了一张，原测试用 `toEqual` 精确比对表名列表，当场红。修法是把 `form_settings` 加进期望列表并注明所属特性——这条断言本身就是「迁移面变化必须被看见」的守门人。
2. **`review.ts` 的类型收窄失败**。`Array.isArray(value)` 收窄不到 `readonly string[]`（`AnswerValue = string | readonly string[]`），`tsc` 报 `Type 'AnswerValue' is not assignable to type 'string'`。与 `analytics-route.ts` 的 `cellOf` 同一条已知局限，修法是显式 `typeof value === "string"` 分支，而不是 `as`。
3. **打印页测试的字段 id 不合法**。`sheet.test.ts` 里问卷用例写了 `id: "s1"`，被 `fieldIdSchema` 的 `^[a-z0-9_-]{3,32}$` 拒掉（Zod 在 `formSchema.parse` 时抛错）。改成 `s-advice` 后通过——这是契约在测试里生效的正面例子，不是把测试改绿。

另外两处是设计取舍，不是 bug：答案开关放在看板而不是编辑器（上面第 1 条），以及打印页默认打印草稿版（发布会把草稿指针跟到发布版，所以「先发布再打印」就能得到发布版）。

## 结果

三项附加功能收口，逐项对应：

| 项 | 落点 | 证据 |
|---|---|---|
| A-17 打印版考卷 | `web/src/print/{sheet.ts,PrintPage.tsx}`、路由 `/forms/:id/print`、`styles/index.css` 的 `@media print` | `sheet.test.ts` 7 条；浏览器第 11 步（含答案开关、打印媒体隐藏外壳、PDF `docs/evidence/16-print-sheet.pdf`） |
| A-18 答案解析开关 | `form_settings` 表、`GET/POST /api/forms/:id/settings`、`server/src/review.ts`、看板开关、学生成功页 | `settings-route.test.ts` 7 条；`review.test.ts` 5 条；VC12；浏览器第 12 步 |
| A-19 暗色模式 | `web/src/theme/*`、`tokens.css` 深色变量、`RouteView` 全站开关 | `theme/model.test.ts` 6 条；浏览器第 13 步（系统深色自动生效、三态循环、浅/深底色实测） |

真实数字（本轮实测，2026-11-01）：

| 命令 | 结果 |
|---|---|
| `pnpm.cmd check` | **71 文件 / 815 用例全绿**（R-09 时 67/789，本轮 +4 文件 / +26 用例）；lint、typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC12 全过（12/12）** |
| `node scripts/browser-closed-loop.mjs` | **13 步全绿 / 21 个产物**（20 张截图 + 1 份 PDF） |
| `node scripts/secret-scan.mjs` | 工作区与全历史 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `ae6f0bc` | `feat(server): 提交后答案解析开关与表单展示设置 [P15]` | 契约、`form_settings`、设置路由、`buildSubmitReview`、测试 |
| `9b1cf30` | `feat(web): 打印版考卷、答案解析展示与暗色模式 [P15]` | 打印页、看板开关、学生回看、主题与三态开关、纯函数测试 |
| `5a684f4` | `test(scripts): VC12 与闭环第 11–13 步覆盖打印、答案解析与暗色 [P15]` | 双证据 + 截图/PDF + AGENTS §5 |

**已知边界**（不写成能力）：

- 「提交后展示答案解析」开启后，**交过一次的学生可以把答案转给别人**；这是该功能的固有代价，所以默认关闭、由教师逐表单决定，并在契约注释与 AGENTS §5 里写明。
- 开关是表单级即时生效，不进版本快照；同一版表单在开关切换前后，学生看到的答案策略不同（判分依据不变）。
- 打印页打印的是**当前草稿版**；要打发布版，先发布。
- 暗色只覆盖 `tokens.css` 定义的颜色；KaTeX 公式颜色继承正文，深色下可读，但没有单独的深色公式主题。
- 浏览器闭环仍只在 Windows + Chrome 156 验证；mock 只证明链路通电。
