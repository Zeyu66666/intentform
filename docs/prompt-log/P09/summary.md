# P09 · 每题正确率：看板从「一个平均分」到「每道题错在哪」

- 迭代：省赛 `R-04` · 日期：`2026-10-28` · 涉及模块：`packages/schema`、`server`、`web`、`scripts`
- 会话导出：`raw-20261028-r04-item-stats.md`（已脱敏）

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 服务端返回逐题统计；看板真实渲染；统计与判分复用同一判定函数。来源：计划 v3.1 §2.1.1 第 1 条 |
| 允许修改范围 | `packages/schema/src/{api,index}.ts`、`server/src/{grading,analytics-route}.ts` 及对应测试、`web/src/dashboard/*`、`scripts/verify.mjs`、`scripts/browser-closed-loop.mjs`、`AGENTS.md` §6 的 VC 清单、本文件。**不动** `packages/llm`、生成链路、发布快照与判分口径 |
| 验收案例 | ①3 份提交（全对 / 部分对 / 未作答）→ `total=3`、`answered`、`correct`、`rate` 逐个对；②零提交 → `rate: null`；③survey → `itemStats: []`；④`score === Σ(judgeItem 为真的题分值)`；⑤看板空数据显示 `—` 不显示 `0%`；⑥`verify.mjs` VC7 真 HTTP 断言 |
| 停止条件 | `pnpm typecheck` / `npx vitest run` / `npx oxlint --deny-warnings` / `node scripts/verify.mjs` 任一不过即停；发现需要改判分口径（`score`/`pendingScore` 语义）即停并回报，不在本轮动口径 |

## 提问

用户原话（本次会话第一句）：`读这两个文件 继续进行下一个阶段`（两份文件：`计划-v3.1.md`、`交接-新leader-20261028.md`）。
第二句：`开始实现`。计划 v3.1 §4.3 写明省赛「按编号 R-04 → R-09 推进」，R-01–R-03 已完成，所以本轮就是 R-04。

计划 §2.1.1 第 1 条给的收口标准（原文要点）：

> 服务端返回逐题统计：分母 = 提交份数（未作答按未答对计）、`answered` 单列、无提交时 `rate` 为 `null`；
> 统计与判分**复用同一判定函数**；看板真实渲染；HTTP 级用例覆盖；无数据不显示 `0%`。

我给的硬约束（延续 AGENTS.md）：不引依赖（看板仍用数字表 + CSS 条，不引 ECharts）、
统计只在服务端算（前端不重算第二份口径）、契约先改在 `packages/schema` 再改调用方。

## AI 修改建议

采纳的：

1. **`ItemStat` 契约放 `packages/schema/src/api.ts`，挂在 `SubmissionsResponse.itemStats`**。
   替代方案是新建一条 `/api/forms/:id/stats` 路由，否决理由是看板已经每刷新拉一次
   `SubmissionsResponse`，多一条路由等于多一次往返，还得处理两份数据不一致的瞬间。
2. **把 `gradeSingle/gradeMulti/gradeFill/gradeNumber` 收进导出的 `judgeItem`**，
   判分与统计都调它。「复用同一判定函数」由类型与调用关系保证，而不是注释。
3. **`rate` 保留 4 位小数、`total === 0` 时为 `null`**，与 `avgScore` 的「未知不伪填 0」同一条口径。

我自己提出又自己否决的（记录在案，避免下一任重开）：

- **统计里加一列「无关改动」或按知识点聚合**：超出 2.1.1 的收口标准，且知识点聚合属于
  R-07 覆盖矩阵的地盘，混进来会让两个证据互相污染。
- **CSV 里追加每题正确率**：CSV 契约是「一行一份答卷」，逐题统计是另一张表；
  硬塞进去会让 `CSV_BASE_COLUMNS` 的字节级断言失去意义。
- **survey 也出 `answered` 统计**：survey 字段没有 `answer`，判对错没有意义；
  作答数对 survey 有用，但那是 R-09 的收集页看板，不在 R-04 混做。

需要用户裁定的那条（已问、已答）：统计范围只含「四种自动判分题型且该题带 `answer`」，
用户回 `开始实现`，按此执行。

