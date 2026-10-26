/**
 * `useGenerateStream` 的状态机（纯 reducer，可单测）。
 *
 * 设计要点：
 *
 * 1. **单一事件流 + 递增 `seq`**：事件本身不做乐观重排，而是按 `seq` 严格推进。
 *    收到"跳号"就先缓存（`pending`），等缺口补上再一次性排空；收到"过期/重复"
 *    就丢弃。两种情况都记进 `anomalies`，时间线会把它们显示出来——**乱序要能被
 *    看见**，否则回放模式下"时间线倒退"会变成无法排查的幽灵 bug。
 * 2. **终态不可逆**：一旦 `terminal` 有值，后续事件全部忽略。`done` / `error`
 *    是一次生成里唯一合法结局；`llm_cancelled` 单独映射成 `cancelled` 状态，
 *    因为"用户按了取消"不是错误（界面文案也不同）。
 * 3. **票面字段不在这里过滤**：本状态保存的是**事件原样**（`FormItem` 含答案）。
 *    学生视图的过滤发生在渲染层的 `fill-plan.ts`（经 `publicView()`），
 *    这一层如果把 `answer` 提前删掉，教师端就没东西可看了。
 * 4. **缺口不能无限等**：跳号先缓存，但如果后端真丢了一帧，`pending` 会永远接不上、
 *    界面停在那一刻。所以外部会周期性派发 `tick`（时间由动作带入，reducer 自己不读
 *    时钟、不排定时器，保持纯函数），等待超过 `GAP_SKIP_AFTER_MS` 就跳过缺号继续，
 *    并在 `anomalies` 里留一条 `gap-skipped`——**丢帧也是要能被看见的**。
 */

import { assertNever, type ErrorCode, type FormItem, type PhaseName } from "@intentform/schema";
import type { SseDoneEvent, SseErrorCode, SseEvent } from "@intentform/schema";

/** 外部 `tick` 的派发间隔（hook 侧用 `setInterval`，测试里手工喂 `now`）。 */
export const GAP_TICK_MS = 500;

/** 缺号等待上限：超过就跳过缺号（3 秒是"一帧 SSE 绝不该这么久"的经验值）。 */
export const GAP_SKIP_AFTER_MS = 3000;

export type RunStatus = "idle" | "streaming" | "done" | "error" | "cancelled";

export type DoneStats = SseDoneEvent["stats"];

export interface PhaseMark {
  readonly seq: number;
  readonly phase: PhaseName;
  /** Unix 毫秒时间戳（绝对时间）。阶段耗时靠相邻时间戳差算。 */
  readonly ts: number;
}

export interface ThinkingEntry {
  readonly seq: number;
  readonly kind: "summary" | "reasoning";
  /** 增量文本（不是累积全文），渲染时按 `kind` 分流。 */
  readonly delta: string;
}

export interface FieldEntry {
  readonly seq: number;
  readonly index: number;
  readonly node: FormItem;
  /** 相对本次生成开始的毫秒数，用来显示"第 N 个节点在 1.2s 落位"。 */
  readonly tMs: number;
}

export interface FieldErrorEntry {
  readonly seq: number;
  readonly index: number;
  readonly id: string;
  readonly codes: readonly ErrorCode[];
  readonly raw: string;
  /** 同 `index` 的 `field` 后来补上了，就记下它的 seq；`null` 表示仍未解决。 */
  readonly resolvedBySeq: number | null;
}

export interface RepairEntry {
  readonly seq: number;
  readonly id: string;
  readonly round: 1 | 2;
  readonly codesBefore: readonly ErrorCode[];
  readonly codesAfter: readonly ErrorCode[];
  readonly status: "fixed" | "failed";
}

export interface UsageEntry {
  readonly seq: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly ms: number;
}

export type Terminal =
  | { readonly kind: "done"; readonly seq: number; readonly versionId: string; readonly stats: DoneStats }
  | {
      readonly kind: "error";
      readonly seq: number;
      readonly code: SseErrorCode;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly kind: "cancelled"; readonly seq: number; readonly message: string };

