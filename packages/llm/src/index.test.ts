import { describe, expect, it } from "vitest";

import {
  DEFAULT_LLM_MODE,
  LLM_MODES,
  isLlmMode,
  requiresUpstreamCredentials,
  resolveLlmMode,
} from "./index.ts";

describe("resolveLlmMode", () => {
  it("未设置 LLM_MODE 时回落到 replay（评委无 Key 复现路径）", () => {
    expect(resolveLlmMode({})).toBe("replay");
    expect(DEFAULT_LLM_MODE).toBe("replay");
  });

  it("空串与纯空白同样回落到 replay", () => {
    expect(resolveLlmMode({ LLM_MODE: "" })).toBe("replay");
    expect(resolveLlmMode({ LLM_MODE: "   " })).toBe("replay");
  });

  it("大小写与首尾空白被归一化", () => {
    expect(resolveLlmMode({ LLM_MODE: " LIVE " })).toBe("live");
    expect(resolveLlmMode({ LLM_MODE: "Replay" })).toBe("replay");
  });

  it("四种合法模式全部被接受", () => {
    for (const mode of LLM_MODES) {
      expect(resolveLlmMode({ LLM_MODE: mode })).toBe(mode);
    }
  });

  it("非法值直接抛错而不是静默降级", () => {
    expect(() => resolveLlmMode({ LLM_MODE: "prod" })).toThrow(/invalid LLM_MODE/);
    expect(() => resolveLlmMode({ LLM_MODE: "offline" })).toThrow(/invalid LLM_MODE/);
  });

  it("错误信息列出全部合法值，便于定位拼写问题", () => {
    try {
      resolveLlmMode({ LLM_MODE: "lvie" });
      expect.unreachable("应当抛错");
    } catch (error) {
      const message = (error as Error).message;
      for (const mode of LLM_MODES) {
        expect(message).toContain(mode);
      }
    }
  });
});

describe("requiresUpstreamCredentials", () => {
  it("只有 live / record 需要真正打上游", () => {
    expect(requiresUpstreamCredentials("live")).toBe(true);
    expect(requiresUpstreamCredentials("record")).toBe(true);
    expect(requiresUpstreamCredentials("replay")).toBe(false);
    expect(requiresUpstreamCredentials("mock")).toBe(false);
  });
});

describe("isLlmMode", () => {
  it("拒绝非字符串与未知字符串", () => {
    expect(isLlmMode(undefined)).toBe(false);
    expect(isLlmMode(1)).toBe(false);
    expect(isLlmMode("LIVE")).toBe(false); // 守卫不做归一化，归一化只发生在 resolveLlmMode
  });
});
