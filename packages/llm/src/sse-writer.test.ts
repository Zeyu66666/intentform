import { describe, expect, it } from "vitest";

import { SSE_HEARTBEAT_FRAME, parseSseEvent } from "@intentform/schema";
import type { SseEventBody } from "@intentform/schema";

import { LlmError } from "./errors.ts";
import { SseEventWriter, type TimerApi, writeGeneration } from "./sse-writer.ts";

/** 假 timer：不真的等 15 秒，手动触发。 */
function fakeTimers(): TimerApi & { tick: () => void; intervals: number[]; cleared: unknown[] } {
  const callbacks = new Map<unknown, () => void>();
  const cleared: unknown[] = [];
  let handle = 0;
  return {
    intervals: [],
    cleared,
    setInterval(callback, ms) {
      handle += 1;
      callbacks.set(handle, callback);
      this.intervals.push(ms);
      return handle;
    },
    clearInterval(h) {
      callbacks.delete(h);
      cleared.push(h);
    },
    tick() {
      for (const callback of callbacks.values()) callback();
    },
  };
}

function frames(written: string[]): string[] {
  return written.join("").split("\n\n").filter((part) => part.trim() !== "");
}

/** 从 `event: x\ndata: {...}` 帧里取回事件对象（parseSseEvent 吃的是对象，不是帧文本）。 */
function eventOf(frame: string) {
  const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
  if (dataLine === undefined) throw new Error(`frame without data line: ${frame}`);
  return parseSseEvent(JSON.parse(dataLine.slice("data: ".length)));
}

const PHASE: SseEventBody = { type: "phase", phase: "understand", ts: 1_000 };
const DONE: SseEventBody = {
  type: "done",
  versionId: "v1",
  stats: { fields: 1, errors: 0, repairs: 0, ms: 10 },
};

describe("SseEventWriter", () => {
  it("seq 从 1 开始单调递增，帧能被 parseSseEvent 读回", () => {
    const written: string[] = [];
    const writer = new SseEventWriter({ write: (text) => written.push(text), heartbeatMs: 0 });
    writer.send(PHASE);
    writer.send({ type: "thinking", kind: "summary", delta: "嗯" });
    writer.send(DONE);
    expect(writer.nextSeq).toBe(4);
    const parsed = written.map((frame) => eventOf(frame));
    expect(parsed.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(parsed.at(-1)?.type).toBe("done");
  });

  it("心跳是注释帧：不占 seq、不被 parseSseEvent 当事件", () => {
    const written: string[] = [];
    const timers = fakeTimers();
    const writer = new SseEventWriter({ write: (text) => written.push(text), heartbeatMs: 15_000, timers });
    writer.startHeartbeat();
    expect(timers.intervals).toEqual([15_000]);
    timers.tick();
    timers.tick();
    expect(written).toEqual([SSE_HEARTBEAT_FRAME, SSE_HEARTBEAT_FRAME]);
    expect(writer.nextSeq).toBe(1);
    expect(SSE_HEARTBEAT_FRAME.startsWith(":")).toBe(true);
    expect(SSE_HEARTBEAT_FRAME.includes("data:")).toBe(false);
    writer.stopHeartbeat();
    expect(timers.cleared).toEqual([1]);
  });

  it("非法事件体不占号：改发 internal 终态并关闭流", () => {
    const written: string[] = [];
    const writer = new SseEventWriter({ write: (text) => written.push(text), heartbeatMs: 0 });
    const bogus = { type: "phase", phase: "bogus", ts: 1 } as unknown as SseEventBody;
    const emitted = writer.send(bogus);
    expect(emitted.type).toBe("error");
    expect(writer.closed).toBe(true);
    expect(writer.nextSeq).toBe(2);
    const parsed = eventOf(written[0] ?? "");
    expect(parsed).toMatchObject({ type: "error", seq: 1, code: "internal" });
  });

  it("终态之后任何写入都抛错（防止迟到的 field 污染时间线）", () => {
    const writer = new SseEventWriter({ write: () => {}, heartbeatMs: 0 });
    writer.send(DONE);
    expect(() => writer.send(PHASE)).toThrowError(LlmError);
  });

  it("生成器没发终态就结束 → 补一个 internal 终态", async () => {
    const written: string[] = [];
    const writer = new SseEventWriter({ write: (text) => written.push(text), heartbeatMs: 0 });
    async function* bodies(): AsyncGenerator<SseEventBody, void, undefined> {
      yield PHASE;
    }
    await writeGeneration(writer, bodies());
    const parsed = frames(written).map((frame) => eventOf(frame));
    expect(parsed.map((event) => event.type)).toEqual(["phase", "error"]);
    expect(parsed.at(-1)).toMatchObject({ code: "internal" });
  });

  it("生成器抛 LlmError → 发对应 error 终态，且文案不含上游报文", async () => {
    const written: string[] = [];
    const writer = new SseEventWriter({ write: (text) => written.push(text), heartbeatMs: 0 });
    async function* bodies(): AsyncGenerator<SseEventBody, void, undefined> {
      yield PHASE;
      throw new LlmError("llm_timeout", "上游模型在 60000 毫秒内没有返回完整结果，请重试", {
        detail: "timeout detail",
      });
    }
    await writeGeneration(writer, bodies());
    const last = eventOf(frames(written).at(-1) ?? "");
    expect(last).toMatchObject({ type: "error", code: "llm_timeout", retryable: true });
  });
});