/** `seq` 异常（跳号 / 重复 / 坏帧 / 缺号超时跳过）——时间线上单独一段，用来暴露协议问题。 */
export type SeqAnomalyKind =
  | "gap-buffered"
  | "out-of-order-drained"
  | "stale-dropped"
  | "malformed"
  | "gap-skipped";

export interface SeqAnomaly {
  readonly kind: SeqAnomalyKind;
  readonly seq: number | null;
  readonly note: string;
}

export interface GenerateState {
  readonly status: RunStatus;
  /** 已按顺序应用的最大 `seq`；0 表示还没应用任何事件。 */
  readonly lastSeq: number;
  /** 因跳号而暂存的乱序事件（按 `seq` 升序）。 */
  readonly pending: readonly SseEvent[];
  readonly anomalies: readonly SeqAnomaly[];
  readonly phases: readonly PhaseMark[];
  readonly thinking: readonly ThinkingEntry[];
  readonly fields: readonly FieldEntry[];
  readonly fieldErrors: readonly FieldErrorEntry[];
  readonly repairs: readonly RepairEntry[];
  readonly usages: readonly UsageEntry[];
  readonly terminal: Terminal | null;
  /** 已应用事件数（用于"收到 18 个事件"这类说明）。 */
  readonly appliedCount: number;
  /**
   * 缺口开始被观察到的时刻（Unix 毫秒），由第一次 `tick` 记下；`null` 表示当前没有缺口。
   * 用"第一次 tick 记起点、后续 tick 量差"而不是在缺口产生时记时间，是为了让 reducer
   * 完全不接触 `Date.now()`——时间只能从动作里进来。
   */
  readonly gapSinceMs: number | null;
}

export const initialGenerateState: GenerateState = {
  status: "idle",
  lastSeq: 0,
  pending: [],
  anomalies: [],
  phases: [],
  thinking: [],
  fields: [],
  fieldErrors: [],
  repairs: [],
  usages: [],
  terminal: null,
  appliedCount: 0,
  gapSinceMs: null,
};

export type GenerateAction =
  | { readonly type: "start" }
  /** 一帧解析成功。 */
  | { readonly type: "event"; readonly event: SseEvent }
  /** 一帧解析失败（坏 JSON / 不符合契约）：记进异常，不打断流。 */
  | { readonly type: "malformed"; readonly reason: string }
  /** 定时心跳：把"当前时刻"喂进 reducer，只用于判断缺口等太久了没有。 */
  | { readonly type: "tick"; readonly now: number }
  /** 用户点了取消。 */
  | { readonly type: "cancel" }
  /** 传输层失败（网络断开、非 2xx、响应体为空）。 */
  | { readonly type: "fail"; readonly code: SseErrorCode; readonly message: string }
  | { readonly type: "reset" };

function addAnomaly(state: GenerateState, anomaly: SeqAnomaly): GenerateState {
  return { ...state, anomalies: [...state.anomalies, anomaly] };
}

