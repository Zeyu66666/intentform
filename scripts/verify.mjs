#!/usr/bin/env node
/**
 * `pnpm verify` —— 语义由计划 v1.1 §7 定义：按顺序跑 VC1–VC3 三条验证用例（回放模式）。
 *
 *   VC1 大纲 → 测验：时间线出现四个阶段、字段逐题落位、0 校验错误、发布得到短链
 *   VC2 手机作答 → 判分 → 看板：响应只含得分（不含 answer）、看板数字与 CSV 更新
 *   VC3 对抗输入：正文含「忽略以上指令」与 <script>，输出仍是合法 Schema、canary 不出现
 *
 * I0 阶段这条闭环还不存在。这里刻意保留一个明确失败的占位，而不是把它定义成
 * lint+typecheck+test —— 那会让人误以为「一条命令跑通生成→渲染→提交」已经验收过。
 * 真正的实现落在 I4（计划 §I4「产出……pnpm verify」），届时本文件被替换。
 */
console.error("[verify] 尚未实现：VC1 大纲→测验、VC2 作答→判分→看板、VC3 对抗输入。计划 I4 落地。");
console.error("[verify] 当前可用的代码级校验：pnpm check（lint + typecheck + test）");
process.exit(1);
