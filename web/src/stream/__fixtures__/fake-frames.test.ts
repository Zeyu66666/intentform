import { SSE_EVENT_CATEGORIES } from "@intentform/schema";
import { describe, expect, it } from "vitest";

import { parseSseFrame, createSseFrameParser } from "../frames";
import { FIXTURE_CHUNKS, FIXTURE_FRAMES, FIXTURE_ITEMS, disorderedFrames } from "./fake-frames";

describe("假帧 · 覆盖度", () => {
  const parsed = FIXTURE_FRAMES.map(parseSseFrame);
  const events = parsed.flatMap((frame) => (frame.kind === "event" ? [frame.event] : []));

  it("每一帧都能被解析：没有 malformed（假数据本身必须合法）", () => {
    const malformed = parsed.filter((frame) => frame.kind === "malformed");
    expect(malformed).toEqual([]);
  });

  it("7 类事件全覆盖（phase/thinking/field/field_error/repair/usage/terminal）", () => {
    const categories = new Set(events.map((event) => (event.type === "done" || event.type === "error" ? "terminal" : event.type)));
    for (const category of SSE_EVENT_CATEGORIES) {
      expect(categories.has(category)).toBe(true);
    }
    expect(SSE_EVENT_CATEGORIES).toHaveLength(7);
  });

  it("混入心跳注释帧，且心跳不被当事件", () => {
    const heartbeats = parsed.filter((frame) => frame.kind === "heartbeat");
    expect(heartbeats).toHaveLength(2);
  });

  it("seq 从 1 开始、步长 1（与真实服务端一致）", () => {
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
  });

  it("7 种题型全部出现在 field 事件里", () => {
    const types = events.flatMap((event) => (event.type === "field" ? [event.node.type] : []));
    expect(new Set(types)).toEqual(
      new Set(["section", "single", "multi", "number", "fill", "short", "scale"]),
    );
  });

  it("FIXTURE_ITEMS 与 field 事件里的节点一一对应", () => {
    const nodes = events.flatMap((event) => (event.type === "field" ? [event.node.id] : []));
    expect(nodes).toEqual(FIXTURE_ITEMS.map((item) => item.id));
  });
});

describe("假帧 · 分块", () => {
  it("chunk 拼回去等于原始帧文本（切分无丢失）", () => {
    expect(FIXTURE_CHUNKS.join("")).toBe(FIXTURE_FRAMES.join(""));
  });

  it("chunk 数明显多于帧数：帧边界确实跨了 chunk", () => {
    expect(FIXTURE_CHUNKS.length).toBeGreaterThan(FIXTURE_FRAMES.length);
  });

  it("逐 chunk 喂给帧解析器，得到的事件数与按帧解析一致", () => {
    const parser = createSseFrameParser();
    const fromChunks = FIXTURE_CHUNKS.flatMap((chunk) => parser.push(chunk)).concat(parser.flush());
    const eventsFromChunks = fromChunks.filter((frame) => frame.kind === "event");
    const eventsFromFrames = FIXTURE_FRAMES.map(parseSseFrame).filter(
      (frame) => frame.kind === "event",
    );
    expect(eventsFromChunks).toHaveLength(eventsFromFrames.length);
  });
});

describe("disorderedFrames", () => {
  it("头部两帧构成 1 → 3 的缺口，用来演示乱序容错", () => {
    const frames = disorderedFrames();
    const seqs = frames.map((frame) => {
      const parsed = parseSseFrame(frame);
      return parsed.kind === "event" ? parsed.event.seq : -1;
    });
    expect(seqs).toEqual([1, 3, 2]);
  });
});
