import type { PhaseName, SseEvent } from "@intentform/schema";
import { describe, expect, it } from "vitest";

import { FIXTURE_FRAMES } from "./__fixtures__/fake-frames";
import { parseSseFrame } from "./frames";
import {
  GAP_SKIP_AFTER_MS,
  generateReducer,
  initialGenerateState,
  selectPreviewFields,
  selectUnresolvedErrors,
  type GenerateAction,
  type GenerateState,
} from "./generate-machine";

function eventsFromFixture(): readonly SseEvent[] {
  const parsed = FIXTURE_FRAMES.map(parseSseFrame);
  const events: SseEvent[] = [];
  for (const frame of parsed) {
    if (frame.kind === "event") events.push(frame.event);
  }
  return events;
}

function feed(state: GenerateState, events: readonly SseEvent[]): GenerateState {
  return events.reduce<GenerateState>((acc, event) => generateReducer(acc, { type: "event", event }), state);
}

const phase = (seq: number, name: PhaseName = "generate", ts = 1_000): SseEvent => ({
  type: "phase",
  seq,
  phase: name,
  ts,
});

const summary = (seq: number, delta = "ok"): SseEvent => ({
  type: "thinking",
  seq,
  kind: "summary",
  delta,
});

const doneEvent = (seq: number, ms = 4_200): SseEvent => ({
  type: "done",
  seq,
  versionId: "v-test",
  stats: { fields: 8, errors: 1, repairs: 1, ms },
});

describe("generateReducer · 完整一轮（假帧驱动）", () => {
  const events = eventsFromFixture();
  const state = feed({ ...initialGenerateState, status: "streaming" }, events);

  it("假帧覆盖了 7 类事件", () => {
    const kinds = new Set(events.map((event) => event.type));
    expect([...kinds].sort()).toEqual(
      ["done", "field", "field_error", "phase", "repair", "thinking", "usage"].sort(),
    );
  });

  it("seq 严格递增 1..N，没有缺口、没有重复", () => {
    const seqs = events.map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    expect(state.lastSeq).toBe(events.length);
    expect(state.appliedCount).toBe(events.length);
  });

  it("终态是 done，且没有 seq 异常", () => {
    expect(state.status).toBe("done");
    expect(state.terminal).toEqual({
      kind: "done",
      seq: state.lastSeq,
      versionId: "v-fixture-preview",
      stats: { fields: 7, errors: 1, repairs: 1, ms: 4_200 },
    });
    expect(state.anomalies).toEqual([]);
  });

  it("四类事件都落到了各自的桶里", () => {
    expect(state.phases).toHaveLength(5);
    expect(state.thinking).toHaveLength(4);
    expect(state.fields).toHaveLength(7);
    expect(state.fieldErrors).toHaveLength(1);
    expect(state.repairs).toHaveLength(1);
    expect(state.usages).toHaveLength(1);
  });

  it("field_error 被同 index 的 field 补上后标记为已解决", () => {
    const [error] = state.fieldErrors;
    expect(error?.index).toBe(3);
    expect(error?.codes).toEqual(["E_ANSWER_MISSING"]);
    expect(error?.resolvedBySeq).not.toBeNull();
    expect(selectUnresolvedErrors(state).size).toBe(0);
  });

  it("终态后到达的事件被忽略（不会改写 stats）", () => {
    const after = generateReducer(state, { type: "event", event: phase(state.lastSeq + 1) });
    expect(after).toBe(state);
  });
});

