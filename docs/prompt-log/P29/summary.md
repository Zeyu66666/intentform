# P29 · 教师看板：让结构说话，补齐公式与删除

- 迭代：界面流程 · 日期：`2026-11-05` · 涉及模块：`web`、`server`、`packages/schema`、`scripts`、`docs/evidence`
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：删除后端 `38ecfd7`，看板前端 `31cbc01`，截图与证据 `dd4657d`，本文档随后

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人的原始诉求：「避免不需要的次要标签，说明文字，辅助文案，描述性文字和荣誉的微文案，让布局，视觉层级，间距和清晰的主操作自己完成解释；每题正确率上数学公式没有正确加载；增加一个删除表单的操作」。随后补充：去文案的原则**只针对前端设计**，不是后端提示与契约 |
| 取舍 | 看板去掉页头副标题、卡片徽标、卡内注释与成段说明，只留标题、数字、表头与操作；题干/答案统一走既有 `MathText`（KaTeX），不再出现裸 `$`。删除做成表单卡上的次级危险操作：先就地二次确认，取消不动数据，确认后调 `DELETE /api/forms/:id`。**删除是逻辑删除**：`form_versions` 有追加式触发器，版本行是历史提交的判分依据，物理删会毁证据，因此新增 `form_deletions` 墓碑，并在列表、详情、学生短链、提交统计与发布的 SQL 里统一排除 |
| 验收案例 | ①看板首屏不再出现解释性副标题/徽标/注释，仍能一眼找到切换表单、编辑、打印、删除；②逐题正确率与提交记录里的 `$...$`、`√` 等渲染为 KaTeX，闭环断言 `.katex` 存在且单元格无裸 `$`；③删除先出确认，取消后表单仍在；确认后下拉与页面不再出现该表单，学生短链与详情 404；④其他教师删除仍是 403，重复删除 404；⑤`pnpm check`、`verify.mjs`（VC1–VC18）、闭环 20 步全绿 |
| 停止条件 | 为「简洁」删掉闭环依赖的字面量（`提交数`、`（已开启）`、`—`、第四格纯百分比）或 `data-testid`；把删除做成物理删而绕过版本触发器；删除确认用浏览器 `confirm()` 导致无法截图与断言；给公式渲染另起一套 Markdown 解析而不再复用 `MathText` |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 看板文案 | `web/src/dashboard/DashboardPage.tsx` | 页头只留「教师看板」与刷新/生成；表单卡左侧状态、标题、短链，右侧切换器与操作；KPI 卡只剩标签与数字；各表卡去掉徽标与说明；空态只留标题与可选主操作 |
| 设置 | `SettingsRow` | 标题「展示与批改」，两个开关只留名称与 `（读取中…）/（已开启）/（默认关闭）`；状态字面量原样保留，闭环第 12 步仍等它 |
| 公式 | `DashboardPage.tsx` / `GradeForm.tsx` | 每题正确率、提交记录、批改面板的题干与答案改用 `<MathText text={...} />`；沿用 `Latex.tsx` 的 KaTeX 白名单与失败降级，不新增依赖 |
| 删除入口 | `DeleteFormAction` | 初始「删除表单」；确认态「确认删除 / 取消」，失败就地显示错误；成功后回调父级过滤列表并回到无选中态 |
| 删除接口 | `server/src/forms-route.ts`、`server/src/db/forms.ts` | `DELETE /api/forms/:id`；`requireOwnedForm` 保持 403/404 口径；`softDeleteForm` 用 `INSERT ... SELECT ... ON CONFLICT DO NOTHING` 保证幂等；所有读取与发布共用 `NOT_DELETED` 片段 |
| 持久层 | `server/src/db/schema.ts` | `form_deletions(form_id PK, teacher_id, deleted_at)`，外键级联到 `forms` 与 `teachers`；不改 `form_versions` 的追加式约束 |
| 契约与客户端 | `packages/schema/src/api.ts`、`web/src/api/teacher.ts`、`web/src/api/http.ts` | 新增 `deleteForm` 路径与 `DeleteFormResponse`；HTTP 方法联合加 `DELETE`，仍由 CSRF 头保护写操作 |

## 我如何引导 AI 修复问题

本轮抓到的真实问题：

