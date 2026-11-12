# P37 · 评审严重问题 #6 的 live 质量摘要

- 迭代：评审报告“最高性价比改动”第 2 项
- 日期：2026-11-12
- 涉及模块：`docs/evidence/eval/`、`README.md`、`docs/evidence/README.md`、`docs/deliverables/README.md`

## 我的提问

提交 P36 后，继续做最高性价比改动第 2 项：把 live/eval 质量结果做成评委能快速复核的一页摘要，不能把 mock 或 replay 结果冒充 live。

## AI 的修改建议

1. 不重新跑 30 条 live，避免浪费额度；使用仓库已有的 `live-2026-10-28T11-56-12-r06c` 作为历史主评测证据。
2. 把本轮已完成的 1 次 live 主生成、5 条 live 对抗和 1 次矛盾复核单独列出，记录终态、耗时、usage、失败数和“不能证明什么”。
3. 在 README、浏览器证据 README 和交付物 README 增加单页入口，让评委不必先翻 `eval/runs/latest.json` 再猜报告含义。

## 我如何引导 AI 修复 Bug

本轮没有修改业务逻辑；重点修复的是证据口径风险。初版摘要容易把“HTTP 200 + done”写成质量通过，后改为明确区分：结构收敛、语义正确性、注入拒答和学科题质不是同一个指标；历史 30 条与本轮 7 次也不合并成一个百分比。

## 结果

- 新增 `docs/evidence/eval/live-quality-summary-2026-11-12.md`。
- 摘要列出历史 live 28/28、澄清 2/2、计划结构 21/28；本轮主生成 5.02s、0 错行、0 修复、2545 tokens；5 条对抗的阶段/usage/边界；已记录总量至少 15882 tokens。
- README、证据 README、交付物 README 均增加入口。
