# P34 · 题目配图：几何与实验题能看图作答

- 迭代：题型能力 · 日期：`2026-11-08` · 涉及模块：`packages/schema`、`server`、`web`、`scripts`、`docs/evidence`
- 会话导出：本轮未导出原始会话；本文件按实际修改与命令结果整理
- 提交边界：契约/持久层/接口、编辑器与渲染、闭环与文档随后分三条提交

## 开工前写清的四件事（纪律 4.0 第 1 条）

| 项 | 内容 |
|---|---|
| 目标 | 负责人的原始诉求：「有些题目是需要图片的，例如三角形、圆的数学题，化学、物理中的实验题，都是要有图才能写的」 |
| 取舍 | 当前模型没有文生图能力，硬做「AI 画图」只会产不可用示意图；本轮把**配图能力**做成教师上传：任意题可挂一张 PNG/JPEG/WebP（5 MiB），学生页、教师预览、打印卷与 Word 导出都显示。版本快照只存 `image.assetId`，图片本体进 `form_assets`；已发布表单的图公开，草稿图只给 owner。上传走 base64 JSON，不引 multipart；只按文件头收 PNG/JPEG/WebP，不收 SVG |
| 验收案例 | ①编辑器能上传/更换/移除配图，预览立即可见；②保存后 diff 出现「配图」一条，撤销/重做跟随版本；③发布后学生页与打印页都加载图片；④Word 导出带 `word/media` 部件；⑤草稿图匿名 404、owner 200；⑥非法文件头 422、缺 CSRF 403、删除表单后图 404；⑦`pnpm check`、`verify.mjs`、闭环 21 步全绿 |
| 停止条件 | 为配图引入对象存储/图片处理依赖；把 base64 塞进 `schema_json` 让每个版本重复存图；把 SVG 直接当 `<img>`（脚本/外链风险）；只有编辑器能看到图、学生页/打印页看不到；Word 里静默丢图且没有任何说明 |

## 实现要点

| 层 | 落点 | 关键决定 |
|---|---|---|
| Schema | `packages/schema/src/types.ts` | 新增 `itemImageSchema`（`assetId` 形如 `a_` + 16 位十六进制、可选 `alt`）；`image` 为可选 + nullable，旧版本与模型输出没有这个键也能通过 |
| 公开视图 | `public-view.ts` | 配图不是答案，投影时保留；`undefined` 统一折成 `null`，渲染层只判一个值 |
| Patch | `patch.ts` | 新增 `setImage`（`null` 移除）；所有题型都支持，diff 记「配图 /（无配图）」；assetId 形状在线缆层校验 |
| 持久层 | `server/src/db/schema.ts`、`db/assets.ts` | `form_assets(id, form_id, teacher_id, mime, byte_length, bytes, created_at)`；读取时连表单状态与归属一起取，已删除表单的图按不存在处理 |
| 上传/读取 | `server/src/asset-route.ts`、`app.ts` | 上传要登录且 owner；PNG/JPEG/WebP 文件头嗅探；5 MiB 上限；已发布表单的图公开可缓存，草稿图只给 owner，未登录/非 owner 统一 404 |
| 编辑器 | `ItemEditor.tsx`、`ItemImageEditor.tsx`、`patch-plan.ts` | 新增「配图」分组：上传立即拿 assetId，题目草稿只引用 id；保存时才产生 `setImage`，未保存离开只留下未被引用的资产 |
| 渲染 | `QuestionImage.tsx`、`FieldRegistry.tsx`、`StudentField.tsx`、`fill-plan.ts`、`PrintPage.tsx` | 单一 `<img>` 入口，限制 `max-h-72` + `max-w-full`；学生 plan 保留 image；打印卷的行模型也带 image |
| Word | `print/docx.ts`、`PrintPage.tsx` | 导出前从资产接口取 PNG/JPEG，读文件头拿像素尺寸，写 `word/media`、关系与 `<w:drawing>`；12 cm 上限等比缩放；WebP 在 Word 里跳过（屏幕仍显示） |
| 闭环 | `scripts/browser-closed-loop.mjs` | 第 21 步用脚本生成 160×100 PNG → CDP 塞文件输入 → 保存 → 发布 → 学生页/打印页 `naturalWidth>0` → 下载 Word 断言含 `word/media/image0.png` |

## 我如何引导 AI 修复问题

1. **把 `image` 做成 required 立刻打穿旧 fixture**。`z.object(...).nullable().default(null)` 的输出类型要求所有测试表单都补 `image`，一次 typecheck 报出多份 fixture。改成可选 + nullable 后，`draftOf`/打印行/公开视图统一 `?? null`，旧版本与模型输出都不用迁移。
2. **Word 的关系 id 与 styles 撞车**。图片关系最初从 `rId1` 开始，正好和 `styles.xml` 的 `rId1` 冲突；单元测试断言 `r:embed` 时抓到实际是 `rId1`。改成 `rId(index+2)` 后，Word 才能把 drawing 解析到图片。
3. **一条配图要在三处渲染**。只加编辑器和学生页会漏打印/Word；把 `QuestionImage` 收成唯一入口，再让 `PrintRow` 与 `fill-plan` 都带 image，避免四个页面各写一份 `<img>` 后某处忘加 `alt`/尺寸。
4. **闭环上传不能只点按钮**。`<input type="file">` 在真实使用中选的是本地文件，脚本用 CDP `DOM.setFileInputFiles` 塞一个真实 PNG，等 `naturalWidth>0` 才继续——否则「上传成功」只是 React 状态变了，图可能根本没加载。

自己否决的：

- **用文生图模型自动配图**：没有可用图像模型，示意图质量不可控，还会把不可信的生成图带进考试。
- **把图片 base64 存进 `schema_json`**：版本快照会重复存大图，学生页与看板响应都会膨胀。
- **引入对象存储**：本地部署的作品多一个外部依赖，SQLite BLOB 已够。
- **允许 SVG**：能画精确几何，但 `<img src>` 加载 SVG 仍有脚本/外链面，本轮只收位图。
- **只做学生页显示、不做 Word**：教师打印 Word 时图丢了，等于功能只完成一半。

## 结果

真实数字（本轮实测，2026-11-08 17:51）：

| 命令 | 结果 |
|---|---|
| `pnpm check` | **92 文件 / 1054 用例全绿**；oxlint 0 告警、0 错误；4 包 typecheck 通过 |
| `node scripts/verify.mjs` | **VC1–VC18 全过（18/18）** |
| `node scripts/browser-closed-loop.mjs` | **21 步全绿 / 35 个产物，exit 0**；第 21 步上传 PNG，`studentImageWidth=160`、`printImageWidth=160`、`wordHasMedia=true` |

**已知边界**：

- 没有 AI 生图：配图必须由教师上传；模型不会自己产出三角形/实验装置图。
- 只收 PNG/JPEG/WebP；SVG、GIF、扫描版 PDF 单页都不收。
- Word 只嵌入 PNG/JPEG；WebP 在 Word 里跳过，打印页/学生页仍正常显示。
- 没有裁剪、缩放、旋转或图文混排编辑器；图片按容器等比缩放。
- 教师上传后未保存就离开会留下一个未被引用的资产；本轮没有清理任务（不影响使用）。
- 配图不参与判分；图片里的文字不会被 OCR 或识别。

## 脱敏说明

本轮留痕不含真实姓名、手机号、学校名、邮箱或 API Key；闭环上传的图片是脚本生成的几何占位图。原始会话未导出，无需额外替换。
