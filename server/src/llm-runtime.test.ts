/**
 * 进程内模型运行设置（`server/src/llm-runtime.ts`）。
 *
 * 最要紧的两条：
 * 1. Key 只进不出——`publicSettings()` 只有 `hasApiKey`；
 * 2. 更新是原子的——非法端点/缺 Key 时**旧配置和旧输入都不能被改脏**，
 *    否则教师改回合法值时会带着上一笔坏输入一起失败。
 */

import { describe, expect, it } from "vitest";

import { resolveLlmRuntimeConfig } from "@intentform/llm";

import { createLlmRuntime } from "./llm-runtime.ts";

const TEST_KEY = "runtime-test-key-not-real";

function liveRuntime() {
  return createLlmRuntime(
    resolveLlmRuntimeConfig("live", { LLM_API_KEY: TEST_KEY }, {}),
    {},
  );
}

describe("createLlmRuntime", () => {
  it("切到 mock/replay 不丢 Key，切回 live 不必重输", () => {
    const runtime = liveRuntime();
    expect(runtime.publicSettings().hasApiKey).toBe(true);

    const mock = runtime.update({
      mode: "mock",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
    });
    expect(mock.mode).toBe("mock");
    // Key 仍留在运行配置里（mock 不读它），切回 live 时不用重输。
    expect(runtime.config.apiKey).toBe(TEST_KEY);
    expect(runtime.publicSettings().hasApiKey).toBe(true);

    const replay = runtime.update({
      mode: "replay",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
    });
    expect(replay.mode).toBe("replay");

    // 不传 apiKey = 保持原 Key。
    const live = runtime.update({
      mode: "live",
      baseUrl: "https://api.example.com/v1",
      model: "model-a",
    });
    expect(live.mode).toBe("live");
    expect(runtime.config.apiKey).toBe(TEST_KEY);
    expect(runtime.config.baseUrl).toBe("https://api.example.com/v1");
  });

  it("公开设置不含 Key 字段", () => {
    const runtime = liveRuntime();
    const settings = runtime.publicSettings();
    expect(Object.keys(settings).sort()).toEqual(["baseUrl", "hasApiKey", "mode", "model"]);
    expect(JSON.stringify(settings)).not.toContain(TEST_KEY);
  });

  it("切到 live 但没 Key 时抛错，旧配置和下一次重试的输入都保持原样", () => {
    const runtime = createLlmRuntime(resolveLlmRuntimeConfig("mock", {}, {}), {});
    expect(() =>
      runtime.update({ mode: "live", baseUrl: "https://api.example.com/v1", model: "model-b" }),
    ).toThrow();

    // 失败后仍是 mock，且端点/模型没有被上一笔坏输入污染。
    expect(runtime.config.mode).toBe("mock");
    expect(runtime.config.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(runtime.config.model).toBe("deepseek-chat");

    // 补上 Key 后，用合法输入一次成功。
    const ok = runtime.update({
      mode: "live",
      baseUrl: "https://api.example.com/v1",
      model: "model-b",
      apiKey: TEST_KEY,
    });
    expect(ok.mode).toBe("live");
    expect(runtime.config.apiKey).toBe(TEST_KEY);
  });

  it("非法 URL 被拒，且不改变当前配置", () => {
    const runtime = liveRuntime();
    const before = runtime.publicSettings();
    expect(() =>
      runtime.update({ mode: "live", baseUrl: "not-a-url", model: "model-b" }),
    ).toThrow();
    expect(runtime.publicSettings()).toEqual(before);
  });

  it("显式传空串会清空 Key；之后再切 live 必须重新提供", () => {
    const runtime = liveRuntime();
    runtime.update({ mode: "mock", baseUrl: "https://api.example.com/v1", model: "m", apiKey: "" });
    expect(runtime.publicSettings().hasApiKey).toBe(false);
    expect(() =>
      runtime.update({ mode: "live", baseUrl: "https://api.example.com/v1", model: "m" }),
    ).toThrow();
  });
});
