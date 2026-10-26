# P01 · Schema DSL v1

- 迭代：`I1` · 日期：`2026-10-26` · 涉及模块：`packages/schema`（`constants` / `types` / `errors` / `rules` / `latex` / `public-view`）
- 会话导出：`raw-20261026-i1-schema.md`（已归档；DSH 会话无 `/export`，该文件为提问原文 + 交付动作整理，已在文件头注明）
- 上游依赖：`zod@3.24.1`、`katex@0.16.11`（`dependencies`）、`@types/katex@0.16.8`（`devDependencies`），均为《计划 v1.1》§3.1 选型表内的库，不是新增选型

## 提问

我的指令只有一句（`m00380` 原文）：

> 我装好了gh cli 你帮我提交吧 然后继续进行I1

前半句是补做 I0 遗留的远端交付，后半句是 I1。执行模式下我不再逐节确认，只要求每条产出能落到 `pnpm check` 上。为了让 AI 知道"完成"的边界，我在同一轮里给了三条硬要求：

- 按《计划 v1.1》§4.1 的 I1 定义做：7 种字段、`meta.objectives`、规则 R1–R8、`publicView()`、契约测试 C1、≥40 条单测；
- 按承诺的 6 个 commit 拆，每个 commit 单独能过 `pnpm typecheck`，不 squash；
- 新增依赖只能是计划选型表里的（zod、katex），并要求说明理由。

## AI 修改建议

AI 有几处没照字面办，逐条记取舍：

1. **`constants.ts` 先拆出来**。计划没要求这一步，AI 的理由是：`LIMITS` 会被 service 层与前端共用，放在 `index.ts` 里会逼调用方连带拉起 zod 与 katex。我采纳——拆完之后 `web` 端只 import 常量时不会把 KaTeX 打进首屏。
2. **Zod 作为唯一结构事实源，类型全部 `z.infer` 派生**。这条是我要求的，但 AI 加了 `DeepReadonly`：解析结果是可变的，而契约层对外应该是只读的，否则调用方能改掉别人手里的"同一份表单"。我采纳，代价是 `DeepReadonly` 对 tuple 的保真度弱（`labels` 的二元组在类型层退化成 `readonly string[]`），长度仍由 `z.tuple` 在运行时保证。这一点写进了代码注释，没有藏。
3. **R7 不做成规则层的直接调用**。AI 提出把 `checkLatex` 改成 `ValidateOptions` 的注入项，理由有两条：KaTeX 是纯前端库却在服务端跑，规则层不该被它拖慢加载；单测要能注入假 checker 而不必依赖 KaTeX 的真实报错文案。我采纳，并追加了一条它没提的要求——**装配必须放在 barrel 里**，否则调用方忘记传 `checkLatex` 就会静默跳过 R7，那是安全漏洞而不是配置项。现在有一条集成测试专门盯着这件事。
4. **`E_SCHEMA_SHAPE` 是 AI 自己加的码**，附录 A.2 没有。它的理由是：Zod 结构失败也得回喂模型，若借用 `E_DUP_ID` 之类的语义码，repairer 会拿着错误的修复提示去改一个形状问题。我认可，但要求它写进本轮偏离清单——错误码是跨迭代契约，悄悄加会坑到 I6 的 prompt。
5. **AI 建议 `publicView` 用删除式实现**（先展开再 `delete answer`），我否决了：将来给字段加新属性（比如 `rubric`、`answerKey`）时，删除式会静默泄露，白名单式默认不公开。它改成逐字段显式构造，并把这个理由写进文件头注释。

## 我如何引导 AI 修复 Bug

本轮 5 个 bug，前 4 个是我看报错原文后回喂修掉的，第 5 个是 AI 自查发现的：

1. `TS5083` 之后的老毛病换了个形状：**字段 id 2 位**。AI 写的测试底稿用了 `q1`/`q2`，而 `LIMITS.idPattern` 是 `^[a-z0-9_-]{3,32}$`，于是 15 条用例集体挂在 `E_SCHEMA_SHAPE` 上，看起来像"规则层全错"，实际是 fixture 不合法。
   我的处理：先让它跑一条最小用例确认 fixture 本身能过校验，再批量改 id。教训是**测试底稿必须满足常量约束，否则全线红灯会掩盖真实问题**。
2. `TS2339: Property 'score' does not exist on type '{ type: "short" ... }'`
   出现在 `public-view.ts` 的 `projectScored`。AI 把 `ShortField | ScaleField` 也塞进了这个函数的参数类型，以为"字段都有 score"。实际 `types.ts` 里短答与量表属于收集型字段，**结构上就没有** `score`/`bloom`/`knowledgePoint`。
   我贴了完整报错，让它回答"为什么这两类没有这三个字段"。它回去读了 `collectFieldSchema` 才承认是分层没读全。修法是收窄参数类型到四个判分型字段，并顺手删掉测试数据里 short/scale 上多余的 `score`——那些键会被 Zod 静默 strip，留着会让人误以为它们参与判分。
3. `E_LATEX_INVALID` 从来不会出现。AI 第一版让 `rules.ts` 直接 `import katex`，但 commit 3 提交时 `latex.ts` 还不存在，于是它把 R7 整段设为"未注入就跳过"。
   我发现问题的时机是跑集成测试：带 `$\broken{x}$` 的表单通过了校验。要求它加装配并补一条**从包入口调用**的测试——单测走 `./rules` 注入假 checker 是通的，走 `./index` 才是用户的真实路径。
