# P12 · 知识点 × 布鲁姆覆盖矩阵

- 迭代：省赛 `R-07` · 日期：`2026-10-30` · 涉及模块：`packages/schema`、`server`、`web`、`scripts`
- 会话导出：本轮未导出原始会话；本文件只记录可由仓库命令复核的实现与验收事实

## 开工前写清的四件事

| 项 | 内容 |
|---|---|
| 目标 | 由当前发布版本的实际 `FormSchema` 计算 `knowledgePoint × bloom`，看板保留所有声明知识点与六个布鲁姆层级的 0 单元格；不做点击补题 |
| 允许修改范围 | `packages/schema/src/{coverage,index,api}.ts`、覆盖矩阵单测；`server/src/{analytics-route,analytics-route.test}.ts`；`web/src/dashboard/DashboardPage.tsx`；`scripts/{verify,browser-closed-loop}.mjs`；本留痕 |
| 验收案例 | ①有标注题按实际题目计数；②未标注题不被猜测；③蓝图声明但无题的知识点保留全 0 行；④服务端零提交仍返回矩阵；⑤看板真实渲染 0 与非 0；⑥HTTP 级 VC10 覆盖 |
| 停止条件 | 为矩阵增加补题交互、根据需求/蓝图伪造题目，或新增依赖；这些都与计划 v3.1 §2.1.1 第 4 条冲突 |

## 采纳的实现

1. 在 `@intentform/schema` 增加 `CoverageMatrix` / `CoverageMatrixRow` 契约与纯函数 `coverageMatrixOf`。
2. 行来自 `meta.objectives`，列固定 `BLOOM_LEVELS` 六级；只读取字段上同时存在的 `knowledgePoint` 与 `bloom`，未知引用不创建新行。
3. `SubmissionsResponse` 增加 `coverageMatrix`，服务端从请求所选版本快照计算；看板直接渲染表格，0 作为明确未覆盖状态。
4. `verify.mjs` 增加 VC10；浏览器脚本增加矩阵断言，但本轮浏览器环境在 CDP `Page.enable` 前断开，未生成新截图。

## 结果

| 命令 | 结果 |
|---|---|
| `pnpm.cmd exec vitest run` | **66 文件 / 780 用例全绿** |
| `pnpm.cmd typecheck` | 4 包通过 |
| `pnpm.cmd exec oxlint --deny-warnings` | 0 告警 / 188 文件 |
| `node scripts/verify.mjs` | **VC1–VC10 全过（10/10）** |
| `node scripts/browser-closed-loop.mjs` | 未完成：Chrome/CDP 在 `Page.enable` 前断开；无新截图，不更新旧截图索引 |

## 已知边界

- 矩阵展示的是教师当前查看版本的 schema 标注，不代表模型标注的教学有效性。
- 简答等没有标注的题不会进入矩阵；这是「实际有标注才计数」，不是自动补标。
- 本轮没有改动覆盖矩阵点击补题能力，仍按计划列为延后项。
