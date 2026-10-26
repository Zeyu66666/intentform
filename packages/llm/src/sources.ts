/**
 * 四种生成来源：`live` / `record` / `replay` / `mock`，统一成同一个 `DeltaSource`。
 *
 * 这样做的理由只有一个：**下游（generate.ts）不知道也不允许知道当前是哪种模式**。
 * 否则「回放路径少校验一次」「mock 少发一个 usage」这类分叉会不断长出来，而它们
 * 正是评审最容易抓到的「演示走的路和文档写的不一样」。
 *
 * 唯一必须区分的差异是**持久化**：只有 `record` 往 `fixtures/replays/` 写文件。
 */

import { createFixtureMeta, readFixture, writeFixture } from "./fixtures.ts";
import type { FixtureChunk, WriteFixtureResult } from "./fixtures.ts";
import { LlmError } from "./errors.ts";
import type { LlmRuntimeConfig, ReplaySpeed } from "./config.ts";
import type { FetchLike, ProviderConfig, TokenUsage } from "./provider.ts";
import { streamChatCompletion } from "./provider.ts";
import { buildMessages } from "./prompt.ts";
import { replayKey } from "./replay-key.ts";
import { SCHEMA_VERSION } from "@intentform/schema";

export type SourceLabel = "live" | "record" | "replay" | "mock";

export interface ContentDelta {
  readonly kind: "content";
  readonly delta: string;
  /** 相对本次生成开始的毫秒数。 */
  readonly tMs: number;
}

export interface UsageDelta {
  readonly kind: "usage";
  readonly usage: TokenUsage;
  readonly tMs: number;
}

export type SourceDelta = ContentDelta | UsageDelta;

export interface StreamInput {
  readonly requirement: string;
  readonly signal?: AbortSignal;
  /** 本次生成开始的时间戳（`clock()`），用于算 `tMs`。 */
  readonly startedAt: number;
}

export interface DeltaSource {
  readonly label: SourceLabel;
  stream(input: StreamInput): AsyncGenerator<SourceDelta, void, undefined>;
}

export type Clock = () => number;

/** 可被 `AbortSignal` 打断的 sleep。信号已中止时立刻抛 `llm_cancelled`。 */
function sleep(ms: number, signal: AbortSignal | undefined, clock: Clock): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted === true) {
      return Promise.reject(new LlmError("llm_cancelled", "生成已被取消", { detail: "aborted in sleep" }));
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new LlmError("llm_cancelled", "生成已被取消", { detail: "aborted in sleep" }));
    };
    if (signal?.aborted === true) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    void clock;
  });
}

function providerConfigOf(config: LlmRuntimeConfig, fetchImpl: FetchLike | undefined): ProviderConfig {
  if (config.apiKey === null) {
    throw new LlmError("llm_config", `${config.mode} 模式需要 LLM_API_KEY`, {
      detail: "apiKey is null",
    });
  }
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: config.timeoutMs,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
    seed: config.seed,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  };
}

export interface LiveSourceOptions {
  readonly fetchImpl?: FetchLike;
  readonly clock?: Clock;
}

/** `live`：真实上游，逐块转发，什么都不落盘。 */
export function createLiveSource(
  config: LlmRuntimeConfig,
  options: LiveSourceOptions = {},
): DeltaSource {
  const clock = options.clock ?? Date.now;
  const providerConfig = providerConfigOf(config, options.fetchImpl);

  return {
    label: "live",
    async *stream(input: StreamInput): AsyncGenerator<SourceDelta, void, undefined> {
      const messages = buildMessages(input.requirement, config.promptVersion);
      const streamOptions = input.signal === undefined ? {} : { signal: input.signal };
      for await (const event of streamChatCompletion(providerConfig, messages, streamOptions)) {
        const tMs = Math.max(0, Math.round(clock() - input.startedAt));
        if (event.kind === "content") yield { kind: "content", delta: event.delta, tMs };
        else if (event.kind === "reasoning") {
          // 思考原文对外只发 `thinking`，由 generate.ts 决定发不发；这里先不透传，
          // 避免把 reasoning 混进 NDJSON 管线（它会破坏逐行 JSON 的前提）。
        } else yield { kind: "usage", usage: event.usage, tMs };
      }
    },
  };
}

export interface RecordSourceOptions extends LiveSourceOptions {
  readonly onRecorded?: (result: WriteFixtureResult) => void;
}

/**
 * `record`：真实上游 + 边转发边收集 chunk，流正常结束后落盘。
 *
 * 只在**正常结束**时写：中途断流/取消留下的半截 fixture 会被读侧判成损坏，
 * 不如根本不写。写盘失败不静默：抛 `internal`，让使用者知道「这次录制没留下证据」。
 */