4. 测试断言把自然语言当结构化数据切：`line.slice(line.indexOf("位置 "), line.indexOf("）"))`。`E_SCORE_SUM` 的提示里有"（整数）"，第一个全角右括号出现在"位置"之前，`slice` 直接取到空串。
   我的处理：要求改成锚定行尾的正则 `/（位置 ([^）]+)）$/`，并让它把这条写进本文件——`repair` 文本是给模型读的散文，**任何程序都不该用第一个定界符去切它**。
5. AI 自查：`errorsOf()` 这个测试 helper 的返回类型被手写成 `{ code, path }[]`，丢了 `message`，导致三处 `TS2339`。修法是让返回类型直接指向源类型 `SchemaError`，而不是手抄子集。

另有一个**设计层**的发现（不是 bug，但改变了规则的位置）：`bloom` 的枚举校验由 `types.ts` 的 `z.enum` 完成，语义层再查一次是死代码。但如果就这么放着，非法 bloom 只会报 `E_SCHEMA_SHAPE`，repairer 拿不到"应该是 6 个层级之一"的有效提示。最后的处理是在 `shapeErrors` 里做**错误码映射**：`invalid_enum_value` 且路径以 `bloom` 结尾 → `E_BLOOM_INVALID`。这样既不重复校验，又保住了附录 A.2 的错误码契约。

## 结果

- 产物：7 种字段的 Zod 定义与派生类型、`LIMITS` 上限、11 个错误码与固定修复提示、R1–R8 规则实现、KaTeX 校验（`trust: false`）、`publicView()` 白名单投影、C1 契约测试、边界用例。
- 验证：`pnpm check` 全绿（lint 127 规则 0 警告 / 4 包 typecheck / **99 条测试通过**，其中 `packages/schema` 占 **85 条**，超过计划的 ≥40）。测试文件分布：`types` 15、`rules` 20、`validators.ai` 17、`index` 14、`latex` 11、`contract` 8。

| commit | message | 说明 |
|---|---|---|
| `9028407` | `refactor(schema): split constants and guards into dedicated module [P01]` | 拆 `constants.ts`，barrel 只做重导出 |
| `2bbd544` | `feat(schema): define FormSchema v1 field union with zod [P01]` | 7 种字段 + `LIMITS` + 15 条类型测试；引入 zod/katex |
| `2893585` | `feat(schema): semantic rules R1-R8 with error codes [P01]` | `errors.ts` + `rules.ts` + 20 条规则测试 |
| `c621cb0` | `feat(schema): validate LaTeX via KaTeX parse [P01]` | `latex.ts` + barrel 装配 + 11 条测试 |
| `7197dad` | `feat(schema): publicView projection + contract test C1 [P01]` | 白名单投影 + 8 条 C1 契约测试 |
| `9f240a0` | `test(schema): AI-generated validator cases [AI-TEST]` | 17 条边界与脏输入用例，含 2 条缺口记录 |
| （本次归档 commit） | `docs(prompt-log): archive P01 raw log and commit hashes [P01]` | 本文件与 raw 导出 |

### 相对《计划 v1.1》的偏离（4 处，均为有理由的追加）

| # | 偏离 | 理由 |
|:--:|---|---|
| 1 | 新增错误码 `E_SCHEMA_SHAPE`（附录 A.2 只有 10 个） | Zod 结构失败需要可回喂的码，借语义码会给出错误修复方向。I6 的 prompt 必须收录此码。 |
| 2 | `E_MULTI_ANSWER_INVALID` 也覆盖"答案 id 重复" | 附录 R3 只说"非空去重全属选项"，没规定重复时报什么码。复用一个码比新增更省心。 |
| 3 | R7 走注入 + barrel 装配，规则层不 `import katex` | 见"AI 修改建议"第 3 条；并有集成测试防止静默跳过。 |
| 4 | 6 个模板 commit 之外多一个 prompt-log 归档 commit | 与 P00 同惯例；留痕本身是评分项，不适合塞进功能 commit。 |

### 已知缺口（带进后续迭代，未在本轮修）

1. **`survey` 的 `meta.totalScore` 未被禁止**。附录只约束了字段级的 `answer`/`score`，没有约束 `meta`。当前放行，用例名以"已知缺口"开头。
2. **`meta.objectives` 内 id 重复未被检查**。当前用 `Set` 收集，重复声明不会报错。R8 只要求"引用存在"，没要求"声明唯一"。
3. **`E_LEAK` 只存在于 `TEST_ONLY_ERROR_CODES`**，生产码里没有任何地方会产生它。C1 靠测试断言而非运行时可报错——若要运行时报错，得等 I4 的 `publicView` 出口统一化。
4. **短答与量表没有人工给分字段**。它们结构上没有 `score`，若 I6 需要"教师给分"，得加 `rubric` 一类字段，届时 `publicView` 必须同步排除。

### 脱敏记录

本次会话导出的 `raw-20261026-i1-schema.md` 中**未出现**需替换的个人信息：无真实姓名、手机号、学校名、邮箱、账号或 API Key。唯一与"身份"相关的字符串是 GitHub 账号 `Zeyu66666` 与仓库地址——这是公开仓库地址，属于可公开信息，且报名材料本就要求仓库可访问，故未替换。

原始导出：`raw-20261026-i1-schema.md`（DSH 会话无 `/export`，该文件为提问原文 + 交付动作整理，已在文件头注明）。
