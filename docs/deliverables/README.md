# 交付文档（PDF）

| 文件 | 说明 |
|---|---|
| `参赛说明-意卷IntentForm.pdf` | 提交用 PDF，10 页，A4 |
| `参赛说明-意卷IntentForm.docx` | 同一份内容的 Word 源，改字用这个改 |
| `build_pdf.py` | 生成 docx 的脚本（python-docx），改完重跑 |

## 重新生成

```bash
# 1) 生成 docx（需要 python-docx；DSH 自带运行时即可）
python docs/deliverables/build_pdf.py

# 2) 导出 PDF（LibreOffice Kit）
node <libreoffice-kit>/lib/cli.js convert \
  --input "docs/deliverables/参赛说明-意卷IntentForm.docx" \
  --output "docs/deliverables/参赛说明-意卷IntentForm.pdf"
```

注意：LibreOffice 导出会提示缺少 `Courier` 字体（正文实际用 Microsoft YaHei + Segoe UI，
`Courier` 只是样式回退候选），不影响排版；页数以导出后 `grep -ao "/Count [0-9]*"` 为准。

## 内容口径

- 所有数字（566 用例、52 文件、4/4、6 步、10 页）都来自某一次真实命令输出；
- 引用的 commit 都能 `git show`；不写"未来会做"当"已经做了"；
- 第 10 页是已知缺口清单，评审怀疑某个功能没做时先对这里。