/** 应用单个事件（不再处理 `seq` 顺序，由 `ingest` 负责）。 */
function applyEvent(state: GenerateState, event: SseEvent): GenerateState {
  switch (event.type) {
    case "phase":
      return {
        ...state,
        phases: [...state.phases, { seq: event.seq, phase: event.phase, ts: event.ts }],
      };

    case "thinking":
      return {
        ...state,
        thinking: [...state.thinking, { seq: event.seq, kind: event.kind, delta: event.delta }],
      };

    case "field":
      return {
        ...state,
        fields: [...state.fields, { seq: event.seq, index: event.index, node: event.node, tMs: event.tMs }],
        // 同 index 的校验失败被这一行补齐了：标成已解决，时间线才能画出"红 → 绿"。
        fieldErrors: state.fieldErrors.map((entry) =>
          entry.index === event.index && entry.resolvedBySeq === null
            ? { ...entry, resolvedBySeq: event.seq }
            : entry,
        ),
      };

    case "field_error":
      return {
        ...state,
        fieldErrors: [
          ...state.fieldErrors,
          {
            seq: event.seq,
            index: event.index,
            id: event.id,
            codes: event.codes,
            raw: event.raw,
            resolvedBySeq: null,
          },
        ],
      };

    case "repair":
      return {
        ...state,
        repairs: [
          ...state.repairs,
          {
            seq: event.seq,
            id: event.id,
            round: event.round,
            codesBefore: event.codesBefore,
            codesAfter: event.codesAfter,
            status: event.status,
          },
        ],
      };

    case "usage":
      return {
        ...state,
        usages: [
          ...state.usages,
          {
            seq: event.seq,
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            ms: event.ms,
          },
        ],
      };

    case "done":
      return {
        ...state,
        status: "done",
        terminal: { kind: "done", seq: event.seq, versionId: event.versionId, stats: event.stats },
      };

    case "error":
      // 取消不是错误：文案、图标、是否显示"重试"都不同，所以这里就分叉。
      if (event.code === "llm_cancelled") {
        return {
          ...state,
          status: "cancelled",
          terminal: { kind: "cancelled", seq: event.seq, message: event.message },
        };
      }
      return {
        ...state,
        status: "error",
        terminal: {
          kind: "error",
          seq: event.seq,
          code: event.code,
          message: event.message,
          retryable: event.retryable,
        },
      };

    default:
      return assertNever(event);
  }
}

function bySeq(a: SseEvent, b: SseEvent): number {
  return a.seq - b.seq;
}

/**
 * 把 `pending` 里能接上的事件按顺序应用掉。
 * `markReordered` 为 `false` 时不记「迟到归位」——跳过缺号之后补应用的那批事件不是迟到，
 * 是我们主动放弃了缺口（`skipGap` 已经单独记了一条 `gap-skipped`），再记一条会误导排查。
 */
function drainPending(state: GenerateState, markReordered = true): GenerateState {
  let next = state;

  for (;;) {
    const head = next.pending[0];
    if (head === undefined) return next;
    if (head.seq !== next.lastSeq + 1) return next;

    next = applyEvent({ ...next, pending: next.pending.slice(1) }, head);
    const applied: GenerateState = {
      ...next,
      lastSeq: head.seq,
      appliedCount: next.appliedCount + 1,
    };
    next = markReordered
      ? {
          ...applied,
          anomalies: [
            ...applied.anomalies,
            {
              kind: "out-of-order-drained",
              seq: head.seq,
              note: `seq ${head.seq} 迟到，缺口补齐后已归位`,
            },
          ],
        }
      : applied;

    if (next.terminal !== null) return next;
  }
}

/**
 * 缺口等超时：放弃等待缺失的 `seq`，把 `lastSeq` 推到第一个待补事件之前，再把这批事件应用掉。
 * 这是"宁可少一帧也不要把界面钉死"的兜底；丢帧会在 `anomalies` 里留一条 `gap-skipped`，
 * 时间线的「协议异常」区会照实显示。
 */
function skipGap(state: GenerateState, now: number): GenerateState {
  const head = state.pending[0];
  if (head === undefined) return { ...state, gapSinceMs: null };

  const missingFrom = state.lastSeq + 1;
  const missingTo = head.seq - 1;
  const skippedCount = head.seq - missingFrom;
  const waitedMs = state.gapSinceMs === null ? 0 : Math.max(0, now - state.gapSinceMs);
  const range = missingFrom === missingTo ? `seq ${missingFrom}` : `seq ${missingFrom}–${missingTo}`;

  const skipped = addAnomaly(
    { ...state, lastSeq: missingTo, gapSinceMs: null },
    {
      kind: "gap-skipped",
      seq: missingFrom,
      note: `${range} 等了 ${(waitedMs / 1000).toFixed(1)}s 仍未到达，已跳过 ${skippedCount} 个号继续应用后续事件（这一帧确实丢了）`,
    },
  );

  return drainPending(skipped, false);
}

