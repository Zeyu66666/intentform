# P22 · Web UI 重写与网页模型设置（A-24）

- 迭代：附加 `A-24` + 界面重写 · 日期：`2026-11-03` · 涉及模块：`packages/schema`、`server`、`web`、`scripts`、文档
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：契约 `3f4ebec`、服务端 `8a0a340`、登录壳与设置页 `0666f81`、就地编辑 `c4bed45`、脚本与证据 `4e2311d`、本留痕与文档随后一个 docs commit

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人提出五条界面问题并选择「改红线，网页填 Key」「生成页直接编辑」：①进入网站先登录；②发布前能直接改题，不必绕去后台；③批改面板贴在被点的题目行下面；④四种模型模式、API 端点与 Key 能在网页里改；⑤去掉老师看不懂的术语，蓝图必须可改 |
| 红线变更 | `AGENTS.md` §5 密钥条增加唯一例外 A-24：已登录教师可在网页提交 API Key，Key 只存当前进程内存、不写 `.env` / 不落库 / 不进日志，响应只回 `hasApiKey`；`ADMIN_EMAIL` 非空时只有该邮箱可写。README 与 `.env.example` 同步 |
| 验收案例 | ①匿名打开 `/dashboard` 显示登录表单且地址不改写，登录后回到 `/dashboard`；②蓝图标题/题量/分值可改且三条自洽不破，生成后的预览卡可改题干并随发布落库；③批改面板在目标提交行的 `nextElementSibling`；④网页改模式/端点/Key 后下一条请求立即生效，Key 不回显，留空保持原 Key；⑤`pnpm check`、VC1–VC17、十八步闭环全绿 |
| 停止条件 | 需要把 Key 写回 `.env` / 数据库、把网页设置做成跨重启持久化、或让生成后的修改直接改写已发布快照 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 契约 | `packages/schema/src/api.ts` | `llmSettingsRequestSchema` 收紧端点 URL、模型名与 Key 长度；`LlmSettingsResponse` 只有 `hasApiKey` / `canEdit`，没有 Key 字段 |
| 服务端运行时 | `server/src/llm-runtime.ts` | 启动配置进内存快照；`update` 先解析成功再原子替换，非法输入连「下一次重试的端点」都不污染；省略 `apiKey` = 保持，空串 = 清空 |
| 设置路由 | `server/src/llm-settings-route.ts` | 必须登录；`ADMIN_EMAIL` 非空时只允许该邮箱；请求体 8 KiB；错误文案不含 Key；只改进程内存 |
| 立即生效 | `server/src/main.ts`、`generate-route.ts`、`suggest-route.ts` | 生成与建议每次请求现取 `llmRuntime.config`；`/healthz` 回当前模式；改 Key 后重建日志脱敏列表 |
| 登录壳 | `web/src/RouteView.tsx`、`auth/LoginPage.tsx` | 教师页统一先问 `/api/auth/me`；匿名显示登录表单并保留原地址；`/f/:slug` 仍匿名可访 |
| 蓝图编辑 | `web/src/panels/BlueprintCard.tsx`、`blueprint-edit.ts` | 章节和 = 题型和 = 总题量；问卷总分恒 0；删除章节把题量并入第一章；最大余数法分配题量 |
| 发布前改题 | `web/src/App.tsx`、`PreviewPanel.tsx`、`GeneratedItemEditor.tsx` | `fieldEdits` 按字段 id 覆盖生成结果；保存/发布用覆盖后的节点；知识点下拉保留不在蓝图里的当前值 |
| 批改贴行 | `web/src/dashboard/DashboardPage.tsx` | 面板作为被点提交行的下一个 `<tr>` 渲染，不再固定挂在页面底部 |
| 术语与密度 | `BlueprintCard`、`DashboardPage`、`GeneratedItemEditor` | 「布鲁姆层级」在界面改为「认知层次」；覆盖矩阵收进 `<details>`，默认不占满屏 |
| 脚本 | `scripts/verify.mjs`、`scripts/browser-closed-loop.mjs` | VC17 验 HTTP 语义；闭环第 1 步验登录优先，第 2 步验蓝图/预览就地改，第 7 步验面板贴行，第 18 步验网页改模式与 Key 不回显 |

## AI 修改建议

采纳的：

1. **登录壳放在路由层，不做成每个页面各自的重定向**。只有一处 `auth.status` 分派，匿名访问任何教师页都会看到登录表单，登录后回到原地址；学生页在分派前直接放行。
2. **蓝图编辑用纯函数维持不变量**。所有改动经 `blueprint-edit.ts`，章节与题型两份计数始终等于总题量；问卷总分强制为 0，避免教师改出无法生成的蓝图。
3. **发布前编辑用 `fieldEdits` 覆盖，不改生成状态本身**。生成结果仍是模型输出的原始事实，发布时再合并；改坏了可以清空覆盖重来，不会污染流式历史。
4. **网页设置只改进程内存**。不写 `.env`、不落库；页面明确写「重启后回到启动配置」——避免「网页点一下悄悄改掉部署事实」。
5. **Key 留空 = 保持原 Key**。改端点时不必重输；显式清空由 API 的空串表达，网页暂不提供清空按钮，避免误触。
6. **`ADMIN_EMAIL` 默认空、生产建议填写**。单教师演示不额外制造登录门槛；多教师部署用邮箱白名单限制全局设置。

自己否决的：

