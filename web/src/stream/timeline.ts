/**
 * 思考时间线的分组与耗时计算（纯函数，可单测）。
 *
 * 三个数字来源必须在文档里说清，否则很容易把相对时间当绝对时间用：
 * - `phase.ts` 是 **Unix 毫秒绝对时间** → 阶段耗时靠相邻两个 `ts` 相减；
 *   第一阶段之前没有参照点，所以用"本阶段 ts − 首阶段 ts"得到相对入场时刻。
 * - 最后一个阶段没有下一个 `ts` 可用，改用终态 `done.stats.ms`（端到端毫秒）减去
 *   它的相对入场时刻——这是 `stats.ms` 存在的意义之一。
 * - `field.tMs` 已经是**相对本次生成开始**的毫秒数，直接展示，不再做差。
 *
 * 分组规则：每个 `phase` 事件开一个新阶段（同名阶段重复出现时标 `第 N 次`，
 * 因为修复环会让 `generate`/`validate` 再次出现，合并会把"回炉"这件事抹掉）。
 * 事件按 `seq` 挂到"它到达时正在进行的阶段"上；`phase` 之前的零星事件进 `prelude`。
 */

import { ERROR_HINTS, type ErrorCode, type PhaseName } from "@intentform/schema";

import type {
  DoneStats,
  FieldErrorEntry,
  GenerateState,
  RepairEntry,
  SeqAnomalyKind,
} from "./generate-machine";

export type StagePhase = PhaseName | "prelude";

export const PHASE_LABELS: Record<StagePhase, string> = {
  prelude: "准备",
  understand: "理解需求",
  plan: "规划结构",
  generate: "逐字段生成",
  validate: "规则校验",
  repair: "定向修复",
  done: "收尾",
};

/** 阶段状态：`active` 只可能出现在最后一个阶段。 */
export type StageStatus = "done" | "active" | "cancelled" | "error";

export interface TimelineFieldItem {
  readonly seq: number;
  readonly index: number;
  readonly id: string;
  readonly title: string;
  readonly typeLabel: string;
  readonly tMs: number;
}

export interface TimelineErrorItem {
  readonly seq: number;
  readonly index: number;
  readonly id: string;
  readonly codes: readonly ErrorCode[];
  /** 每个错误码对应的固定文案（`ERROR_HINTS`），不显示裸码。 */
  readonly hints: readonly string[];
  readonly resolved: boolean;
}

export interface TimelineRepairItem {
  readonly seq: number;
  readonly id: string;
  readonly round: 1 | 2;
  readonly status: "fixed" | "failed";
  /** 形如「第 1 轮：E_ANSWER_MISSING → 已修复」。 */
  readonly text: string;
}

export interface TimelineUsageItem {
  readonly seq: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly ms: number;
}

export interface TimelineStage {
  /** React key：`${phase}#${occurrence}`。 */
  readonly key: string;
  readonly phase: StagePhase;
  readonly label: string;
  readonly occurrence: number;
  /** 相对首阶段的入场时刻（毫秒）；`prelude` 为 null。 */
  readonly startsAtMs: number | null;
  /** 阶段耗时（毫秒）；未结束或无法计算时为 null。 */
  readonly durationMs: number | null;
  readonly summaries: readonly string[];
  /** `reasoning` 增量的拼接原文（可折叠展示）。 */
  readonly reasoning: string;
  readonly reasoningChunks: number;
  readonly fields: readonly TimelineFieldItem[];
  readonly errors: readonly TimelineErrorItem[];
  readonly repairs: readonly TimelineRepairItem[];
  readonly usages: readonly TimelineUsageItem[];
}

export interface TimelineAnomalyItem {
  readonly kind: SeqAnomalyKind;
  /** 作者可读的分类名（面板直接显示，不显示裸 kind）。 */
  readonly label: string;
  readonly seq: number | null;
  readonly note: string;
}

export interface Timeline {
  readonly stages: readonly TimelineStage[];
  readonly totalElapsedMs: number | null;
  readonly stats: DoneStats | null;
  /** 事件数与 `seq` 异常条数，用来证明"乱序被观察到了"。 */
  readonly appliedCount: number;
  readonly anomalyCount: number;
  /** 协议异常明细（跳号缓存 / 迟到归位 / 过期丢弃 / 坏帧 / 缺号超时跳过）。 */
  readonly anomalies: readonly TimelineAnomalyItem[];
}

/** `seq` 异常的中文名——时间线的「协议异常」区显示这个，不显示裸 kind。 */
export const ANOMALY_LABELS: Record<SeqAnomalyKind, string> = {
  "gap-buffered": "跳号先缓存",
  "out-of-order-drained": "迟到归位",
  "stale-dropped": "过期丢弃",
  malformed: "坏帧",
  "gap-skipped": "缺号跳过",
};

const TYPE_LABELS: Record<string, string> = {
  single: "单选",
  multi: "多选",
  fill: "填空",
  number: "数值",
  short: "简答",
  scale: "量表",
  section: "分节",
};

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function repairText(entry: RepairEntry): string {
  const outcome = entry.status === "fixed" ? "已修复" : `仍失败（${entry.codesAfter.join("、")}）`;
  return `第 ${entry.round} 轮：${entry.codesBefore.join("、")} → ${outcome}`;
}

function errorItem(entry: FieldErrorEntry): TimelineErrorItem {
  return {
    seq: entry.seq,
    index: entry.index,
    id: entry.id === "" ? `#${entry.index}` : entry.id,
    codes: entry.codes,
    hints: entry.codes.map((code) => ERROR_HINTS[code]),
    resolved: entry.resolvedBySeq !== null,
  };
}