/** 按 `seq` 顺序摄入事件：连续就应用，跳号就缓存，过期就丢弃。 */
function ingest(state: GenerateState, event: SseEvent): GenerateState {
  if (state.terminal !== null) return state;
  if (event.seq <= state.lastSeq) {
    return addAnomaly(state, {
      kind: "stale-dropped",
      seq: event.seq,
      note: `seq ${event.seq} 重复或过期（已应用到 ${state.lastSeq}），已丢弃`,
    });
  }

  if (event.seq > state.lastSeq + 1) {
    if (state.pending.some((pending) => pending.seq === event.seq)) {
      return addAnomaly(state, {
        kind: "stale-dropped",
        seq: event.seq,
        note: `seq ${event.seq} 已在等待队列中，重复到达已丢弃`,
      });
    }
    return addAnomaly(
      {
        ...state,
        pending: [...state.pending, event].sort(bySeq),
      },
      {
        kind: "gap-buffered",
        seq: event.seq,
        note: `期待 seq ${state.lastSeq + 1}，先收到 ${event.seq}，已暂存等待缺口`,
      },
    );
  }

  let next = applyEvent(state, event);
  next = { ...next, lastSeq: event.seq, appliedCount: next.appliedCount + 1 };
  if (next.terminal !== null) return next;
  return drainPending(next);
}

export function generateReducer(state: GenerateState, action: GenerateAction): GenerateState {
  switch (action.type) {
    case "start":
      return { ...initialGenerateState, status: "streaming" };

    case "event": {
      const next = ingest(state, action.event);
      // 缺口被补齐（pending 清空）就忘掉缺口起点，免得下一次跳号沿用旧时间戳被立刻跳过。
      if (next.pending.length === 0 && next.gapSinceMs !== null) {
        return { ...next, gapSinceMs: null };
      }
      return next;
    }

    case "tick": {
      if (state.terminal !== null) return state;
      if (state.pending.length === 0) {
        return state.gapSinceMs === null ? state : { ...state, gapSinceMs: null };
      }
      if (state.gapSinceMs === null) {
        // 第一次观测到缺口：记下起点，下一次 tick 才有差值可算。
        return { ...state, gapSinceMs: action.now };
      }
      if (action.now - state.gapSinceMs < GAP_SKIP_AFTER_MS) return state;
      return skipGap(state, action.now);
    }

    case "malformed":
      return addAnomaly(state, {
        kind: "malformed",
        seq: null,
        note: `有一帧无法解析：${action.reason}`,
      });

    case "cancel": {
      if (state.status !== "streaming") return state;
      return {
        ...state,
        status: "cancelled",
        pending: [],
        gapSinceMs: null,
        terminal: {
          kind: "cancelled",
          seq: state.lastSeq + 1,
          message: "已取消本次生成（上游请求已中断）",
        },
      };
    }

    case "fail": {
      if (state.terminal !== null) return state;
      return {
        ...state,
        status: "error",
        pending: [],
        gapSinceMs: null,
        terminal: {
          kind: "error",
          seq: state.lastSeq + 1,
          code: action.code,
          message: action.message,
          retryable: true,
        },
      };
    }

    case "reset":
      return initialGenerateState;

    default:
      return assertNever(action);
  }
}

/** 预览区要按 `field.index` 排序；乱序到达时不能让第 3 题排在第 5 题后面。 */
export function selectPreviewFields(state: GenerateState): readonly FieldEntry[] {
  return [...state.fields].sort((a, b) => a.index - b.index);
}

/** 未解决的校验失败，按 index 索引，供预览区把对应占位标红。 */
export function selectUnresolvedErrors(state: GenerateState): ReadonlyMap<number, FieldErrorEntry> {
  const result = new Map<number, FieldErrorEntry>();
  for (const entry of state.fieldErrors) {
    if (entry.resolvedBySeq === null) result.set(entry.index, entry);
  }
  return result;
}
