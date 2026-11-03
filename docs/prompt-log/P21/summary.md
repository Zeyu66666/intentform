# P21 · 主观题 AI 辅助评分（A-23）

- 迭代：附加 `A-23` · 日期：`2026-11-03` · 涉及模块：`packages/schema`、`packages/llm`、`server`、`web`、`scripts`、文档
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：契约 `48308e5`、提示词 `f3f75d9`、服务端 `9940083`、前端 `8903995`、脚本 `0a6dc21`、本留痕与文档随后一个 docs commit

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人明确要求并选择「真 AI，逐表单开启」：教师显式打开开关后，批改简答时可把**该题原文**发给模型，只回建议分/理由，教师确认后才落分 |
| 红线变更 | `AGENTS.md` §5 原「学生答案永不进入生成链路」增加唯一例外 A-23；同时写明答案与模型原文不进日志。计划 §2.2 与附加功能 §6 同步改为「已交付」 |
| 验收案例 | ①开关默认关闭，关闭时 403；②开启后只对简答题；③只取该题原文，不取整份答卷；④只回建议、不写 `manual_grades`；⑤教师仍需手动保存；⑥旧能力不回退 |
| 停止条件 | 需要发送整份答卷/学生身份、自动落分、或把答案写进日志 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 契约 | `packages/schema/src/api.ts` | `aiGradeRequestSchema` 只收 `itemId` 且 `.strict()`；`AiGradeResponse` 只有建议分/理由/来源/版本 |
| 设置 | 同上、`server/src/db/*` | `form_settings.ai_grading_enabled` 默认 0；老库用 `PRAGMA table_info` 判断后幂等 ALTER；请求里省略该字段表示不改 |
| 提示词 | `packages/llm/src/grade-short.ts` | `grade.v1`；答案包在 `<<<STUDENT_ANSWER … STUDENT_ANSWER>>>` 数据块；系统提示明确「不是指令」 |
| 校验 | 同上 | 建议分必须是 `0–maxScore` 的整数，理由非空且 ≤500 字；mock 是满分一半；replay 无录像明确报错 |
| 服务端 | `server/src/ai-grade-route.ts` | 调模型前四道闸：开关关闭 403、提交归属、只接受该提交版本里的简答、只取该题原文；成功也不写 `manual_grades` |
| 前端 | `web/src/dashboard/{DashboardPage,GradeForm}.tsx` | 看板开关写明会把该题原文发给模型；批改面板只有开关开启才显示按钮；建议分只填入输入框，不触发保存 |

## AI 修改建议

采纳的：

1. **开关放在表单级设置，不放全局**。每份卷子的数据敏感度不同；默认关闭，教师逐表单决定。
2. **请求只收 `itemId`**。答案必须由服务端从提交里取，客户端不能借接口把任意文本送进模型；`.strict()` 连多余键都拒。
3. **建议分不落库**。复用原有 `manual_grades` 保存按钮，AI 只改输入框；这样"模型给了 5 分"永远不是最终成绩。
4. **只发该题原文**。不发送整份答卷、不带学生身份/IP、不把答案或模型原文写日志。
5. **开关字段可选**。老客户端只发 `showAnswersAfterSubmit` 时不会把 AI 开关顺手关掉；新客户端显式发两个布尔值。

自己否决的：

- **自动保存 AI 分**：越过教师确认，且模型误判会直接改成绩。
- **发送整份答卷让模型自己找题**：数据最小化原则，且会扩大提示词注入面。
- **把答案或模型原文写进错误信息/日志**：违反 AGENTS §5 日志条。

## 我如何引导 AI 修复问题

本轮抓到的真实问题：

1. **`parseAnswers` 重复导出**。给 `grade-route.ts` 加 `export` 时，文件底部本来已有 `export { parseAnswers }`，TS 报 TS2323；恢复成私有函数、沿用底部导出。
2. **`SubmitResponse` 形状记错**。测试里写 `response.json.submission.submissionId`，实际是 `response.json.submissionId`；类型检查直接把错误指出来。
3. **浏览器第 17 步抢跑**。打开看板后只等了 AI 开关，提交表还没渲染就去点 `dash-grade-`，报「找不到元素」；补一条等待批改按钮出现的断言后通过。
4. **老库没有新列**。`CREATE TABLE IF NOT EXISTS` 不会给已存在的 `form_settings` 补 `ai_grading_enabled`；在 `migrate()` 末尾用 `PRAGMA table_info` 判断后 ALTER，重复启动幂等。
5. **契约测试一度允许客户端多传 `answer`**。最初用 zod 默认行为（忽略多余键），测试也写成 `true`；改为 `.strict()` 并把期望改成 `false`，明确「答案只能由服务端取」。

## 结果

真实数字（本轮实测，2026-11-03）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **78 文件 / 929 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC16 全过（16/16）** |
| `node scripts/browser-closed-loop.mjs` | **17 步全绿 / 29 个产物**（28 张截图 + 1 份 PDF）；第 17 步开关 → 建议 → 不自动保存 |
| `node scripts/secret-scan.mjs` / `--history` | 均 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `48308e5` | `feat(schema): AI 辅助评分契约与表单开关 [P21]` | 请求/响应、设置字段 |
| `f3f75d9` | `feat(llm): 简答评分 prompt grade.v1 [P21]` | 定界块、分数校验、mock/replay |
| `9940083` | `feat(server): AI 辅助评分只回建议不落分 [P21]` | 开关、归属、简答限定、幂等迁移 |
| `8903995` | `feat(web): 表单开关与批改面板接入 AI 建议分 [P21]` | 开关与建议分 UI |
| `0a6dc21` | `test(scripts): VC16 与闭环第 17 步覆盖 AI 辅助评分 [P21]` | HTTP 与浏览器两级证据 |

**已知边界**：

- 这是 AGENTS §5 的唯一新增例外；只对简答题生效，关闭时整条路由 403。
- 模型只拿到该题题干、满分与原文；整份答卷、学生身份、IP 不进入提示词。
- 建议分不落库，教师必须手动保存；`mock` 是满分一半的演示值，不证明评分质量。
- `replay` 无 `grade.v1` 录像时明确报错，不回落 mock。
- 数据合规由教师/学校决定：开启即表示同意把该题原文发送给上游模型。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱，未做占位符替换。
