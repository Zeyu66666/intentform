# 交付文档

## 提交物

| 文件 | 用途 | 页数 |
|---|---|---|
| `作品介绍-意卷IntentForm-v1.pdf` / `.docx` | 官方提交页「6. 作品介绍文档」用这份：严格按组委会七项要求排章（详情与用法 / 亮点 / AI 测试落地 / 关键技术 / 图片 / 发表获奖 / 继承与优化）+ 附录 A 已知缺口 + 附录 B 复现清单 + 附录 C 四种模式怎么跑（评委自带 Key） | 23 |

这份文档同时承担官方 2.3「技术文档（≤30 页）」职责，所以第 3、4 章写得更细；
若提交页把「作品介绍文档」与「技术文档」分两个上传栏，同一份文件分别上传即可。

早先另有一份《参赛说明》（按「问题—方案—证据」叙事，10 页），它没有对官方七项逐条映射、
数字也停在 I5 时期，已从仓库删除，不作为提交物。文中需要引用它的地方一律改指本文件。

## 生成与校验

```bash
# 0) 只有改了截图才需要：从 docs/evidence 原图生成文档用裁剪版（只裁空白边）
python docs/deliverables/crop_figures.py

# 1) 生成 docx（python-docx；DSH 自带运行时即可）
python docs/deliverables/build_intro.py        # 作品介绍

# 2) 导出 PDF（LibreOffice Kit；输出文件已存在时先删，否则报 EEXIST）
rm -f "docs/deliverables/作品介绍-意卷IntentForm-v1.pdf"
node <libreoffice-kit>/lib/cli.js convert \
  --input "docs/deliverables/作品介绍-意卷IntentForm-v1.docx" \
  --output "docs/deliverables/作品介绍-意卷IntentForm-v1.pdf"

# 3) 目视复核（144dpi 出图，逐页看有没有空白页、图片是否被切断）
node <libreoffice-kit>/lib/cli.js render \
  --input "docs/deliverables/作品介绍-意卷IntentForm-v1.pdf" --output-dir <dir>
```

导出会提示缺少 `Courier`（样式回退候选，正文用思源黑体/Segoe UI + Consolas），不影响排版；
页数以 `render` 返回的 `pageCount` 或 `grep -ao "/Count [0-9]*"` 为准。
分页踩过的坑：表格恰好排到页底时用 `add_page_break()` 会多顶出一张只有页脚的空白页，
所以章间分页统一用 `heading(...).paragraph_format.page_break_before = True`；
表格行加 `w:cantSplit`（`table()` 里统一加），否则一行被页边界切开时下一页会剩一条半截单元格。

## 内容口径

- 所有数字（59 文件 / 685 用例、6/6、八步闭环、23 页）都来自某一次真实命令输出，
  第 2 页有「文中数字的核对方式」表，逐条给出自证命令；
- 引用的 commit 都能 `git show`；缺陷只写真实发生过的（含"AI 修错又被测试抓回"的两次反复）；
- 截图全部来自 `docs/evidence/` 里同一次真浏览器运行的落盘文件，没有摆拍、没有补图；
- 第 19 页附录 A 是已知缺口清单，第 20 页附录 B 是复现清单（命令 + 期望输出 + 证据索引），
  第 21–23 页附录 C 讲四种模式怎么跑（含评委自带 Key 的 live / record 命令与实测输出），
  评审怀疑某个功能没做时先对这几页。
