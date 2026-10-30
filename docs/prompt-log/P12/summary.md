# P12 · 知识点 × 布鲁姆覆盖矩阵

- 迭代：省赛 `R-07` · 日期：`2026-10-30` · 涉及模块：`packages/schema`、`server`、`web`、`scripts`
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理，未补造不存在的会话原文
- 提交边界：**本轮 1 个 commit**，不是多次提交：`312cfb9`

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 由当前版本的实际 `FormSchema` 计算 `knowledgePoint × bloom`，看板展示所有声明知识点与六个布鲁姆层级；空单元格保留为 `0`；不做点击补题 |
| 允许修改范围 | `packages/schema/src/{coverage,index,api}.ts`、覆盖矩阵测试；`server/src/{analytics-route,analytics-route.test}.ts`；`web/src/dashboard/DashboardPage.tsx`；`scripts/{verify,browser-closed-loop}.mjs`；本留痕 |
| 验收案例 | ①有标注题按实际题目计数；②未标注题不被猜测；③声明但没有题的知识点保留全 0 行；④零提交仍返回矩阵；⑤看板同时显示 0 与非 0；⑥HTTP 级 VC10 覆盖 |
| 停止条件 | 增加补题交互、根据需求或蓝图伪造题目、引入新依赖，或把矩阵另做一套服务端/前端统计口径 |

## 提问与裁定

本轮没有新增用户选项裁定；执行依据是《计划-v3.1》§2.1.1 第 4 条与上一轮 R-06 已冻结的蓝图契约。

沿用的硬约束：矩阵必须由实际生成结果计算；`meta.objectives` 是行的来源；`BLOOM_LEVELS` 六级是固定列；没有点击补题，也不因缺少标注而自动补标；`web` 只消费 schema 契约与纯函数。

## AI 修改建议

采纳的：

1. 在 `packages/schema` 增加 `CoverageMatrix` / `CoverageMatrixRow` 契约和纯函数 `coverageMatrixOf()`。
2. 服务端从教师当前查看的版本快照计算矩阵，并随 `SubmissionsResponse` 返回；历史版本按各自 Schema 计算。
3. 看板直接渲染服务端矩阵，保留全 0 单元格，避免把「未覆盖」误读成「没有统计」。
4. 在 `verify.mjs` 增加 VC10，并在浏览器闭环脚本加入零提交与有提交两种矩阵断言。

我自己否决的：

- 由蓝图知识点直接生成矩阵行：蓝图不是成品，计划要求以实际 Schema 为准。
- 只返回非零单元格：会丢失“空单元格可见”的验收条件。
- 在前端按题目重新统计：会产生第二套统计口径，前端只渲染接口返回值。
- 给空知识点增加补题按钮：属于计划明确延后的交互，不在 R-07 范围内。

## 我如何引导 AI 修复问题

本轮没有发生需要修复的功能 Bug，主要做了两次验收口径校正：

1. **VC7 原有夹具没有知识点和布鲁姆标注**。给两道验证题补上 `kp-basic`、`remember`、`apply`，同时保留一行未标注简答题，验证“有标注计数、无标注不猜测”。
2. **空矩阵行不能用零提交代替**。VC10 专门声明一个已覆盖知识点和一个未覆盖知识点，分别断言 `1/1/0` 与全 0。

## 结果

省赛 R-07 收口。计划 §2.1.1 第 4 条逐项对应：

| 要求 | 落点 | 证据 |
|---|---|---|
| 由实际生成 Schema 计算 | `packages/schema/src/coverage.ts` 的 `coverageMatrixOf()`；服务端按版本快照调用 | `coverage.test.ts`；`analytics-route.test.ts` |
| 知识点 × 六级布鲁姆 | 行来自 `meta.objectives`，列来自 `BLOOM_LEVELS`，只读取题目标注 | schema 纯函数测试；VC10 |
| 空单元格可见 | 未覆盖知识点保留全 0 行，未覆盖层级保留 0 单元格 | `coverage.test.ts`；VC10；看板 `data-testid=dash-coverage-matrix` |
| 看板真实渲染 | 教师看板渲染六列中文标签与每行计数，不做前端重算 | `DashboardPage.tsx`；浏览器脚本断言 |
| HTTP 级闭环 | 零提交/有提交、已覆盖/未覆盖均有断言 | `node scripts/verify.mjs`，VC1–VC10 全过 |

真实数字（本轮实测）：

| 命令 | 结果 |
|---|---|
| `pnpm.cmd exec vitest run` | **66 文件 / 780 用例全绿** |
| `pnpm.cmd typecheck` | 4 包通过 |
| `pnpm.cmd exec oxlint --deny-warnings` | 0 告警 / 188 文件 |
| `node scripts/verify.mjs` | **VC1–VC10 全过（10/10）** |
| `node scripts/browser-closed-loop.mjs` | 未完成：Chrome/CDP 在 `Page.enable` 前断开；未生成新截图 |
| `node scripts/secret-scan.mjs` | 工作区扫描 0 命中 |
| `node scripts/secret-scan.mjs --history` | 全历史扫描 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `312cfb9` | `feat(schema): add knowledge bloom coverage matrix [P12]` | 本轮唯一 commit：schema 契约/纯函数、服务端响应、看板、VC10、浏览器断言与证据文档 |

**已知边界**（不写成能力）：

- 矩阵展示的是当前版本 Schema 中已有的教学标注，不证明模型标注本身教学有效。
- 简答题、分节或没有 `knowledgePoint` / `bloom` 的字段不会进入计数；这表示“不乱猜”，不是自动补标。
- 覆盖矩阵点击补题仍未做，按计划继续留在延后项。
- 浏览器级断言已写入脚本，但本轮 Chrome/CDP 在 `Page.enable` 前断开，旧截图不能作为 R-07 新证据。
