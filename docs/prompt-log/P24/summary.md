# P24 · 生成深度：难度递进、参考卷与联网开关

- 迭代：生成质量 · 日期：`2026-11-04` · 涉及模块：`packages/schema`、`packages/llm`、`server`、`web`、`scripts`、`fixtures`、文档
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：契约 `d383423`、难度编辑 `297f3fe`、蓝图界面 `931b777`、提示词与隔离 `d73b723`、回放键 `89a0d9a`、搜索与设置 `3980fdd`、生成页 `ce7c2b1`、POST 字面量 `f054427`、mock 参考回执 `48db106`、重录 `f57966b`、闭环 `b2d9fee`，本留痕与设计/计划随后一个 docs commit

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人生成高三数学试卷后反馈：题目「没有深度，一眼就有思路」，整卷难度没有层层递进。希望生成前参考网上同类型试卷的结构与风格，也允许教师直接提供一份参考试卷，并以教师参考卷为准 |
| 取舍 | 采用 **1 + 2 + 3**：①蓝图新增四档难度 `difficultyMix`（基础→提升→综合→压轴）与 `styleNotes`；②教师粘贴参考卷，**只提取题型比例、知识点覆盖、难度梯度与命题风格，绝不复用原题**；③Web 端联网参考开关，**只有 live 模式且端点/Key 配齐才外呼**，`mock/replay/record` 强制零外呼。第一版参考卷只收粘贴文本，不做 Word/PDF 解析 |
| 验收案例 | ①蓝图卡显示四档难度，改任一档后题型和/章节和/总题量同步，三者和始终相等；②带参考卷的 `plan` 响应含 `styleNotes`，响应不含参考原文；`generate` 提示词拿不到参考/搜索原文；③`webSearch=true` 但运行在 mock/replay/record 时搜索 fetch **零调用**、回执 `off`；④搜索超时、坏 JSON、缺 URL 时降级为不搜索且不阻断规划；⑤设置接口只回 `hasSearchKey`，Key 不进日志/响应；⑥`plan.v2`/`generate.v4` 六条录像重录为真实上游，`pnpm check`、VC1–VC17、六条 fixture 自检、十九步闭环全绿 |
| 停止条件 | 需要解析 Word/PDF、引入搜索供应商 SDK、把学生答案送进生成、离线模式偷偷外呼、或拿旧录像冒充新提示词 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 契约 | `packages/schema/src/blueprint.ts`、`api.ts` | `difficultyMix?` 严格四键、缺省按 0、存在时四档和必须等于 `totalCount`；`styleNotes` ≤500 字；`PlanRequest.reference` ≤20000 字、`webSearch?`；旧蓝图缺两字段仍合法 |
| 复用 | `packages/schema/src/constants.ts` | `DIFFICULTY_LEVELS` / `DIFFICULTY_LABELS`（基础/提升/综合/压轴）单一来源，schema、编辑器、界面共用 |
| 编辑 | `web/src/panels/blueprint-edit.ts` | `withDifficultyCount` 与章节/题型共用最大余数分配；改任一维度后三者重新配平；旧蓝图不凭空补 `difficultyMix` |
| 提示词 | `packages/llm/src/plan.ts`、`prompt.ts` | `plan.v2` 要求难度递进、参考卷/搜索各自定界、反照抄红线、`styleNotes`；`generate.v4` 只接收确认后的蓝图，硬约束四档并禁止浅题/要求解析推理链 |
| 隔离 | `plan.ts` / `prompt.ts` | 参考卷与搜索摘要只进 `buildPlanMessages`；`buildUserPrompt(requirement, blueprint)` 结构上不接收原文，生成阶段无法复制 |
| 回放键 | `packages/llm/src/replay-key.ts` | `normalize(需求) + "\0" + [refHash + "\0"] + model + "\0" + promptVersion + "\0" + "v" + schemaVersion`；`refHash`=规范化参考卷 SHA-256 前 16 位；无参考卷整段省略，旧键逐字节不变 |
| 搜索 | `server/src/search.ts` | 薄契约 `POST {query, limit:8}` → `{results:[{title,snippet,url}]}`；8s 超时；坏条目丢弃；失败只 warn。四道闸：`live ∧ webSearch ∧ 端点非空 ∧ Key 非空` |
| 设置 | `server/src/llm-runtime.ts`、`llm-settings-route.ts` | 搜索端点/Key 与 A-24 同生命周期：只存进程内存，响应只回 `searchBaseUrl` / `hasSearchKey`，日志走统一脱敏 |
| 界面 | `web/src/panels/RequirementPanel.tsx`、`App.tsx`、`SettingsPage.tsx` | 「参考试卷（可选）」折叠粘贴框；联网开关在非 live 禁用并写明原因；时间线显示参考/搜索回执；设置页新增搜索端点与 Key |
| 录像 | `packages/llm/src/testing/record-fixtures.ts` | 双升版是硬前提：3 条需求 ×（plan+generate）=6 条全部用真实上游重录，`meta.upstream` 如实写 `openai-compatible:api.deepseek.com`，旧 v1/v3 录像删除而非改标签 |
| 闭环 | `scripts/browser-closed-loop.mjs` | 第 2 步断言四档难度在场且和=题型和；第 19 步粘贴参考卷，断言参考回执、搜索 `off`、难度+1 后同步、`styleNotes` 非空且不含原文 |