1. **`DELETE` 没有进 HTTP 方法联合**。接上 `teacherApi.deleteForm` 后 typecheck 报 `Type '"DELETE"' is not assignable to type '"GET" | "POST" | "PATCH"'`。根因是 `HttpRequestOptions.method` 还是上一轮的三值联合；补上 `DELETE` 并更新注释后通过。这也说明删除不是「多写一个 fetch」，而是要先把唯一 HTTP 出口的方法面扩开。
2. **加表后结构测试立刻变红**。`db.test.ts` 断言的是 `sqlite_master` 的完整表清单；新增 `form_deletions` 后旧期望值对不上。没有放宽成 `toContain`——清单本身就是要防止「偷偷多出一张表」，改成显式列出新表并更新测试名。
3. **桌面端表单卡换行难看**。第一次闭环截图里，切换器与三个操作被挤到下一行、左对齐，标题右侧留下一大块空白。改成 `sm:` 以上左右两栏：左侧 `min-w-0 flex-1` 承载状态/标题/短链，右侧 `sm:shrink-0` 纵向放切换器与右对齐的操作行；手机宽度仍纵向堆叠。改完重跑闭环并目检 `07-dashboard.png` 与 `32-delete-confirm.png`。

自己否决的：

- **物理删除表单行**：`forms` 上的 `ON DELETE CASCADE` 到不了 `form_versions`，因为后者的 `BEFORE DELETE` 触发器会 `ABORT`；绕开触发器等于废掉「历史提交按旧快照判分」的证据链。墓碑是唯一不撒谎的删法。
- **删除时把 slug 清空或改写成占位**：会改写 `forms` 的发布指针语义，且旧链接的 404 应当由「已删除」统一决定，而不是靠 slug 是否为空。
- **用 `window.confirm()` 做二次确认**：原生弹窗不可截图、不可脚本断言，也破坏页面内的视觉层级。
- **给公式再写一个 Markdown/LaTeX 混合解析器**：`MathText` 已经覆盖 KaTeX 白名单与降级，重复实现只会多一份会漂移的真相。
- **保留「我的表单 N」与「切换表单」可见标签**：下拉框本身已经说明用途，数字在列表里也能数出来；但 `<label className="sr-only">` 保留给读屏。

## 结果

真实数字（本轮实测，2026-11-05 15:18）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **87 文件 / 1021 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC18 全过（18/18）**，新增 VC18 覆盖删除后列表/详情/学生短链/提交统计同时下线与重复删除 404 |
| `node scripts/browser-closed-loop.mjs` | **20 步全绿 / 33 个产物，exit 0**；第 6 步断言 `.katex` 存在且无裸 `$`，第 20 步删除确认取消后保留、确认后看板移除且学生短链 404 |

| commit | message | 说明 |
|---|---|---|
| `38ecfd7` | `feat(server): 表单支持逻辑删除并同步下线各入口 [P29]` | 墓碑表、仓库过滤、`DELETE` 路由、三组路由测试与 VC18 |
| `31cbc01` | `feat(web): 看板去掉冗余微文案、渲染公式并加入删除入口 [P29]` | 看板与批改面板文案收敛、`MathText` 接入、删除确认交互、HTTP 客户端 `DELETE` 与单测 |
| `dd4657d` | `test(evidence): 重跑看板改版与删除表单的浏览器闭环 [P29]` | 闭环脚本两步新断言，全部截图同一次生产构建重跑 |

**已知边界**：

- 删除是逻辑删除：数据仍在库里，只是所有教师/学生入口都看不到；本轮没有「回收站/恢复」界面，也没有后台清理任务。
- 墓碑不记录操作者 IP 或原因，只记 `teacher_id + deleted_at`；审计需求不在本轮范围。
- 看板「待批改」仍是前端从已加载行派生，不是服务端 summary 字段。
- 公式渲染只覆盖看板与批改面板的题干/答案；其他页面若仍有裸 `$`，需要各自接入 `MathText`。
- 闭环截图仍只在 Windows + Chrome 156 验证；换环境需重跑闭环。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱或 API Key；截图中的学生链接为 `127.0.0.1` 本地地址，题目均为演示文本。原始会话未导出，无需额外替换。
