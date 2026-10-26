import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { parseSseEvent, LIMITS } from "@intentform/schema";
import type { SseEvent } from "@intentform/schema";

import { GENERATE_PATH, MAX_REQUEST_BYTES, createGenerateHandler, parseGenerateBody } from "./generate-route.ts";
import { resolveLlmRuntimeConfig } from "@intentform/llm";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
          server.closeAllConnections();
        }),
    ),
  );
});

async function startServer(): Promise<string> {
  const handler = createGenerateHandler({
    config: resolveLlmRuntimeConfig("mock", {}, {}),
    heartbeatMs: 0,
  });
  const server = createServer((req, res) => {
    if (req.url === GENERATE_PATH) {
      void handler.handle(req, res);
      return;
    }
    res.writeHead(404).end();
  });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("没拿到端口");
  return `http://127.0.0.1:${String(address.port)}`;
}

function parseFrames(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter((frame) => frame.trim() !== "" && !frame.trimStart().startsWith(":"))
    .map((frame) => {
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
      if (dataLine === undefined) throw new Error(`帧里没有 data 行: ${frame}`);
      return parseSseEvent(JSON.parse(dataLine.slice("data: ".length)));
    });
}

describe("parseGenerateBody", () => {
  it("接受合法需求（两侧空白去掉）", () => {
    expect(parseGenerateBody(JSON.stringify({ requirement: "  出一份测验  " }))).toEqual({
      ok: true,
      requirement: "出一份测验",
    });
  });

  it("坏 JSON / 非对象 / 缺字段 / 空串 → 400", () => {
    for (const body of ["{", "[]", "null", "{}", JSON.stringify({ requirement: 42 }), JSON.stringify({ requirement: "  " })]) {
      const result = parseGenerateBody(body);
      expect(result.ok, body).toBe(false);
      if (!result.ok) expect(result.status).toBe(400);
    }
  });

  it(`${String(LIMITS.requirementMaxChars)} 字边界：等长通过、多一字 422`, () => {
    const ok = parseGenerateBody(JSON.stringify({ requirement: "题".repeat(LIMITS.requirementMaxChars) }));
    expect(ok.ok).toBe(true);
    const tooLong = parseGenerateBody(JSON.stringify({ requirement: "题".repeat(LIMITS.requirementMaxChars + 1) }));
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) {
      expect(tooLong.status).toBe(422);
      expect(tooLong.error).toBe("requirement_too_long");
    }
  });
});

describe("POST /api/generate（mock 模式，端到端）", () => {
  it("返回 text/event-stream，seq 从 1 起单调递增，最后是 done", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}${GENERATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirement: "出一份初二数学测验" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    // §2.6 第 4 条：界面必须能分辨 live / replay / mock。模式走响应头，
    // 事件载荷一字不改，所以这里断言头而不去翻事件。
    expect(response.headers.get("x-intentform-llm-mode")).toBe("mock");

    const raw = await response.text();
    const events = parseFrames(raw);
    expect(events.length).toBeGreaterThan(3);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(events.at(-1)?.type).toBe("done");
    expect(events.filter((event) => event.type === "done")).toHaveLength(1);
    // 事件体不含任何上游细节字段
    expect(raw).not.toContain("api.deepseek.com");
    expect(raw).not.toContain("Bearer ");
  });

  it("非 POST → 405；非 JSON → 415；超大请求体 → 413", async () => {
    const baseUrl = await startServer();

    const get = await fetch(`${baseUrl}${GENERATE_PATH}`);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");

    const textPlain = await fetch(`${baseUrl}${GENERATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "requirement=x",
    });
    expect(textPlain.status).toBe(415);

    const huge = await fetch(`${baseUrl}${GENERATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirement: "题".repeat(MAX_REQUEST_BYTES) }),
    });
    expect(huge.status).toBe(413);
    const payload = (await huge.json()) as Record<string, unknown>;
    expect(payload["ok"]).toBe(false);
  });
});
