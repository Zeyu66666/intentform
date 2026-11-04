# 生成深度：难度契约 + 教师参考卷 + 联网开关 · 设计（2026-11-04）

## 意图

高三试卷生成出来「一眼就有思路、没有层层递进」。根因是生成提示只约束 Schema、题型与知识点，
没有难度结构，也没有命题角色。教师要的是：基础 → 提升 → 综合 → 压轴 的递进卷，
并且可以拿一份真题卷当命题基准（**只取结构，不出原题**），以及一个只在 live 模式生效的联网搜索开关。

三条路线合并（负责人拍板）：
1. 结构化命题设计（难度契约）——本轮主体；
2. 教师粘贴参考试卷文本，**以教师参考卷为准**，不复用原题；
3. 联网搜索开关，Web UI 可调，离线模式（mock/replay/record）强制不启用。

## 目标

- 蓝图新增难度结构 `difficultyMix`（基础/提升/综合/压轴），与 `typeMix`、`sections` 一样构成
  「和 = totalCount」的第三份分区，教师可在蓝图卡编辑。
- 生成提示升级：按难度角色命题、按顺序递进、解析必须给推理链、禁止浅题与照抄。
- 教师粘贴参考卷文本：只进规划阶段，被提炼成结构化约束（题型比例、难度梯度、知识点、风格备注），
  **原始参考文本不进入生成阶段的提示**。
- 联网搜索：请求级开关 + 服务端配置（搜索端点/Key，进程内存，只回 `hasSearchKey`），
  仅 `live` 且配置齐全时生效；搜索结果同样只进规划阶段，带来源 URL，不进生成阶段原文。
- 回放键对「无参考、无搜索」的旧需求保持不变；带参考文本的需求必须命中不到旧录像（见下）。

## 非目标 / 反目标

- **不复用参考卷原题**：不复制题干/选项/数字/答案/解析，不做「改几个数字」的伪原创。
  生成阶段根本拿不到参考原文，从结构上封死照抄。
- 不做 Word/PDF 上传解析（第一版只粘贴文本；Word 导出是另一条线）。
- 不绑定具体搜索供应商：v1 定一个薄 HTTP 契约（见下），供应商差异由教师侧代理解决。
- 不把搜索/参考做进整表门禁：违规靠提示词红线 + 事后人工核对，不升级为发布失败。
- 不做逐题难度字段：难度是蓝图分区 + 命题角色提示，不往 `FormItem` 加新字段（Schema 不动）。

## 契约

### 蓝图：difficultyMix

```ts
export const DIFFICULTY_LEVELS = ["basic", "standard", "comprehensive", "advanced"] as const;
export type DifficultyLevel = (typeof DIFFICULTY_LEVELS)[number];
export const DIFFICULTY_LABELS = { basic: "基础", standard: "提升", comprehensive: "综合", advanced: "压轴" };

interface FormBlueprint {
  // ...现有字段
  readonly difficultyMix?: Readonly<Partial<Record<DifficultyLevel, number>>> | undefined;
}
```

- **可选**（与 `quotas` 同理）：旧录像、旧蓝图继续合法。
- `superRefine`：存在时六键严格对象、缺省补 0，和必须 = `totalCount`。
- 编辑不变量：`sections 和 = typeMix 和 = difficultyMix 和 = totalCount`。
  改难度分布 → 总题量变，`sections` 与 `typeMix` 按原权重重分（复用 `distribute()`）；
  改章节/题型 → `difficultyMix` 按原权重重分。三者互为配平，确认按钮永不因一次编辑变灰。

### 参考卷与搜索：只进 plan

- `plan` 请求新增可选 `reference?: string`（教师粘贴的参考卷文本，上限沿用 `LIMITS` 里新增的
  `referenceMaxChars`，建议 20000）。
- plan 用户消息追加定界块 `<<<REFERENCE … REFERENCE>>>`，系统提示（plan.v2）写明：
  只提取结构与风格、**输出里不得包含参考卷原题片段**、提炼结果写进蓝图新增字段
  `styleNotes: string`（≤500 字，人话，例如「压轴多为参数讨论，选择题偏多步计算」）。
- 搜索（仅 live）：plan 路由在调模型前先 `searchWeb(query)`，结果整理成
  `<<<SEARCH … SEARCH>>>` 块（每条：title/snippet/url，≤8 条），同样只进 plan，
  plan 把来源并进 `styleNotes`（带 URL）。**生成阶段的 `buildUserPrompt` 只收到蓝图，
  拿不到 reference/search 原文**——由测试钉死。
- `FormBlueprint.styleNotes?: string | undefined`，进蓝图 JSON，随蓝图进生成提示。

### 回放键（契约变更，随本文档一起批准）

```
key = normalize(requirement)
    + "\u0000" + refHash            // 无 reference 时为空串；有则 sha256(normalize(reference)) 前 16 位
    + "\u0000" + model + "\u0000" + promptVersion + "\u0000" + "v" + schemaVersion
```

