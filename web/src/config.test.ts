import { describe, expect, it } from "vitest";

import { DEFAULT_API_BASE, PUBLIC_ENV_KEYS, readWebConfig, resolveApiBase } from "./config";

describe("resolveApiBase", () => {
  it("未配置时默认同源 /api", () => {
    expect(resolveApiBase(undefined)).toBe(DEFAULT_API_BASE);
    expect(resolveApiBase("")).toBe("/api");
    expect(resolveApiBase("  ")).toBe("/api");
  });

  it("去掉尾部斜杠，避免拼出 //generate", () => {
    expect(resolveApiBase("/api/")).toBe("/api");
    expect(resolveApiBase("api//")).toBe("/api");
  });

  it("缺少前导斜杠时补齐", () => {
    expect(resolveApiBase("api")).toBe("/api");
    expect(resolveApiBase("gateway/api")).toBe("/gateway/api");
  });

  it("拒绝绝对地址：前端配置不能把请求和 session cookie 发到第三方域", () => {
    expect(() => resolveApiBase("https://evil.example.com/api")).toThrow(/same-origin/);
    expect(() => resolveApiBase("http://127.0.0.1:8787/api")).toThrow(/same-origin/);
  });
});

describe("readWebConfig", () => {
  it("只认白名单内的键，且不回显任何密钥", () => {
    const config = readWebConfig({
      VITE_API_BASE: "/api",
      LLM_API_KEY: "sk-should-never-reach-frontend", // secret-scan:allow 断言用的假值，非真实 Key
    });
    expect(config).toEqual({ apiBase: "/api", fillPathPrefix: "/f" });
    expect(JSON.stringify(config)).not.toContain("sk-");
    expect(PUBLIC_ENV_KEYS).toEqual(["VITE_API_BASE"]);
  });

  it("填写页路由前缀固定为 /f", () => {
    expect(readWebConfig({}).fillPathPrefix).toBe("/f");
  });
});