## 我如何引导 AI 修复 Bug

本轮没有"实现中崩掉再修"的 bug，但有两处**设计上的口径冲撞**在实现前被我拦下，记录如下：

1. **`AnswerValue` 的 `readonly` 冲突**。统计要读 `parseAnswers()` 的输出（`readonly string[]`），
   而判分的 `AnswerValue` 原本是 `string | string[]`，类型检查当场报
   `Type 'readonly string[]' is not assignable to type 'AnswerValue'`。
   按 AGENTS §3「readonly 是契约的一部分」，选择**放宽入参**（`string | readonly string[]`），
   而不是在调用方 `as string[]` 绕过——判分与统计都只读，不需要可变数组。
2. **零提交时条形轨道的视觉歧义**。看板上 `—` 的判定先做对了，但第一版仍渲染了空进度条，
   截图里一条空轨道看起来和 `0%` 没区别。按 §2.6 第 4 条「未知值不伪填」的口径，
   改成 `rate === null` 时整根条不画。**这是看截图才发现的**，不是测试能抓的——
   纯函数测试只钉住了文本，钉不住"文本旁边那根条"。

## 结果

省赛 R-04 收口。计划 §2.1.1 第 1 条的五项要求逐条对应：

| 要求 | 落点 | 证据 |
|---|---|---|
| 服务端返回逐题统计，分母 = 提交份数（未作答按未答对计） | `server/src/analytics-route.ts` `itemStatsOf` | `server/src/analytics-route.test.ts` 三条提交用例；VC7 |
| `answered` 单列 | 同上 + `isAnswered`（`server/src/grading.ts`） | `grading.test.ts` 两条；VC7 断言 `answered === 2` |
| 无提交时 `rate` 为 `null` | 契约注释 + `itemStatsOf` | HTTP 用例「还没有提交时 rate 是 null」；VC7 前置断言 |
| 统计与判分复用同一判定函数 | `judgeItem` 是唯一判定入口，`gradeSubmission` 与统计都调它 | `grading.test.ts`「得分 = judgeItem 判对的题分值之和」 |
| 看板真实渲染、无数据不显示 `0%` | `web/src/dashboard/{model,DashboardPage}.tsx` | `model.test.ts` 两条；浏览器闭环第 3 / 6 步断言 + 截图 `03b` / `07` |

真实数字（本机实测，全部可一条命令复现）：

| 命令 | 结果 |
|---|---|
| `npx vitest run` | **59 文件 / 702 用例全绿**（R-03 收口时是 685，本轮 +17） |
| `pnpm typecheck` | 4 包通过 |
| `npx oxlint --deny-warnings` | 0 告警 / 170 文件 / 127 规则 |
| `node scripts/verify.mjs` | **7/7**（新增 VC7） |
| `node scripts/browser-closed-loop.mjs` | **8 步全绿 / 12 张截图**（第 3、6 步新增正确率断言） |

| commit | message | 说明 |
|---|---|---|
| `d69730b` | `feat(grading): 单题判定收成一个 judgeItem，判分与统计同源 [P09]` | 判定同源 + `correctnessItemsOf` + `isAnswered` |
| `1a60d18` | `feat(analytics): 提交列表接口返回逐题正确率 [P09]` | `ItemStat` 契约 + 服务端统计 + HTTP 用例 |
| `e524d1f` | `feat(web): 看板渲染每题正确率，无数据显示 — 不显示 0% [P09]` | 纯函数 + 区块渲染 |
| `18e0bf5` | `feat(web): 正确率表与提交表分家，无数据时不画空条形 [P09]` | 截图审查后的两处视觉修正 |
| `5a23c7e` | `test(scripts): VC7 覆盖每题正确率，浏览器闭环断真实渲染 [P09]` | 证据链 |

**已知边界**（不写成能力）：

- 逐题统计只覆盖四种自动判分题型；**简答不参与**（人工给分没有对错），survey 的
  `itemStats` 是空数组。survey 看板的 `0/0` 与均分问题属于 R-09，本轮未动。
- 统计与 CSV 是两条出口：CSV 仍是"一行一份答卷"，没有逐题正确率列（有意为之，见上文被否决项）。
