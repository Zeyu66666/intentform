# P14 · 收集页真实闭环：survey 看板不再出现 0/0

- 迭代：省赛 `R-09` · 日期：`2026-10-30` · 涉及模块：`packages/schema`、`packages/llm`、`server`、`web`、`scripts`
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理。两处失败（误覆盖 `verify.mjs`、看板表格漏改）如实记录在「我如何引导 AI 修复问题」
- 提交边界：功能按模块分 5 个 commit（schema / server×2 / llm / web / scripts），证据与文档单独提交

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 计划 §4.3 R-09 与 0.2 #5：先修 survey 看板的 `0/0` 与「均分 0」，再补 `verify.mjs` 用例与浏览器闭环，走通「生成收集页 → 填写 → 看板回收 → CSV」 |
| 允许修改范围 | `packages/schema/src/api.ts`；`packages/llm/src/{generate,sources}.ts`；`server/src/{analytics-route,generate-route}.ts`；`web/src/dashboard/*`、`web/src/{App.tsx,stream/*}`；`scripts/verify.mjs`、`scripts/browser-closed-loop.mjs`；`AGENTS.md` §6、证据索引、本留痕 |
| 验收案例 | ①问卷看板不出现「平均分」「满分」「0 / 0」；②改为逐字段回收统计（分母 = 提交份数，零提交 `—`）；③生成页选问卷后，生成链路按 survey 校验并产出无答案字段；④HTTP VC11：建问卷→发布→提交→回收看板→CSV；⑤浏览器第 10 步界面级走通同一链路 |
| 停止条件 | 改判分/满分口径、放开 survey 带答案、把「看板不显示」做成前端隐藏而接口仍返回 0/0 语义的假修，或改了 prompt/回放键（那会迫使六条录像重录） |

## 提问与裁定

用户原话：`交接文件没有更新下一应该项是 R-09：survey 看板修复 + 收集页真实闭环。继续完成计划`。

沿用的硬约束：契约先改 `packages/schema`；问卷禁答案/分值（附录 A）；不引依赖；浏览器证据必须区分「链路通电」与「模型质量」；mock 不冒充模型。

本轮中途的一次操作事故与裁定：AI 用整文件写入的方式改 `scripts/verify.mjs`，把 VC1–VC10 正文覆盖成只剩 VC11 片段。语法检查（`node --check`）当场报错。按项目纪律不自行猜测恢复，向用户说明后获得授权，用 `git restore scripts/verify.mjs` 从 HEAD 恢复，再用精确编辑补回 VC11。

## AI 修改建议

采纳的：

1. **`SubmissionSummary.kind` + `collectionStats` 进契约**。前端已有 `FormSummary.kind`，但看板数据本身应当自证类型：否则「这份提交列表该不该有分数」要靠调用方自己拼两份数据。
2. **回收率与逐题正确率同一口径**：分母 = 提交份数、零提交 `rate: null`、看板显示 `—` 不显示 `0%`。两套口径迟早漂移。
3. **`kind` 从界面一路传到生成链路**：`POST /api/generate` 接受可选 `kind`；`generateForm` 的解析顺序为「显式 kind → 蓝图 kind → 需求文本推断」。教师确认过的蓝图类型必须就是校验类型——否则问卷会在逐行校验里被当成测验判「缺答案」。
4. **mock 生成源认识 kind**：`StreamInput` 增加可选 `kind`，mock 在 survey 下输出 section/short/scale。这是浏览器闭环能在无 Key 环境下真走「生成收集页」的前提。
5. **浏览器第 10 步在界面上真生成问卷**（选「问卷」→ 蓝图确认 → 流式生成 → 发布），而不是借种子问卷——否则「生成收集页」这一段没有界面级证据。

自己提出又否决的：

- **给 survey 的提交行显示「已提交」**：行里只留提交时间就够了；多一列状态字既无信息量，又容易被读成"得分待定"。
- **看板展开每条回收的答案原文**：计划 §2.1 对收集页的要求是「显示回收数据、不显示平均分」，明细在 CSV；加一个答案详情面板属于新功能，不在 R-09 收口标准里。
- **给 survey 的 CSV 去掉 score/max_score 两列**：`CSV_BASE_COLUMNS` 是字节级断言的契约，问卷的两列填 0 是事实（无分值语义），改列集合会让「一行一份答卷」的导出契约分叉。

## 我如何引导 AI 修复问题

本轮共三处真实问题，全部保留经过：

