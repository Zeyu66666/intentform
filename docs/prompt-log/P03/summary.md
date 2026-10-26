# P03 · 生成式 UI（三栏页 / FieldRegistry / 时间线）

- 迭代：`I3` · 日期：`2026-10-26` · 涉及模块：`web`（`stream` / `render` / `panels` / `styles`）
- 会话导出：`raw-20261026-i3-web.md`（已脱敏；DSH 会话无 `/export`，该文件为提问原文 + 交付动作整理，已在文件头注明）
- 上游依赖（全部为《计划》§3.1 选型表内、`pnpm --filter @intentform/web add --save-exact` 精确锁版本）：`react@18.3.1`、`react-dom@18.3.1`、`katex@0.16.11`、`vite@5.4.11`、`@vitejs/plugin-react@4.3.4`、`tailwindcss@3.4.17`、`postcss@8.4.49`、`autoprefixer@10.4.20`、`@types/react@18.3.12`、`@types/react-dom@18.3.1`、`@types/katex@0.16.8`

## 提问

与 I2 同一形态：我把 I3 拆成共享任务派给队友 `web-streaming`（`context: fresh`）。brief 的八项里有四条决定了这轮的质量下限：

- **写作用域只有 `web/**`**；`packages/schema/**` 只读，需要新类型来找我。
- **不许任何 git 命令**，不许 spawn 子队友，不许新增依赖。
- **`fill` 态绝不渲染答案/解析/分值/bloom/知识点**——这是产品承诺，不是样式问题。
- 交付必须贴**验收命令的实际输出**（typecheck / vitest / oxlint / build 的真实尾部），以及浏览器实测的具体数字。

三栏骨架、设计 Token（6 色 / 5 级字号 / 8pt 间距 / 2 档圆角）与 token 变量名我先落盘成契约（`web/src/styles/tokens.css` + `tailwind.config.js` 只做映射不写值），队友不许改 token 名。

收尾时我按《审查报告》追加三条修正指令：①关掉 Windows 原子写触发的 chokidar 崩溃；②seq 缺口要有超时兜底；③把 `fill-plan.ts` 里"publicView 只剥 answer"的注释改准。

## AI 修改建议

1. **`FieldRegistry` 拆成 `edit` / `fill` 两张注册表，而不是一个组件加 `mode` 分支**。AI 的理由：两态的输入完全不同（edit 要渲染正确答案以便教师校对，fill 连读都不能读），分支写在一个组件里，"哪个字段在哪种态下读了什么"必须靠读完整函数才知道。我采纳——物理隔离比约定可靠，`FillRenderPlan` 用**判别联合**在类型层就装不下 `answer`/`score`/`bloom`/`knowledgePoint`。
2. **AI 建议引入 Radix 做无障碍原语、ECharts 画统计**。否决：I3 的收口标准是"三栏页能收事件逐字段渲染 + 时间线显示耗时 + 取消能中断"，用不到弹出层与图表。`AGENTS.md` §1.2「能不装就不装」，延到真正需要时再加（这也让首屏少了两个大包）。
3. **中栏用 `grid-cols-[var(--layout-left)_minmax(0,1fr)_var(--layout-right)]`**，AI 主动解释为什么中间必须是 `minmax(0,1fr)` 而不是 `1fr`：`1fr` 的最小值是 `auto`，一条长公式就能把中间栏撑出横向滚动条。我采纳，并要求它把这条写进注释——这是"看起来一样的写法差一个词就坏"的典型。
4. **AI 提议把主 chunk 拆开**（当时 505 kB，超过 Vite 500 kB 提示线）。我否决：KaTeX 已经走 `import()` 懒加载，再拆只会让公式先闪一帧纯文本，现场演示时容易被误判成"坏页"。把 505 kB 留在那里、把理由写进文档，比为了一个黄色提示条牺牲观感好。
5. **AI 自己提出 `seq` 缺口要有兜底**（缺一帧界面永久卡在 streaming），并建议在 reducer 里直接 `setTimeout`。问题我采纳，实现我否掉：reducer 必须保持纯函数，时间通过 `{type:"tick", now}` 注入，阈值 3000ms，且无缺口时必须返回**同一引用**，否则每 500ms 触发一次无意义重渲染。
6. **AI 主动交代"watcher 修复无法给出改前必崩的对照"**：摘掉 `server.watch.ignored` 后跑 20 轮也没能确定性复现 `EBUSY`（chokidar 3 有约 100ms 的原子合并窗口，会把 tmpdir 事件吞掉）。我保留这个诚实的说法，没有让它编一个"改前崩溃"的截图——这正是《审查报告》明令禁止的那类倒填。

