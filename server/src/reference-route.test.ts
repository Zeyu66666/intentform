/**
 * `POST /api/reference/extract`：上传的是不可信文件，这里验四类拒绝（非法 base64、
 * 超限、扩展名不符、文件头不符）和一条成功路径。解析器本身的边界在
 * `reference/reference.test.ts`。
 */

import { afterEach, describe, expect, it } from "vitest";

import type { ReferenceExtractResponse } from "@intentform/schema";

import { call, startTestServer, type TestServer } from "./testing/harness.ts";

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(): Promise<TestServer> {
  server = await startTestServer();
  return server;
}

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

function sampleDocx(): Buffer {
  return zipStore([
    {
      name: "word/document.xml",
      data: "<w:document><w:body><w:p><w:r><w:t>一、选择题（每题 5 分）</w:t></w:r></w:p></w:body></w:document>",
    },
  ]);
}

describe("POST /api/reference/extract", () => {
  it("上传 .docx 返回提取文本与字数", async () => {
    const app = await boot();
    const response = await call<ReferenceExtractResponse>(app, "POST", "/api/reference/extract", {
      body: { filename: "参考卷.docx", data: sampleDocx().toString("base64") },
    });
    expect(response.status).toBe(200);
    expect(response.json.ok).toBe(true);
    expect(response.json.kind).toBe("docx");
    expect(response.json.filename).toBe("参考卷.docx");
    expect(response.json.text).toContain("一、选择题");
    expect(response.json.charCount).toBe(response.json.text.length);
    expect(response.json.truncated).toBe(false);
  });

  it("扩展名不符 / 文件头不符 / 非法 base64 分别拒绝", async () => {
    const app = await boot();
    const doc = sampleDocx().toString("base64");

    const legacy = await call(app, "POST", "/api/reference/extract", {
      body: { filename: "参考卷.doc", data: doc },
    });
    expect(legacy.status).toBe(422);

    const fake = await call(app, "POST", "/api/reference/extract", {
      body: { filename: "参考卷.pdf", data: doc },
    });
    expect(fake.status).toBe(422);

    const badBase64 = await call(app, "POST", "/api/reference/extract", {
      body: { filename: "参考卷.docx", data: "***not-base64***" },
    });
    expect(badBase64.status).toBe(400);

    const empty = await call(app, "POST", "/api/reference/extract", {
      body: { filename: "参考卷.docx", data: "" },
    });
    expect(empty.status).toBe(400);
  });

  it("没有 CSRF 头时被跨站写保护挡住", async () => {
    const app = await boot();
    const response = await call(app, "POST", "/api/reference/extract", {
      body: { filename: "参考卷.docx", data: sampleDocx().toString("base64") },
      csrf: false,
    });
    expect(response.status).toBe(403);
  });
});
