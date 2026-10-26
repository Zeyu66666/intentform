/**
 * SSE 事件契约的契约测试（《计划 v2.0》§3.6）。
 *
 * 这里测的不是"实现有没有 bug"，而是**协议本身有没有被改动**：
 * 事件数、类别数、`seq` 单调、心跳不是事件、编码解码往返一致。
 * 任何一条红了，说明有人动了 `AGENTS.md` §7 列为"不可擅自更改"的东西。
 */

import { describe, expect, it } from "vitest";

import { LIMITS } from "./constants";
import { formItemSchema } from "./types";
import {
  createSseSequencer,
  eventCategory,
  isHeartbeatFrame,
  isTerminalEvent,
  parseSseDataLine,
  parseSseEvent,
  safeParseSseEvent,
  SSE_EVENT_CATEGORIES,
  SSE_EVENT_TYPES,
  SSE_HEARTBEAT_FRAME,
  TERMINAL_EVENT_TYPES,
  type SseEvent,
  type SseEventBody,
  toNdjsonLine,
  toSseFrame,
} from "./sse-events";

/**
 * 一个结构合法的单选题节点，作为 `field` 事件的载荷底稿。
 * 用 `formItemSchema.parse` 而不是对象字面量：契约里的 `node` 是 Zod 推断出的
 * 可变数组类型，`as const` 的只读数组塞不进去，而手写一遍类型等于复制契约。
 */
const validNode = formItemSchema.parse({
  type: "single",
  id: "q001",
  title: "下列哪个是二次函数？",
  required: true,
  score: 5,
  bloom: "apply",
  knowledgePoint: "kp1",
  options: [
    { id: "a", text: "$y=x^2$" },
    { id: "b", text: "$y=x^3$" },
  ],
  answer: "a",
});

describe("事件枚举（AGENTS.md §7：7 类事件不可擅自扩展）", () => {
  it("线上事件名有 8 个，类别有 7 个，终态占其一", () => {
    expect(SSE_EVENT_TYPES).toHaveLength(8);
    expect(new Set(SSE_EVENT_TYPES).size).toBe(8);
    expect(SSE_EVENT_CATEGORIES).toHaveLength(7);
    expect(new Set(SSE_EVENT_CATEGORIES).size).toBe(7);
  });

  it("每个线上事件名都能映射到类别，且只有终态事件映射到 terminal", () => {
    for (const type of SSE_EVENT_TYPES) {
      const category = eventCategory(type);
      expect(SSE_EVENT_CATEGORIES).toContain(category);
      const expected = (TERMINAL_EVENT_TYPES as readonly string[]).includes(type)
        ? "terminal"
        : type;
      expect(category).toBe(expected);
    }
  });

  it("心跳帧是 SSE 注释行，不是事件类型", () => {
    expect(isHeartbeatFrame(SSE_HEARTBEAT_FRAME)).toBe(true);
    expect(isHeartbeatFrame(": keep-alive")).toBe(true);
    expect(isHeartbeatFrame('{"type":"phase"}')).toBe(false);
    // 心跳不能被当成事件解析出来——这正是"不扩枚举"的运行时保证
    expect(parseSseDataLine(SSE_HEARTBEAT_FRAME).ok).toBe(false);
    expect(SSE_EVENT_TYPES as readonly string[]).not.toContain("heartbeat");
    expect(SSE_EVENT_TYPES as readonly string[]).not.toContain("ping");
  });

  it("终态判定只认 done / error", () => {
    const done = parseSseEvent({
      type: "done",
      seq: 9,
      versionId: "v1",
      stats: { fields: 3, errors: 0, repairs: 0, ms: 1200 },
    });
    const error = parseSseEvent({
      type: "error",
      seq: 9,
      code: "llm_timeout",
      message: "上游超时",
      retryable: true,
    });
    const phase = parseSseEvent({ type: "phase", seq: 1, phase: "generate", ts: 1_700_000_000_000 });

    expect(isTerminalEvent(done)).toBe(true);
    expect(isTerminalEvent(error)).toBe(true);
    expect(isTerminalEvent(phase)).toBe(false);
  });
});

