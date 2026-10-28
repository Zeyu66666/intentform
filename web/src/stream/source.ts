/**
 * 生成链路的数据源（可注入）。
 *
 * 为什么要把"网络"抽成一个 `AsyncIterable<string>`：
 *
 * - `/api/generate` 是 **POST**（请求体 `{ requirement }`），`EventSource` 只能发 GET
 *   且无法带请求体，所以必须手写 `fetch` + `response.body.getReader()`；
 * - 后端 I2 与本屏并行开发，开发期用假帧数组（`__fixtures__/fake-frames.ts`）
 *   就能把 reducer / 时间线 / 渲染全部走通，不必等接口；
 * - 测试里注入假源即可覆盖"帧被切成两半""非 2xx""响应体为空"等分支，
 *   这些分支用真实网络很难稳定复现。
 *
 * 生产实现 `createFetchStreamSource` 只做三件事：发请求、把字节流解码成字符串流、
 * **在退出时释放 reader**（`finally` 里 `reader.cancel()`，否则 abort 时连接会悬挂）。
 */

import type { Clarification, SseErrorCode } from "@intentform/schema";

import { createTextStreamDecoder } from "./decode";

export interface GenerateRequest {
  readonly requirement: string;
  /**
   * 澄清补答（省赛 R-05）。缺省或空数组时**不进请求体**：
   * 服务端把「有没有补充」当作两条路径，请求体形状不同，回放键才不会漂。
   */
  readonly clarifications?: readonly Clarification[];
  /** 取消信号。取消按钮 → `controller.abort()` → `reader.read()` 抛 AbortError。 */
  readonly signal: AbortSignal;
}

/** 产出一块块**原始帧文本**（不是事件）：帧解析在 `frames.ts`，与网络解耦。 */
export type StreamSource = (request: GenerateRequest) => AsyncIterable<string>;

/** 传输层错误。码表与 SSE 终态一致，界面文案因此可以只维护一份。 */
export class GenerateStreamError extends Error {
  readonly code: SseErrorCode;

  constructor(code: SseErrorCode, message: string) {
    super(message);
    this.name = "GenerateStreamError";
    this.code = code;
  }
}

export interface FetchStreamSourceOptions {
  /** 同源 API 基址，来自 `resolveApiBase()`（默认 `/api`）。 */
  readonly apiBase: string;
  /** 端点名，默认 `/generate`。 */
  readonly endpoint?: string;
  /** 注入点：测试与"换一个 fetch 实现"都从这里进。 */
  readonly fetchImpl?: typeof fetch;
  /**
   * 上游模式回执（`x-intentform-llm-mode` 响应头）。
   *
   * 《计划 v3.0》§2.6 要求界面始终能分清 live / replay / mock：回放和真实上游在
   * 事件流上长得一模一样，看不出差别，而"演示时以为在调模型、其实在播录像"是
   * 评审现场最容易翻车的地方。模式只在服务端知道，所以由服务端把它放响应头，
   * 这一层负责把它交给界面——不进 SSE 事件，避免改动冻结的事件契约。
   */
  readonly onUpstreamMode?: (mode: string) => void;
}

function joinUrl(apiBase: string, endpoint: string): string {
  const base = apiBase.replace(/\/+$/, "");
  return `${base === "" ? "" : base}${endpoint}`;
}

/**
 * 生产数据源：`POST ${apiBase}/generate` → `text/event-stream`。
 *
 * 只带 `Content-Type` 与 `Accept`：前端零 Key（`AGENTS.md` §5），鉴权走同源
 * session cookie（I4），所以这里刻意不出现任何 `Authorization` 头。
 */
export function createFetchStreamSource(options: FetchStreamSourceOptions): StreamSource {
  const url = joinUrl(options.apiBase, options.endpoint ?? "/generate");
  const doFetch = options.fetchImpl ?? fetch;

  return async function* fetchStream(request: GenerateRequest): AsyncIterable<string> {
    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(
        request.clarifications === undefined || request.clarifications.length === 0
          ? { requirement: request.requirement }
          : { requirement: request.requirement, clarifications: request.clarifications },
      ),
      signal: request.signal,
      credentials: "same-origin",
    });

    if (!response.ok) {
      throw new GenerateStreamError(
        "llm_upstream",
        `生成服务返回 ${response.status} ${response.statusText}`.trim(),
      );
    }
    if (response.body === null) {
      throw new GenerateStreamError("llm_upstream", "生成服务返回了空响应体");
    }

    // 头缺失（例如中间层把它剥掉）时不上报，界面显示"未知"，而不是编一个模式。
    const upstreamMode = response.headers.get("x-intentform-llm-mode");
    if (upstreamMode !== null && options.onUpstreamMode !== undefined) {
      options.onUpstreamMode(upstreamMode);
    }

    const reader = response.body.getReader();
    const decoder = createTextStreamDecoder();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value === undefined) continue;
        const text = decoder.push(value);
        if (text !== "") yield text;
      }
      const tail = decoder.flush();
      if (tail !== "") yield tail;
    } finally {
      // 无论正常结束、抛错还是被 abort，都必须释放 reader：
      // 不释放会让浏览器一直挂着这条连接（取消按钮就变成"假取消"）。
      // `cancel()` 只关流、不解除锁，所以还要 `releaseLock()`——这两个动作少了任何一个
      // 都算泄漏，`source.test.ts` 里对"锁已释放"做了断言。
      try {
        await reader.cancel();
      } catch {
        // 已 abort 的流上 cancel 会拒绝，这是预期的，无需上报。
      }
      try {
        reader.releaseLock();
      } catch {
        // 锁已被释放过：幂等收尾。
      }
    }
  };
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortError";
  }
}

/** 与 `AbortError` 同形的错误：`fetch` 抛 DOMException，假源抛这个，上层只认 `name`。 */
export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";
}

function waitForDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new AbortedError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface FixtureStreamOptions {
  /** 每块之间的间隔，用来模拟真实流式的节奏；测试里传 0。 */
  readonly delayMs?: number;
}

/**
 * 开发期数据源：把假帧数组按节奏吐出来，**不是**真实生成。
 *
 * 调用方必须在界面上标明「演示数据」，`AGENTS.md` §7 明确禁止静默假装成真实生成。
 */
export function createFixtureStreamSource(
  chunks: readonly string[],
  options: FixtureStreamOptions = {},
): StreamSource {
  const delayMs = options.delayMs ?? 40;

  return async function* fixtureStream(request: GenerateRequest): AsyncIterable<string> {
    for (const chunk of chunks) {
      if (request.signal.aborted) throw new AbortedError();
      await waitForDelay(delayMs, request.signal);
      if (request.signal.aborted) throw new AbortedError();
      yield chunk;
    }
  };
}

export type StreamMode = "live" | "fixture";

/**
 * 选数据源：只在 dev 下允许 `?stream=fixture` 切到假帧。
 *
 * 生产构建永远 `live`——演示数据能进生产，就等于允许界面在无后端时假装成功。
 */
export function selectStreamMode(search: string, isDev: boolean): StreamMode {
  if (!isDev) return "live";
  const params = new URLSearchParams(search);
  return params.get("stream") === "fixture" ? "fixture" : "live";
}
