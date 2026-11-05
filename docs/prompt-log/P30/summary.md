# P30 · 打印卷面：换行、去横线与可排版的 Word

- 迭代：打印与导出 · 日期：`2026-11-05` · 涉及模块：`web`、`packages/llm`、`scripts`、`docs/evidence`
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：打印页与文档模型、Word 生成、mock 多行题干与闭环断言随后分三条提交

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人的原始诉求：「打印试卷这里换行没有正常生效还是没有去掉；题目下面不需要给出横线；且允许给出 word 版本能让使用者自行排版」 |
| 取舍 | 换行从「只靠 CSS `white-space: pre-line`」改成**结构**：`MathText` 在文本段内把 `\n` 渲染成 `<br />`，打印、页面与 Word 导出共用同一条换行。打印卷面删除填空/简答下方的作答横线，题目之间只留间距。新增「下载 Word」：浏览器端零依赖生成真 `.docx`（存储模式 ZIP + WordprocessingML），`$...$` 公式经 KaTeX 的 MathML 转成 Word 原生 OMML。**不新增依赖、不引后端、不改 API** |
| 验收案例 | ①多行题干在打印卷面、页面与 Word 里都真的换行；②打印卷面内不再有作答横线（`span.border-b` 为 0）；③点「下载 Word」落出 ZIP 魔数正确、能被 Word 打开的文件；④Word 里公式是公式对象（本轮实测识别出 3 个），不是原始 `$...$`；⑤默认不含答案，勾选后含答案；⑥`pnpm check`、`verify.mjs`（VC1–VC18）、闭环 20 步全绿 |
| 停止条件 | 为换行引入 Markdown/HTML 渲染依赖；为 Word 引入 `docx`/`html-docx` 等新包；把 `.docx` 做成改扩展名的 HTML；导出时把答案带出去；为去横线删掉题号/选项/答案等既有结构 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 换行 | `web/src/render/Latex.tsx` | 文本段按 `\r\n|\r|\n` 切开，段间插入 `<br />`；外层仍保留 `whitespace-pre-line` 折叠连续空格。SSR 测试直接断言 `<br/>（1）`，不再只断言类名 |
| 卷面 | `web/src/print/PrintPage.tsx`、`sheet.ts` | 删除 `blanks` 字段与作答横线；标题、分节、描述也走 `MathText`；工具栏新增「下载 Word」（`data-testid="print-docx"`） |
| Word 容器 | `web/src/print/docx.ts` | 手写存储模式 ZIP：本地头、中央目录、EOCD、CRC32；固定时间戳让输出可复现；五份部件：`[Content_Types].xml`、`_rels/.rels`、`word/document.xml`、`word/styles.xml`、`word/_rels/document.xml.rels` |
| Word 公式 | `web/src/print/docx.ts` | KaTeX `output:"mathml"` → 极简 XML 解析 → OMML：`m:f` 分式、`m:rad` 根式、`m:sSup`/`m:sSub` 上下标、`m:acc` 重音；不认识的节点摊平，KaTeX 失败退回原始 TeX |
| Word 排版 | `word/styles.xml` + `document.xml` | A4、14mm 页边距、正文 10.5pt、标题 18pt 居中；题号悬挂缩进；`<w:br/>` 保留换行；答案/解析灰色小字 |
| mock 素材 | `packages/llm/src/sources.ts` | 简答题干改成三行（建议 + 理由），让闭环每次都能看到换行路径，而不是只在教师真实表单里偶发 |

## 我如何引导 AI 修复问题

本轮抓到的真实问题：

1. **换行过去只靠 CSS，证据脚本无法证明**。`MathText` 原来只有 `whitespace-pre-line`；浏览器静态页测试里它确实生效，但打印、SSR 与导出三条路径各自赌一次 CSS。改成文本段内插 `<br />` 后，换行成为 DOM 结构，测试能直接断言 `<br/>（1）`，Word 侧则对应 `<w:br/>`。这不是「CSS 不工作」，而是**把隐式依赖改成显式结构**。
2. **AI 辅助评分步骤偶发超时**。第一次跑闭环在第 17 步失败：开关存在但点不亮。根因是看板设置还在读取（`aiEnabled === null` 时 `disabled`），脚本只等元素出现就去点；多行题干让页面更高，时序窗口被放大。修法是等 `disabled === false` 再点，产品代码不动。这类「测试等错了状态」比「功能坏了」更常见，失败信息也正好指到那一步。
3. **多产物插入导致截图编号整体后移**。Word 文件作为第 11 步的新产物，后续 `nextArtifactName` 从 24 开始，旧的 23–33 全部变成孤儿。处理方式是删掉旧文件、只保留同一次运行的新编号（24–34），否则证据目录会出现两套同步骤截图。
4. **Word 文件的真实性不能只看扩展名**。验证分三层：ZIP 魔数 + 大小（闭环）、`python -m zipfile` 能列出五份部件、Word COM 能打开并报告 `OMaths.Count = 3`。只做第一层会漏掉「容器对、Word 打不开」的坏文件。

自己否决的：

- **引入 `docx` npm 包**：能省事，但违反「不新增依赖」；而且它会把 XLSX 级的体积带进纯前端打印页。
- **下载 HTML 改扩展名 `.doc`**：Word 会报「格式与扩展名不匹配」，且 KaTeX 的 CSS 在 Word 里不生效，公式会散架。
- **服务端生成 Word**：题面本来就在浏览器里，多一条渲染路径就多一份会和打印页漂移的真相。
- **把公式截成图片塞进 Word**：视觉保真，但教师无法编辑，正好违背「自行排版」；OMML 是 Word 原生公式，能改。
- **保留空白横线但改成交互层隐藏**：纸上根本不需要，留着只会让「有没有横线」变成两套口径。

## 结果

真实数字（本轮实测，2026-11-05 22:20）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **88 文件 / 1028 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC18 全过（18/18）** |
| `node scripts/browser-closed-loop.mjs` | **20 步全绿 / 34 个产物，exit 0**；第 11 步 `printBreaks=2`、`answerRules=0`、`docxBytes=9713` |
| Word COM 打开 `16-print-sheet.docx` | 成功打开，识别 **3 个公式对象**、20 个段落 |
| `python -m zipfile -l` | 五份 OOXML 部件齐全 |

**已知边界**：

- OMML 转换覆盖 KaTeX 常见结构（分式、根式、上下标、重音、括号）；`munderover` 等复杂结构会摊平成顺序文本，极端公式可能丢失上下限位置。
- Word 版式只给基础样式（A4、字体、段距、悬挂缩进），不尝试复刻打印页的每个间距；教师仍可自行调整，这正是「可排版」的目标。
- Word 里不嵌图片、页眉页脚与页码；问卷仍不提供答案。
- 打印页打印的仍是当前草稿版，要打发布版需先发布（沿用 A-17 口径）。
- 闭环截图仍只在 Windows + Chrome 156 验证。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱或 API Key；截图中的学生链接为 `127.0.0.1` 本地地址，题目均为演示文本。原始会话未导出，无需额外替换。