## 我如何引导 AI 修复问题

本轮抓到的真实问题：

1. **oxlint 把 `fetch` 判成 GET**。`searchWeb` 用 `method: init.method`，类型是 `"POST"`，但 `unicorn/no-invalid-fetch-options` 只看字面量，报「body is not allowed when method is GET」。改成字面量 `method: "POST"`，语义不变，静态检查也能看懂。
2. **搜索查询词的换行折叠规则写反了**。测试原本断言两个空行会折叠成一个，但 `normalizeRequirement` 的契约是「3 个及以上连续空行才折叠」；把用例改成两空行保留、四空行折叠，避免按错误预期改实现。
3. **密钥扫描命中测试假 Key**。`search.test.ts` 里直接写 `apiKey: "搜索测试假 Key"`，扫描器把它当真实 Key。提取 `SEARCH_TEST_CREDENTIAL` 常量并保留 `not-real` 语义，测试不靠关扫描通过。
4. **`App.tsx` 回执块少了一个 `:`**。`plan.usedReference ? (...) )}` 被 `tsc` 报 TS1005；逐行读编译错误定位到条件表达式的冒号缺失，而不是猜「可能是 JSX 类型问题」。
5. **回执读的是「当前输入框」而不是「当次规划用的参考卷」**。生成后教师再改左栏，回执会跟着变，等于谎报。给 `PlanState.ready` 加 `usedReference`，回执只用当次结果。
6. **闭环新步骤读不到运行模式**。第 19 步 `goto('/')` 后立刻读 `web-search-hint`，`/healthz` 的 effect 还没回来，提示是「未读到服务端运行模式」而不是「离线演示模式」，开关断言因此失败。改成先 `waitFor` 提示出现「离线演示模式」再断言，测的是异步链路的真实完成态，不是碰巧的时序。
7. **批量替换把编辑函数与测试一起改坏**。第一次改 `blueprint-edit.ts` 的替换串匹配了 71 处，注释与同类函数被误伤。按基线恢复后改为逐处精确替换，每步跑单文件测试确认只动了目标位置；没有用 `git checkout .` 把已完成的真实修改一起丢掉。
8. **mock 的参考回执必须诚实**。闭环跑在 mock，没有模型可提炼参考卷；最初想把真实 `styleNotes` 写死在 mock 里，等于伪造模型结论。最终 `mockBlueprint` 只写「已收到参考卷（N 字），离线模式不解析原文」，让链路可验、又不冒充提炼质量。

自己否决的：

