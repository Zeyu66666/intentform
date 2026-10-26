import { describe, expect, it } from "vitest";

import { createSseFrameParser, parseSseFrame, splitSseFrames } from "./frames";

const PHASE_FRAME =
  'event: phase\ndata: {"type":"phase","seq":1,"phase":"understand","ts":1734000000000}\n\n';

const FIELD_FRAME =
  'event: field\ndata: {"type":"field","seq":2,"index":0,"node":{"type":"section","id":"sec-basic","title":"一、基础概念"},"tMs":120}\n\n';

describe("splitSseFrames", () => {
  it("按空行切帧，残留留给下一块 chunk", () => {
    const result = splitSseFrames(`${PHASE_FRAME}data: {"type":"pha`);
    expect(result.frames).toHaveLength(1);
    expect(result.rest).toBe('data: {"type":"pha');
  });

  it("一次 chunk 里有多帧时全部切出", () => {
    const result = splitSseFrames(`${PHASE_FRAME}${FIELD_FRAME}`);
    expect(result.frames).toHaveLength(2);
    expect(result.rest).toBe("");
  });

  it("兼容 \\r\\n 行结束符（某些代理会改写）", () => {
    const crlf = "event: phase\r\ndata: {\"type\":\"phase\",\"seq\":1,\"phase\":\"plan\",\"ts\":1}\r\n\r\n";
    const result = splitSseFrames(crlf);
    expect(result.frames).toHaveLength(1);
    expect(result.rest).toBe("");
  });

  it("没有空行时不出帧", () => {
    const result = splitSseFrames("event: phase\ndata: {}\n");
    expect(result.frames).toHaveLength(0);
  });
});

describe("parseSseFrame", () => {
  it("解析出带类型的合法事件", () => {
    const parsed = parseSseFrame(PHASE_FRAME);
    expect(parsed.kind).toBe("event");
    if (parsed.kind !== "event") throw new Error("unreachable");
    expect(parsed.event.type).toBe("phase");
    expect(parsed.event.seq).toBe(1);
  });

  it("心跳注释帧不算事件（不扩事件枚举）", () => {
    expect(parseSseFrame(": ping")).toEqual({ kind: "heartbeat" });
    expect(parseSseFrame(": ping\n: keep-alive")).toEqual({ kind: "heartbeat" });
    expect(parseSseFrame("")).toEqual({ kind: "heartbeat" });
  });

  it("漏发 event: 行也能解析：类型事实来自 payload 的 type", () => {
    const frame = 'data: {"type":"usage","seq":9,"promptTokens":1,"completionTokens":2,"ms":3}';
    const parsed = parseSseFrame(frame);
    expect(parsed.kind).toBe("event");
    if (parsed.kind !== "event") throw new Error("unreachable");
    expect(parsed.event.type).toBe("usage");
  });

  it("多行 data 按规范用换行拼接", () => {
    const frame = 'data: {"type":"phase",\ndata: "seq":1,"phase":"plan","ts":7}';
    const parsed = parseSseFrame(frame);
    expect(parsed.kind).toBe("event");
    if (parsed.kind !== "event") throw new Error("unreachable");
    expect(parsed.event.type).toBe("phase");
  });

  it("坏 JSON 变成 malformed，不抛错（坏帧不能打断整条流）", () => {
    const parsed = parseSseFrame('data: {"type":"phase",');
    expect(parsed.kind).toBe("malformed");
    if (parsed.kind !== "malformed") throw new Error("unreachable");
    expect(parsed.reason).toContain("invalid JSON");
  });

  it("合法 JSON 但不符合契约也是 malformed", () => {
    const parsed = parseSseFrame('data: {"type":"field","seq":1}');
    expect(parsed.kind).toBe("malformed");
    if (parsed.kind !== "malformed") throw new Error("unreachable");
    expect(parsed.reason.length).toBeGreaterThan(0);
  });

  it("未知字段名被忽略（SSE 规范）", () => {
    const parsed = parseSseFrame(`id: 42\nretry: 100\ncomment: whatever\n${PHASE_FRAME.trim()}`);
    expect(parsed.kind).toBe("event");
  });
});

describe("createSseFrameParser", () => {
  it("一帧被切成两块 chunk 时仍能解析（最常见的流式 bug）", () => {
    const parser = createSseFrameParser();
    const half = Math.floor(PHASE_FRAME.length / 2);

    const first = parser.push(PHASE_FRAME.slice(0, half));
    const second = parser.push(PHASE_FRAME.slice(half));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
    expect(second[0]?.kind).toBe("event");
  });

  it("逐字符喂进去也不丢事件", () => {
    const parser = createSseFrameParser();
    const frames = [...PHASE_FRAME].flatMap((char) => parser.push(char));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe("event");
  });

  it("flush 收尾能吐出没有结尾空行的最后一帧", () => {
    const parser = createSseFrameParser();
    parser.push('data: {"type":"phase","seq":3,"phase":"done","ts":9}');
    const flushed = parser.flush();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.kind).toBe("event");
  });

  it("flush 后缓冲区清空，不会重复吐帧", () => {
    const parser = createSseFrameParser();
    parser.push(`${PHASE_FRAME}`);
    expect(parser.flush()).toHaveLength(0);
  });

  it("心跳与事件混在同一个 chunk 里：心跳被跳过", () => {
    const parser = createSseFrameParser();
    const parsed = parser.push(`${": ping\n\n"}${PHASE_FRAME}`);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.kind).toBe("heartbeat");
    expect(parsed[1]?.kind).toBe("event");
  });
});
