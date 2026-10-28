# P08 · 受限修改（Patch + 撤销）：一句话改，但只准改七种东西

- 迭代：`I7`（省赛 R-03 顺延） · 日期：`2026-10-28` · 涉及模块：`packages/schema`、`packages/llm`、`server`、`web`
- 会话导出：`raw-20261028-i7-patch.md`（已脱敏；本仓库不使用对话导出功能，该文件是"提问原文 + 动作"的整理稿）
- 编号说明：原计划里 Patch 是 `P07`，省赛 R-01/R-02 先落地并占用了 `P07`，Patch 顺延为 `P08`。

## 提问

用户原话（`m04471`）：`你就按计划继续吧` —— 在此之前用户已定下两条约束且仍未解除：
作品介绍文档不再随每次代码改动重出（等候选冻结再一次性重做），后续工作按省赛方向排。
《计划 v3.0》§4.1 里 I7 的原文是：「受限修改 + 撤销；**不扩通用 Patch、不做重做栈**」，
所以这一轮的提问不是"给我做个编辑器"，而是：

> 在已有 `applyPatch` 之上把「自然语言 → 改动 → 版本」打通：冲突要 409、每次落库必须追加一版、
> 撤销只回退一步、模型只准提议那几种操作，且建议这半步不能写库。

我给的硬约束（延续 AGENTS.md）：

1. 不引依赖，服务端仍是 `node:http` 零框架，`web` 仍只能拿到 `schema` 的类型与纯函数。
2. 写库的只有一个入口 `PATCH /api/forms/:id`，`baseVersionId` 做乐观锁；旧基线一律 409。
3. 建议接口 `POST /api/forms/:id/suggest` **只回 ops 与人话差异，绝不写库**——
   要让「看一眼」和「改掉」是两个动作，不能点一下就悄悄落库。
4. 模型只准产出七种 op（改题干/改选项/改分值/加题/删题/移题/改答案？——**不是**：
   最后一种是 `setAnswer` 只对客观题开放，简答禁止带答案）。
5. 撤销不做重做栈：`POST /api/forms/:id/undo` 只把草稿指针回退一步。

## AI 修改建议

按采纳顺序，含被否决的：

1. **（采纳）契约先行**：`packages/schema/src/patch.ts` 里用 `discriminatedUnion("op")` 定义七种 op
   与纯函数 `applyPatch(schema, ops)`，返回 `{schema, changes}`；`changes` 是人话差异，
   总分那条由 `recomputeTotalScore` 在契约层算——**前端与后端共用同一份差异**，不各算一遍。
2. **（否决）AI 建议"顺手实现一次通用 JSON Patch（RFC 6902）"**。否决理由：通用 Patch 允许
   改任意路径，等于把"表单是什么"从 schema 里搬走；而且 `add`/`remove`/`replace` 的路径语义
   会让权限与门禁无处安放（哪一条路径算"改答案"？）。受限 op 的好处是**每条都能被
   `validateForm` 单点判定**，坏改动在落库前就会被挡住。
3. **（否决）AI 建议"建议接口直接把新 schema 存成草稿，再让用户确认是否保留"**。
   否决理由：这会让"看一眼"产生副作用——用户放弃建议后，草稿指针已经动过了，
   「撤销」也就分不清是撤建议还是撤自己上一次的编辑。改成**建议只读**，采用才 `PATCH`。
4. **（采纳，但改了实现）AI 提出把 `suggestPatch` 塞进 `generate.ts` 的修复环里复用**。
   否决复用、保留独立文件 `packages/llm/src/patch-suggest.ts`：生成是"从零产出整表"，
   改成是"在既有 schema 上产出 ops"，两者的 prompt、校验器和失败语义都不同，
   混在一个文件里会让 `generate.v2` 的回放键与 `patch.v1` 的混在一起。
5. **（采纳）`replay` 模式对 patch 显式报错**：`patch.v1` 还没有录像，
   硬套 `generate` 的录像会得到"看着像成功"的错答案，所以抛 `llm_config` 并说明要用 `live` 或 `mock`。

## 我如何引导 AI 修复 Bug

这一轮有四个真实问题，都是先看到具体现象再定位的：

1. **类型不匹配（编辑页接不上建议框）**：`SuggestBox` 的 `onApplied` 一开始签名是
   `(detail: FormDetailResponse) => void`，但 `PATCH` 返回的是 `PatchFormResponse`
   （没有 `form` 之外的字段、版本是 `FormVersionSummary`）。AI 第一版在组件里拼了一个假详情
   去满足类型，被我否掉：**拼假详情会掩盖"少发了一次请求"这件事**。
   改成回调只给三项 `{schema, versionId, versionN}`，由 `EditorPage` 就地替换编辑态。
   报错原文：`error TS4104: The type 'readonly (...)[]' is 'readonly' and cannot be assigned to the mutable type`。
