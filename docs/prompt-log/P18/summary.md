# P18 · 单题精细修改（A-20）

- 迭代：附加 `A-20` · 日期：`2026-11-02` · 涉及模块：`packages/schema`、`packages/llm`、`server`、`web`、`scripts`、文档
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：契约 `a276909`、提示词 `7d218b5`、服务端 `492441f`、前端 `be9b69b`、脚本 `1ddf54f`、本留痕与证据随后一个 docs commit

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 按《计划-单题修改-P18》交付：点任意一题即可改题干、分值、选项与正确项、解析、必答、布鲁姆、知识点，简答可改 `maxLength`；面板内「只改这道题」的建议只列本题改动；手动修改与建议采用走同一条 `applyPatch → PATCH`；答案改动生成新版本且已发布指针不前进 |
| 允许修改范围 | `packages/schema/src/{patch,api}.ts`、`packages/llm/src/patch-suggest.ts`、`server/src/suggest-route.ts`、`web/src/edit/*`、`scripts/{verify,browser-closed-loop}.mjs`、证据索引与留痕 |
| 验收案例 | ①面板能改 D1 列出的全部字段；②单题建议只回目标题的字段 op，越界整包拒绝；③手动改答案与建议改答案都走 PATCH；④答案改动后旧版提交仍按旧快照判分；⑤`pnpm check` 全绿、VC1–VC13、闭环 15 步 |
| 停止条件 | 需要引入通用 JSON Patch、把答案改动直接写进已发布版本、或让建议绕过 `applyPatch` 直接写库 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 契约 | `packages/schema/src/patch.ts` | op 6 → 11。`setAnswer` / `setExplanation` / `setRequired` / `setMeta` 之外补 `setMaxLength`：D1 要求简答可改字数上限，原四个新 op 没有承载位置；**界面能改的每一项都必须有可撤销的一步 op**，不能只改内存 |
| 契约 | `packages/schema/src/api.ts` | `targetItemId` 可选但给了就必须是合法字段 id；`ITEM_SCOPE_PATCH_OPS` 排除 `addItem` / `removeItem` / `moveItem`——单题建议不负责结构变更 |
| 提示词 | `packages/llm/src/patch-suggest.ts` | `patch.v1 → patch.v2`；带 `targetItemId` 时提示词只允许该题的字段 op |
| 服务端 | `server/src/suggest-route.ts` | 两道闸：目标题必须存在于**这一版**（否则 422），模型返回的 op 再逐条校验 id 与白名单（越界 422）。两道闸都在写库之前，**没有静默过滤** |
| 前端 | `web/src/edit/ItemEditor.tsx` | 单题面板；选项增删改与正确项、填空/数值/简答的答案控件、解析、必答、布鲁姆、知识点、`maxLength`、上移/下移/清除/删除 |
| 前端 | `web/src/edit/answer-input.ts` | Schema ⇄ 草稿 ⇄ 载荷的唯一转换层；数值空输入转 `NaN` 而不是 0 |
| 前端 | `web/src/edit/patch-plan.ts` | 草稿 → op 序列；挑选项时也要校验有效答案（删掉正确项必须当场拒绝），但只有答案本身被改时才发 `setAnswer` |
| 前端 | `web/src/edit/SuggestBox.tsx` | `scopeItemId` 驱动 testid 前缀与「仅第 N 题 · M 条改动」标题；整表建议保持原样 |
| 前端 | `web/src/edit/EditorPage.tsx` | 保存、撤销、采用建议后都保留选中题；删除旧的 `FieldEditor` |

## AI 修改建议

采纳的：

