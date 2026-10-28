# P11 · 两阶段蓝图：先定结构，再填题目

- 迭代：省赛 `R-06` · 日期：`2026-10-28` · 涉及模块：`packages/schema`、`packages/llm`、`server`、`web`、`eval`、`scripts`、`fixtures`
- 会话导出：`raw-20261028-r06-blueprint.md`（已脱敏）

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 先产出结构化蓝图（章节 / 题量 / 题型 / 知识点分布 / 总分），教师确认后再生成字段；蓝图与成品的偏差可度量；时间线真实出现 `plan` 阶段（未发生不许演出）；prompt 升版并重录 fixture。来源：计划 v3.1 §2.1.1 第 3 条 |
| 允许修改范围 | `packages/schema/src/{blueprint,prompt?}.ts`、`packages/llm/src/{plan,sources,prompt,generate}.ts`、`server/src/{plan-route,generate-route,app,main}.ts`、`web/src/{panels,api,App.tsx}`、`eval/run.mjs`、`scripts/*`、`fixtures/replays/`（重录）、文档。**不动**：判分口径、看板、SSE 事件类型清单（不加第 8 类） |
| 验收案例 | ①`POST /api/plan` 回结构合法蓝图（自洽：章节题量之和 = 总题量 = 题型分布之和）；②同一需求两次调用结果确定（replay/mock）；③带蓝图生成时 prompt 含蓝图块、不带时需求字节不变；④时间线出现 `plan` 且无蓝图时不出现；⑤偏差可度量（题量/题型/总分/知识点）；⑥浏览器能确认蓝图再生成；⑦`eval` 报告有蓝图→成品偏差 |
| 停止条件 | 需要新增 SSE 事件类型、蓝图校验不过却降级成「无蓝图生成」、或录制失败 ⇒ 停下回报 |

## 提问

用户 2026-10-28 的裁定：

> 我可以提供deepseek的key 你给我方案

随后在两个选项上选了：**A｜蓝图独立一步、教师可确认**，以及**重跑一次 live 评测**。

硬约束（延续 AGENTS.md）：不引依赖；不新增 SSE 事件类型；教师可跳过蓝图直接生成；
蓝图与生成各自有独立回放键；fixture 必须是真实上游录制的（没有 Key 就不录，不用 stub 冒充）。

## AI 修改建议

采纳的：

1. **蓝图走独立的 `POST /api/plan`**，模型产出一行 NDJSON，`blueprintSchema` 校验其自洽性
   （章节题量之和 = 总题量 = 题型分布之和），不合法重试一次后明确报错。
2. **`plan.v1` 与 `generate.v3` 是两个 prompt 版本**，因此是两个回放键；
   `StreamInput` 增加可选的 `promptVersion` / `messages` 覆写，录制/回放/实时三条路径
   共用同一套实现，不为蓝图另写一套 IO。
3. **偏差在 `packages/schema` 里算**（纯函数），服务端只负责取数与发 `thinking` 摘要，
   eval 复用同一个函数——两处口径不可能漂移。

我自己否决的：

- **同一流内先蓝图后字段**（方案 B）：教师无法在生成前确认蓝图，与 §2.4「确认后再生成」不符。
- **把偏差塞进 `done.stats`**：那是事件载荷契约，改它要动 7 类事件的 schema；用 `thinking` 摘要 + eval 落数即可。
- **蓝图不合法时降级成无蓝图生成**：那会让"两阶段"在失败时静默退化成单阶段，证据链断在这里。

## 我如何引导 AI 修复 Bug

本轮四处真实发生的问题，次序即发现次序：

1. **提示词样例还是旧形状**（最严重）。契约把 `knowledgePoints` 改成 `{id,name}` 之后，
   `plan.v1` 的系统提示与样例仍写着字符串数组。真实录制时模型**照抄样例**，两次都返回
   `"knowledgePoints":["二次函数的定义",…]`，契约一律拒收，错误是
   `Expected object, received string`。定位方式：在 `planForm` 的失败分支打印原文前 300 字，
   一眼看出不是"围栏"也不是"散文开场"，而是字段形状不对。
   修法：样例改成 `{"id":"kp_open","name":"开口方向"}`，并补一条
   「**样例本身必须是合法蓝图**」的测试——模型最爱照抄样例，样例坏=整份输出坏。
2. **录像校验不认蓝图**。`check-fixtures` 把所有 `.ndjson` 当 FormItem 流行逐行校验，
   3 条蓝图录像全被报"有 1 行不是合法 FormItem"。修法：按 `meta.promptVersion` 分支，
   `plan.*` 用 `parseBlueprint` 验，生成才走逐行校验。