2. **`describeFailure` 少参数**：`error TS2554: Expected 2 arguments, but got 1` ——
   `describeFailure(failure, options)` 第二参是 `{notFound, unauthorized?}` 文案表。
   这类错误说明 AI 记的是旧签名，用 `pnpm typecheck` 一次性照出来。
3. **`ops` 是 readonly**：`patchForm(formId, {baseVersionId, ops: suggestion.ops})` 编译不过，
   因为请求体要可变数组。改成 `ops: [...suggestion.ops]` 并写明"拷一份"的理由，
   而不是把契约里的 `readonly` 去掉——契约的只读是对的，改调用方。
4. **（界面级，闭环第 8 步兜住的）"采用后界面还显示 v1"**：冒烟脚本第一次读 `edit-form-meta`
   时读到 `当前草稿 v1`、diff 显示 `0 条`，看起来像"采用没生效"。真相是脚本在点击后
   **同一个事件循环里**就读了 DOM，React 还没重渲染；截图 `03-applied.png` 里明明是 `v2`。
   修法不是给界面加延时，而是**改成等条件**：`waitFor(meta 含 'v2')`。
   这类"测试自己太急"的假失败，如果当成产品缺陷去改 UI，就会把正确的实现改坏。

## 结果

产物：

- `packages/schema/src/patch.ts`：七 op 契约 + `applyPatch` + `describeChange`（人话差异）
- `packages/llm/src/patch-suggest.ts` + `prompt.ts` 的 `patch.v1`：自然语言 → ops（`live`/`record`/`mock`）
- `server/src/patch-route.ts`：`PATCH /api/forms/:id`（乐观锁 409）、`POST /api/forms/:id/undo`
- `server/src/suggest-route.ts`：`POST /api/forms/:id/suggest`（只读，带独立限流配额）
- `web/src/edit/`：`EditorPage.tsx`、`patch-plan.ts`（编辑态 → ops）、`SuggestBox.tsx`（建议半步）
- `scripts/verify.mjs` 补 VC6；`scripts/browser-closed-loop.mjs` 补第 8 步（九步十二图）

| commit | message | 说明 |
|---|---|---|
| `d9eb110` | `feat(patch): 受限修改与撤销的服务端地基 [P08]` | op 契约、`applyPatch`、`PATCH`/`undo` 路由、24 条测试 |
| `6139997` | `feat(patch): 草稿的发布门禁提示 issues [P08]` | `PATCH` 响应带 `validateForm` 的 issues，只提示不拦保存 |
| `3ce8401` | `feat(patch): 一句话改成受限操作集（建议半步，不写库）[P08]` | `patch-suggest.ts`、`patch.v1`、建议路由与限流 |
| `e1a3cb3` | `feat(web): 编辑页与一句话改，采用/撤销/409 都有入口 [P08]` | 编辑器页、`patch-plan`、409 与撤销提示 |
| `df67e25` | `test(scripts): 闭环加第 8 步编辑器，九步十二图 [P08]` | 界面级证据：v1 → 采用 v2 → 撤销 v1 |

验收实测（2026-10-28 08:30）：`npx vitest run` **59 文件 / 685 用例**全绿；`pnpm typecheck` 4 包；
`oxlint --deny-warnings` 0 告警（170 文件）；`node scripts/verify.mjs` **6/6**（VC6 覆盖 PATCH 追加版本、
旧 `baseVersionId` 409、undo 回退）；`node scripts/browser-closed-loop.mjs` **9 步全绿 / 12 张截图**。

## 已知缺口

1. `replay` 模式没有 `patch.v1` 录像，离线只能走 `mock`（内置脚本改第一题题干 + 第 2 题加分）。
   要演示"模型真读懂了这句话"，必须 `LLM_MODE=live` 且配 Key。
2. **版本冲突的浏览器级证据仍缺**：VC6 是 HTTP 级；编辑器里的 409 分支（`fill-conflict` 类似的
   提示 + 刷新按钮）只有实现与 `typecheck` 把关，没有真点击。
3. 加题只有"简答"一种模板，且只能追加到末尾；没有"插入到第 N 位"的入口。
4. 页面层没有 DOM 自动化测试（与本仓库一贯约定一致）：编辑页的交互靠第 8 步截屏 + 人工看。

## 脱敏记录

无需替换：本轮提问与工具输出里没有姓名、手机号、学校名、邮箱、密钥；
截图 `09-editor.png` ~ `11-editor-undone.png` 里的表单标题与题目都来自 `pnpm seed` 的虚构数据。
