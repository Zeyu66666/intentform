/**
 * `.docx` → 纯文本。
 *
 * 只读 `word/document.xml`：正文段落、换行、制表符足够让规划阶段提炼题型比例与
 * 命题风格；页眉页脚、批注、图片不在参考卷的语义里。旧 `.doc`（OLE 复合文档）
 * 不是 ZIP，无法用同一条路径读取，调用方会给出明确提示而不是吐乱码。
 */

import { readZipEntry } from "./zip.ts";

export class ReferenceTextError extends Error {}

const TEXT_TOKEN =
  /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>|<w:cr\b[^>]*\/>|<w:tab\b[^>]*\/>|<\/w:p>/gu;

function decodeXmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/giu, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : match;
  });
}

/** 空白规整：保留段落，去掉行尾空格，连续空行最多留一行。 */
export function normalizeExtractedText(text: string): string {
  // 控制字符用码点过滤而不是正则字符类：`\u0000-\u001f` 会让 lint 报
  // `no-control-regex`，而这里的目标只是「保留换行与制表符，其余不可见控制符丢掉」。
  const cleaned = [...text]
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code === 9 || code === 10 || code >= 32;
    })
    .join("");
  return cleaned
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function extractDocxText(bytes: Buffer): string {
  if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) {
    throw new ReferenceTextError("文件不是有效的 .docx（缺少 ZIP 文件头）");
  }
  const entry = readZipEntry(bytes, "word/document.xml");
  if (entry === undefined) {
    throw new ReferenceTextError("这份 Word 文件里找不到正文（word/document.xml）");
  }

  const xml = entry.bytes.toString("utf8");
  let text = "";
  let match = TEXT_TOKEN.exec(xml);
  while (match !== null) {
    if (match[1] !== undefined) {
      text += decodeXmlEntities(match[1]);
    } else {
      // `<w:br/>`、`<w:cr/>`、段落结束都按换行；制表符原样保留。
      text += match[0].startsWith("<w:tab") ? "\t" : "\n";
    }
    match = TEXT_TOKEN.exec(xml);
  }

  const normalized = normalizeExtractedText(text);
  if (normalized.length === 0) {
    throw new ReferenceTextError("这份 Word 文件没有可提取的文字");
  }
  return normalized;
}
