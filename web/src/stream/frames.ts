/**
 * SSE 帧拆分与解析（纯函数，可单测）。
 *
 * 为什么手写而不是 `EventSource`：`POST /api/generate` 的请求体里带 `requirement`，
 * 而 `EventSource` 只能发 GET 且不能带请求体。所以整条链路拆成两段：
 *
 * - `source.ts`：网络（`fetch` + `response.body.getReader()` + `TextDecoder`）；
 * - 本文件：把**已解码的字符串流**切成 SSE 帧，再把帧交给 `@intentform/schema`
 *   的 `parseSseDataLine` 校验成 `SseEvent`。
 *
 * 拆开的好处是帧边界（chunk 截断）与协议解析可以脱离网络单测——网络那一层的
 * 失败很难在 CI 里稳定复现，而"一帧被切成两半"是最常见的流式 bug。
 *
 * 三条约定（对应 `packages/schema/src/sse-events.ts`）：
 * 1. 帧以空行结束（`\n\n`，也容忍 `\r\n\r\n` / `\r\r`）；
 * 2. `:` 开头的是心跳注释行，**不是事件**，不扩事件枚举；
 * 3. 事件的类型以 `data:` 载荷里的 `type` 为准，`event:` 行只是协作信息。
 */

import { isHeartbeatFrame, parseSseDataLine, type SseEvent } from "@intentform/schema";

/** 一帧的解析结果。`malformed` 不抛错：坏帧要在时间线上可见，而不是打断整条流。 */
export type ParsedFrame =
  | { readonly kind: "heartbeat" }
  | { readonly kind: "event"; readonly event: SseEvent }
  | { readonly kind: "malformed"; readonly reason: string; readonly frame: string };

export interface SplitResult {
  /** 已完整的帧（不含分隔空行）。 */
  readonly frames: readonly string[];
  /** 尚未收到结尾空行的残留，下一块 chunk 拼在它后面。 */
  readonly rest: string;
}

/**
 * 帧分隔符。SSE 规范允许 `\r\n` / `\n` / `\r` 三种行结束符，
 * 交替顺序很重要：`\r\n\r\n` 必须排在 `\r\r` 之前，否则会被拆错。
 */
const FRAME_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;

/** 从缓冲区里切出所有完整帧，返回帧数组与剩余未完成的部分。 */
export function splitSseFrames(buffer: string): SplitResult {
  const frames: string[] = [];
  let rest = buffer;

  for (;;) {
    const match = FRAME_BOUNDARY.exec(rest);
    if (match === null) break;
    frames.push(rest.slice(0, match.index));
    rest = rest.slice(match.index + match[0].length);
  }

  return { frames, rest };
}

/**
 * 解析单帧。
 *
 * 没有任何 `data:` 行的帧（心跳、或空帧）归为 `heartbeat`——调用方一律忽略，
 * 不产生时间线条目，也不污染 `seq` 统计。
 */
export function parseSseFrame(frame: string): ParsedFrame {
  const dataLines: string[] = [];
  const lines = frame.split(/\r\n|\r|\n/);

  for (const line of lines) {
    if (line === "") continue;
    if (isHeartbeatFrame(line)) continue;

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    // 规范：冒号后若紧跟一个空格，该空格属于格式而不是值。
    const rawValue = colon === -1 ? "" : line.slice(colon + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;

    switch (field) {
      case "data":
        dataLines.push(value);
        break;
      // `event:` / `id:` / `retry:` 不参与判定：类型事实来自 payload 的 `type` 字段，
      // 这样即使服务端漏发 `event:` 行，前端也不会把事件当成未知类型丢掉。
      case "event":
      case "id":
      case "retry":
        break;
      default:
        // SSE 规范要求忽略未知字段，这里保持一致。
        break;
    }
  }

  if (dataLines.length === 0) return { kind: "heartbeat" };

  const parsed = parseSseDataLine(dataLines.join("\n"));
  if (!parsed.ok) return { kind: "malformed", reason: parsed.reason, frame };

  return { kind: "event", event: parsed.event };
}

export interface SseFrameParser {
  /** 追加一块 chunk，返回这块钱能凑出的所有帧的解析结果。 */
  push(chunk: string): readonly ParsedFrame[];
  /** 流结束时收尾：把缓冲区里的残留当作最后一帧解析。 */
  flush(): readonly ParsedFrame[];
}

/** 有状态的帧解析器：跨 chunk 维护缓冲区，这是"帧被切开"的唯一正确解法。 */
export function createSseFrameParser(): SseFrameParser {
  let buffer = "";

  return {
    push(chunk: string): readonly ParsedFrame[] {
      buffer += chunk;
      const { frames, rest } = splitSseFrames(buffer);
      buffer = rest;
      return frames.map(parseSseFrame);
    },
    flush(): readonly ParsedFrame[] {
      const remainder = buffer.trim();
      buffer = "";
      if (remainder === "") return [];
      return [parseSseFrame(remainder)];
    },
  };
}