## 我如何引导 AI 修复 Bug

本轮 5 个真实问题：

1. **`publicView()` 还在把 `bloom` / `knowledgePoint` / `meta.objectives` 发给学生端。**
   队友在交付说明里按规矩"只报不改"地列了这条：schema 侧 `projectScored()` 保留 `score`/`bloom`/`knowledgePoint`，`projectMeta()` 保留 `objectives`，与《计划》§3.5 冲突；`contract.test.ts:155-160` 当时甚至断言"保留分值、层级、知识点"。
   我的处理：**这是真 bug，契约层由我改**。`StripAnswer<T>` 扩成 `StripTeacherMeta<T> = DistributiveOmit<T, "answer"|"explanation"|"bloom"|"knowledgePoint">`，`PublicFormMeta` 删 `objectives`，`projectScored()` 只回 `{ score }`；`score` **保留**（分值不构成答案提示，且学生需要知道自己这题几分）。测试改成"保留分值、剥掉层级与知识点"，并加一条"meta 不带 objectives"。提交 `04c0e6f`。
   注意 web 侧的 `toFillRenderPlan` 白名单一行没删——现在它是**第二道闸门**，注释也从"publicView 只剥 answer，所以这里必需"改准为"schema 已剥，这里是纵深防御"。两处不一致的注释比没有注释更危险。

2. **`seq` 缺一帧 → 界面永久卡在 streaming。**
   现象：后端丢帧（或代理吞帧）后，前端把后续事件全塞进 pending 排队，`status` 永远是 `streaming`，取消按钮之外没有任何出路。
   修法：`generate-machine.ts` 加 `gapSinceMs` 与 `tick` action，`GAP_TICK_MS = 500`、`GAP_SKIP_AFTER_MS = 3000`；超时后 `skipGap()` 把 `lastSeq` 推到缺失区间末尾并补应用 pending，同时记一条 `gap-skipped` 协议异常；hook 侧只在 `status === "streaming"` 时排 interval 且清理函数必清。
   局限（如实记）：`gap-skipped` 只有单测覆盖，回放 fixture 的 seq 是连续的，浏览器里看不到这条异常。

3. **Windows 原子写把 dev server 打死（白屏 `exit 1`）。**
   现象：编辑器保存 `.PreviewPanel.tsx` 时出现 `EBUSY: resource busy or locked`，chokidar 把错误抛到进程，dev server 直接退出。
   修法：`vite.config.ts` 加 `server.watch.ignored: ["**/.*.tmpdir/**", "**/*.tmp", "**/*.swp", "**/*~"]`。验证是三层间接证据：`resolveConfig` 打印 `server.watch`、仓库外脚本 3 轮原子写 `tmpdir/tmp events: 0`、dev server 20 轮 @60ms 均 200 且 `grep -c -i ebusy = 0`。**没有"改前必崩"的对照**，摘掉 fix 后跑 20 轮也没稳定复现，这一点在交付说明与本节都写明了。

4. **中栏横向滚动条。** 1280×800 下 `scrollWidth > innerWidth`，根因是 `1fr` 的自动最小值。改 `minmax(0,1fr)` 后实测 `[320, 596, 300]`、`scrollWidth=1280=innerWidth`。

5. **审查驱动的两处回退。** ①时间线里原来有 `<details>推理原文（N 段，M 字）</details>`，按 §2.4 删掉原文、只留"推理摘要 N 段"——理由同上：模型自述不可核验，展开它等于暗示"它真的这样想"。②界面上 replay 与 live 显示完全一样（模式只存在于服务端 `LLM_MODE`），违反 §2.6「live/replay/mock 始终可辨」。修法是服务端在 SSE 响应上加 `x-intentform-llm-mode` 头（不动冻结的事件载荷），前端 `source.ts` 通过 `onUpstreamMode` 回调交给界面，头缺失就显示"未知（等待响应头回执）"——不猜。

## 结果