- **把网页设置写进 `.env` 或数据库**：越过了「环境变量是部署事实」的边界，也把 Key 带到磁盘上。
- **让修改直接改写已发布快照**：违反发布快照追加式写入的红线；改动只能进新草稿版本。
- **在网页提供「清空 Key」按钮**：清空后 live 模式立即不可用，却没有任何提示能补救；本轮先保证「留空不误清」，清空留在 API 层。
- **给覆盖矩阵做一套新图表库**：项目禁用 ECharts，且本轮目标是降噪；收进折叠区、保留原有数字表即可。

## 我如何引导 AI 修复问题

本轮抓到的真实问题：

1. **蓝图测试导入未使用的 `withSectionTitle`**（TS6133）。没有删掉了事，而是补一条「改章节标题后其余字段不变」的用例，把导入变成真覆盖。
2. **`toEqual` 断言被零值条目打穿**。`withSectionCount` 会为所有非该题型的键写 0，测试原本按「只含目标键」断言；改成 `toMatchObject`，只断言关心的键。
3. **重构 `llm-runtime.ts` 后留下模块级 `baseUrl` / `model`**（TS6133）。端点与模型始终跟着 `current` 走，删掉重复状态，避免两份事实来源。
4. **设置路由测试里 `allowed.json` 是 `unknown`**。给 `call` 加 `<LlmSettingsResponse>` 泛型，测试直接读 `canEdit` / `hasApiKey`。
5. **「mock 模式不应保留 Key」的测试期望是错的**。`resolveLlmRuntimeConfig` 无论模式都保留 `LLM_API_KEY`，切回 live 才不用重输；改期望并修正注释。
6. **suggest 的 replay 用例回 200 而不是 400**。路由改从 `ctx.llm.config` 取配置后，测试脚手架却永远建 mock；`testing/harness.ts` 改为尊重显式 `LLM_MODE`（缺省 mock）。
7. **VC17 报「mock 启动不应有 Key」**。`spawnServer` 继承 `process.env`，本机刚好设了 `LLM_API_KEY`；在 verify 的启动环境里显式写 `LLM_API_KEY: ""`，让用例不依赖开发者机器。
8. **闭环第 18 步误以为「留空保存会清 Key」**。实际设计是留空保持原 Key；把断言改成「再保存一次留空，`hasApiKey` 仍为 true」，并在摘要里记 `blankKeepsKey`，避免把正确行为当缺陷修。

## 结果

真实数字（本轮实测，2026-11-03）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **83 文件 / 955 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC17 全过（17/17）** |
| `node scripts/browser-closed-loop.mjs` | **18 步全绿 / 30 个产物**（29 张截图 + 1 份 PDF）；新增登录优先、蓝图/预览就地编辑、模型设置；复查后同一步再验题型输入框宽度、知识点不露内部 id、左栏无异常空白、单选答案行渲染 KaTeX |
| `node scripts/secret-scan.mjs` / `--history` | 均 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `3f4ebec` | `feat(schema): 模型运行设置契约与 ADMIN_EMAIL 配置 [P22]` | 请求/响应、模式标签、白名单环境变量 |
| `8a0a340` | `feat(server): 进程内模型设置与网页切换立即生效 [P22]` | 原子更新、设置路由、healthz、生成/建议现取配置 |
| `0666f81` | `feat(web): 登录优先外壳与模型设置页 [P22]` | 登录壳、顶栏导航、`/settings`、路由与测试 |
| `c4bed45` | `feat(web): 蓝图与生成预览就地编辑、批改面板贴行 [P22]` | 蓝图不变量、预览编辑、批改面板位置、术语降噪 |
| `4e2311d` | `test(scripts): VC17 与闭环十八步覆盖登录、就地编辑和模型设置 [P22]` | HTTP 与浏览器两级证据、重跑截图 |

## 复查后的界面修正（同一轮 P22）

负责人带着三张截图回来，指出的是界面可用性缺陷，不是新功能：

| 现象 | 根因 | 修正 |
|---|---|---|
| 蓝图「题型分布」的数字被挤得看不清 | 三列网格 + `w-full` 数字框，标签与输入互相抢宽 | 改两列，数字框固定 `w-16` 且右对齐、等宽数字；章节题量同步加宽 |
| 知识点后面的框显示 `kp_op` 这类内部 id | 第二个输入框直接编辑 `point.id` | 只保留中文名称输入；id 由蓝图继续维护、题目继续引用，但不再暴露给教师；题目编辑器里的知识点下拉也只显示名称 |
| 生成完成后左栏出现整屏空白 | 左栏 `flex-1` 被拉高到与预览栏同高，`mt-auto` 又把按钮推到最底部 | 左栏按内容收口（`self-start`），去掉 `mt-auto`；发布面板紧跟内容。浏览器闭环直接断言「左栏高度 − 子元素高度 ≤ 4px」 |
| 单选答案行显示 `$2x-1=7$` 原文 | 答案行把选项文本当纯文本插进 JSX，只有选项列表走了 `MathText` | 答案行同样走 `MathText`；SSR 测试与浏览器闭环都断言出现 KaTeX、原始美元符消失 |

**已知边界**：

- 网页设置只对当前进程生效；重启回到 `.env` / 进程环境的启动配置，多实例部署不会互相同步。
- Key 仍会随设置请求从浏览器发往服务端，生产必须走 HTTPS；服务端不落盘、不回显、不进日志。
- 网页没有「清空 Key」按钮：留空保存 = 保持原 Key；需要清空时调用 API 显式传 `apiKey: ""`。
- `ADMIN_EMAIL` 为空时任意已登录教师都能改全局设置；多教师部署必须填写。
- `mock` / `replay` 下的界面证据证明链路与交互，不证明模型生成或评分质量。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱；截图与测试中的 Key（`browser-test-key-not-real`、`runtime-test-key-not-real`）均为显式标注的虚构值，不对应任何上游账号。
