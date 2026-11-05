import { describe, expect, it } from "vitest";

import { API_PATHS, REFERENCE_UPLOAD_MAX_BYTES, type ReferenceExtractResponse } from "@intentform/schema";

import { CSRF_HEADER, CSRF_HEADER_VALUE, type HttpClient, type HttpRequestOptions } from "./http";
import { createReferenceApi, type ReferenceFileLike } from "./reference";

const RESPONSE: ReferenceExtractResponse = {
  ok: true,
  filename: "卷子.docx",
  kind: "docx",
  text: "一、选择题",
  charCount: 5,
  truncated: false,
  warnings: [],
};

function fakeFile(name: string, content: string, size = content.length): ReferenceFileLike {
  const bytes = new TextEncoder().encode(content);
  return {
    name,
    size,
    arrayBuffer: () => Promise.resolve(bytes.buffer as ArrayBuffer),
  };
}

describe("referenceApi.extract", () => {
  it("把文件读成 base64，POST 到提取接口并带 CSRF 头", async () => {
    const calls: { path: string; options: HttpRequestOptions | undefined }[] = [];
    const client: HttpClient = {
      request: <T>(path: string, options?: HttpRequestOptions): Promise<{ ok: true; data: T }> => {
        calls.push({ path, options });
        return Promise.resolve({ ok: true, data: RESPONSE as T });
      },
    };
    const api = createReferenceApi(client);
    const outcome = await api.extract(fakeFile("卷子.docx", "abc"));

    expect(outcome.ok).toBe(true);
    expect(calls[0]?.path).toBe(API_PATHS.referenceExtract);
    expect(calls[0]?.options?.method).toBe("POST");
    expect(calls[0]?.options?.csrf).toBe(true);
    const body = calls[0]?.options?.body as { filename: string; data: string };
    expect(body.filename).toBe("卷子.docx");
    expect(atob(body.data)).toBe("abc");
  });

  it("本地先挡住超过 10 MiB 的文件，不发请求", async () => {
    let called = false;
    const client: HttpClient = {
      request: <T>(): Promise<{ ok: true; data: T }> => {
        called = true;
        return Promise.resolve({ ok: true, data: RESPONSE as T });
      },
    };
    const api = createReferenceApi(client);
    const outcome = await api.extract(fakeFile("大.pdf", "", REFERENCE_UPLOAD_MAX_BYTES + 1));

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.code).toBe("payload_too_large");
    expect(called).toBe(false);
  });

  it("读取文件失败时返回可显示的失败，而不是抛异常", async () => {
    const client: HttpClient = {
      request: <T>(): Promise<{ ok: true; data: T }> =>
        Promise.resolve({ ok: true, data: RESPONSE as T }),
    };
    const api = createReferenceApi(client);
    const outcome = await api.extract({
      name: "坏.pdf",
      size: 3,
      arrayBuffer: () => Promise.reject(new Error("read failed")),
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.failure.message).toContain("读取文件失败");
  });

  it("CSRF 常量与客户端一致", () => {
    expect(CSRF_HEADER).toBe("x-intentform-csrf");
    expect(CSRF_HEADER_VALUE).toBe("1");
  });
});
