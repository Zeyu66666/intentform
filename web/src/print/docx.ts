/**
 * 打印版考卷的 Word 导出（零依赖）。
 *
 * 为什么不调后端、也不引 `docx` 包：
 * 1. 题面数据已经在浏览器里（打印页刚从 `GET /api/forms/:id` 拿到 schema），
 *    再让服务端生成一遍等于多一条会漂移的渲染路径；
 * 2. 「不新增依赖」是硬约束。`.docx` 本质是 ZIP + 五份 XML，ZIP 用「存储」模式
 *    （不压缩）即可，CRC32 与目录结构都在这里手写，几十行；
 * 3. 教师下载后要**自己排版**，所以输出的是真 `.docx`，不是改扩展名的 HTML。
 *
 * 公式走 KaTeX 的 MathML 输出，再转成 OMML（Word 原生公式）。转换只覆盖 KaTeX
 * 实际会产出的结构；遇到不认识的节点就摊平成普通文本，绝不丢题面。
 *
 * 换行在 Word 里落成 `<w:br/>`，与 `MathText` 的 `<br />` 同源——打印、页面、
 * 导出三条路径看到的是同一条换行。
 */

import katex from "katex";
import { FIELD_TYPE_LABELS, normalizeMathBlanks, type FormSchema } from "@intentform/schema";

import { splitMath } from "../render/katex";
import { printHeaderText, type PrintRow } from "./sheet";

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document" as const;

// ── 最小 ZIP（存储模式）────────────────────────────────────────────────────

interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const encoder = new TextEncoder();

/** 固定 1980-01-01 00:00，ZIP 头因此可复现；Word 不关心时间戳。 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function u16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function u32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

/** 只存储、不压缩：DOCX 的 XML 都很小，换来一个不依赖 `zlib` 的浏览器实现。 */
export function zipStore(entries: readonly ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.byteLength);
    const localView = new DataView(local.buffer);
    u32(localView, 0, 0x04034b50);
    u16(localView, 4, 20);
    u16(localView, 6, 0x0800); // UTF-8 文件名
    u16(localView, 8, 0); // store
    u16(localView, 10, DOS_TIME);
    u16(localView, 12, DOS_DATE);
    u32(localView, 14, crc);
    u32(localView, 18, entry.data.byteLength);
    u32(localView, 22, entry.data.byteLength);
    u16(localView, 26, name.byteLength);
    u16(localView, 28, 0);
    local.set(name, 30);
    localParts.push(local, entry.data);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    u32(centralView, 0, 0x02014b50);
    u16(centralView, 4, 20);
    u16(centralView, 6, 20);
    u16(centralView, 8, 0x0800);
    u16(centralView, 10, 0);
    u16(centralView, 12, DOS_TIME);
    u16(centralView, 14, DOS_DATE);
    u32(centralView, 16, crc);
    u32(centralView, 20, entry.data.byteLength);
    u32(centralView, 24, entry.data.byteLength);
    u16(centralView, 28, name.byteLength);
    u16(centralView, 30, 0);
    u16(centralView, 32, 0);
    u16(centralView, 34, 0);
    u16(centralView, 36, 0);
    u32(centralView, 38, 0);
    u32(centralView, 42, offset);
    central.set(name, 46);
    centralParts.push(central);

    offset += local.byteLength + entry.data.byteLength;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  u32(endView, 0, 0x06054b50);
  u16(endView, 4, 0);
  u16(endView, 6, 0);
  u16(endView, 8, entries.length);
  u16(endView, 10, entries.length);
  u32(endView, 12, centralSize);
  u32(endView, 16, offset);
  u16(endView, 20, 0);

  return concat([...localParts, ...centralParts, end]);
}

// ── 极简 XML 解析（只解析 KaTeX 自己的 MathML）─────────────────────────────

interface XmlElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: readonly XmlChild[];
}

type XmlChild = XmlElement | string;

interface MutableElement {
  readonly tag: string;
  readonly attrs: Record<string, string>;
  readonly children: XmlChild[];
}

function decodeEntities(text: string): string {
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

function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*"([^"]*)"/gu;
  let match = pattern.exec(source);
  while (match !== null) {
    attrs[match[1] ?? ""] = decodeEntities(match[2] ?? "");
    match = pattern.exec(source);
  }
  return attrs;
}

/** 只认标签与文本；KaTeX 的输出是机器生成的，不需要处理注释、CDATA 与命名空间前缀。 */
function parseXml(xml: string): XmlElement {
  const root: MutableElement = { tag: "#root", attrs: {}, children: [] };
  const stack: MutableElement[] = [root];
  const tokenPattern = /<[^>]*>|[^<]+/gu;
  let match = tokenPattern.exec(xml);
  while (match !== null) {
    const token = match[0];
    if (token.startsWith("<?") || token.startsWith("<!")) {
      match = tokenPattern.exec(xml);
      continue;
    }
    if (token.startsWith("</")) {
      if (stack.length > 1) stack.pop();
    } else if (token.startsWith("<")) {
      const selfClosing = token.endsWith("/>");
      const inner = token.slice(1, selfClosing ? -2 : -1).trim();
      const space = inner.search(/\s/u);
      const tag = space === -1 ? inner : inner.slice(0, space);
      const attrs = space === -1 ? {} : parseAttributes(inner.slice(space));
      const element: MutableElement = { tag, attrs, children: [] };
      stack[stack.length - 1]?.children.push(element);
      if (!selfClosing) stack.push(element);
    } else {
      stack[stack.length - 1]?.children.push(decodeEntities(token));
    }
    match = tokenPattern.exec(xml);
  }
  return root;
}