1. **`scripts/verify.mjs` 被整文件覆盖（操作事故）**。写入后 `node --check` 报 `Unexpected token '}'`；检查发现 VC1–VC9 的正文已被替换。授权恢复后重新以「在 `vc10CoverageMatrix` 之前插入」的方式补 VC11，首跑 10/11（VC11 断言字段数写错），修正后 11/11。教训：对已存在的长脚本，只用精确编辑，不用整文件写入。
2. **看板表格仍是 `0 / 0`（证据抓到的真实缺陷）**。第一版只改了统计行（隐藏均分/满分）与新增回收块，**漏了提交表的得分列**；浏览器第 10 步的断言直接红在 `survey 看板不应出现 0/0`，失败信息附页面文本，一眼看到 `0 / 0` 出现在回收行里。修法：问卷下提交表只保留「提交时间」，标题改「回收记录」。这是纯函数测试钉不住的视觉层缺陷，与 P09 的「空进度条」同类。
3. **kind 断链（设计缺口）**。此前生成页的「表单类型」只影响澄清与蓝图，`/api/generate` 仍按需求文本推断 kind：需求不含「问卷」字样时，选了问卷也会被按测验校验（问卷字段全部被判缺答案）。R-09 把 kind 显式传进请求体，并在生成器里让蓝图 kind 优先。

## 结果

省赛 R-09 收口。计划 §4.3 R-09 与 0.2 #5 逐项对应：

| 要求 | 落点 | 证据 |
|---|---|---|
| 看板不出现 `0/0` 与均分 0 | `web/src/dashboard/DashboardPage.tsx`：问卷隐藏均分/满分/得分列 | 浏览器第 10 步逐条断言（含页面文本兜底） |
| 看板显示回收数据 | `collectionStats` 契约 + `collectionStatsOf` +「回收情况」表 | `analytics-route.test.ts`；VC11；浏览器第 10 步 |
| 零提交不伪填 | 回收率 `rate: null` → `—`，不画空条 | `model.test.ts`；VC11 空看板断言 |
| 生成收集页 | `kind` 进请求体、蓝图 kind 优先、mock 问卷脚本 | `generate-route.test.ts`、`source.test.ts`、`generate.test.ts`；浏览器第 10 步（时间线出现「判定为 问卷」） |
| 填写 → 回收 → CSV | 手机视口填写、提交成功无分数、CSV 含刚提交的答案 | 浏览器第 10 步；VC11 |

真实数字（本轮实测，2026-10-30）：

| 命令 | 结果 |
|---|---|
| `pnpm.cmd check` | **67 文件 / 789 用例全绿**（R-08 时 783，本轮 +6）；lint、typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC11 全过（11/11）** |
| `node scripts/browser-closed-loop.mjs` | **10 步全绿 / 17 张截图**（exit 0） |
| `node scripts/secret-scan.mjs` / `--history` | 各 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `964f70e` | `feat(schema): 收集页逐字段回收统计进契约 [P14]` | `kind` + `CollectionStat` + `collectionStats` |
| `4add5c4` | `feat(server): survey 看板返回逐字段回收统计 [P14]` | `collectionStatsOf` 与 HTTP 用例 |
| `4396fad` | `feat(server): /api/generate 接收教师选择的 kind [P14]` | 可选 kind、非法值 400、透传生成器 |
| `1f91250` | `feat(llm): 生成链路把 kind 传给来源，mock 支持问卷脚本 [P14]` | 蓝图 kind 优先；`StreamInput.kind`；mock 问卷行 |
| `9e3bb2c` | `feat(web): survey 看板改为回收统计，生成请求带上 kind [P14]` | 看板分流、回收表、标题与空态 |
| `b521732` | `test(scripts): VC11 与浏览器闭环第 10 步覆盖收集页闭环 [P14]` | 双证据 |
| `1d45d1d` | `docs(evidence): 十步十七图，收集页闭环截图 [P14]` | 同一次生产构建运行 |

**已知边界**（不写成能力）：

- mock 的问卷脚本是内置脚本（section/short/scale），浏览器第 10 步证明的是**链路通电**，不证明模型产出的问卷质量；后者要看 live 与 `pnpm eval`。
- 问卷看板只展示逐字段回收数量与填写率，**不展开每条答案原文**；答案在 CSV 里。展开面板属于新功能，未做。
- CSV 对问卷仍保留 `score`/`max_score` 两列（值为 0）：那是固定列契约，问卷无分值语义是事实；页面不再把它渲染成 `0/0`。
- 跳过蓝图、且需求文本不含问卷关键词时，kind 仍按文本推断——这是「跳过蓝图」路径的已有边界，R-09 未改该路径。
- 问卷的 `shortItems` 服务端仍按字段返回（score 0），但 `pendingScore` 恒为 0，看板不会出现批改入口。
