# P31 · 参考试卷从「粘贴」改为「上传 Word / PDF」

- 迭代：生成入口 · 日期：`2026-11-05` · 涉及模块：`packages/schema`、`server`、`web`、`scripts`、`docs/evidence`
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：契约与解析器、前端上传、闭环与文档随后分三条提交

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人的原始诉求：「把上传参考试卷的方式改成上传 word 或者 pdf」。此前左栏是 textarea，教师得先把卷子复制成纯文本 |
| 取舍 | 解析放服务端：`POST /api/reference/extract` 接收 base64 JSON（不引 multipart 依赖），返回提取文本、字数、截断标记与警告。DOCX 用存储模式 ZIP + `word/document.xml`；PDF 用 FlateDecode 内容流 + 字体 `ToUnicode` CMap，支持 Type0/Identity-H 与简单字体。**不新增依赖**；上限 10 MiB、提取文本 20,000 字；扫描件没有文字层时明确报错，不返回空串 |
| 验收案例 | ①选 `.docx` 或 `.pdf` 后显示文件名、字数与可展开的提取文字；②Word 的段落/换行被还原；③中文文字型 PDF 的 CID 能按 ToUnicode 还原；④扫描件/旧 `.doc`/改名文件被明确拒绝；⑤超 10 MiB 在前端就被挡住，非法 base64 与缺 CSRF 被服务端拒绝；⑥上传的文本进 `/api/plan`，蓝图回执与 `styleNotes` 正常；⑦`pnpm check`、`verify.mjs`、闭环 20 步全绿 |
| 停止条件 | 为 PDF 解析引入 `pdfjs-dist` 等新依赖；把文件落盘或写进日志；用 OCR 假装支持扫描件；上传失败时静默退回空参考卷；把 10 MiB 上限做成「读进内存后再拒」 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| 契约 | `packages/schema/src/api.ts` | 新增 `API_PATHS.referenceExtract`、`REFERENCE_UPLOAD_MAX_BYTES`、请求/响应类型；文件名 ≤255、base64 ≤10 MiB 对应长度 |
| 路由 | `server/src/reference-route.ts`、`app.ts` | 匿名可用但走生成同款每分钟配额；CSRF 全局中间件照旧；扩展名与文件头双判；解码后再次卡 10 MiB；超出 20,000 字截断并回 `truncated` |
| DOCX | `server/src/reference/{zip,docx}.ts` | 手写 ZIP 中央目录读取，只支持 store/deflate，单条目 20 MiB、总量 40 MiB 上限；只读 `word/document.xml`，`<w:br/>`/`</w:p>` 转换行 |
| PDF | `server/src/reference/pdf.ts` | 对象扫描（含 `/ObjStm`）、FlateDecode、页面 `/Resources` 字体表、`ToUnicode` 的 bfchar/bfrange、`Tj/TJ/'/"` 与 `Td/TD/T*/Tm` 换行；页数 200、对象 20,000、单流 20 MiB、文本 200k 字符上限；没有可读字符时抛「没有文字层」 |
| 前端 API | `web/src/api/reference.ts` | 前端先挡 10 MiB；分块 `btoa` 避免参数栈溢出；失败仍返回 `ApiResult` |
| 界面 | `RequirementPanel.tsx`、`App.tsx` | 折叠区里放「选择文件」按钮（隐藏原生 input，去掉「未选择任何文件」噪声）；解析中 / 成功（文件名 · 字数 / 移除 / 查看提取文字）/ 失败三态；上传序号防迟到结果覆盖；`reset` 时一并清空 |
| 闭环 | `scripts/browser-closed-loop.mjs` | 新增 `Page.setFiles`（CDP `DOM.setFileInputFiles`）与最小 DOCX 构造器；第 19 步上传带唯一标记的 `.docx`，等 `reference-ready` 与 `reference-text` 出现后才生成 |

## 我如何引导 AI 修复问题

本轮抓到的真实问题：

1. **真实 PDF 的 `/Length` 是间接引用，第一版解析器读出 0 字**。扫描器把 `/Length 3 0 R` 里的 `3` 当成字节数，内容流只截到 3 字节；deliverable PDF 的 23 页全部「没有文字层」。修法是识别「数字 + 数字 + R」的间接长度，退回到 `endstream` 定位。修完同一份 PDF 提取出 23,783 字，`16-print-sheet.pdf` 提取出 405 字。这个缺陷只有拿**真实 PDF**试才会出现，合成测试数据一直是直接长度。
2. **闭环第 12 步「开关变为已开启」超时**。看板设置在读取时复选框是 `disabled`，脚本只等元素出现就点；页面变高后时序窗口被放大。修法与 P30 第 17 步一致：等 `disabled === false` 再点，产品逻辑不动。两次同类失败说明「等元素存在」经常不够，等**可交互状态**才对。
3. **上传后原生文件名被清空**。为了允许连续选同一个文件，`onChange` 里把 input 的 `value` 重置为空；副作用是原生控件立刻显示「未选择任何文件」，和下方的「reference.docx · 48 字」自相矛盾。改成隐藏 input、用 label 做「选择文件」按钮，文件名只由状态行负责，视觉上去掉重复微文案。
4. **正则字符类里的多余转义被 lint 拦下**。`[^\s<>\[\]()\/]` 在字符类里不需要转义 `[`、`]`、`/`；oxlint 的 `no-useless-escape` 直接报错。修成 `[^\s<>[\]()/]`，行为不变。

自己否决的：

- **引入 `pdfjs-dist` / `mammoth`**：违反「不新增依赖」，而且会把浏览器级解析器塞进服务端包。
- **让前端解析文件**：浏览器没有稳定的 PDF 文本层 API；DOCX 还要自己解 ZIP，等于把同一套逻辑再写一遍。
- **multipart 上传**：要手写 boundary 解析；base64 只多 1/3 体积，换来一个纯 JSON 路由。
- **扫描件走 OCR**：本轮没有 OCR 依赖，返回空串或乱码比明确报错更糟。
- **上传后把原文落盘**：参考卷只用于本次规划，落盘会多一份需要清理的敏感数据。

## 结果

真实数字（本轮实测，2026-11-05 22:35）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **91 文件 / 1041 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC18 全过（18/18）** |
| `node scripts/browser-closed-loop.mjs` | **20 步全绿 / 34 个产物，exit 0**；第 19 步上传 `.docx` 解析出 48 字，参考卷回执与 `styleNotes` 正常 |
| 真实 PDF 抽查 | 作品介绍 PDF：23,783 字；打印版 PDF：405 字；均无解析警告 |

**已知边界**：

- 只支持 `.docx`，旧 `.doc` 会提示另存为 `.docx`；不支持加密/受保护 PDF。
- 只提取文字层：扫描件、纯图片 PDF 会明确报错；不做 OCR。
- 不做版面还原：多栏/表格 PDF 的阅读顺序可能与纸面不同，但题型、分值、风格仍可提炼。
- PDF 的复杂公式可能只留下字符或符号；参考卷只用于提炼结构，不要求公式可编辑。
- 10 MiB 上限与 20,000 字上限是产品口径；超长文本截断并回 `truncated`，界面显示警告。
- 闭环截图仍只在 Windows + Chrome 156 验证。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱或 API Key；上传样例是脚本构造的演示 DOCX，真实 PDF 抽查只输出字数与首段，不把原文写进证据。原始会话未导出，无需额外替换。
