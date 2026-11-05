/**
 * 参考试卷文本提取：DOCX 的段落/换行、PDF 的 ToUnicode 与内容流，以及类型判定。
 *
 * 这些测试用**自己构造的最小文件**，不依赖外部样本：解析器的边界（ZIP 方法、
 * 两字节 CID、换行算子）都由测试数据点名，失败时不用猜是哪份 PDF 的怪结构。
 */

import { describe, expect, it } from "vitest";

import { extractReference, ReferenceTextError } from "./index.ts";

function zipStore(entries: readonly { readonly name: string; readonly data: string }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    locals.push(local, data);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    centrals.push(central);
    offset += local.length + data.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

function docxWith(bodyXml: string): Buffer {
  return zipStore([
    {
      name: "word/document.xml",
      data: `<w:document><w:body>${bodyXml}</w:body></w:document>`,
    },
  ]);
}

function pdfWith(hexText: string): Buffer {
  const map: Readonly<Record<string, string>> = {
    "4F60": "你",
    "597D": "好",
    "4E16": "世",
    "754C": "界",
    "6570": "数",
    "5B66": "学",
    "8003": "考",
    "8BD5": "试",
    "9898": "题",
    "76EE": "目",
    "53C2": "参",
    "7B54": "答",
    "6848": "案",
  };
  const codes = Object.keys(map);
  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    `${String(codes.length)} beginbfchar`,
    ...codes.map((code) => `<${code}> <${code}>`),
    "endbfchar",
    "endcmap",
    "end",
    "end",
    "end",
  ].join("\n");
  const content = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    `<${hexText}> Tj`,
    "0 -20 Td",
    "<4E16 754C> Tj",
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${String(Buffer.byteLength(content, "latin1"))} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /ToUnicode 6 0 R >>",
    `<< /Length ${String(Buffer.byteLength(cmap, "latin1"))} >>\nstream\n${cmap}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  objects.forEach((dict, index) => {
    pdf += `${String(index + 1)} 0 obj\n${dict}\nendobj\n`;
  });
  return Buffer.from(pdf, "latin1");
}

describe("DOCX 文本提取", () => {
  it("段落、换行与 XML 转义都被还原", () => {
    const bytes = docxWith(
      "<w:p><w:r><w:t>第一段 &amp; 题型</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>第二行</w:t><w:br/><w:t>换行后</w:t></w:r></w:p>",
    );
    const result = extractReference("卷子.docx", bytes);
    expect(result.kind).toBe("docx");
    expect(result.text).toBe("第一段 & 题型\n第二行\n换行后");
  });

  it("找不到 document.xml 时不假装成功", () => {
    const bytes = zipStore([{ name: "word/other.xml", data: "<x/>" }]);
    expect(() => extractReference("坏了.docx", bytes)).toThrow(ReferenceTextError);
  });
});

describe("PDF 文本提取", () => {
  it("按 ToUnicode 把两字节 CID 还原成中文，并保留换行", () => {
    const bytes = pdfWith("4F60597D4E16754C65705B6680038BD5989876EE53C280037B546848");
    const result = extractReference("试卷.pdf", bytes);
    expect(result.kind).toBe("pdf");
    expect(result.text).toContain("你好世界数学考试题目参考答案");
    expect(result.text).toContain("世界");
  });

  it("没有文字层时明确报错，而不是返回空串", () => {
    const content = "q 1 0 0 1 0 0 cm /Im0 Do Q";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
      `<< /Length ${String(Buffer.byteLength(content, "latin1"))} >>\nstream\n${content}\nendstream`,
    ];
    let pdf = "%PDF-1.4\n";
    objects.forEach((dict, index) => {
      pdf += `${String(index + 1)} 0 obj\n${dict}\nendobj\n`;
    });
    expect(() => extractReference("扫描件.pdf", Buffer.from(pdf, "latin1"))).toThrow(/没有可提取的文字层/u);
  });
});

describe("类型判定", () => {
  it("只认扩展名与文件头同时匹配的文件", () => {
    expect(() => extractReference("卷子.doc", Buffer.from("x"))).toThrow(/docx/u);
    expect(() => extractReference("假.pdf", Buffer.from("PK\u0003\u0004", "latin1"))).toThrow(/不是有效的 PDF/u);
    expect(() => extractReference("假.docx", Buffer.from("%PDF-1.4", "latin1"))).toThrow(
      /不是有效的 Word/u,
    );
  });
});
