/**
 * 生成链路 SSE 事件契约（《计划 v2.0》§3.6 + `AGENTS.md` §7）。
 *
 * 这份文件是**唯一契约源**：`server` 只负责发，`web` 只负责收，两边 import 同一份
 * Zod schema 与类型，任何字段改动都必须先改这里再改实现。
 *
 * 三条不可协商的约定（改它们等于改产品定位）：
 *
 * 1. **7 类事件**：`phase` / `thinking` / `field` / `field_error` / `repair` / `usage`
 *    + 终态（`done` 与 `error` 同属一类，因为一次生成只会走到其中之一）。
 *    线上 `event:` 名有 8 个，类别只有 7 个——数类别用 `SSE_EVENT_CATEGORIES`。
 * 2. **每个事件带递增 `seq`**（从 1 开始，步长 1，全局单调）。回放、乱序重排、
 *    "第几个事件到第几个事件"的耗时统计全靠它；`Array.prototype.sort` 按 `seq`
 *    排序必须稳定，所以它必须由**单一写入者**发放，不允许各分支自行填号。
 * 3. **心跳是 SSE 注释行**（`:` 开头），**不是事件**。不要为它扩枚举
 *    （`AGENTS.md` §7 明确禁止），`isHeartbeatFrame()` 负责识别。
 *
 * 单位约定（写错单位是这类协议最常见的隐性 bug）：
 * - `phase.ts`      —— Unix 毫秒时间戳（绝对时间，用于时间线对齐墙钟）
 * - `field.tMs`     —— 相对本次生成开始的毫秒数（相对时间，用于"第 N 题在 1.2s 落位"）
 * - `usage.ms`      —— 该阶段上游调用耗时（毫秒）
 *
 * 上游原始响应**不进事件**：`error` 只带稳定错误码与面向用户的一句话，避免把
 * Provider 的原始报文（可能含 Key 片段、内部 URL）泄到前端。
 */

import { z } from "zod";

import { LIMITS } from "./constants";
import { ERROR_CODES } from "./errors";
import { formItemSchema } from "./types";

/**
 * 线上 `event:` 名，共 8 个。顺序即文档顺序，测试对成员与数量做断言。
 */
