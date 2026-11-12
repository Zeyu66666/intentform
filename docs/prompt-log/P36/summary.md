# P36 · 评审严重问题修复（replay 可比对 + 发布版打印）

- 迭代：评审报告 2026-11-12 的严重问题 #2、#3、#5、#7
- 日期：2026-11-12
- 涉及模块：`packages/llm`、`packages/schema`、`server`、`web`

## 我的提问

根据评审报告的问题清单，从严重度为“严重”的第 2 项开始修复。保留匿名短链账号体系这一项的设计边界，不做架构级重构；优先修复 6 天内可验证的小改。

## AI 的修改建议

1. replay 的运行时时间字段应由回放源固定为确定值，避免评委对同一输入做原始 SSE diff 时被 `ts`、`tMs`、`usage.ms` 和 `done.stats.ms` 干扰。
2. 打印页增加版本选择：默认仍打印草稿，但已发布表单允许显式读取 `publishedVersionId`，避免把未发布草稿误印成正式卷。
3. 前端生成流按 SSE 终态判断成功，不把“HTTP 200 + `event:error`”当成成功；replay miss 的错误应进入统一错误态。

## 我如何引导 AI 修复 Bug

1. 初版打印页改动把 `getForm` 的版本参数留成了两个 `undefined`，逻辑上没有真正选择发布版。修正为先读取表单摘要拿到 `publishedVersionId`，再带 `?versionId=` 请求目标版本；没有发布版时显示明确错误。
2. 初版流结束判断尝试读取 React 闭包中的旧 `state.terminal`，无法可靠判断本轮是否收到终态。改为在 pump 局部记录 `terminalSeen`，只有没收到 `done/error` 才补 internal error。
3. replay 确定性验证用两次真实请求确认：同一预置需求两次均 18 events、`done.fields=9`、`versionId` 相同，修复后 `rawEqual=true`。

## 结果

- replay 输出运行时字段固定后，同一输入两次 SSE 字节完全一致。
- 表单详情支持 `?versionId=`；打印页可切换“当前草稿/已发布版”，未发布时禁用发布版选项。
- 前端收到 replay miss 等 SSE `error` 终态时保持错误态，不再等待流结束后误补“终态缺失”。
- `pnpm typecheck` 通过；`pnpm test` 92 个文件 / 1054 条用例通过；新增 API 路径、服务端版本选择和 replay timing 回归测试。
