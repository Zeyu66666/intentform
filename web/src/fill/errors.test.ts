import { describe, expect, it } from "vitest";

import { FILL_NOT_FOUND_MESSAGE, mapFillLoad } from "./errors";
import { quizView } from "./__fixtures__/public-form";

describe("mapFillLoad", () => {
  it("成功时原样交出公开视图", () => {
    const view = quizView();
    const load = mapFillLoad({ ok: true, data: view });
    expect(load.kind).toBe("ready");
    if (load.kind !== "ready") return;
    expect(load.view).toBe(view);
  });

  it("404：链接不对或表单未发布，重试无意义", () => {
    const load = mapFillLoad({
      ok: false,
      failure: { status: 404, code: "not_found", message: "not found" },
    });
    expect(load.kind).toBe("error");
    if (load.kind !== "error") return;
    expect(load.message).toBe(FILL_NOT_FOUND_MESSAGE);
    expect(load.retryable).toBe(false);
  });

  it("断网：给可重试标记", () => {
    const load = mapFillLoad({
      ok: false,
      failure: { status: null, code: null, message: "网络异常，请检查连接后重试" },
    });
    if (load.kind !== "error") throw new Error("应为 error");
    expect(load.retryable).toBe(true);
  });

  it("5xx：可重试；429：也可重试", () => {
    const server = mapFillLoad({
      ok: false,
      failure: { status: 503, code: "internal", message: "boom" },
    });
    if (server.kind !== "error") throw new Error("应为 error");
    expect(server.retryable).toBe(true);
    expect(server.message).toBe("服务端出错了，请稍后重试");

    const limited = mapFillLoad({
      ok: false,
      failure: { status: 429, code: "rate_limited", message: "too many" },
    });
    if (limited.kind !== "error") throw new Error("应为 error");
    expect(limited.retryable).toBe(true);
    expect(limited.message).toBe("操作太频繁，请稍后再试");
  });
});