3. **题量显示自相矛盾**：`蓝图对照：题量 8 → 9（差 0）`。`fields` 含分节、偏差不含分节，
   同一句话里两个口径。修法：显示也按题目数算。
4. **评测报告把 prompt 版本写死成 `generate.v1`**。prompt 已升到 v3，报告头却还写 v1，
   这正是计划 §0.2 #7 记的那类"数字与版本脱钩"。修法：从 `@intentform/llm` 读
   `DEFAULT_PROMPT_VERSION`；顺带把「首轮达标」限定在判分需求上（原来把澄清探针也算进去了）。

## 结果

省赛 R-06 收口。计划 §2.1.1 第 3 条逐项对应：

| 要求 | 落点 | 证据 |
|---|---|---|
| 先产出结构化蓝图（章节/题量/题型/知识点分布） | `FormBlueprint` 契约 + `POST /api/plan`（`plan.v1`） | `blueprint.test.ts` 9 条、`plan.test.ts` 11 条、`plan-route.test.ts` 7 条；VC9 |
| 再生成字段 | `/api/generate` 收 `blueprint`，作为硬约束进用户消息的 `<<<BLUEPRINT` 块 | `prompt.test.ts`；`generate-route.test.ts` |
| 蓝图与成品偏差可度量 | `compareWithBlueprint`（纯函数）+ 流尾「蓝图对照」+ eval 汇总 | eval 报告「计划 vs 成品 20 / 28」 |
| 时间线真实出现该阶段 | 只有带蓝图才发 `plan` phase；不带时既不出现 plan 也不出现蓝图事件 | `generate.test.ts`；VC9 双向断言；闭环第 2 步截图 `02b-plan.png` |
| prompt 升版并重录 fixture | `plan.v1`（新）+ `generate.v2 → v3`；6 条录像全部来自真实上游 | `fixtures/replays/`（`upstream=openai-compatible:api.deepseek.com`），`check-fixtures` 6/6 |

真实数字（当轮实测）：

| 命令 | 结果 |
|---|---|
| `npx vitest run` | **65 文件 / 778 用例全绿**（R-05 收口 742，本轮 +36） |
| `pnpm typecheck` | 4 包通过 |
| `npx oxlint --deny-warnings` | 0 告警 / 184 文件 |
| `node scripts/verify.mjs` | **9/9**（新增 VC9） |
| `node scripts/browser-closed-loop.mjs` | **9 步全绿 / 14 张截图**（新增 `02b-plan.png`，第 2、9 步都走蓝图确认） |
| `node eval/run.mjs --mode live --label r06c` | **整份达标率 28/28（100%）**；首轮 28；错行 0；澄清 2/2；**计划 vs 成品结构完全一致 21/28**、题量偏差 0.00；单条均值 4.98 s（含规划+生成两次调用） |
| `node --experimental-strip-types packages/llm/src/check-fixtures.ts` | 6 条录像全部通过 |

| commit | message | 说明 |
|---|---|---|
| 见 `git log` | `feat(schema): 蓝图契约与 plan.v1…` / `feat(server): /api/plan…` / `feat(web): 蓝图卡片…` / `feat(llm): 重录录像…` / `docs` | 本轮共 8 条，逐条见仓库 |

**已知边界**（不写成能力）：

- **蓝图不能就地编辑**：要改结构请回去改需求。给蓝图加编辑器等于把"表单是什么"搬到第三处。
- **知识点 id 复用率 21/28**：模型有时在题目里用了蓝图没列到的 id（或反过来漏用）。
  偏差如实记录，不隐藏。
- **单次运行有抖动**：同一 prompt 版本连跑两轮，一轮错行 4（3 修复、1 丢弃）、另一轮 0；
  达标率两轮都是 28/28。报告里引的是最后一轮，抖动写在这里。
- **100% 的含义有限**：判据只查题量/题型/总分/kind；知识点覆盖单列在「计划 vs 成品」。
  这是"这一组需求能被满足"，不是"教学效果好"。
- **单条耗时翻倍**：两阶段是两次模型调用（均值 4.97 s）。
- **replay 只覆盖 3 条预置**（6 个录像：蓝图 + 生成各 3）。自由输入在 replay 下仍会
  「未命中录像」并明确报错；`plan.v1` 的未命中同样报错，不回落 mock。
- eval 脚本现在从根目录解析 `@intentform/{schema,llm}`（根 `package.json` 加了这两个
  `workspace:*` devDependencies），否则 `eval/run.mjs` 无法 import 纯函数做偏差计算。
