/**
 * `teacher.ts` 的请求形状测试：只验"发出去的到底是不是那一个请求"。
 *
 * 这一层最容易悄悄坏掉的地方不是逻辑，而是路径/方法/CSRF 三件套之一写错——
 * 逻辑测试全绿、真机上却 404 或 403。所以这里断的是字面量路径，而不是
 * `API_PATHS.patchForm("form-1")` 自己（用常量断言常量，两边一起错也发现不了）。
 */

import { describe, expect, it } from "vitest";

import { CSRF_HEADER, CSRF_HEADER_VALUE, createHttpClient } from "./http";
import { createTeacherApi } from "./teacher";

interface Captured {
  readonly url: string;
  readonly init: RequestInit;
}

function recordingFetch(response: Response, captured: Captured[]): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    captured.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(response);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiFor(response: Response, captured: Captured[]) {
  return createTeacherApi(createHttpClient({ fetchImpl: recordingFetch(response, captured) }));
}

const PATCH_OK = {
  ok: true,
  form: {
    id: "form-1",
    title: "第一单元小测",
    kind: "quiz",
    status: "draft",
    draftVersionId: "ver-2",
    updatedAt: "2024-05-01T00:00:00.000Z",
  },
  version: {
    id: "ver-2",
    n: 2,
    source: "patch",
    promptVersion: "manual",
    createdAt: "2024-05-01T00:00:00.000Z",
  },
  schema: { meta: { version: 1, kind: "quiz", title: "第一单元小测" }, items: [] },
  changes: [{ op: "setScore", itemId: "q-single", where: "第 1 题", before: "5 分", after: "8 分" }],
};

describe("teacherApi.patchForm", () => {
  it("PATCH /api/forms/:id，带 CSRF 头与请求体", async () => {
    const captured: Captured[] = [];
    const api = apiFor(jsonResponse(PATCH_OK), captured);

    const request = {
      baseVersionId: "ver-1",
      ops: [{ op: "setScore", itemId: "q-single", score: 8 } as const],
    };
    const result = await api.patchForm("form-1", request);

    expect(result.ok).toBe(true);
    const [sent] = captured;
    expect(sent?.url).toBe("/api/forms/form-1");
    expect(sent?.init.method).toBe("PATCH");
    expect(sent?.init.credentials).toBe("include");
    const headers = sent?.init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(sent?.init.body))).toEqual(request);
  });

  it("409 版本冲突：状态码与契约错误码原样透给上层，让界面自己决定不自动重试", async () => {
    const captured: Captured[] = [];
    const api = apiFor(
      jsonResponse({ ok: false, error: "version_conflict", message: "版本已更新" }, 409),
      captured,
    );

    const result = await api.patchForm("form-1", {
      baseVersionId: "ver-stale",
      ops: [{ op: "setScore", itemId: "q-single", score: 8 }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.status).toBe(409);
    expect(result.failure.code).toBe("version_conflict");
  });
});

describe("teacherApi.undoDraft", () => {
  it("POST /api/forms/:id/undo，带 CSRF 头与 fromVersionId", async () => {
    const captured: Captured[] = [];
    const api = apiFor(
      jsonResponse({
        ...PATCH_OK,
        version: { ...PATCH_OK.version, id: "ver-1", n: 1 },
        undone: true,
      }),
      captured,
    );

    const result = await api.undoDraft("form-1", { fromVersionId: "ver-2" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.undone).toBe(true);
    const [sent] = captured;
    expect(sent?.url).toBe("/api/forms/form-1/undo");
    expect(sent?.init.method).toBe("POST");
    const headers = sent?.init.headers as Record<string, string>;
    expect(headers[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(JSON.parse(String(sent?.init.body))).toEqual({ fromVersionId: "ver-2" });
  });

  it("已经是第一个版本：undone === false 是正常返回，不是失败", async () => {
    const captured: Captured[] = [];
    const api = apiFor(jsonResponse({ ...PATCH_OK, undone: false }), captured);

    const result = await api.undoDraft("form-1", { fromVersionId: "ver-1" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.undone).toBe(false);
  });
});