describe("序号发放器（seq 从 1 开始、步长 1、单一写入者）", () => {
  it("按调用顺序发放 1..n", () => {
    const sequencer = createSseSequencer();
    const events: SseEvent[] = [];

    for (let i = 0; i < 5; i += 1) {
      events.push(sequencer.next({ type: "thinking", delta: `c${i}`, kind: "reasoning" }));
    }

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(sequencer.nextSeq).toBe(6);
  });

  it("允许指定起点（回放追加写事件时用）", () => {
    const sequencer = createSseSequencer(42);
    expect(sequencer.nextSeq).toBe(42);
    expect(sequencer.next({ type: "phase", phase: "plan", ts: 1 }).seq).toBe(42);
    expect(sequencer.nextSeq).toBe(43);
  });

  it("非法起点直接抛错，不静默纠正", () => {
    expect(() => createSseSequencer(0)).toThrow(/invalid SSE sequencer start/);
    expect(() => createSseSequencer(1.5)).toThrow(/invalid SSE sequencer start/);
    expect(() => createSseSequencer(-3)).toThrow(/invalid SSE sequencer start/);
  });

  it("发放前过一遍契约：不合法的载荷不会带着 seq 出去", () => {
    const sequencer = createSseSequencer();
    const badDone = {
      type: "done",
      versionId: "",
      stats: { fields: 0, errors: 0, repairs: 0, ms: 0 },
    } as unknown as SseEventBody;

    expect(() => sequencer.next(badDone)).toThrow();
    // 失败的那次不消耗序号：否则时间线上会出现空洞
    expect(sequencer.nextSeq).toBe(1);
    expect(sequencer.next({ type: "phase", phase: "done", ts: 0 }).seq).toBe(1);
  });
});

describe("编解码往返", () => {
  it("toSseFrame → 取 data 行 → parseSseDataLine，字段完全一致", () => {
    const event = parseSseEvent({
      type: "field",
      seq: 7,
      index: 0,
      node: validNode,
      tMs: 320,
    });

    const frame = toSseFrame(event);
    expect(frame.startsWith("event: field\n")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);

    const dataLine = frame
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice("data: ".length))[0];
    expect(dataLine).toBeDefined();

    const parsed = parseSseDataLine(dataLine ?? "");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.event).toEqual(event);
    }
  });

  it("toNdjsonLine 是单行 + 换行，且能原样解析回来", () => {
    const event = parseSseEvent({ type: "usage", seq: 3, promptTokens: 10, completionTokens: 20, ms: 900 });
    const line = toNdjsonLine(event);

    expect(line.endsWith("\n")).toBe(true);
    expect(line.trimEnd().includes("\n")).toBe(false);

    const parsed = parseSseDataLine(line);
    expect(parsed.ok && parsed.event).toEqual(event);
  });

  it("7 类事件都能编码成帧", () => {
    const bodies: SseEventBody[] = [
      { type: "phase", phase: "understand", ts: 0 },
      { type: "thinking", delta: "摘要", kind: "summary" },
      { type: "field", index: 0, node: validNode, tMs: 1 },
      { type: "field_error", index: 1, id: "q002", codes: ["E_ANSWER_MISSING"], raw: "{bad" },
      { type: "repair", id: "q002", round: 1, codesBefore: ["E_ANSWER_MISSING"], codesAfter: [], status: "fixed" },
      { type: "usage", promptTokens: 1, completionTokens: 2, ms: 3 },
      { type: "done", versionId: "v1", stats: { fields: 1, errors: 0, repairs: 0, ms: 10 } },
      { type: "error", code: "llm_cancelled", message: "已取消", retryable: false },
    ];

    const sequencer = createSseSequencer();
    const events = bodies.map((body) => sequencer.next(body));

    // 8 个线上事件 → 7 个类别
    expect(new Set(events.map((event) => eventCategory(event.type)))).toEqual(
      new Set(SSE_EVENT_CATEGORIES),
    );
    for (const event of events) {
      expect(parseSseFrameType(toSseFrame(event))).toBe(event.type);
    }
  });
});

