# P19 · 通用 JSON Patch + 重做栈（A-21）

- 迭代：附加 `A-21` · 日期：`2026-11-02` · 涉及模块：`packages/schema`、`server`、`web`、`scripts`、文档
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：契约与翻译 `be8e111`、服务端 `8ea33ac`、前端 `9418975`、脚本 `a051686`、本留痕与文档随后一个 docs commit

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 按负责人 2026-11-02 的决定，把《计划-v3.1》§2.2 原「不做」的「通用 JSON Patch、重做栈」拉进范围。**实现方式限定为**：语法收 RFC 6902，落库前翻译回十一个受限 op；撤销后可按 LIFO 重做 |
| 允许修改范围 | `packages/schema/src/{json-patch,api,patch}.ts`、`server/src/{forms-route,app}.ts` 与 `db/{schema,forms}.ts`、`web/src/{api/teacher.ts,edit/EditorPage.tsx}`、`scripts/{verify,browser-closed-loop}.mjs`、文档与证据 |
| 验收案例 | ①RFC 6902 六种操作可用；②路径只能落在题目字段，meta/题目数量/id/题型不可改；③越界 400 且不写库；④撤销后可重做回同一版本；⑤撤销后新版本产生时旧重做分支作废；⑥所有旧能力不回退 |
| 停止条件 | 需要放开任意 JSON 路径、直接覆盖整份 Schema、或让重做产生新版本 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 契约 | `packages/schema/src/json-patch.ts` | 手写 RFC 6902 子集与 JSON Pointer，不引库。`applyJsonPatch` 在深拷贝上执行，失败不返回半套文档 |
| 翻译 | 同上 | 路径白名单 `^/items/<下标>/<字段>` + 选项/答案子路径；应用后过 `formSchema`，再逐字段翻译成 `setStem`/`setOptions`/`setAnswer`/…；最后 `applyPatch` 重放对账，结果不一致整包拒绝 |
| 结构锁 | 同上 | meta、items 数量、每题的 id/type 都比对；结构变化统一 `json_patch_structure_locked`。`test` 只读，允许任意路径 |
| 请求 | `packages/schema/src/api.ts` | `patchFormRequestSchema` 改成 union：`ops` 与 `jsonPatch` 二选一，`.strict()` 拒绝两个都带；`patchFormPayloadOf` 做形状归一 |
| 服务端 | `server/src/forms-route.ts` | 翻译失败在 `applyPatch` 之前返回 400，不产生版本；成功路径与受限 op 完全共用 |
| 重做栈 | `server/src/db/schema.ts`、`db/forms.ts` | 新表 `form_redo_stack(form_id, seq, version_id)`；只存 id，不复制 Schema。`pushRedo` / `popRedo` / `clearRedo` / `redoDepth` |
| 撤销/重做 | `server/src/forms-route.ts` | 撤销先压栈再拨指针；重做弹栈并校验 `parent_id === 当前草稿`，对不上就清栈返回 `redone:false`；任何新版本 `clearRedo` |
| 前端 | `web/src/edit/EditorPage.tsx` | 页头加「重做」，由详情/撤销/重做返回的 `redoAvailable` 控制；保存或采用建议后置灰 |

## AI 修改建议

采纳的：

1. **翻译而不是直接写 JSON**。直接写会让 `changes`、单题作用域、撤销粒度全部失效；翻译回 11 个 op 后，旧的安全边界与测试继续有效。
2. **`totalScore` 不参与对账**。它是派生字段，JSON Patch 改分值后旧总分必然对不上；以 `applyPatch` 重算的结果为准，否则每一条改分值的合法补丁都会被误拒。
3. **重做栈存版本 id，不存 Schema**。`form_versions` 本身不可变，重做只是拨指针；存整份 Schema 会制造第二份事实源。
4. **重做校验 parentId**。撤销两次后从中间分支改过，栈顶可能不是当前草稿的子版本；校验后清栈，历史不会分叉。
5. **`test` 允许任意只读路径**。它不写库，限制它只会让标准 RFC 用例无法使用；写入路径仍严格白名单。

自己否决的：

- **把通用 Patch 做成整份 Schema 覆盖**：等于绕过行级校验和发布门禁，也违反负责人选的「Patch 仍校验」。
- **重做时重新提交一次 Patch**：会新增版本，撤销/重做不再对称；而版本行本来就不可变，拨指针即可。
- **在客户端维护重做栈**：刷新后丢失，且与服务端版本指针可能不一致。

## 我如何引导 AI 修复问题

本轮抓到的真实问题：

1. **翻译对账把总分差异当成不支持**。第一条改成「题干 + 分值」的用例失败：`applyPatch` 重算总分 22，而 JSON Patch 副本里还是 20。修法是在最终比对时把 `meta.totalScore` 归零后比较，并写明总分是派生字段。
2. **`translateJsonPatch` 复用了 `applyJsonPatch` 的错误类型**。`fail` 返回的是带 `value` 的结果类型，和翻译结果的 `{ok:true, ops}` 不兼容；拆出 `translationFail` 后才通过类型检查。
3. **联合类型在解析后拿不到 `explanation`**。`before.type !== "section"` 仍包含量表；加 `hasExplanation` 类型谓词收窄到五种题型。
4. **VC14 的 changes 断言漏了总分那一行**。第一次跑失败，响应里多了一条 `where:"总分"`；改为只筛 `itemId === "v-single"` 的两条，再断言顺序。
5. **commit-msg 钩子拒了 `[A-21]`**。标签必须是 `[Pxx]` 或 `[AI-TEST]`；改用 `[P19]` 后提交成功。这属于提交纪律，不是功能缺陷。

## 结果

真实数字（本轮实测，2026-11-02）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **73 文件 / 893 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC14 全过（14/14）** |
| `node scripts/browser-closed-loop.mjs` | **15 步全绿 / 25 个产物**；第 8 步撤销后真点重做，提示「已重做，当前草稿 v2」 |
| `node scripts/secret-scan.mjs` / `--history` | 均 0 命中 |

| commit | message | 说明 |
|---|---|---|
| `be8e111` | `feat(schema): 通用 JSON Patch 语法与受限翻译 [P19]` | RFC 6902、翻译对账、请求 union、redo 契约 |
| `8ea33ac` | `feat(server): PATCH 接受通用 Patch 并补撤销重做栈 [P19]` | 翻译分支、`form_redo_stack`、`/redo` |
| `9418975` | `feat(web): 编辑器补重做按钮与服务端栈状态 [P19]` | `redoAvailable`、API 客户端 |
| `a051686` | `test(scripts): VC14 与闭环第 8 步覆盖通用 Patch 和重做 [P19]` | HTTP 与浏览器两级证据 |

**已知边界**：

- 路径是白名单，不是「任意 JSON 都能改」；meta、题目数量、id、题型均不可改。
- 重做栈按表单隔离，没有多人协同语义；并发仍以 `baseVersionId` 409 为准。
- 重做不产生新版本，只拨指针；撤销后再改出的新版本会复用版本号序列中的下一个 n。
- 通用 Patch 只提供 HTTP 能力，编辑器界面仍用受限 op（界面没有原始 JSON 编辑框）。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱，未做占位符替换。