- **只加「请出难题」一句提示词**：没有结构化难度分区，模型仍会把整卷堆在基础档；四档 `difficultyMix` 才能被蓝图编辑和生成提示同时约束。
- **参考卷原文直接进生成提示**：模型最省力的做法就是改几个数字；结构上把原文挡在 plan 阶段之外，比在提示里写十遍「不要抄」更可靠。
- **给某家搜索 API 写专用适配器**：比赛作品不该把供应商形状写进核心链路；只认最小 POST 契约，教师侧用一行代理接任何供应商。
- **搜索失败就阻断规划**：搜索是锦上添花，失败降级为 `failed` 并继续规划，回执如实说明。
- **旧录像改 `meta` 冒充新提示词**：`fixtures.test.ts` 断言 `meta.promptVersion === DEFAULT_PROMPT_VERSION`，升版就必须重录；本轮用系统环境里的真实 Key 重录 6 条。

## 结果

真实数字（本轮实测，2026-11-04）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **86 文件 / 1003 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC17 全过（17/17）** |
| `node --experimental-strip-types packages/llm/src/check-fixtures.ts` | **全部通过（6 条 fixture）** |
| `node scripts/browser-closed-loop.mjs` | **19 步全绿 / 31 个产物**（30 张截图 + 1 份 PDF）；第 2 步难度断言、第 19 步参考卷与难度编辑 |
| `node scripts/secret-scan.mjs` / `--history` | 均 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `d383423` | `feat(schema): 生成难度与参考卷契约 [P24]` | `difficultyMix`/`styleNotes`、参考卷与 `webSearch` 请求字段 |
| `297f3fe` | `feat(web): 蓝图难度分布编辑 [P24]` | `withDifficultyCount` 与三维配平 |
| `931b777` | `feat(web): 蓝图难度分布界面 [P24]` | 四档中文输入，和题型同一套样式 |
| `d73b723` | `feat(llm): 生成难度递进与参考卷隔离 [P24]` | `plan.v2`/`generate.v4`、定界块、反照抄、mock 难度 |
| `89a0d9a` | `feat(llm): 回放键加入参考卷指纹 [P24]` | `refHash` 段；无参考卷旧键不变 |
| `3980fdd` | `feat(server): live 联网参考搜索与内存设置 [P24]` | 薄搜索适配器、四道闸、设置与脱敏 |
| `ce7c2b1` | `feat(web): 参考试卷与联网参考开关 [P24]` | 粘贴框、离线禁用、参考/搜索回执 |
| `f054427` | `fix(server): 搜索外呼固定 POST 字面量 [P24]` | 修 oxlint 误判，语义不变 |
| `48db106` | `fix(llm): mock 蓝图回执参考卷但不解析原文 [P24]` | mock 只写「收到 N 字」 |
| `f57966b` | `test(fixtures): 重录 plan.v2/generate.v4 六条录像 [P24]` | 真实上游、如实标注，旧录像删除 |
| `b2d9fee` | `test(scripts): 闭环覆盖参考卷与难度分布 [P24]` | 第 2 步难度、第 19 步参考卷与 `styleNotes` |

**已知边界**：

- 联网搜索只在 `live` 且教师配置了搜索端点与 Key 时外呼；仓库不自带搜索供应商，演示与闭环下回执恒为 `off`。
- 参考卷第一版只支持粘贴文本，不解析 Word/PDF；超过 20000 字直接 400。
- 四档难度是**提示词硬约束**，模型不保证 100% 兑现；蓝图对照与人工编辑是兜底，不把结构偏差升级成发布失败。
- `styleNotes` 目前不进生成界面的可见区域；它随蓝图进入生成提示，闭环通过 API 响应断言存在。
- mock 的 `styleNotes` 只是「收到参考卷」的回执，不代表模型提炼质量；真实提炼效果由 `plan.v2` 录像与 `pnpm eval` 观察。
- 重录使用真实上游 `api.deepseek.com`，`meta.upstream` 如实记录；没有 Key 的机器跑 `replay` 仍不需要联网。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱或 API Key；截图中的「立体几何」「教师改过的蓝图标题」「教师参考-OMEGA」均为演示文本。原始会话未导出，无需额外替换。
