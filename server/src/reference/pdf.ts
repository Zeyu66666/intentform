/**
 * `.pdf` → 纯文本（零依赖，面向「文字型 PDF」）。
 *
 * 只做参考卷需要的事：从页面内容流里取出显示文本。范围与边界：
 * - 支持 FlateDecode 内容流、`Tj`/`TJ`/`'`/`"`、`Td`/`TD`/`T*`/`Tm` 的换行判断；
 * - 支持 Type0（Identity-H，两字节码）与简单字体，优先走字体的 `ToUnicode` CMap；
 * - 支持对象流（`/ObjStm`）里的字体与 CMap；
 * - **不做 OCR**：扫描件没有文字层时会明确报错，而不是返回空串假装成功；
 * - 不做版面还原：多栏 PDF 的阅读顺序可能与纸面不一致，但题型/分值/风格仍可提炼。
 *
 * 这份实现刻意不引 `pdfjs-dist` 之类的依赖：参考卷只要求「把字读出来」，而 PDF
 * 是不可信输入，解析器越窄，越容易把上限（流大小、页数）说清楚。
 */

import { inflateSync } from "node:zlib";

import { normalizeExtractedText, ReferenceTextError } from "./docx.ts";

const MAX_STREAM_BYTES = 20 * 1024 * 1024;
const MAX_PAGES = 200;
const MAX_OBJECTS = 20_000;
const MAX_TEXT_CHARS = 200_000;

interface PdfObject {
  readonly id: number;
  readonly dict: string;
  readonly stream?: Buffer;
}

interface PdfFont {
  readonly codeBytes: 1 | 2;
  readonly cmap: ReadonlyMap<number, string>;
}

interface ContentValue {
  readonly kind: "bytes" | "hex" | "name" | "number" | "array";
  readonly bytes?: Buffer;
  readonly name?: string;
  readonly number?: number;
  readonly items?: readonly ContentValue[];
}

export interface PdfTextResult {
  readonly text: string;
  readonly warnings: readonly string[];
}

// ── 对象扫描 ───────────────────────────────────────────────────────────────

function scanObjects(bytes: Buffer): readonly PdfObject[] {
  const text = bytes.toString("latin1");
  const objects: PdfObject[] = [];
  const objectPattern = /(\d+)\s+(\d+)\s+obj\b/g;
  let match = objectPattern.exec(text);
  while (match !== null && objects.length < MAX_OBJECTS) {
    const id = Number(match[1]);
    const bodyStart = objectPattern.lastIndex;
    const streamIndex = text.indexOf("stream", bodyStart);
    const endObjectIndex = text.indexOf("endobj", bodyStart);
    const hasStream = streamIndex !== -1 && (endObjectIndex === -1 || streamIndex < endObjectIndex);

    if (hasStream) {
      const dict = text.slice(bodyStart, streamIndex).trim();
      let dataStart = streamIndex + "stream".length;
      if (text.startsWith("\r\n", dataStart)) dataStart += 2;
      else if (text[dataStart] === "\n" || text[dataStart] === "\r") dataStart += 1;
      const lengthMatch = /\/Length\s+(\d+)\b/u.exec(dict);
      // `/Length 3 0 R` 是间接长度：数字是对象号而不是字节数，此时退回到
      // `endstream` 定位。压缩流里出现完整 "endstream" 字样的概率可以忽略。
      const indirectLength =
        lengthMatch !== null &&
        new RegExp(`/Length\\s+${lengthMatch[1]}\\s+\\d+\\s+R`, "u").test(dict);
      let dataEnd =
        lengthMatch === null || indirectLength
          ? text.indexOf("endstream", dataStart)
          : Math.min(text.length, dataStart + Number(lengthMatch[1]));
      if (dataEnd <= dataStart) dataEnd = text.indexOf("endstream", dataStart);
      if (dataEnd <= dataStart) dataEnd = dataStart;
      objects.push({
        id,
        dict,
        stream: bytes.subarray(dataStart, dataEnd),
      });
      const after = text.indexOf("endobj", dataEnd);
      objectPattern.lastIndex = after === -1 ? text.length : after + "endobj".length;
    } else {
      const end = endObjectIndex === -1 ? text.length : endObjectIndex;
      objects.push({ id, dict: text.slice(bodyStart, end).trim() });
      objectPattern.lastIndex = end + "endobj".length;
    }
    match = objectPattern.exec(text);
  }
  return objects;
}

