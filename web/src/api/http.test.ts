import { describe, expect, it } from "vitest";

import {
  BAD_RESPONSE_MESSAGE,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  NETWORK_MESSAGE,
  createHttpClient,
} from "./http";

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function recordingFetch(response: Response | Error, captured: Captured[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(input), init: init ?? {} });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createHttpClient", () => {
  it("写操作带 CSRF 头、JSON 请求体、credentials=include", async () => {
    const captured: Captured[] = [];
    const client = createHttpClient({ fetchImpl: recordingFetch(jsonResponse({ ok: true }), captured) });

    const result = await client.request<{ ok: true }>("/api/submissions", {
      method: "POST",
      body: { slug: "abc", formVersionId: "v1", answers: {} },
      csrf: true,
    });

    expect(result.ok).toBe(true);
    const [request] = captured;
    expect(request?.url).toBe("/api/submissions");
    expect(request?.init.method).toBe("POST");
    const headers = request?.init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(request?.init.credentials).toBe("include");
    expect(request?.init.body).toBe(
      JSON.stringify({ slug: "abc", formVersionId: "v1", answers: {} }),
    );
  });

  it("GET 不带 CSRF 头与 Content-Type（少一次无谓的预检）", async () => {
    const captured: Captured[] = [];
    const client = createHttpClient({ fetchImpl: recordingFetch(jsonResponse({ ok: true }), captured) });

    await client.request("/api/forms");

    const headers = captured[0]?.init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBeUndefined();
    expect(headers["Content-Type"]).toBeUndefined();
    expect(captured[0]?.init.body).toBeUndefined();
    expect(captured[0]?.init.credentials).toBe("include");
  });

  it("409 版本冲突：状态码与契约错误码一起回给上层", async () => {
    const captured: Captured[] = [];
    const client = createHttpClient({
      fetchImpl: recordingFetch(
        jsonResponse({ ok: false, error: "version_conflict", message: "版本已更新" }, 409),
        captured,
      ),
    });

    const result = await client.request("/api/submissions", { method: "POST", csrf: true });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.status).toBe(409);
    expect(result.failure.code).toBe("version_conflict");
    expect(result.failure.message).toBe("版本已更新");
  });

  it("错误体不是 ApiErrorBody 时用本地兜底文案，不把 HTML 塞进界面", async () => {
    const captured: Captured[] = [];
    const client = createHttpClient({
      fetchImpl: recordingFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }), captured),
    });

    const result = await client.request("/api/forms");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.status).toBe(502);
    expect(result.failure.code).toBeNull();
    expect(result.failure.message).toBe("请求失败（HTTP 502）");
  });

  it("连不上服务端：status=null + 可操作提示", async () => {
    const captured: Captured[] = [];
    const client = createHttpClient({
      fetchImpl: recordingFetch(new TypeError("Failed to fetch"), captured),
    });

    const result = await client.request("/api/forms");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.status).toBeNull();
    expect(result.failure.message).toBe(NETWORK_MESSAGE);
  });

  it("200 但不是 JSON：报契约违约，不假装成功", async () => {
    const captured: Captured[] = [];
    const client = createHttpClient({
      fetchImpl: recordingFetch(new Response("not json", { status: 200 }), captured),
    });

    const result = await client.request("/api/forms");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.message).toBe(BAD_RESPONSE_MESSAGE);
  });

  it("200 + JSON：原样交出响应体", async () => {
    const captured: Captured[] = [];
    const client = createHttpClient({
      fetchImpl: recordingFetch(jsonResponse({ ok: true, forms: [] }), captured),
    });

    const result = await client.request<{ ok: true; forms: readonly never[] }>("/api/forms");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.forms).toEqual([]);
  });
});
