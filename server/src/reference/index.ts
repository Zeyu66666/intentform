/**
 * 参考试卷上传的文本提取入口：按扩展名与文件头双重判定，避免「改名就换类型」。
 */

import type { ReferenceFileKind } from "@intentform/schema";

import { extractDocxText, ReferenceTextError } from "./docx.ts";
import { extractPdfText } from "./pdf.ts";

export { ReferenceTextError };

export interface ExtractedReference {
  readonly kind: ReferenceFileKind;
  readonly text: string;
  readonly warnings: readonly string[];
}

function kindOf(filename: string): ReferenceFileKind | undefined {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".pdf")) return "pdf";
  return undefined;
}

function hasZipMagic(bytes: Buffer): boolean {
  return bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
}

function hasPdfMagic(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

export function extractReference(filename: string, bytes: Buffer): ExtractedReference {
  const kind = kindOf(filename);
  if (kind === undefined) {
    throw new ReferenceTextError("只支持 .docx 与 .pdf；旧 .doc 请先另存为 .docx");
  }
  if (kind === "docx" && !hasZipMagic(bytes)) {
    throw new ReferenceTextError("文件扩展名是 .docx，但内容不是有效的 Word 文档");
  }
  if (kind === "pdf" && !hasPdfMagic(bytes)) {
    throw new ReferenceTextError("文件扩展名是 .pdf，但内容不是有效的 PDF");
  }
  if (kind === "docx") {
    return { kind, text: extractDocxText(bytes), warnings: [] };
  }
  const result = extractPdfText(bytes);
  return { kind, text: result.text, warnings: result.warnings };
}