function firstElement(node: XmlElement, tag: string): XmlElement | undefined {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    if (child.tag === tag) return child;
    const nested = firstElement(child, tag);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function elementChildren(node: XmlElement): readonly XmlElement[] {
  return node.children.filter((child): child is XmlElement => typeof child !== "string");
}

function textContent(node: XmlElement): string {
  let text = "";
  for (const child of node.children) {
    text += typeof child === "string" ? child : textContent(child);
  }
  return text;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

// ── MathML → OMML ──────────────────────────────────────────────────────────

const MATH_FONT =
  '<w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:eastAsia="Cambria Math"/></w:rPr>';

function mathRun(text: string): string {
  if (text === "") return "";
  return `<m:r>${MATH_FONT}<m:t xml:space="preserve">${escapeXml(text)}</m:t></m:r>`;
}

/** U+2061 是不可见的「函数应用」，Word 里没有对应物，直接去掉。 */
function mathTextOf(node: XmlElement): string {
  return textContent(node).replace(/⁡/gu, "");
}

function ommlChildren(node: XmlElement): string {
  return elementChildren(node)
    .map((child) => ommlOf(child))
    .join("");
}

function ommlOf(node: XmlElement): string {
  const children = elementChildren(node);
  switch (node.tag) {
    case "mi":
    case "mn":
    case "mo":
    case "mtext":
      return mathRun(mathTextOf(node));
    case "mspace":
      return mathRun(" ");
    case "mfrac": {
      const numerator = children[0];
      const denominator = children[1];
      if (numerator === undefined || denominator === undefined) return ommlChildren(node);
      return `<m:f><m:num>${ommlOf(numerator)}</m:num><m:den>${ommlOf(denominator)}</m:den></m:f>`;
    }
    case "msqrt":
      return `<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>${ommlChildren(node)}</m:e></m:rad>`;
    case "mroot": {
      const radicand = children[0];
      const degree = children[1];
      if (radicand === undefined || degree === undefined) return ommlChildren(node);
      return `<m:rad><m:deg>${ommlOf(degree)}</m:deg><m:e>${ommlOf(radicand)}</m:e></m:rad>`;
    }
    case "msup": {
      const base = children[0];
      const sup = children[1];
      if (base === undefined || sup === undefined) return ommlChildren(node);
      return `<m:sSup><m:e>${ommlOf(base)}</m:e><m:sup>${ommlOf(sup)}</m:sup></m:sSup>`;
    }
    case "msub": {
      const base = children[0];
      const sub = children[1];
      if (base === undefined || sub === undefined) return ommlChildren(node);
      return `<m:sSub><m:e>${ommlOf(base)}</m:e><m:sub>${ommlOf(sub)}</m:sub></m:sSub>`;
    }
    case "msubsup": {
      const base = children[0];
      const sub = children[1];
      const sup = children[2];
      if (base === undefined || sub === undefined || sup === undefined) return ommlChildren(node);
      return `<m:sSubSup><m:e>${ommlOf(base)}</m:e><m:sub>${ommlOf(sub)}</m:sub><m:sup>${ommlOf(sup)}</m:sup></m:sSubSup>`;
    }
    case "mover": {
      const base = children[0];
      const over = children[1];
      if (base === undefined || over === undefined) return ommlChildren(node);
      const accent = node.attrs["accent"] === "true" && over.tag === "mo" && mathTextOf(over).length === 1;
      if (accent) {
        return `<m:acc><m:accPr><m:chr m:val="${escapeXml(mathTextOf(over))}"/></m:accPr><m:e>${ommlOf(base)}</m:e></m:acc>`;
      }
      return `<m:limUpp><m:e>${ommlOf(base)}</m:e><m:lim>${ommlOf(over)}</m:lim></m:limUpp>`;
    }
    case "munder": {
      const base = children[0];
      const under = children[1];
      if (base === undefined || under === undefined) return ommlChildren(node);
      return `<m:limLow><m:e>${ommlOf(base)}</m:e><m:lim>${ommlOf(under)}</m:lim></m:limLow>`;
    }
    case "munderover": {
      // Word 的上下限结构比 MathML 复杂；摊平成「底 + 下 + 上」，至少不丢符号。
      return children.map((child) => ommlOf(child)).join("");
    }
    case "mfenced": {
      const open = node.attrs["open"] ?? "(";
      const close = node.attrs["close"] ?? ")";
      return `${mathRun(open)}${ommlChildren(node)}${mathRun(close)}`;
    }
    case "annotation":
      return "";
    default:
      // `math` / `semantics` / `mrow` / `mstyle` / `mpadded` / `mtable` 等：
      // 结构层直接摊平，叶子节点仍然按上面的规则转换。
      return ommlChildren(node);
  }
}

/** 把一段 LaTeX 转成 OMML；失败或 KaTeX 不认时退回原始 TeX 文本。 */
export function latexToOmml(tex: string): string {
  try {
    const html = katex.renderToString(normalizeMathBlanks(tex), {
      output: "mathml",
      throwOnError: false,
      trust: false,
      strict: "ignore",
      maxExpand: 1000,
      maxSize: 50,
    });
    const root = parseXml(html);
    const math = firstElement(root, "math");
    if (math === undefined) return mathRun(tex);
    const semantics = firstElement(math, "semantics");
    return ommlOf(semantics ?? math);
  } catch {
    return mathRun(tex);
  }
}

// ── WordprocessingML ───────────────────────────────────────────────────────

function textRun(text: string): string {
  return `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
}

/** 文本段里的换行落成 `<w:br/>`，与 `MathText` 的 `<br />` 同源。 */
function textWithBreaks(text: string): string {
  return text
    .split(/\r\n|\r|\n/u)
    .map((line, index) => `${index === 0 ? "" : "<w:r><w:br/></w:r>"}${textRun(line)}`)
    .join("");
}

/** 普通文本 + 行内公式；`$...$` 之外不会经过 KaTeX。 */
function inlineXml(text: string): string {
  return splitMath(text)
    .map((segment) =>
      segment.kind === "math"
        ? `<m:oMath>${latexToOmml(segment.tex)}</m:oMath>`
        : textWithBreaks(segment.text),
    )
    .join("");
}

function paragraph(content: string, styleId?: string, pPrExtra = ""): string {
  const pPr =
    styleId === undefined && pPrExtra === ""
      ? ""
      : `<w:pPr>${styleId === undefined ? "" : `<w:pStyle w:val="${styleId}"/>`}${pPrExtra}</w:pPr>`;
  return `<w:p>${pPr}${content}</w:p>`;
}

function questionParagraph(row: Extract<PrintRow, { kind: "question" }>): string {
  const score = row.score === undefined ? "" : textRun(`（${String(row.score)} 分）`);
  const type = textRun(`[${FIELD_TYPE_LABELS[row.type]}]`);
  return paragraph(
    `${textRun(`${String(row.no)}.`)}${textRun(" ")}${inlineXml(row.title)}${score}${type}`,
    undefined,
    '<w:ind w:left="420" w:hanging="420"/><w:spacing w:before="120" w:after="60"/>',
  );
}

function optionParagraph(option: Extract<PrintRow, { kind: "question" }>["options"][number]): string {
  return paragraph(
    `${textRun(`${option.letter}. `)}${inlineXml(option.text)}`,
    undefined,
    '<w:ind w:left="840"/><w:spacing w:after="20"/>',
  );
}

function answerParagraph(label: string, text: string): string {
  return paragraph(`${textRun(label)}${inlineXml(text)}`, "Answer");
}

function documentBody(schema: FormSchema, rows: readonly PrintRow[]): string {
  const parts: string[] = [];
  parts.push(paragraph(inlineXml(schema.meta.title), "Title"));
  parts.push(paragraph(textRun(printHeaderText(schema)), "Subtitle"));
  parts.push(paragraph(textRun("姓名 __________　　班级 __________　　学号 __________"), "Subtitle"));

  for (const row of rows) {
    if (row.kind === "section") {
      parts.push(paragraph(inlineXml(row.title), "Heading1"));
      if (row.description !== undefined) {
        parts.push(paragraph(inlineXml(row.description), "Note"));
      }
      continue;
    }

    parts.push(questionParagraph(row));
    for (const option of row.options) parts.push(optionParagraph(option));
    if (row.answer !== undefined) parts.push(answerParagraph("答案：", row.answer));
    if (row.explanation !== undefined) parts.push(answerParagraph("解析：", row.explanation));
  }

  parts.push(
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="794" w:right="794" w:bottom="794" w:left="794" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr>',
  );
  return parts.join("");
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults>
<w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault>
</w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:after="80"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Answer"><w:name w:val="Answer"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="40"/></w:pPr><w:rPr><w:color w:val="595959"/><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr></w:style>
</w:styles>`;

function documentXml(schema: FormSchema, rows: readonly PrintRow[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>${documentBody(schema, rows)}</w:body></w:document>`;
}

/** 生成一份可直接用 Word 打开、可继续排版的 `.docx`。 */
export function buildDocx(schema: FormSchema, rows: readonly PrintRow[]): Uint8Array {
  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(ROOT_RELS) },
    { name: "word/document.xml", data: encoder.encode(documentXml(schema, rows)) },
    { name: "word/styles.xml", data: encoder.encode(STYLES) },
    { name: "word/_rels/document.xml.rels", data: encoder.encode(DOCUMENT_RELS) },
  ]);
}

/** 文件名去掉 Windows 不允许的字符；空标题兜底成「试卷」。 */
export function docxFilename(title: string): string {
  const base = title.replace(/[\\/:*?"<>|]/gu, "").trim();
  return `${base === "" ? "试卷" : base}.docx`;
}