describe("generateReducer · seq 乱序与跳号", () => {
  it("跳号先缓存、缺口补齐后按序应用，并留下可观察的异常", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(1) });
    // seq 3 先到（跳过了 2）
    state = generateReducer(state, { type: "event", event: doneEvent(3) });

    expect(state.lastSeq).toBe(1);
    expect(state.pending).toHaveLength(1);
    expect(state.terminal).toBeNull();
    expect(state.anomalies.map((anomaly) => anomaly.kind)).toEqual(["gap-buffered"]);

    // seq 2 补上 → 2 应用，随后排空 3
    state = generateReducer(state, { type: "event", event: summary(2) });

    expect(state.lastSeq).toBe(3);
    expect(state.pending).toHaveLength(0);
    expect(state.thinking).toHaveLength(1);
    expect(state.status).toBe("done");
    expect(state.anomalies.map((anomaly) => anomaly.kind)).toEqual([
      "gap-buffered",
      "out-of-order-drained",
    ]);
  });

  it("重复 seq 被丢弃并记一条 stale-dropped", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(1) });
    state = generateReducer(state, { type: "event", event: phase(1) });

    expect(state.phases).toHaveLength(1);
    expect(state.appliedCount).toBe(1);
    expect(state.anomalies).toHaveLength(1);
    expect(state.anomalies[0]?.kind).toBe("stale-dropped");
  });

  it("等待队列里的重复 seq 也只保留一条", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(1) });
    state = generateReducer(state, { type: "event", event: doneEvent(3) });
    state = generateReducer(state, { type: "event", event: doneEvent(3) });

    expect(state.pending).toHaveLength(1);
    expect(state.anomalies).toHaveLength(2);
  });

  it("缺口一直不补时事件停在 pending，不越序应用", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(2) });
    expect(state.phases).toHaveLength(0);
    expect(state.pending).toHaveLength(1);
    expect(state.lastSeq).toBe(0);
  });
});

describe("generateReducer · 终态、取消与失败", () => {
  it("error 事件 → status=error，保留可重试标记", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, {
      type: "event",
      event: { type: "error", seq: 1, code: "llm_timeout", message: "上游超时", retryable: true },
    });

    expect(state.status).toBe("error");
    expect(state.terminal).toEqual({
      kind: "error",
      seq: 1,
      code: "llm_timeout",
      message: "上游超时",
      retryable: true,
    });
  });

  it("llm_cancelled 走取消分支，不显示成错误", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, {
      type: "event",
      event: { type: "error", seq: 1, code: "llm_cancelled", message: "已取消", retryable: false },
    });

    expect(state.status).toBe("cancelled");
    expect(state.terminal?.kind).toBe("cancelled");
  });

  it("cancel 动作在流式中生效，任意阶段都能取消", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(1, "understand") });
    state = generateReducer(state, { type: "cancel" });

    expect(state.status).toBe("cancelled");
    expect(state.terminal?.kind).toBe("cancelled");
    if (state.terminal?.kind !== "cancelled") throw new Error("unreachable");
    expect(state.terminal.message).toContain("已取消");
  });

  it("cancel 在非流式状态下是 no-op（不会把 done 改成取消）", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(1) });
    state = generateReducer(state, { type: "event", event: doneEvent(2) });
    const after = generateReducer(state, { type: "cancel" });
    expect(after).toBe(state);
  });

  it("传输层失败 → error 终态", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "fail", code: "llm_upstream", message: "生成服务返回 502" });
    expect(state.status).toBe("error");
    expect(state.terminal).toMatchObject({ kind: "error", code: "llm_upstream" });
  });

  it("坏帧只记异常，不改变 status", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "malformed", reason: "invalid JSON" });
    expect(state.status).toBe("streaming");
    expect(state.anomalies[0]?.kind).toBe("malformed");
  });

  it("start 重置上一轮的全部状态", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = feed(state, eventsFromFixture());
    const restarted = generateReducer(state, { type: "start" });

    expect(restarted).toEqual({ ...initialGenerateState, status: "streaming" });
  });
});