function expandObjectStreams(
  objects: readonly PdfObject[],
  warnings: Set<string>,
): readonly PdfObject[] {
  const byId = new Map<number, PdfObject>();
  for (const object of objects) byId.set(object.id, object);

  for (const object of objects) {
    if (!/\/Type\s*\/ObjStm\b/u.test(object.dict) || object.stream === undefined) continue;
    const data = decodeStream(object, warnings);
    if (data === undefined) continue;
    const count = Number(/\/N\s+(\d+)\b/u.exec(object.dict)?.[1] ?? "0");
    const first = Number(/\/First\s+(\d+)\b/u.exec(object.dict)?.[1] ?? "-1");
    if (!Number.isInteger(count) || count <= 0 || first < 0 || first > data.length) continue;
    const header = data
      .subarray(0, first)
      .toString("latin1")
      .trim()
      .split(/\s+/u)
      .map((part) => Number(part));
    for (let index = 0; index < count; index += 1) {
      const id = header[index * 2];
      const relative = header[index * 2 + 1];
      if (id === undefined || relative === undefined || !Number.isInteger(id) || !Number.isInteger(relative)) {
        continue;
      }
      const start = first + relative;
      const next = header[(index + 1) * 2 + 1];
      const end = next === undefined ? data.length : Math.min(data.length, first + next);
      if (start < 0 || start >= data.length || byId.has(id)) continue;
      byId.set(id, { id, dict: data.subarray(start, end).toString("latin1").trim() });
    }
  }
  return [...byId.values()];
}

function decodeStream(object: PdfObject, warnings: Set<string>): Buffer | undefined {
  if (object.stream === undefined) return undefined;
  const filter = /\/Filter\s*(\[[^\]]*\]|\/[A-Za-z0-9]+)/u.exec(object.dict)?.[1] ?? "";
  if (filter === "" || filter === "/FlateDecode" || /\[\s*\/FlateDecode\s*\]/u.test(filter)) {
    if (filter === "") return object.stream;
    try {
      return inflateSync(object.stream, { maxOutputLength: MAX_STREAM_BYTES });
    } catch {
      warnings.add("PDF 内容流解压失败，已跳过一段");
      return undefined;
    }
  }
  warnings.add("PDF 使用了暂不支持的压缩方式，已跳过一段");
  return undefined;
}

// ── 字典取值 ───────────────────────────────────────────────────────────────

