import { createServer } from "node:http";
import type { Server } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { parseSseEvent, LIMITS } from "@intentform/schema";
import type { SseEvent } from "@intentform/schema";

import { GENERATE_PATH, MAX_REQUEST_BYTES, createGenerateHandler, parseGenerateBody } from "./generate-route.ts";
import { CLARIFY_ANSWER_MAX_CHARS } from "@intentform/schema";
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
      request: {
        requirement: "出一份测验",
        composedRequirement: "出一份测验",
        clarifyNote: "",
      },
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

/**
 * 澄清补充（省赛 R-05）：回答拼进需求、再交给生成器。
 *
 * 最重要的一条是「没有补充时字节不变」——回放键是需求原文的哈希，
 * 多一个空格就换一次键，三条预置 fixture 当场失效。
 */
describe("parseGenerateBody · 澄清补充", () => {
  it("带补充：追加约束块，并给时间线备好一句话", () => {
    const result = parseGenerateBody(
      JSON.stringify({
        requirement: "帮我出一份英语卷子",
        clarifications: [
          { slot: "count", answer: "10 题" },
          { slot: "score", answer: "100 分" },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.request.requirement).toBe("帮我出一份英语卷子");
    expect(result.request.composedRequirement).toContain("【教师补充的约束】");
    expect(result.request.composedRequirement).toContain("- 题量：10 题");
    expect(result.request.composedRequirement).toContain("- 总分：100 分");
    expect(result.request.clarifyNote).toBe("澄清 2 项：题量=10 题、总分=100 分");
  });

  it("没有补充（缺省或空数组）：composedRequirement 逐字节等于原需求", () => {
    for (const body of [
      { requirement: "出十道判断题" },
      { requirement: "出十道判断题", clarifications: [] },
    ]) {
      const result = parseGenerateBody(JSON.stringify(body));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.request.composedRequirement).toBe("出十道判断题");
      expect(result.request.clarifyNote).toBe("");
    }
  });

  it("拼完超过需求字数上限 → 422（而不是把超长串塞给模型）", () => {
    const almost = "题".repeat(LIMITS.requirementMaxChars - 10);
    const result = parseGenerateBody(
      JSON.stringify({
        requirement: almost,
        clarifications: [{ slot: "knowledge", answer: "知".repeat(50) }],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(422);
  });

  it("非法槽位 / 空回答 / 回答超长 / 不是数组 → 400", () => {
    const bad: readonly unknown[] = [
      [{ slot: "subject", answer: "数学" }],
      [{ slot: "count", answer: "   " }],
      [{ slot: "count", answer: 42 }],
      [{ slot: "knowledge", answer: "知".repeat(CLARIFY_ANSWER_MAX_CHARS + 1) }],
      "count=10",
    ];
    for (const clarifications of bad) {
      const result = parseGenerateBody(
        JSON.stringify({ requirement: "帮我出一份英语卷子", clarifications }),
      );
      expect(result.ok, JSON.stringify(clarifications)).toBe(false);
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

/**
 * 生成请求带蓝图（省赛 R-06）。三个命题：
 * 1. 合法蓝图透传到生成器，事件流里出现「蓝图已确认」；
 * 2. 非法蓝图**拒收**，不许静默丢掉——丢掉就等于两阶段退化成单阶段；
 * 3. 不带蓝图时请求体行为与以前一致。
 */
describe("POST /api/generate · 蓝图", () => {
  const BLUEPRINT = {
    title: "二次函数入门测验",
    kind: "quiz",
    sections: [{ title: "全部", count: 4 }],
    totalCount: 4,
    typeMix: { single: 4 },
    totalScore: 20,
    knowledgePoints: [{ id: "kp-basic", name: "基础运算" }],
  };

  it("带合法蓝图：事件流里出现 plan 阶段与蓝图摘要", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}${GENERATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirement: "出一份小测验", blueprint: BLUEPRINT }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"phase":"plan"');
    expect(text).toContain("蓝图已确认");
  });

  it("非法蓝图（题量对不上）→ 400，且不开始流", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}${GENERATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requirement: "出一份小测验",
        blueprint: { ...BLUEPRINT, totalCount: 9 },
      }),
    });
    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("不带蓝图：事件流里没有 plan 阶段（未发生不许演出）", async () => {
    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}${GENERATE_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requirement: "出一份小测验" }),
    });
    const text = await response.text();
    expect(text).not.toContain('"phase":"plan"');
  });
});