interface StageDraft {
  phase: StagePhase;
  seq: number;
  occurrence: number;
  /** 首阶段 `ts` 为参照；`prelude` 没有。 */
  startsAt: number | null;
  startTs: number | null;
  summaries: string[];
  reasoning: string[];
  reasoningChunks: number;
  fields: TimelineFieldItem[];
  errors: TimelineErrorItem[];
  repairs: TimelineRepairItem[];
  usages: TimelineUsageItem[];
}

/** 事件属于第几个阶段：`phase` 事件之前的事件归 `prelude`（下标 0）。 */
function stageIndexFor(seq: number, marks: readonly { readonly seq: number }[]): number {
  let index = 0;
  for (let i = 0; i < marks.length; i += 1) {
    const mark = marks[i];
    if (mark === undefined || mark.seq > seq) break;
    index = i + 1;
  }
  return index;
}

export function buildTimeline(state: GenerateState): Timeline {
  const marks = [...state.phases].sort((a, b) => a.seq - b.seq);
  const firstTs = marks[0]?.ts ?? null;

  const drafts: StageDraft[] = [
    {
      phase: "prelude",
      seq: Number.NEGATIVE_INFINITY,
      occurrence: 1,
      startsAt: null,
      startTs: null,
      summaries: [],
      reasoning: [],
      reasoningChunks: 0,
      fields: [],
      errors: [],
      repairs: [],
      usages: [],
    },
  ];

  const occurrences = new Map<PhaseName, number>();
  for (const mark of marks) {
    const occurrence = (occurrences.get(mark.phase) ?? 0) + 1;
    occurrences.set(mark.phase, occurrence);
    drafts.push({
      phase: mark.phase,
      seq: mark.seq,
      occurrence,
      startsAt: firstTs === null ? null : Math.max(0, mark.ts - firstTs),
      startTs: mark.ts,
      summaries: [],
      reasoning: [],
      reasoningChunks: 0,
      fields: [],
      errors: [],
      repairs: [],
      usages: [],
    });
  }

  const at = (seq: number): StageDraft => {
    const index = stageIndexFor(seq, marks);
    return drafts[index] ?? drafts[0]!;
  };

  for (const entry of [...state.thinking].sort((a, b) => a.seq - b.seq)) {
    const draft = at(entry.seq);
    if (entry.kind === "summary") draft.summaries.push(entry.delta.trim());
    else {
      draft.reasoning.push(entry.delta);
      draft.reasoningChunks += 1;
    }
  }

  for (const entry of state.fields) {
    at(entry.seq).fields.push({
      seq: entry.seq,
      index: entry.index,
      id: entry.node.id,
      title: entry.node.title,
      typeLabel: TYPE_LABELS[entry.node.type] ?? entry.node.type,
      tMs: entry.tMs,
    });
  }

  for (const entry of state.fieldErrors) at(entry.seq).errors.push(errorItem(entry));

  for (const entry of state.repairs) {
    at(entry.seq).repairs.push({
      seq: entry.seq,
      id: entry.id,
      round: entry.round,
      status: entry.status,
      text: repairText(entry),
    });
  }

  for (const entry of state.usages) {
    at(entry.seq).usages.push({
      seq: entry.seq,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      ms: entry.ms,
    });
  }

  const stats = state.terminal?.kind === "done" ? state.terminal.stats : null;

  const stages: TimelineStage[] = drafts.map((draft, index) => {
    const next = drafts[index + 1];
    let durationMs: number | null = null;

    if (draft.startTs !== null) {
      if (next !== undefined && next.startTs !== null) {
        durationMs = Math.max(0, next.startTs - draft.startTs);
      } else if (stats !== null) {
        // 最后一个阶段：端到端毫秒减去它的相对入场时刻。
        durationMs = Math.max(0, stats.ms - (draft.startsAt ?? 0));
      }
    }

    const stageStatus: StageStatus =
      state.status === "done"
        ? "done"
        : state.status === "error"
          ? "error"
          : state.status === "cancelled"
            ? "cancelled"
            : "active";

    return {
      key: `${draft.phase}#${draft.occurrence}`,
      phase: draft.phase,
      label: PHASE_LABELS[draft.phase],
      occurrence: draft.occurrence,
      startsAtMs: draft.startsAt,
      // 最后一个阶段仍在流式中时耗时未知，显示「进行中」而不是 0ms。
      durationMs: durationMs === null && index === drafts.length - 1 && stageStatus === "active" ? null : durationMs,
      summaries: [...draft.summaries],
      reasoning: draft.reasoning.join(""),
      reasoningChunks: draft.reasoningChunks,
      fields: [...draft.fields].sort((a, b) => a.index - b.index),
      errors: [...draft.errors].sort((a, b) => a.seq - b.seq),
      repairs: [...draft.repairs].sort((a, b) => a.seq - b.seq),
      usages: [...draft.usages].sort((a, b) => a.seq - b.seq),
    };
  });

  const visibleStages = stages.filter(
    (stage) =>
      stage.phase !== "prelude" ||
      stage.summaries.length > 0 ||
      stage.reasoning !== "" ||
      stage.fields.length > 0 ||
      stage.errors.length > 0,
  );

  const lastMark = marks[marks.length - 1];
  const totalElapsedMs =
    stats !== null
      ? stats.ms
      : firstTs !== null && lastMark !== undefined
        ? Math.max(0, lastMark.ts - firstTs)
        : null;

  return {
    stages: visibleStages,
    totalElapsedMs,
    stats,
    appliedCount: state.appliedCount,
    anomalyCount: state.anomalies.length,
    anomalies: state.anomalies.map((anomaly) => ({
      kind: anomaly.kind,
      label: ANOMALY_LABELS[anomaly.kind],
      seq: anomaly.seq,
      note: anomaly.note,
    })),
  };
}
