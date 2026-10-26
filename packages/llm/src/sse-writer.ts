/**
 * SSE 写出层：唯一给事件挂 `seq`、唯一写帧的地方。
 *
 * 三个契约点必须由它一个人负责（分散到路由里必然写错）：
 * 1. **序号单调且失败不占号**：`createSseSequencer().next()` 先按契约校验再自增，
 *    所以一份不合法的事件不会吃掉一个号（客户端按 seq 排序，跳号会被当成丢包）。
 * 2. **心跳是注释帧不是事件**：`SSE_HEARTBEAT_FRAME` 以 `:` 开头，`EventSource`
 *    会忽略它，也不占 `seq`。用真实事件当心跳会污染前端时间线。
 * 3. **终态只发一次**：无论生成器抛错、被取消还是正常结束，写出层保证流以一个
 *    `done` 或 `error` 收尾，然后立刻停止（之后再写会抛错，避免「迟到的 field」）。
 */

import {
  SSE_HEARTBEAT_FRAME,
  SSE_HEARTBEAT_INTERVAL_MS,
  createSseSequencer,
  isTerminalEvent,
  toSseFrame,
} from "@intentform/schema";
import type { SseEvent, SseEventBody, SseSequencer, SseTerminalEvent } from "@intentform/schema";

import { LlmError, toErrorEventBody } from "./errors.ts";

export interface TimerApi {
  readonly setInterval: (callback: () => void, ms: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

const nodeTimers: TimerApi = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

export interface SseWriterOptions {
  /** 真正把字符串交给 HTTP 响应的函数（`res.write`）。 */
  readonly write: (text: string) => void;
  /** 心跳间隔；`0` 关闭心跳（单测用）。默认 15s。 */
  readonly heartbeatMs?: number;
  readonly timers?: TimerApi;
  readonly onTerminal?: (event: SseTerminalEvent) => void;
}

export class SseEventWriter {
  readonly #sequencer: SseSequencer;

  readonly #write: (text: string) => void;

  readonly #timers: TimerApi;

  readonly #heartbeatMs: number;

  readonly #onTerminal: ((event: SseTerminalEvent) => void) | undefined;

  #timer: unknown = null;

  #closed = false;

  #heartbeats = 0;

  constructor(options: SseWriterOptions) {
    this.#sequencer = createSseSequencer();
    this.#write = options.write;
    this.#timers = options.timers ?? nodeTimers;
    this.#heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;
    this.#onTerminal = options.onTerminal;
  }

  /** 下一个将要发放的序号（= 已发事件数 + 1）。 */
  get nextSeq(): number {
    return this.#sequencer.nextSeq;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get heartbeats(): number {
    return this.#heartbeats;
  }

  /** 挂序号并写出。事件体不合法时改发 `internal` 终态，绝不把非法帧写出去。 */
  send(body: SseEventBody): SseEvent {
    if (this.#closed) {
      throw new LlmError("internal", "SSE 流已结束，不能再写事件", {
        detail: `late event type=${body.type}`,
      });
    }

    let event: SseEvent;
    try {
      event = this.#sequencer.next(body);
    } catch (error) {
      const fallback = this.#sequencer.next(
        toErrorEventBody(
          new LlmError("internal", "服务端生成的流式事件不合法，请重试", {
            detail: `invalid event body type=${body.type}: ${error instanceof Error ? error.message : String(error)}`,
          }),
        ),
      );
      this.#write(toSseFrame(fallback));
      if (isTerminalEvent(fallback)) this.#finish(fallback);
      return fallback;
    }

    this.#write(toSseFrame(event));
    if (isTerminalEvent(event)) this.#finish(event);
    return event;
  }

  /** 写一帧心跳。停表/已关闭时什么都不做。 */
  heartbeat(): void {
    if (this.#closed || this.#heartbeatMs <= 0) return;
    this.#heartbeats += 1;
    this.#write(SSE_HEARTBEAT_FRAME);
  }

  startHeartbeat(): void {
    if (this.#heartbeatMs <= 0 || this.#timer !== null || this.#closed) return;
    this.#timer = this.#timers.setInterval(() => {
      this.heartbeat();
    }, this.#heartbeatMs);
  }

  stopHeartbeat(): void {
    if (this.#timer === null) return;
    this.#timers.clearInterval(this.#timer);
    this.#timer = null;
  }

  /** 结束：停表并标记关闭。重复调用安全。 */
  close(): void {
    this.stopHeartbeat();
    this.#closed = true;
  }

  #finish(event: SseTerminalEvent): void {
    this.close();
    this.#onTerminal?.(event);
  }
}

/**
 * 把生成器产出的 body 序列写到客户端。
 *
 * 三条兜底：
 * - 生成器抛错 → 发 `error`（`toErrorEventBody` 已保证文案不含上游原始报文）；
 * - 生成器没发终态就结束 → 补一个 `internal`，否则客户端会一直等 `done`；
 * - 生成器发了终态后还想再发 → `SseEventWriter.send` 抛错，这里吞掉并停止读。
 */
export async function writeGeneration(
  writer: SseEventWriter,
  bodies: AsyncIterable<SseEventBody>,
): Promise<void> {
  writer.startHeartbeat();
  try {
    for await (const body of bodies) {
      if (writer.closed) break;
      writer.send(body);
    }
  } catch (error) {
    if (!writer.closed) {
      writer.send(toErrorEventBody(error));
    }
  } finally {
    if (!writer.closed) {
      writer.send(
        toErrorEventBody(
          new LlmError("internal", "生成在写出终态事件前中断，请重试", { detail: "stream ended without terminal" }),
        ),
      );
    }
    writer.stopHeartbeat();
  }
}
