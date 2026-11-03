# P20 · 覆盖矩阵点击补题（A-22）

- 迭代：附加 `A-22` · 日期：`2026-11-03` · 涉及模块：`packages/schema`、`packages/llm`、`server`、`web`、`scripts`、文档
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：契约 `c927f73`、提示词 `a38a6ec`、服务端 `fdfcc8d`、前端 `ec75302`、脚本 `af23045`、本留痕与文档随后一个 docs commit

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人明确推翻《计划-v3.1》§2.2「覆盖矩阵只展示」的决定：矩阵每格成为补题入口，**手动模板与模型生成两条路都要有**，且确认前不写库 |
| 允许修改范围 | `packages/schema/src/api.ts`、`packages/llm/src/supplement.ts`、`server/src/supplement-route.ts`、`web/src/{dashboard,edit,router,Link,api}`、`scripts/{verify,browser-closed-loop}.mjs`、文档 |
| 验收案例 | ①点矩阵格进入编辑页并预填知识点/层级；②手动路径插入模板题；③模型路径回一道候选题、教师确认后才进草稿；④补题接口不写库；⑤未知知识点 422、旧版本 409；⑥旧能力不回退 |
| 停止条件 | 需要让模型直接写库、自动批量填满矩阵，或把学生答案带进补题上下文 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 契约 | `packages/schema/src/api.ts` | `POST /api/forms/:id/supplement`：只收 `baseVersionId / knowledgePoint / bloom / instruction?`，只回一道 `FormItem` + 来源，不含任何写库语义 |
| 提示词 | `packages/llm/src/supplement.ts` | 独立 `supplement.v1`；输出单 JSON 题目，禁止 section/scale；知识点与层级在解析后被钉回请求值 |
| 校验 | 同上 | `formItemSchema` 结构校验 + 选项/答案一致性；replay 无录像明确报错；mock 是固定单选题 |
| 服务端 | `server/src/supplement-route.ts` | 调模型前三道闸：归属（403/404）、`baseVersionId` 是否当前草稿（409）、知识点是否在本版 `meta.objectives`（422）。候选 id 由服务端生成 |
| 矩阵 | `web/src/dashboard/DashboardPage.tsx` | 每格改成 `Link`，地址 `?add=1&kp=…&bloom=…`；0 与已有覆盖都可点 |
| 路由 | `web/src/router.ts` | `editorAddItemPath` 统一拼查询串；`parseRoute` 仍只看 pathname |
| 补题面板 | `web/src/edit/SupplementBox.tsx` | 手动：回调插入预填模板；模型：调接口、显示候选、点「加入草稿」才回调 |
| 编辑态 | `web/src/edit/patch-plan.ts` | `add` 意图支持 `id / knowledgePoint / bloom / item`；整道候选题经 `formItemSchema.parse` 后进 `addItem` |

## AI 修改建议

采纳的：

1. **补题接口只回候选，不写库**。与 `/suggest` 同一条原则：模型理解错了，在教师确认前不能变成版本增量。
2. **知识点与层级由请求钉死**。模型写错知识点时，题即使加进去也不会被矩阵算到目标格，补题就失去意义；钉死作用域、只让模型决定题目内容。
3. **手动路径插入模板题而不是空表单**。复用 `ItemEditor` 的全部字段编辑能力，不必另写一套「新建题目」表单。
4. **模型候选题整道进 `addItem`**，而不是把字段逐个覆盖到模板题上。题型（单选/简答）不同时逐字段覆盖无法表达，整道添加才与 Schema 一致。
5. **矩阵格用链接而不是按钮**。保留中键新开、复制地址等浏览器语义；补题地址可分享。

自己否决的：

- **看板弹窗内直接编辑整道题**：会把 `ItemEditor` 的草稿/乐观锁逻辑复制到看板，制造第二份编辑状态。
- **补题后自动发布**：发布是教师的显式动作，补题只进草稿。
- **批量填满矩阵**：一次只补一格，避免「模型一口气生成 20 题」变成不可审阅的版本增量。

## 我如何引导 AI 修复问题

本轮抓到的真实问题：

1. **浏览器断言等错了文案**。第 16 步第一次超时在「diff 出现加题」；`PatchChange` 对新增题的 `after` 是「新增「…」」，不是 op 名「加题」。改用「新增」后通过。教训：断言要对准界面实际渲染的字段，不要对准内部 op 名。
2. **新路由的越权返回 404 而不是 403**。第一版直接用 `findForm`，别人的表单查不到就当不存在；改为复用 `requireOwnedForm`，存在但不是自己的返回 403，与 AGENTS §5 一致。
3. **`FormItem` 联合类型在测试里读不到 `bloom/knowledgePoint`**。补题候选已排除 section/scale，但类型仍是全联合；测试先 `expect(type).toBe("single")` 再 `if (type !== "single") return` 收窄，没有用 `as`。
4. **`FetchLike` 与 `typeof fetch` 不兼容**。补题输入先写成 `typeof fetch`，注入假 fetch 时 TS 报 URL/Request 参数不匹配；改用 provider 导出的 `FetchLike`。
5. **契约测试漏了新增请求**。补题契约最初没有 API 层测试；补上「层级枚举、必填、500 字上限」后才算与其它请求同口径。

## 结果

真实数字（本轮实测，2026-11-03）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **76 文件 / 914 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC15 全过（15/15）** |
| `node scripts/browser-closed-loop.mjs` | **16 步全绿 / 28 个产物**（27 张截图 + 1 份 PDF）；第 16 步走完模型与手动两条补题路径 |
| `node scripts/secret-scan.mjs` / `--history` | 均 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `c927f73` | `feat(schema): 覆盖矩阵补题接口契约 [P20]` | 请求/响应形状与上限 |
| `a38a6ec` | `feat(llm): 单题补题 prompt supplement.v1 [P20]` | 提示词、解析校验、mock/replay |
| `fdfcc8d` | `feat(server): 补题接口按知识点与草稿版本限域 [P20]` | 403/409/422 三道闸 |
| `ec75302` | `feat(web): 覆盖矩阵可点，补题走手动模板或模型候选 [P20]` | 矩阵链接、补题面板、addItem 预填 |
| `af23045` | `test(scripts): VC15 与闭环第 16 步覆盖矩阵补题 [P20]` | HTTP 与浏览器两级证据 |

**已知边界**：

- 补题一次只补一道，不批量填满矩阵。
- `mock` 模式回固定单选题，只证明链路通电；`replay` 无录像明确报错。
- 候选题的知识点/层级由请求钉死，模型给的值会被覆盖。
- 补题只进草稿，不自动保存或发布；教师仍需点「保存为新草稿」。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱，未做占位符替换。