function skipSpace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function captureValue(text: string, start: number): string {
  const first = text[start];
  if (first === "<" && text[start + 1] === "<") {
    let depth = 0;
    for (let index = start; index < text.length - 1; index += 1) {
      if (text.startsWith("<<", index)) {
        depth += 1;
        index += 1;
      } else if (text.startsWith(">>", index)) {
        depth -= 1;
        index += 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return text.slice(start);
  }
  if (first === "[") {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === "[") depth += 1;
      else if (text[index] === "]") {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return text.slice(start);
  }
  if (first === "(") {
    let depth = 0;
    for (let index = start; index < text.length; index += 1) {
      if (text[index] === "\\") index += 1;
      else if (text[index] === "(") depth += 1;
      else if (text[index] === ")") {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return text.slice(start);
  }
  const match = /^(\d+\s+\d+\s+R|[^\s<>[\]()/]+|\/[^\s<>[\]()/]+)/u.exec(text.slice(start));
  return match?.[1] ?? "";
}

function valueAfter(dict: string, key: string): string | undefined {
  const pattern = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![A-Za-z0-9])`, "u");
  const match = pattern.exec(dict);
  if (match === null) return undefined;
  const start = skipSpace(dict, match.index + match[0].length);
  const value = captureValue(dict, start);
  return value === "" ? undefined : value;
}

function refId(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d+)\s+\d+\s+R\b/u.exec(value.trim());
  return match === null ? undefined : Number(match[1]);
}

function objectById(objects: ReadonlyMap<number, PdfObject>, id: number | undefined): PdfObject | undefined {
  return id === undefined ? undefined : objects.get(id);
}

// ── 字体与 CMap ────────────────────────────────────────────────────────────

function hexBytes(hex: string): Buffer {
  const cleaned = hex.replace(/[^0-9a-f]/giu, "");
  return Buffer.from(cleaned.length % 2 === 0 ? cleaned : `${cleaned}0`, "hex");
}

function utf16be(buffer: Buffer): string {
  let text = "";
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    text += String.fromCharCode(buffer.readUInt16BE(index));
  }
  return text;
}

function incrementLast(text: string, delta: number): string {
  if (text === "") return text;
  return text.slice(0, -1) + String.fromCharCode(text.charCodeAt(text.length - 1) + delta);
}

function parseCMap(data: Buffer): ReadonlyMap<number, string> {
  const text = data.toString("latin1");
  const cmap = new Map<number, string>();

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/gu)) {
    const body = block[1] ?? "";
    for (const pair of body.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/gu)) {
      cmap.set(Number.parseInt(pair[1] ?? "0", 16), utf16be(hexBytes(pair[2] ?? "")));
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/gu)) {
    const body = block[1] ?? "";
    const rangePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/gu;
    let match = rangePattern.exec(body);
    while (match !== null) {
      const low = Number.parseInt(match[1] ?? "0", 16);
      const high = Number.parseInt(match[2] ?? "0", 16);
      if (high >= low && high - low <= 65_535) {
        if (match[4] !== undefined) {
          const base = utf16be(hexBytes(match[4]));
          for (let code = low; code <= high; code += 1) {
            cmap.set(code, incrementLast(base, code - low));
          }
        } else {
          const items = [...(match[5] ?? "").matchAll(/<([0-9A-Fa-f]+)>/gu)].map((item) => item[1] ?? "");
          for (let offset = 0; offset <= high - low && offset < items.length; offset += 1) {
            cmap.set(low + offset, utf16be(hexBytes(items[offset] ?? "")));
          }
        }
      }
      match = rangePattern.exec(body);
    }
  }
  return cmap;
}

function fontFrom(
  object: PdfObject | undefined,
  objects: ReadonlyMap<number, PdfObject>,
  warnings: Set<string>,
): PdfFont | undefined {
  if (object === undefined) return undefined;
  const type0 = /\/Subtype\s*\/Type0\b/u.test(object.dict);
  const codeBytes: 1 | 2 = type0 ? 2 : 1;
  const toUnicodeRef = refId(valueAfter(object.dict, "/ToUnicode"));
  const cmapObject = objectById(objects, toUnicodeRef);
  let cmap: ReadonlyMap<number, string> = new Map();
  if (cmapObject !== undefined) {
    const data = decodeStream(cmapObject, warnings);
    if (data !== undefined) cmap = parseCMap(data);
  }
  if (type0 && cmap.size === 0) {
    warnings.add("PDF 中有字体缺少 Unicode 映射，个别字符会显示为 �");
  }
  return { codeBytes, cmap };
}

function fontsOfPage(
  page: PdfObject,
  objects: ReadonlyMap<number, PdfObject>,
  warnings: Set<string>,
): ReadonlyMap<string, PdfFont> {
  const resourcesRaw = valueAfter(page.dict, "/Resources");
  const resources =
    resourcesRaw?.startsWith("<<") === true
      ? resourcesRaw
      : objectById(objects, refId(resourcesRaw))?.dict;
  if (resources === undefined) return new Map();

  const fontRaw = valueAfter(resources, "/Font");
  const fontDict =
    fontRaw?.startsWith("<<") === true
      ? fontRaw
      : objectById(objects, refId(fontRaw))?.dict;
  if (fontDict === undefined) return new Map();

  const fonts = new Map<string, PdfFont>();
  for (const match of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/gu)) {
    const name = match[1] ?? "";
    const font = fontFrom(objectById(objects, Number(match[2] ?? "0")), objects, warnings);
    if (name !== "" && font !== undefined) fonts.set(name, font);
  }
  return fonts;
}

// ── 内容流 ─────────────────────────────────────────────────────────────────

function decodeLiteral(text: string, start: number): { readonly bytes: Buffer; readonly next: number } {
  const out: number[] = [];
  let index = start + 1;
  let depth = 1;
  while (index < text.length && depth > 0) {
    const char = text[index] ?? "";
    if (char === "\\") {
      const next = text[index + 1] ?? "";
      const simple: Record<string, number> = {
        n: 10,
        r: 13,
        t: 9,
        b: 8,
        f: 12,
        "(": 40,
        ")": 41,
        "\\": 92,
      };
      if (simple[next] !== undefined) {
        out.push(simple[next]);
        index += 2;
        continue;
      }
      if (next >= "0" && next <= "7") {
        let octal = "";
        let cursor = index + 1;
        while (cursor < text.length && octal.length < 3 && text[cursor] !== undefined && /[0-7]/u.test(text[cursor] ?? "")) {
          octal += text[cursor];
          cursor += 1;
        }
        out.push(Number.parseInt(octal, 8) & 0xff);
        index = cursor;
        continue;
      }
      if (next === "\n" || next === "\r") {
        index += next === "\r" && text[index + 2] === "\n" ? 3 : 2;
        continue;
      }
      out.push(next.charCodeAt(0) & 0xff);
      index += 2;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) return { bytes: Buffer.from(out), next: index + 1 };
    }
    out.push(char.charCodeAt(0) & 0xff);
    index += 1;
  }
  return { bytes: Buffer.from(out), next: index };
}

function readHexString(text: string, start: number): { readonly bytes: Buffer; readonly next: number } {
  const end = text.indexOf(">", start + 1);
  if (end === -1) return { bytes: Buffer.alloc(0), next: text.length };
  return { bytes: hexBytes(text.slice(start + 1, end)), next: end + 1 };
}

function isDelimiter(char: string): boolean {
  return /\s/u.test(char) || "()<>[]{}/%".includes(char);
}

function readContentArray(text: string, start: number): { readonly value: ContentValue; readonly next: number } {
  const items: ContentValue[] = [];
  let index = start + 1;
  while (index < text.length) {
    index = skipSpace(text, index);
    const char = text[index] ?? "";
    if (char === "]") return { value: { kind: "array", items }, next: index + 1 };
    if (char === "") break;
    const parsed = readContentValue(text, index);
    if (parsed === undefined) break;
    items.push(parsed.value);
    index = parsed.next;
  }
  return { value: { kind: "array", items }, next: index };
}

function readContentValue(text: string, start: number): { readonly value: ContentValue; readonly next: number } | undefined {
  const char = text[start] ?? "";
  if (char === "(") {
    const literal = decodeLiteral(text, start);
    return { value: { kind: "bytes", bytes: literal.bytes }, next: literal.next };
  }
  if (char === "<" && text[start + 1] !== "<") {
    const hex = readHexString(text, start);
    return { value: { kind: "hex", bytes: hex.bytes }, next: hex.next };
  }
  if (char === "<" && text[start + 1] === "<") {
    const value = captureValue(text, start);
    return { value: { kind: "name", name: value }, next: start + value.length };
  }
  if (char === "[") return readContentArray(text, start);
  if (char === "/") {
    let end = start + 1;
    while (end < text.length && !isDelimiter(text[end] ?? "")) end += 1;
    return { value: { kind: "name", name: text.slice(start + 1, end) }, next: end };
  }
  const numberMatch = /^[+-]?(?:\d+\.?\d*|\.\d+)/u.exec(text.slice(start));
  if (numberMatch !== null) {
    return { value: { kind: "number", number: Number(numberMatch[0]) }, next: start + numberMatch[0].length };
  }
  return undefined;
}

function decodeText(font: PdfFont | undefined, bytes: Buffer): string {
  if (font === undefined) return bytes.toString("latin1");
  let text = "";
  if (font.codeBytes === 2) {
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      const code = bytes.readUInt16BE(index);
      text += font.cmap.get(code) ?? "�";
    }
    return text;
  }
  for (const byte of bytes) {
    text += font.cmap.get(byte) ?? String.fromCharCode(byte);
  }
  return text;
}

function nextContentToken(
  content: string,
  start: number,
): { readonly kind: "value"; readonly value: ContentValue; readonly next: number } | { readonly kind: "operator"; readonly operator: string; readonly next: number } {
  const index = skipSpace(content, start);
  const parsed = readContentValue(content, index);
  if (parsed !== undefined) return { kind: "value", value: parsed.value, next: parsed.next };
  let end = index;
  while (end < content.length && !isDelimiter(content[end] ?? "")) end += 1;
  return { kind: "operator", operator: content.slice(index, end), next: end === index ? index + 1 : end };
}

function contentText(
  content: string,
  fonts: ReadonlyMap<string, PdfFont>,
  _warnings: Set<string>,
): string {
  let output = "";
  let font: PdfFont | undefined;
  let lastY: number | undefined;
  let pendingNewline = false;

  const newline = (): void => {
    if (output !== "" && !output.endsWith("\n")) output += "\n";
    pendingNewline = false;
  };
  const show = (value: ContentValue | undefined): void => {
    if (value?.bytes === undefined) return;
    if (pendingNewline) newline();
    output += decodeText(font, value.bytes);
  };

  let operands: ContentValue[] = [];
  let index = 0;
  while (index < content.length) {
    index = skipSpace(content, index);
    if (index >= content.length) break;
    if (content[index] === "%") {
      const end = content.indexOf("\n", index);
      index = end === -1 ? content.length : end + 1;
      continue;
    }

    const token = nextContentToken(content, index);
    index = token.next;
    if (token.kind === "value") {
      operands.push(token.value);
      continue;
    }

    const operator = token.operator;
    if (operator === "Tf") {
      const name = operands[0]?.kind === "name" ? operands[0].name : undefined;
      font = name === undefined ? undefined : fonts.get(name);
    } else if (operator === "Tj" || operator === "'" || operator === "\"") {
      if (operator !== "Tj") newline();
      show(operands.find((item) => item.kind === "bytes" || item.kind === "hex"));
    } else if (operator === "TJ") {
      const array = operands.find((item) => item.kind === "array");
      for (const item of array?.items ?? []) {
        if (item.kind === "number") {
          if ((item.number ?? 0) <= -100) output += " ";
        } else {
          show(item);
        }
      }
    } else if (operator === "Td" || operator === "TD") {
      const move = operands.filter((item) => item.kind === "number");
      const ty = move[1]?.number ?? 0;
      if (Math.abs(ty) > 0.01) newline();
    } else if (operator === "Tm") {
      const numbers = operands.filter((item) => item.kind === "number");
      const y = numbers[5]?.number;
      if (y !== undefined) {
        if (lastY !== undefined && Math.abs(y - lastY) > 0.5) newline();
        lastY = y;
      }
    } else if (operator === "T*") {
      newline();
    } else if (operator === "BT") {
      lastY = undefined;
      pendingNewline = false;
    } else if (operator === "ET") {
      newline();
      lastY = undefined;
    }
    operands = [];
    if (output.length > MAX_TEXT_CHARS) break;
  }
  return output;
}

// ── 入口 ───────────────────────────────────────────────────────────────────

export function extractPdfText(bytes: Buffer): PdfTextResult {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    throw new ReferenceTextError("文件不是有效的 PDF（缺少 %PDF- 文件头）");
  }
  const warnings = new Set<string>();
  let objects = expandObjectStreams(scanObjects(bytes), warnings);
  if (objects.length === 0) {
    throw new ReferenceTextError("PDF 结构无法解析（没有找到对象）");
  }
  const byId = new Map(objects.map((object) => [object.id, object]));
  objects = [...byId.values()];

  const pages = objects
    .filter((object) => /\/Type\s*\/Page\b/u.test(object.dict) && !/\/Type\s*\/Pages\b/u.test(object.dict))
    .sort((left, right) => left.id - right.id)
    .slice(0, MAX_PAGES);

  if (pages.length === 0) {
    throw new ReferenceTextError("PDF 里没有找到页面");
  }

  let text = "";
  for (const page of pages) {
    const fonts = fontsOfPage(page, byId, warnings);
    const contentsRaw = valueAfter(page.dict, "/Contents");
    if (contentsRaw === undefined) continue;
    const refs = [...contentsRaw.matchAll(/(\d+)\s+\d+\s+R/gu)].map((match) => Number(match[1] ?? "0"));
    for (const ref of refs) {
      const contentObject = byId.get(ref);
      if (contentObject === undefined) continue;
      const data = decodeStream(contentObject, warnings);
      if (data === undefined) continue;
      text += `${contentText(data.toString("latin1"), fonts, warnings)}\n`;
    }
  }

  const normalized = normalizeExtractedText(text);
  const readable = normalized.match(/[A-Za-z0-9一-鿿]/gu)?.length ?? 0;
  if (readable < 10) {
    throw new ReferenceTextError(
      "这份 PDF 没有可提取的文字层（可能是扫描件或纯图片），请上传 Word 或文字型 PDF",
    );
  }
  return { text: normalized, warnings: [...warnings] };
}
