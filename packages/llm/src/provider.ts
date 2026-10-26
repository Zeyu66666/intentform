/**
 * OpenAI 兼容 `/chat/completions` 客户端（零依赖，只用手工 SSE 解析）。
 *
 * 为什么不用 SDK：SDK 的流式事件抽象会吞掉「上游到底发了什么」的证据，而这个项目
 * 的关键需求恰好是「把 delta 原文按字节流转发、落盘、可重放」。自己解析三层结构
 * （HTTP 字节流 → NDJSON 行 → SSE 帧）才可能在任意切点上做对。
 *
 * 本文件只做「上游 → 事件」的翻译，不碰语义（NDJSON 校验在 generate.ts）。
 */

import { LlmError, redactSecrets, truncate } from "./errors.ts";
import { asRecord, readArray, readNumber, readString, tryParseJson } from "./json.ts";
import { LineSplitter } from "./line-splitter.ts";

export interface ChatMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

/** 上游事件：`thinking` 与 `field` 的分流就发生在这一层，不是靠猜 payload。 */
export type UpstreamEvent =
  | { readonly kind: "reasoning"; readonly delta: string }
  | { readonly kind: "content"; readonly delta: string }
  | { readonly kind: "usage"; readonly usage: TokenUsage };

export interface FetchInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

export type FetchLike = (url: string, init: FetchInit) => Promise<Response>;

export interface ProviderConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** 整条流的最长存活时间（含首包）。 */
  readonly timeoutMs: number;
  readonly maxTokens: number;
  readonly temperature: number;
  /** DeepSeek 支持 `seed`；其它兼容实现可能不认，null 表示不发送。 */
  readonly seed: number | null;
  readonly fetchImpl?: FetchLike;
}

export interface StreamChatOptions {
  readonly signal?: AbortSignal;
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** `baseUrl` 允许带或不带结尾斜杠，也允许已经写到 `/v1`。 */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return `${trimmed}/chat/completions`;
}

export function buildChatRequestBody(
  config: Pick<ProviderConfig, "model" | "maxTokens" | "temperature" | "seed">,
  messages: readonly ChatMessage[],
): Record<string, unknown> {
  return {
    model: config.model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    stream: true,
    stream_options: { include_usage: true },
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    ...(config.seed === null ? {} : { seed: config.seed }),
  };
}

type ParsedFrame =
  | { readonly kind: "done" }
  | { readonly kind: "empty" }
  | { readonly kind: "events"; readonly events: readonly UpstreamEvent[] };

/**
 * 解析一个 SSE 帧的 `data` 负载。
 *
 * `[DONE]` 之外的一切都必须是 JSON；解析不出来就判上游故障（`llm_upstream`），
 * 而不是当成空帧跳过 —— 静默跳过会让「流被截断」表现为「模型少生成了几题」，极难排查。
 */
export function parseUpstreamFrame(payload: string): ParsedFrame {
  const trimmed = payload.trim();
  if (trimmed === "") return { kind: "empty" };
  if (trimmed === "[DONE]") return { kind: "done" };

  const parsed = tryParseJson(trimmed);
  if (!parsed.ok) {
    throw new LlmError("llm_upstream", "上游返回了无法解析的数据帧，请重试", {
      detail: `invalid JSON frame: ${truncate(trimmed, 400)}`,
    });
  }
  const record = asRecord(parsed.value);
  if (record === undefined) {
    throw new LlmError("llm_upstream", "上游返回了非对象数据帧，请重试", {
      detail: `non-object frame: ${truncate(trimmed, 400)}`,
    });
  }

  const upstreamError = asRecord(record["error"]);
  if (upstreamError !== undefined) {
    const upstreamMessage = readString(upstreamError, "message") ?? "unknown";
    throw new LlmError("llm_upstream", "上游模型返回错误，请稍后重试", {
      detail: `upstream error: ${truncate(upstreamMessage, 400)}`,
    });
  }

  const events: UpstreamEvent[] = [];
  const choices = readArray(record, "choices");
  const firstChoice = choices === undefined ? undefined : asRecord(choices[0]);
  const delta = firstChoice === undefined ? undefined : asRecord(firstChoice["delta"]);
  if (delta !== undefined) {
    const reasoning = readString(delta, "reasoning_content") ?? readString(delta, "reasoning");
    if (reasoning !== undefined && reasoning !== "") {
      events.push({ kind: "reasoning", delta: reasoning });
    }
    const content = readString(delta, "content");
    if (content !== undefined && content !== "") {
      events.push({ kind: "content", delta: content });
    }
  }

  const usage = asRecord(record["usage"]);
  if (usage !== undefined) {
    const promptTokens = readNumber(usage, "prompt_tokens") ?? 0;
    const completionTokens = readNumber(usage, "completion_tokens") ?? 0;
    events.push({
      kind: "usage",
      usage: {
        promptTokens: toTokenCount(promptTokens),
        completionTokens: toTokenCount(completionTokens),
      },
    });
  }

  return events.length === 0 ? { kind: "empty" } : { kind: "events", events };
}

function toTokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

/** 把上游 SSE 行组装成帧：`data:` 可以多行，空行分发，注释行（心跳）忽略。 */
class SseFrameCollector {
  #data: string[] = [];
  readonly #onFrame: (payload: string) => void;

  constructor(onFrame: (payload: string) => void) {
    this.#onFrame = onFrame;
  }

  push(line: string): void {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.#data.push(value);
  }

  dispatch(): void {
    if (this.#data.length === 0) return;
    const payload = this.#data.join("\n");
    this.#data = [];
    this.#onFrame(payload);
  }
}

interface AbortState {
  timedOut: boolean;
  cancelled: boolean;
}

/**
 * 流式请求上游。产出 `UpstreamEvent`，异常一律是 `LlmError`
 * （SWR 搬到别的库会丢掉 `code`，所以这里不 try/catch 成泛化 Error）。
 */
export async function* streamChatCompletion(
  config: ProviderConfig,
  messages: readonly ChatMessage[],
  options: StreamChatOptions = {},
): AsyncGenerator<UpstreamEvent, void, undefined> {
  const fetchImpl: FetchLike = config.fetchImpl ?? defaultFetch;
  const external = options.signal;
  if (external?.aborted === true) {
    throw new LlmError("llm_cancelled", "生成已被取消", { detail: "signal already aborted" });
  }

  const controller = new AbortController();
  const state: AbortState = { timedOut: false, cancelled: false };
  const onExternalAbort = (): void => {
    state.cancelled = true;
    controller.abort();
  };
  external?.addEventListener("abort", onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    state.timedOut = true;
    controller.abort();
  }, config.timeoutMs);

  const cleanup = (): void => {
    clearTimeout(timer);
    external?.removeEventListener("abort", onExternalAbort);
  };

  let response: Response;
  try {
    response = await fetchImpl(chatCompletionsUrl(config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(buildChatRequestBody(config, messages)),
      signal: controller.signal,
    });
  } catch (error) {
    cleanup();
    throw toUpstreamError(error, state, config.timeoutMs, config.apiKey);
  }

  if (!response.ok) {
    const snippet = await readSnippet(response);
    cleanup();
    throw new LlmError("llm_upstream", `上游模型返回 HTTP ${String(response.status)}，请稍后重试`, {
      detail: `status=${String(response.status)} body=${redactSecrets(snippet, [config.apiKey])}`,
    });
  }

  const body = response.body;
  if (body === null) {
    cleanup();
    throw new LlmError("llm_upstream", "上游响应没有响应体", { detail: "empty body" });
  }

  const reader = body.getReader();
  const splitter = new LineSplitter({ keepEmptyLines: true });
  const pending: UpstreamEvent[] = [];
  let sawDone = false;
  const collector = new SseFrameCollector((payload: string) => {
    const frame = parseUpstreamFrame(payload);
    if (frame.kind === "done") {
      sawDone = true;
      return;
    }
    if (frame.kind === "events") {
      for (const event of frame.events) pending.push(event);
    }
  });

  try {
    for (;;) {
      const step = await reader.read();
      if (step.done) {
        for (const line of splitter.flush()) collector.push(line);
        collector.dispatch();
      } else if (step.value !== undefined) {
        for (const line of splitter.push(step.value)) collector.push(line);
      }
      for (const event of pending) yield event;
      pending.length = 0;
      if (step.done) break;
      if (sawDone) break;
    }
  } catch (error) {
    throw toUpstreamError(error, state, config.timeoutMs, config.apiKey);
  } finally {
    cleanup();
    try {
      await reader.cancel();
    } catch {
      // 上游已经关闭，取消失败不影响结果。
    }
  }
}

async function readSnippet(response: Response): Promise<string> {
  try {
    return redactSecrets(truncate(await response.text(), 800), []);
  } catch {
    return "";
  }
}

function toUpstreamError(
  error: unknown,
  state: AbortState,
  timeoutMs: number,
  apiKey: string,
): LlmError {
  if (error instanceof LlmError) return error;
  if (state.timedOut) {
    return new LlmError(
      "llm_timeout",
      `上游模型在 ${String(timeoutMs)} 毫秒内没有返回完整结果，请重试`,
      { detail: `timeout after ${String(timeoutMs)}ms`, cause: error },
    );
  }
  if (state.cancelled) {
    return new LlmError("llm_cancelled", "生成已被取消", { detail: "aborted by caller", cause: error });
  }
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return new LlmError("llm_upstream", "与上游模型的连接中断，请重试", {
    detail: redactSecrets(truncate(message, 800), [apiKey]),
    cause: error,
  });
}