describe("generateReducer · 缺号超时（tick 由 hook 侧注入时间）", () => {
  const T0 = 1_700_000_000_000;

  /** seq 1 之后直接送 seq 3：seq 2 丢了。 */
  function withGap(): GenerateState {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(1, "generate", 1_000) });
    state = generateReducer(state, { type: "event", event: summary(3, "迟到的那一段") });
    return state;
  }

  it("缺口刚被观测到：第一次 tick 只记起点，不动 pending", () => {
    let state = withGap();
    expect(state.pending.map((event) => event.seq)).toEqual([3]);
    expect(state.thinking).toHaveLength(0);

    state = generateReducer(state, { type: "tick", now: T0 });

    expect(state.gapSinceMs).toBe(T0);
    expect(state.pending.map((event) => event.seq)).toEqual([3]);
    expect(state.thinking).toHaveLength(0);
    expect(state.status).toBe("streaming");
  });

  it("等满阈值仍未到：跳过缺号、应用后续事件、anomaly 记 gap-skipped", () => {
    let state = withGap();
    state = generateReducer(state, { type: "tick", now: T0 });
    state = generateReducer(state, { type: "tick", now: T0 + 1_500 });
    // 1.5s 还在等：pending 不清、事件不应用
    expect(state.pending).toHaveLength(1);
    expect(state.thinking).toHaveLength(0);

    state = generateReducer(state, { type: "tick", now: T0 + GAP_SKIP_AFTER_MS + 1 });

    expect(state.pending).toHaveLength(0);
    expect(state.gapSinceMs).toBeNull();
    expect(state.lastSeq).toBe(3);
    expect(state.thinking).toHaveLength(1);
    expect(state.appliedCount).toBe(2);

    const skipped = state.anomalies.filter((anomaly) => anomaly.kind === "gap-skipped");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.seq).toBe(2);
    expect(skipped[0]?.note).toContain("3.0s");
    expect(skipped[0]?.note).toContain("已跳过 1 个号");
    // 跳过是我们主动放弃，不该混进"迟到归位"，否则排查时看不出是丢帧
    expect(state.anomalies.some((anomaly) => anomaly.kind === "out-of-order-drained")).toBe(false);
  });

  it("缺口在超时前补齐：pending 清空、gapSinceMs 归零，且记一条迟到归位", () => {
    let state = withGap();
    state = generateReducer(state, { type: "tick", now: T0 });
    expect(state.gapSinceMs).toBe(T0);

    state = generateReducer(state, { type: "event", event: summary(2, "补上的那一段") });

    expect(state.pending).toHaveLength(0);
    expect(state.gapSinceMs).toBeNull();
    expect(state.lastSeq).toBe(3);
    expect(state.thinking.map((entry) => entry.delta)).toEqual(["补上的那一段", "迟到的那一段"]);
    expect(state.anomalies.map((anomaly) => anomaly.kind)).toEqual([
      "gap-buffered",
      "out-of-order-drained",
    ]);
  });

  it("没有缺口时 tick 不产生新状态（同一个引用，避免无意义重渲染）", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(1) });

    expect(generateReducer(state, { type: "tick", now: T0 })).toBe(state);
  });

  it("终态之后 tick 是 no-op", () => {
    let state = generateReducer(initialGenerateState, { type: "start" });
    state = generateReducer(state, { type: "event", event: phase(1) });
    state = generateReducer(state, { type: "event", event: doneEvent(2) });

    expect(generateReducer(state, { type: "tick", now: T0 })).toBe(state);
  });
});

describe("selectPreviewFields", () => {
  it("字段桶里乱序时按 index 排序输出，第 3 题不会跑到第 5 题后面", () => {
    // 直接构造一个"桶里顺序是乱的"状态：真实链路上 seq 会保证到达顺序，
    // 但 PreviewPanel 不能依赖这一点（修复环会用新 seq 重发同一个 index）。
    const parsed = eventsFromFixture().filter((event) => event.type === "field");
    const fields = [...parsed]
      .reverse()
      .map((event, position) => (event.type === "field" ? { ...event, seq: position + 1 } : event));
    const state: GenerateState = {
      ...initialGenerateState,
      status: "streaming",
      fields: fields.flatMap((event) =>
        event.type === "field" ? [{ seq: event.seq, index: event.index, node: event.node, tMs: event.tMs }] : [],
      ),
    };
    const preview = selectPreviewFields(state);

    expect(preview.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("reducer 纯函数性", () => {
  it("同一个 state + 同一批 action 得到同样结果，且不改动入参", () => {
    const events = eventsFromFixture();
    const base = { ...initialGenerateState, status: "streaming" } satisfies GenerateState;
    const snapshot = JSON.stringify(base);

    const first = feed(base, events);
    const second = feed(base, events);

    expect(JSON.stringify(base)).toBe(snapshot);
    expect(first).toEqual(second);
  });

  it("actions 会被穷举处理（编译期保证）；这里只验证 reset", () => {
    const action: GenerateAction = { type: "reset" };
    expect(generateReducer({ ...initialGenerateState, status: "done" }, action)).toEqual(
      initialGenerateState,
    );
  });
});
