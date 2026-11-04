import { describe, expect, it } from "vitest";

import { readRuntimeMode, type RuntimeFetch } from "./runtime";

describe("readRuntimeMode", () => {
  it("读 healthz 的 llmMode", async () => {
    const fetchImpl: RuntimeFetch = () =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, llmMode: "live" }) });
    await expect(readRuntimeMode(fetchImpl)).resolves.toBe("live");
  });

  it("网络失败 / 非 2xx / 形状不符一律 null，不猜成 live", async () => {
    const cases: readonly RuntimeFetch[] = [
      () => Promise.reject(new Error("offline")),
      () => Promise.resolve({ ok: false, json: () => Promise.resolve({ llmMode: "live" }) }),
      () => Promise.resolve({ ok: true, json: () => Promise.resolve(null) }),
      () => Promise.resolve({ ok: true, json: () => Promise.resolve({ llmMode: 42 }) }),
    ];
    for (const fetchImpl of cases) {
      await expect(readRuntimeMode(fetchImpl)).resolves.toBeNull();
    }
  });
});