- 产物：三栏生成页（左需求输入 + 预置按钮 + 取消、中实时预览 + edit/fill 切换、右时间线含阶段/耗时/字段到达/协议异常/修复轮次）、`FieldRegistry` 双态注册表、`useGenerateStream`（reducer + 纯函数状态机 + seq 乱序缓存/迟到归位/过期丢弃/缺号跳过）、SSE 帧解析与 UTF-8 解码、KaTeX 渲染（`trust: false`，失败降级 `<code>`）、设计 Token 契约。
- 验证：`web typecheck` 0 错；`npx vitest run web` **13 文件 / 127 条**（其中 `stream` 与 `render` 占 114 条）；全仓 `npx vitest run` **316 条通过 / 28 文件**；`oxlint --deny-warnings web` **0 警告 0 错误**（30 文件）；`pnpm --filter @intentform/web build` 成功。
- 浏览器实测（CDP，1280×800）：三栏列宽 `[320, 596, 300]`、`scrollWidth = innerWidth = 1280`、无横向溢出；学生态 `leaks {answer/explanation/score/bloom/knowledgePoint}` 全 `false`、`answerInHtml false`、`katex 8` 节点、控件 `radio 9 / checkbox 4 / text 1 / number 1 / textarea 1`；取消后 header 显示「已取消：上游请求已中断，不当作错误」且保留已生成卡片。

| commit | message | 说明 |
|---|---|---|
| `3c2bd85` | `build(web): vite 5 + react 18 + tailwind toolchain and token contract` | 工具链 + `tokens.css` 变量名冻结 + Tailwind 只映射 |
| `f6378c0` | `chore(lint): scope react jsx rules to web and fix stale contract comment` | 只对 `web/**` 关 `react-in-jsx-scope` |
| `04c0e6f` | `fix(schema): strip bloom, knowledgePoint and objectives from publicView [P03]` | 学生端投影收口 + 契约测试改断言 |
| `9d53fff` | `feat(web): SSE client state machine, seq gap recovery and thinking timeline [P03]` | `stream/*` + 假帧 + `panels/TimelinePanel` |
| `4dda3e0` | `feat(web): FieldRegistry renderer with edit and fill states [P03]` | `render/*`（`fill-plan` 白名单、KaTeX） |
| `f131dfc` | `feat(web): three-column generate page wired to the generate stream [P03]` | `App.tsx` 三栏装配 + 模式显示 + `vite.config` watcher |

### 相对《计划 v3.0》的偏离（3 处）

| # | 偏离 | 理由 |
|:--:|---|---|
| 1 | 新增 `tick` action 与 `gap-skipped` 异常种类（计划只写"seq 递增"） | 计划默认"帧不会丢"。真丢了界面会永久卡住，而卡住的表现是"看起来还在生成"，比报错更糟。 |
| 2 | 界面数据源标签依赖服务端 `x-intentform-llm-mode` 响应头 | §2.6 第 4 条要求；走 HTTP 头不改冻结的事件载荷。服务端 + 前端各一条测试。 |
| 3 | 删掉"推理原文"折叠面板 | 审查 §2.4；保留段数作为可观测事实。 |

### 已知缺口（带进 I4 / I5）

1. **`.tsx` 没有自动化测试**：`vitest.config.ts` 只收 `.ts`，渲染正确性靠 CDP 手测（三次：1280×800 编辑态、学生态、取消态）。要补 `@testing-library/react` 属于新增依赖，本轮不做。
2. **学生态只读**：按 I4 范围，当前不收集作答、不提交。
3. **`gap-skipped` 无浏览器内复现路径**：需要 I2 故意丢一帧才能演示。
4. **主 chunk 约 505 kB**：刻意不拆（见"AI 修改建议"第 4 条）。
5. **未与真实上游联调**：本机无 Key，浏览器侧只跑过假帧与 `replay` 服务端。
6. **`tick` 每 500ms 在流式期间空转 dispatch**：无缺口时返回同一引用不重渲染，但函数调用仍在；量级可忽略，留待 I5 真机压测时再看。

### 脱敏记录

`raw-20261026-i3-web.md` 中无需替换的个人信息：无真实姓名、手机号、学校名、邮箱、账号或 API Key。文中的 `127.0.0.1:5173`、`D:\project1\.scratch\*.png` 为本地端口与仓库外截图路径，可公开。