describe("解析失败路径", () => {
  it("空串 / 非 JSON / 未知类型 / seq 越界 都被拒绝且不抛错", () => {
    expect(parseSseDataLine("   ")).toEqual({ ok: false, reason: "empty data" });

    const brokenJson = parseSseDataLine("{not json");
    expect(brokenJson.ok).toBe(false);
    if (!brokenJson.ok) expect(brokenJson.reason).toMatch(/^invalid JSON/);

    const unknownType = parseSseDataLine(JSON.stringify({ type: "heartbeat", seq: 1 }));
    expect(unknownType.ok).toBe(false);
    if (!unknownType.ok) expect(unknownType.reason).toContain("type");

    const zeroSeq = parseSseDataLine(
      JSON.stringify({ type: "phase", seq: 0, phase: "plan", ts: 0 }),
    );
    expect(zeroSeq.ok).toBe(false);

    const fractionalSeq = parseSseDataLine(
      JSON.stringify({ type: "phase", seq: 1.5, phase: "plan", ts: 0 }),
    );
    expect(fractionalSeq.ok).toBe(false);
  });

  it("error 事件必须带 retryable（前端据此决定是否显示重试）", () => {
    const missing = parseSseDataLine(
      JSON.stringify({ type: "error", seq: 2, code: "llm_upstream", message: "断流" }),
    );
    expect(missing.ok).toBe(false);
  });

  it("error.code 只接受枚举内的码，不接受自由字符串", () => {
    const parsed = parseSseDataLine(
      JSON.stringify({
        type: "error",
        seq: 2,
        code: "upstream 500: {\"error\":\"...\"}",
        message: "断流",
        retryable: true,
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("field_error.raw 超过 LIMITS.rawLineMax 时被拒绝", () => {
    const parsed = parseSseDataLine(
      JSON.stringify({
        type: "field_error",
        seq: 4,
        index: 0,
        id: "q001",
        codes: ["E_SCHEMA_SHAPE"],
        raw: "x".repeat(LIMITS.rawLineMax + 1),
      }),
    );
    expect(parsed.ok).toBe(false);

    const atLimit = parseSseDataLine(
      JSON.stringify({
        type: "field_error",
        seq: 4,
        index: 0,
        id: "q001",
        codes: ["E_SCHEMA_SHAPE"],
        raw: "x".repeat(LIMITS.rawLineMax),
      }),
    );
    expect(atLimit.ok).toBe(true);
  });

  it("safeParseSseEvent 与 parseSseEvent 行为一致（一个返回结果，一个抛错）", () => {
    const value = { type: "phase", seq: 1, phase: "generate", ts: 5 };
    expect(parseSseEvent(value)).toEqual(value);
    expect(safeParseSseEvent(value).success).toBe(true);
    expect(safeParseSseEvent({ type: "nope" }).success).toBe(false);
    expect(() => parseSseEvent({ type: "nope" })).toThrow();
  });
});

describe("field 节点的形状由 FormSchema 决定，契约不另立一套", () => {
  it("缺 options 的单选题被拒绝（说明 node 走的是 formItemSchema）", () => {
    const parsed = parseSseDataLine(
      JSON.stringify({
        type: "field",
        seq: 1,
        index: 0,
        node: { type: "single", id: "q001", title: "t", score: 5, bloom: "apply", knowledgePoint: "kp1", answer: "a" },
        tMs: 0,
      }),
    );
    expect(parsed.ok).toBe(false);
  });

  it("section 节点可以走同一个通道（结构节点不是题目，但有形状约束）", () => {
    const parsed = parseSseDataLine(
      JSON.stringify({
        type: "field",
        seq: 2,
        index: 0,
        node: { type: "section", id: "sec1", title: "第一部分" },
        tMs: 0,
      }),
    );
    expect(parsed.ok).toBe(true);
  });

  it("未知字段类型的 node 被拒绝", () => {
    const parsed = parseSseDataLine(
      JSON.stringify({
        type: "field",
        seq: 3,
        index: 0,
        node: { type: "matrix", id: "q009", title: "矩阵题" },
        tMs: 0,
      }),
    );
    expect(parsed.ok).toBe(false);
  });
});

/** 从帧里取出 `event:` 行的事件名，避免测试里重复写解析逻辑。 */
function parseSseFrameType(frame: string): string {
  const line = frame.split("\n").find((item) => item.startsWith("event: "));
  return line === undefined ? "" : line.slice("event: ".length);
}