1. **补 `setMaxLength`，而不是让输入框只改内存**。计划列了四个新 op，但 D1 明确要求简答可改 `maxLength`；少一个 op 就意味着这个输入框保存后丢失。实际 op 总数 11，`PATCH_ERROR_CODES` 11 条（原 6 + 新 5），已在 `附加功能.md` 记录偏差。
2. **选项与答案分成两个 op**。改选项文字只发 `setOptions`；改正确项才发 `setAnswer`。合成一个 op 会让「只改措辞」也产生判分版本，历史提交的答案标签跟着变。
3. **删掉正确项当场拒绝**。`patch-plan` 在触碰选项时用「草稿答案或原答案」做有效性校验，错误在面板里出现，而不是等服务端 400。
4. **`null` 一律删键**。清空解析、清空布鲁姆/知识点都产生 `null`，`applyPatch` 删除对应键，避免序列化出 `explanation: null` 这种和「没有解析」不等价的形状。
5. **单题建议保留整表建议**。整表入口在页头，单题入口在面板顶部；两者共用 `SuggestBox`，用 `scopeItemId` 区分 testid，避免同一页面两个 `edit-suggest-input` 冲突。

自己否决的：

- **让单题建议也能加题/删题**：作用域会从「这一题」滑到「这张卷」，与 D2 的「只改这道题」冲突。
- **答案改动自动发布**：D4 要求已发布指针不前进；自动发布会把一次草稿修改直接推给学生。
- **前端自己算 `changes`**：diff 必须与 PATCH 返回同源，否则预览和落库会出现两套口径。

## 我如何引导 AI 修复问题

本轮抓到并修掉的真实问题：

1. **数值空输入被当成 0**。`Number("")` 是 0，第一版 `toAnswerPayload` 会把「没填」静默变成正确答案 0。测试先写下「空白应为 NaN」，再改实现；`patch-plan` 拿到 NaN 后报「请填写数值」，而不是保存一个错误答案。
2. **删掉正确项没有触发校验**。第一版只在答案本身被改时校验，测试「删掉正确项应被拒绝」失败。修法是：触碰选项时用有效答案校验，但只在答案被改时发 `setAnswer`——校验面与写入面分开。
3. **联合类型收窄在回调里丢失**。`ItemEditor` 的填空/数值分支在 `onChange` 回调里读 `draft.answer` 时 TS 报 TS2345；用局部 `const answer = draft.answer` 保住收窄，没有用 `as`。
4. **VC13 第一版读错响应形状**。`CreateFormResponse` 是 `{ ok, form, version }`，没有 `schema`；改成建完后 `GET` 详情再取 `schema`，断言才成立。
5. **测试里清空解析却没有可清的键**。原用例的 Schema 没有 `explanation`，清空不会产生 op；改用带解析的 Schema，才真正覆盖「`null` 删键」。
6. **oxlint 拒绝近似常量**。测试里的 `3.142` / `0.001` 触发 `approx-constant`；换成 `2.75` / `0.25`，保留「数值 + 容差」的语义。

## 结果

真实数字（本轮实测，2026-11-02）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **72 文件 / 869 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC13 全过（13/13）** |
| `node scripts/browser-closed-loop.mjs` | **15 步全绿 / 25 个产物**（24 张截图 + 1 份 PDF；第 15 步新增 3 张） |
| `node scripts/secret-scan.mjs` / `--history` | 均 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `a276909` | `feat(schema): 补单题编辑的五个字段 op 与建议作用域契约 [P18]` | 5 个新 op、错误码、`targetItemId`、单题白名单 |
| `7d218b5` | `feat(llm): 单题建议 prompt 升到 patch.v2 [P18]` | 提示词与回放版本 |
| `492441f` | `feat(server): 建议接口按 targetItemId 双重限域 [P18]` | 422 两道闸 |
| `be9b69b` | `feat(web): 编辑面板支持选项答案解析与单题建议 [P18]` | `ItemEditor`、`answer-input`、`patch-plan`、`SuggestBox`、`EditorPage` |
| `1ddf54f` | `test(scripts): VC13 与闭环第 15 步覆盖单题修改 [P18]` | HTTP 与浏览器两级证据 |

**已知边界**：

- 单题建议只做字段修改，不含加题/删题/移动；结构性操作仍由面板按钮发起。
- 答案改动不会自动发布，教师必须显式发布新版本，学生才看到新卷面。
- 仍只支持单步撤销，没有重做栈；没有通用 JSON Patch。
- 浏览器第 15 步的生成步骤仍是 `LLM_MODE=mock`，它证明链路通电，不证明模型读懂那句话。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱，未做占位符替换。