export function createRecordSource(
  config: LlmRuntimeConfig,
  options: RecordSourceOptions = {},
): DeltaSource {
  const clock = options.clock ?? Date.now;
  const live = createLiveSource(config, options);

  return {
    label: "record",
    async *stream(input: StreamInput): AsyncGenerator<SourceDelta, void, undefined> {
      const chunks: FixtureChunk[] = [];
      let usage: TokenUsage | null = null;
      let lastTMs = 0;

      for await (const delta of live.stream(input)) {
        if (delta.kind === "content") {
          const dt = Math.max(0, Math.round(delta.tMs) - Math.round(lastTMs));
          lastTMs = delta.tMs;
          chunks.push({ d: delta.delta, dt });
        } else {
          usage = delta.usage;
        }
        yield delta;
      }

      if (chunks.length === 0) {
        throw new LlmError("llm_invalid_output", "上游没有产生任何内容增量，未写入回放文件", {
          detail: "empty stream",
        });
      }

      const hash = replayKey({
        requirement: input.requirement,
        model: config.model,
        promptVersion: config.promptVersion,
        schemaVersion: SCHEMA_VERSION,
      });
      const meta = createFixtureMeta(chunks, {
        requirement: input.requirement,
        model: config.model,
        promptVersion: config.promptVersion,
        schemaVersion: SCHEMA_VERSION,
        upstream: config.upstreamLabel,
        recordedAt: new Date(clock()),
        usage,
      });
      const result = await writeFixture(config.fixtureDir, hash, chunks, meta);
      options.onRecorded?.(result);
    },
  };
}

const SPEED_FACTOR: Record<ReplaySpeed, number> = { "1x": 1, "2x": 0.5, instant: 0 };

export interface ReplaySourceOptions {
  readonly clock?: Clock;
}

/**
 * `replay`：读 fixture 重放。
 *
 * 未命中/损坏都由 `readFixture()` 抛 `LlmError`（码 `llm_config`，文案含
 * `REPLAY_MISS_HINT`）。**绝不降级成空流**——那会让前端显示一张空表单，
 * 而评委以为「模型生成了什么也没生成」。
 */
export function createReplaySource(
  config: LlmRuntimeConfig,
  options: ReplaySourceOptions = {},
): DeltaSource {
  const clock = options.clock ?? Date.now;
  const factor = SPEED_FACTOR[config.replaySpeed];

  return {
    label: "replay",
    async *stream(input: StreamInput): AsyncGenerator<SourceDelta, void, undefined> {
      const hash = replayKey({
        requirement: input.requirement,
        model: config.model,
        promptVersion: config.promptVersion,
        schemaVersion: SCHEMA_VERSION,
      });
      const fixture = await readFixture(config.fixtureDir, hash);

      let elapsed = 0;
      for (const chunk of fixture.chunks) {
        const wait = Math.round(chunk.dt * factor);
        if (wait > 0) await sleep(wait, input.signal, clock);
        elapsed += wait;
        yield { kind: "content", delta: chunk.d, tMs: elapsed };
      }
      yield {
        kind: "usage",
        usage: {
          promptTokens: fixture.meta.usage.promptTokens,
          completionTokens: fixture.meta.usage.completionTokens,
        },
        tMs: elapsed,
      };
    },
  };
}

/**
 * mock 的确定性脚本：与需求无关的固定几行（但标题里带需求前 12 个字，便于肉眼分辨
 * 是哪一次请求）。刻意覆盖 4 种题型 + 1 个分节，让前端能看见真实渲染。
 */
export function mockLines(requirement: string): readonly string[] {
  const title = requirement.trim().slice(0, 12).replace(/\s+/g, " ") || "未命名需求";
  const lines = [
    { type: "section", id: "sec_main", title: `模拟表单：${title}`, description: "mock 模式输出，仅用于联调" },
    {
      type: "single",
      id: "q_single",
      title: "示例单选题：$2+2$ 等于几？",
      required: true,
      score: 5,
      bloom: "remember",
      knowledgePoint: "kp_basic",
      options: [
        { id: "a", text: "3" },
        { id: "b", text: "4" },
      ],
      answer: "b",
      explanation: "基础加法。",
    },
    {
      type: "fill",
      id: "q_fill",
      title: "示例填空题：水的化学式是 ____。",
      required: true,
      score: 5,
      bloom: "understand",
      knowledgePoint: "kp_basic",
      answer: ["H2O"],
    },
    {
      type: "number",
      id: "q_number",
      title: "示例数值题：$\\sqrt{81}$ 等于多少？",
      required: true,
      score: 5,
      bloom: "apply",
      knowledgePoint: "kp_basic",
      answer: { value: 9, tolerance: 0 },
    },
    { type: "short", id: "q_short", title: "示例简答题：还有什么想补充的？", required: false },
  ];
  return lines.map((line) => `${JSON.stringify(line)}\n`);
}

export interface MockSourceOptions {
  readonly clock?: Clock;
  /** 每个 chunk 之间的间隔，默认 12ms；测试传 0。 */
  readonly chunkDelayMs?: number;
}

/** `mock`：确定性模板流，不碰网络、不落盘。 */
export function createMockSource(options: MockSourceOptions = {}): DeltaSource {
  const clock = options.clock ?? Date.now;
  const chunkDelayMs = options.chunkDelayMs ?? 12;

  return {
    label: "mock",
    async *stream(input: StreamInput): AsyncGenerator<SourceDelta, void, undefined> {
      const lines = mockLines(input.requirement);
      let elapsed = 0;
      for (const line of lines) {
        if (chunkDelayMs > 0) await sleep(chunkDelayMs, input.signal, clock);
        elapsed += chunkDelayMs;
        yield { kind: "content", delta: line, tMs: elapsed };
      }
      yield {
        kind: "usage",
        usage: {
          promptTokens: Math.ceil(input.requirement.length / 2),
          completionTokens: Math.ceil(lines.join("").length / 2),
        },
        tMs: elapsed,
      };
    },
  };
}