export const SSE_EVENT_TYPES = [
  "phase",
  "thinking",
  "field",
  "field_error",
  "repair",
  "usage",
  "done",
  "error",
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** 事件类别，共 **7** 类：`done` 与 `error` 合并为终态一类。 */
export const SSE_EVENT_CATEGORIES = [
  "phase",
  "thinking",
  "field",
  "field_error",
  "repair",
  "usage",
  "terminal",
] as const;

export type SseEventCategory = (typeof SSE_EVENT_CATEGORIES)[number];

export const TERMINAL_EVENT_TYPES = ["done", "error"] as const;

export type TerminalEventType = (typeof TERMINAL_EVENT_TYPES)[number];

/** 阶段名。`done` 是"生成已收尾"的阶段，和终态事件的 `done` 不是同一个东西。 */
export const PHASE_NAMES = [
  "understand",
  "plan",
  "generate",
  "validate",
  "repair",
  "done",
] as const;

export type PhaseName = (typeof PHASE_NAMES)[number];

/**
 * 终态错误码。刻意穷举而不是 `z.string()`：前端要按码分支给可操作提示
 * （「重试」还是「先去配 Key」），自由字符串会让前端只能显示原文。
 * 新增码属于契约变更，必须同步 `packages/contracts` 的调用方与本文档。
 */
export const SSE_ERROR_CODES = [
  /** 上游超过 `LLM_TIMEOUT_MS`（默认 60s）。可重试。 */
  "llm_timeout",
  /** 上游非 2xx，或流在读的过程中断开。可重试。 */
  "llm_upstream",
  /** 修复 2 轮后输出仍不合法。同输入重试大概率无效，但换个模型有效。 */
  "llm_invalid_output",
  /** 客户端断开或用户点了取消。不可重试（重试等于违背用户意图）。 */
  "llm_cancelled",
  /** `live`/`record` 缺 Key 或配置非法。不可重试，必须先改配置。 */
  "llm_config",
  /** 未归类的服务端异常。不可重试。 */
  "internal",
] as const;

export type SseErrorCode = (typeof SSE_ERROR_CODES)[number];

/** 心跳间隔。计划 §3.4 定的是 15 秒，超时断连的代理阈值通常在 30–60 秒。 */
export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/** 心跳帧：SSE 注释行。客户端 `EventSource` 会忽略它，但能保活 TCP。 */
export const SSE_HEARTBEAT_FRAME = ": ping\n\n";

/** 递增序号。上限取 2^31-1：一次生成不可能到这个量级，同时保持 `int4` 友好。 */
const seqSchema = z.number().int().min(1).max(2_147_483_647);

const tsSchema = z.number().int().nonnegative();

const relativeMsSchema = z.number().int().nonnegative();

const errorCodeListSchema = z.array(z.enum(ERROR_CODES)).min(1);

export const phaseEventSchema = z.object({
  type: z.literal("phase"),
  seq: seqSchema,
  phase: z.enum(PHASE_NAMES),
  /** Unix 毫秒时间戳。 */
  ts: tsSchema,
});

export const thinkingEventSchema = z.object({
  type: z.literal("thinking"),
  seq: seqSchema,
  /** 增量文本，不是累积全文。客户端负责拼接。 */
  delta: z.string(),
  /**
   * `reasoning` 是模型思考原文；`summary` 是阶段一句话摘要（我们自己生成，
   * 不来自模型）。两者共用 `delta` 字段，靠 `kind` 分流渲染。
   */
  kind: z.enum(["summary", "reasoning"]),
});

export const fieldEventSchema = z.object({
  type: z.literal("field"),
  seq: seqSchema,
  /** 已通过校验的节点序号，从 0 开始，按到达顺序递增。 */
  index: z.number().int().nonnegative(),
  /** 分节或字段本体，形状即 `formItemSchema`：契约不允许出现第三种形状。 */
  node: formItemSchema,
  /** 相对本次生成开始的毫秒数。 */
  tMs: relativeMsSchema,
});

export const fieldErrorEventSchema = z.object({
  type: z.literal("field_error"),
  seq: seqSchema,
  /** 出问题的行序号，与 `field.index` 同一计数空间，便于前端把占位槽标红。 */
  index: z.number().int().nonnegative(),
  /** 能解析出 id 就填 id；整行不是 JSON 时用空串占位（不允许 null，省掉前端分支）。 */
  id: z.string(),
  /** 命中的错误码，至少一个。码表见 `errors.ts`。 */
  codes: errorCodeListSchema,
  /** 原始行的截断片段，上限 `LIMITS.rawLineMax`；只用于排查与前端提示，不可回显为学生可见内容。 */
  raw: z.string().max(LIMITS.rawLineMax),
});

export const repairEventSchema = z.object({
  type: z.literal("repair"),
  seq: seqSchema,
  /** 被修复的字段 id（Patch 以 id 寻址，这里同样不用下标）。 */
  id: z.string().min(1),
  /** 修复轮次，计划 §5 限定最多 2 轮。 */
  round: z.union([z.literal(1), z.literal(2)]),
  /** 修复前的错误码集合。 */
  codesBefore: errorCodeListSchema,
  /** 修复后的错误码集合；`fixed` 时为空数组，所以这里不能套 `.min(1)`。 */
  codesAfter: z.array(z.enum(ERROR_CODES)),
  /** 错误集合是否真的减少了（单调性判定结果）。 */
  status: z.enum(["fixed", "failed"]),
});

export const usageEventSchema = z.object({
  type: z.literal("usage"),
  seq: seqSchema,
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  ms: relativeMsSchema,
});

const doneStatsSchema = z.object({
  /** 成功落位的节点总数（含 section）。 */
  fields: z.number().int().nonnegative(),
  /** 校验失败的行数。 */
  errors: z.number().int().nonnegative(),
  /** 实际发生的修复次数（0–2 × 字段数，但看板上按次数展示）。 */
  repairs: z.number().int().nonnegative(),
  /** 端到端耗时，毫秒。 */
  ms: relativeMsSchema,
});

export const doneEventSchema = z.object({
  type: z.literal("done"),
  seq: seqSchema,
  /**
   * 落库后的版本 id。I2 阶段还没有数据库，服务端回放/模拟路径填占位值，
   * I4 接 `form_versions` 后填真实 id——字段类型不变，调用方不用改。
   */
  versionId: z.string().min(1),
  stats: doneStatsSchema,
});

export const errorEventSchema = z.object({
  type: z.literal("error"),
  seq: seqSchema,
  code: z.enum(SSE_ERROR_CODES),
  /** 面向用户的一句话，**不含上游原始报文**。 */
  message: z.string().min(1),
  retryable: z.boolean(),
});

export const sseEventSchema = z.discriminatedUnion("type", [
  phaseEventSchema,
  thinkingEventSchema,
  fieldEventSchema,
  fieldErrorEventSchema,
  repairEventSchema,
  usageEventSchema,
  doneEventSchema,
  errorEventSchema,
]);

export type SsePhaseEvent = z.infer<typeof phaseEventSchema>;
export type SseThinkingEvent = z.infer<typeof thinkingEventSchema>;
export type SseFieldEvent = z.infer<typeof fieldEventSchema>;
export type SseFieldErrorEvent = z.infer<typeof fieldErrorEventSchema>;
export type SseRepairEvent = z.infer<typeof repairEventSchema>;
export type SseUsageEvent = z.infer<typeof usageEventSchema>;
export type SseDoneEvent = z.infer<typeof doneEventSchema>;
export type SseErrorEvent = z.infer<typeof errorEventSchema>;

/** 事件联合类型。`seq` 已在每个成员里，不需要外部再拼。 */
export type SseEvent = z.infer<typeof sseEventSchema>;

export type SseTerminalEvent = SseDoneEvent | SseErrorEvent;

/** 去掉 `seq` 后的事件体：这是发放序号之前的形态，也是服务端写事件时的入参。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SseEventBody = DistributiveOmit<SseEvent, "seq">;

/**
 * 序号发放器。
 *
 * 为什么必须由单一写入者发放：客户端按 `seq` 排序，一旦两个分支各自计数
 * （例如"正常字段"与"修复事件"分别从 1 开始），排序结果就是错的，而回放时
 * 这种错会表现为"时间线倒退"，很难从日志里看出来。
 */
export interface SseSequencer {
  /** 下一个将被使用的序号。 */
  readonly nextSeq: number;
  /** 挂上序号并返回；`seq` 自增。 */
  next(body: SseEventBody): SseEvent;
}

export function createSseSequencer(startAt: number = 1): SseSequencer {
  if (!Number.isInteger(startAt) || startAt < 1) {
    throw new Error(`invalid SSE sequencer start: ${String(startAt)} (expect integer >= 1)`);
  }

  let seq = startAt;

  return {
    get nextSeq(): number {
      return seq;
    },
    next(body: SseEventBody): SseEvent {
      // 用 schema 解析而不是类型断言：既挂上 seq，又保证服务端自己写出去的每一个
      // 事件都过一遍契约。代价是每个事件一次浅校验，对每秒几十个事件的量级可忽略。
      const event = sseEventSchema.parse({ ...body, seq });
      seq += 1;
      return event;
    },
  };
}

/** 校验任意值是否为合法事件（前端 reducer 与 fixture 测试共用）。 */
export function parseSseEvent(value: unknown): SseEvent {
  return sseEventSchema.parse(value);
}

/** 非抛错的版本，供"容错消费"场景使用（例如回放文件里混入了旧版本事件）。 */
export function safeParseSseEvent(value: unknown): z.SafeParseReturnType<unknown, SseEvent> {
  return sseEventSchema.safeParse(value);
}

/** 类别映射。穷举 `switch`，新增事件类型而漏写分支时编译期报错。 */
export function eventCategory(type: SseEventType): SseEventCategory {
  switch (type) {
    case "phase":
      return "phase";
    case "thinking":
      return "thinking";
    case "field":
      return "field";
    case "field_error":
      return "field_error";
    case "repair":
      return "repair";
    case "usage":
      return "usage";
    case "done":
    case "error":
      return "terminal";
  }
}

export function isTerminalEvent(event: SseEvent): event is SseTerminalEvent {
  return event.type === "done" || event.type === "error";
}

/**
 * 序列化成一行 NDJSON。
 *
 * 注意：**回放 fixture 不是这个格式**。fixture 记录的是上游 chunk（原始 delta +
 * 相对延迟），见 `fixtures/replays/README.md`。这里是事件日志 / 测试工具用的格式。
 */
export function toNdjsonLine(event: SseEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/**
 * 序列化成一帧 SSE（`event:` + `data:` + 空行）。
 * 服务端用 Hono 的 `streamSSE` 时不需要它；无框架的服务端、或测试里手写响应时会用。
 */
export function toSseFrame(event: SseEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export type SseDataParseResult =
  | { readonly ok: true; readonly event: SseEvent }
  | { readonly ok: false; readonly reason: string };

/** 解析一帧 SSE 的 `data:` 载荷（或一行 NDJSON）。返回判别联合，不抛错。 */
export function parseSseDataLine(data: string): SseDataParseResult {
  const trimmed = data.trim();
  if (trimmed === "") {
    return { ok: false, reason: "empty data" };
  }

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, reason: `invalid JSON: ${error instanceof Error ? error.message : "unknown"}` };
  }

  const parsed = sseEventSchema.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      ok: false,
      reason: first === undefined ? "schema mismatch" : `${first.path.join(".")}: ${first.message}`,
    };
  }

  return { ok: true, event: parsed.data };
}

/** 心跳帧判定：SSE 注释行以 `:` 开头，`EventSource` 不会把它当事件分发。 */
export function isHeartbeatFrame(line: string): boolean {
  return line.trimStart().startsWith(":");
}
