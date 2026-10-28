# P10 会话整理稿（R-05 意图澄清）

- 日期：2026-10-28 · 已脱敏
- 本仓库不使用对话导出功能，本文件是「提问原文 + 动作 + 结果」的整理稿。

## 1 提问原文

用户：

> 可以 你push吧 然后给我R-05的方案

AI 给了方案，其中一个二选一摆在用户面前：澄清走「规则层」还是「模型层」。
用户回：

> 规则层

## 2 动作与顺序

1. 先按纪律写 `P10/summary.md` 的目标/范围/验收/停止条件（停止条件里写死了
   「不得新增 SSE 事件类型」与「预置需求不得被判缺槽位」）。
2. TDD 五轮：
   - `detectMissingSlots` / `buildClarifyQuestions` / `composeRequirement` 的测试 → 实现
   - `describeClarifications` 的测试 → 实现（时间线那句话）
   - `POST /api/clarify` 的 HTTP 用例 → 路由
   - `parseGenerateBody` 带 `clarifications` 的用例 → 拼装与校验
   - 前端 `clarify-model` 纯函数测试 → 组件与接线
3. 用 30 条 eval 需求做规则校准（`node --experimental-strip-types` 直接跑纯函数）：
   第一版 28 条判分需求里 20 条被误问 → 收紧后 0 条。
4. 证据：`verify.mjs` 加 VC8；浏览器闭环加第 9 步（13 张截图）；eval 探针改打真实接口。

## 3 AI 提出但被否决的方案

- **新增 `clarify` SSE 事件类型**：AGENTS §7 冻结 7 类事件，改它等于改产品定位。
- **让模型生成追问文案**：要重录 fixture，而 R-06 升 prompt 时还要再录一次，两轮互相覆盖回放键；
  且「追问数」会变成模型自证。
- **追问超过 3 个**：计划写死上限，多问会把「意图主导」变成「问卷审问」。

## 4 结果

见 `summary.md` 的「结果」（5 项收口对应、8 个 commit、6 条命令的真实输出）。
