import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./main.ts";

import { isProductionEnvironment, PRODUCTION_CONTENT_SECURITY_POLICY } from "./security.ts";

describe("生产页面 CSP", () => {
  it("只在 NODE_ENV=production 启用生产语义", () => {
    expect(isProductionEnvironment({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionEnvironment({ NODE_ENV: "development" })).toBe(false);
    expect(isProductionEnvironment({})).toBe(false);
  });

  it("允许本地脚本与 KaTeX 所需的 style attribute，但不放开脚本内联", () => {
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("style-src-attr 'unsafe-inline'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).not.toContain("script-src 'unsafe-inline'");
    expect(PRODUCTION_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
  });

  it("生产首页下发 CSP，开发环境不下发严格 CSP", async () => {
    const folder = mkdtempSync(join(tmpdir(), "intentform-csp-"));
    const indexHtml = join(folder, "index.html");
    mkdirSync(join(folder, "assets"));
    writeFileSync(join(folder, "assets", "test.js"), "console.log('ok');");
    const databasePath = join(folder, "test.db");
    writeFileSync(indexHtml, "<!doctype html><div id=\"root\"></div>");
    const probe = createNetServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => resolve());
    });
    const address = probe.address();
    if (address === null || typeof address === "string") throw new Error("port probe failed");
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const server = startServer({
      NODE_ENV: "production",
      PORT: String(port),
      SESSION_SECRET: "security-test-secret",
      DATABASE_PATH: databasePath,
      WEB_INDEX_HTML: indexHtml,
      LLM_MODE: "mock",
      ARGON2_MEMORY_KIB: "8192",
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/`, {
        headers: { accept: "text/html" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toBe(PRODUCTION_CONTENT_SECURITY_POLICY);
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const asset = await fetch(`http://127.0.0.1:${String(port)}/assets/test.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toContain("console.log");
      const traversal = await fetch(`http://127.0.0.1:${String(port)}/assets/%2e%2e/%2e%2e/index.html`);
      expect(traversal.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