- 无参考的旧需求：`refHash` 段为空 → **键与旧公式逐字节相同**，重录前的 6 条录像在无参考时仍可命中。
- 有参考的需求：键必然不同 → 命中不到旧录像 → replay 明确报 miss（不回落 mock，已是现有行为）。
- 搜索结果不进键：搜索只在 live 开启，replay 永不搜索，无不确定性。
- `fixtures/replays/README.md` §2 同步更新此公式（该文件是契约文件，改动随本文档获批）。

### 联网搜索

- 设置（并入现有 llm-settings 路由与进程内存语义，同 A-24）：
  `searchBaseUrl: string`（URL 校验）、`searchApiKey: string`（留空 = 保持，空串 = 清空）、
  响应只回 `hasSearchKey` / `searchBaseUrl`，永不回 Key。**AGENTS.md §5 密钥行扩一句**：
  搜索 Key 与 A-24 同规则（内存、不落盘、不进日志、`hasSearchKey`）。同一 commit 附验证。
- 请求级开关：plan 请求 `webSearch?: boolean`。服务端四道闸全过才搜：
  `mode === "live"` ∧ `webSearch === true` ∧ `searchBaseUrl` 非空 ∧ `searchKey` 非空。
  任一不满足：**静默降级为不搜**（不报错——离线模式下开关本就应禁用），并在响应头回执
  `x-intentform-search: off|on`，界面如实显示。
- 薄 HTTP 契约（v1，不绑定供应商）：
  `POST {searchBaseUrl}`，`Authorization: Bearer {searchApiKey}`，体 `{ "query": string, "limit": 8 }`，
  期望 `{ "results": [{ "title": string, "snippet": string, "url": string }] }`。
  字段缺失的条目丢弃；超时 8s；失败 = 不搜（记 warn，不阻断生成）。
  供应商不兼容时教师侧用一行代理转格式——文档写明，不进代码。
- 搜索查询词：取需求前 120 字（规范化后）。不另做查询改写（v1 简单可测）。

### 提示词版本

| 提示词 | 旧 | 新 | 原因 |
|---|---|---|---|
| plan | `plan.v1` | `plan.v2` | 加难度结构、reference/search 定界块、styleNotes、反照抄红线 |
| generate | `generate.v3` | `generate.v4` | 加难度角色命题规则、递进顺序、解析推理链、禁止浅题 |

- mock 的 `mockBlueprint` 补 `difficultyMix`（确定性：按 named types 之外的余量四档均分，和对齐）。
- **重录 6 条录像**（3 需求 × plan+generate）是本方案的硬前提：需要可用的 live Key（deepseek）。
  `fixtures.test.ts` 断言 `meta.promptVersion === DEFAULT_PROMPT_VERSION`，不重录则测试红——
  这是刻意的：不允许新提示词配旧录像冒充。重录用现有 `testing/record-fixtures.ts`，
  meta 照实标 `openai-compatible:<host>`。**没有可用 Key 时的降级**：本方案不落地，
  先只做不改提示词的部分（UI/设置/开关管道），提示词与重录等 Key 到位再做——由负责人选择。

## 界面

- 蓝图卡：题型分布下方加「难度分布」四输入（中文标签，`w-16 text-right tabular-nums`），
  与题型分布同一套配平编辑函数。
- 生成页需求面板：加「参考试卷（可选）」折叠 textarea + 「联网参考」checkbox。
  checkbox 在非 live 模式 `disabled` 并显示原因「当前为离线演示模式」。
- 模型设置页：加搜索端点 / 搜索 Key 两个字段，Key 只回 `hasSearchKey`。
- 看板/时间线：搜索是否生效走 `x-intentform-search` 回执，时间线在 plan 阶段显示
  「联网参考：已搜到 N 条 / 未启用」。

## 验证

- schema：difficultyMix 校验（和、严格键、缺省）；带参考的 plan 请求解析；回放键含 refHash 的新旧公式用例。
- llm：plan.v2 输出含 difficultyMix/styleNotes 且不含参考原文（喂含特征串的 reference 断言不出现）；
  generate.v4 消息里没有 reference/search 原文；`searchWeb` 契约解析与超时降级。
- server：四道闸（mock/replay/record 下 webSearch=true 不发外呼——用注入的 fetch 桩断言零调用）；
  settings 只回 hasSearchKey；plan 路由注入参考块。
- web：蓝图难度编辑配平；参考 textarea 与开关的禁用态；设置页搜索字段。
- 闭环：第 2 步蓝图出现难度分布并可编辑；新增一步粘贴参考卷 → plan 响应含 styleNotes 且时间线出现参考回执。
- 重录后 `pnpm check`、`node scripts/verify.mjs`、`check-fixtures 6/6`、浏览器闭环全绿。

## 已决 / 待决

已决：A+C；教师参考卷优先；不复用原题；粘贴文本先行；搜索薄契约；离线强制不搜；
提示词双升版 + 重录为硬前提。

负责人确认（2026-11-04）：
1. **live Key 可用**（系统环境变量里已有 `LLM_API_KEY`）→ 全量落地并重录 6 条录像。
2. **薄搜索契约接受**（`POST {query, limit}` → `{results:[{title,snippet,url}]}`）：
   供应商适配由教师侧用一行代理完成，不进代码。

未决：Word/PDF 参考卷解析（本版只收粘贴文本）。
