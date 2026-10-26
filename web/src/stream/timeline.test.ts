import { describe, expect, it } from "vitest";

import { FIXTURE_FRAMES } from "./__fixtures__/fake-frames";
import { parseSseFrame } from "./frames";
import { generateReducer, initialGenerateState, type GenerateState } from "./generate-machine";
import { ANOMALY_LABELS, PHASE_LABELS, buildTimeline, formatMs, repairText } from "./timeline";

function stateFromFixture(): GenerateState {
  return FIXTURE_FRAMES.reduce<GenerateState>((acc, frame) => {
    const parsed = parseSseFrame(frame);
    if (parsed.kind !== "event") return acc;
    return generateReducer(acc, { type: "event", event: parsed.event });
  }, { ...initialGenerateState, status: "streaming" });
}

describe("PHASE_LABELS", () => {
  it("六个阶段加 prelude 都有中文标签（新增阶段会编译报错）", () => {
    expect(PHASE_LABELS.understand).toBe("理解需求");
    expect(PHASE_LABELS.plan).toBe("规划结构");
    expect(PHASE_LABELS.generate).toBe("逐字段生成");
    expect(PHASE_LABELS.validate).toBe("规则校验");
    expect(PHASE_LABELS.repair).toBe("定向修复");
    expect(PHASE_LABELS.done).toBe("收尾");
    expect(PHASE_LABELS.prelude).toBe("准备");
  });
});

describe("formatMs", () => {
  it("毫秒 → 人能扫读的字符串", () => {
    expect(formatMs(0)).toBe("0ms");
    expect(formatMs(870)).toBe("870ms");
    expect(formatMs(1_200)).toBe("1.2s");
    expect(formatMs(Number.NaN)).toBe("—");
  });
});

describe("buildTimeline", () => {
  const state = stateFromFixture();
  const timeline = buildTimeline(state);

  it("按 phase 事件分阶段，且顺序与事件一致", () => {
    expect(timeline.stages.map((stage) => stage.phase)).toEqual([
      "understand",
      "plan",
      "generate",
      "validate",
      "done",
    ]);
  });

  it("阶段耗时用相邻 phase.ts 相减；最后一段用 done.stats.ms", () => {
    const [understand, plan, generate, validate, done] = timeline.stages;
    // understand 起点 0，plan 在 +780
    expect(understand?.startsAtMs).toBe(0);
    expect(understand?.durationMs).toBe(780);
    // plan → generate(+1620)
    expect(plan?.durationMs).toBe(840);
    // generate → validate(+3560)
    expect(generate?.durationMs).toBe(1_940);
    // validate → done(+4120)
    expect(validate?.durationMs).toBe(560);
    // 最后一段：stats.ms(4200) − 相对入场(4120)
    expect(done?.startsAtMs).toBe(4_120);
    expect(done?.durationMs).toBe(80);
  });

  it("总耗时取 done.stats.ms", () => {
    expect(timeline.totalElapsedMs).toBe(4_200);
    expect(timeline.stats).toEqual({ fields: 7, errors: 1, repairs: 1, ms: 4_200 });
  });

  it("thinking 按 kind 分流：summary 一行，reasoning 拼原文", () => {
    const understand = timeline.stages[0];
    expect(understand?.summaries).toHaveLength(1);
    expect(understand?.summaries[0]).toContain("已理解需求");

    const plan = timeline.stages[1];
    expect(plan?.summaries).toHaveLength(0);
    expect(plan?.reasoningChunks).toBe(2);
    expect(plan?.reasoning).toContain("三个知识点");
    expect(plan?.reasoning).toContain("单选 4 道");
  });

  it("field 挂到它到达时正在进行的阶段，并带上 tMs", () => {
    const generate = timeline.stages[2];
    expect(generate?.fields).toHaveLength(7);
    expect(generate?.fields[0]?.index).toBe(0);
    expect(generate?.fields[0]?.typeLabel).toBe("分节");
    expect(generate?.fields[1]?.tMs).toBe(1_740);
  });

  it("field_error 带 ERROR_HINTS 文案而不是裸码，且标记已解决", () => {
    const generate = timeline.stages[2];
    const [error] = generate?.errors ?? [];
    expect(error?.codes).toEqual(["E_ANSWER_MISSING"]);
    expect(error?.hints[0]).toContain("填空题至少给 1 个非空答案");
    expect(error?.resolved).toBe(true);
    expect(error?.id).toBe("q-axis");
  });

  it("repair 显示「第 N 轮：E_X → 已修复」", () => {
    const generate = timeline.stages[2];
    expect(generate?.repairs[0]?.text).toBe("第 1 轮：E_ANSWER_MISSING → 已修复");
  });

  it("usage 挂到对应阶段", () => {
    const generate = timeline.stages[2];
    expect(generate?.usages).toHaveLength(1);
    expect(generate?.usages[0]?.completionTokens).toBe(466);
  });

  it("统计事件数与异常数，供界面上报", () => {
    expect(timeline.appliedCount).toBeGreaterThan(0);
    expect(timeline.anomalyCount).toBe(0);
  });
});

describe("buildTimeline · 边界", () => {
  it("空状态产出空时间线，不炸", () => {
    const timeline = buildTimeline(initialGenerateState);
    expect(timeline.stages).toEqual([]);
    expect(timeline.totalElapsedMs).toBeNull();
    expect(timeline.stats).toBeNull();
  });

  it("phase 之前的零星事件进 prelude，而不是被丢掉", () => {
    const state: GenerateState = {
      ...initialGenerateState,
      status: "streaming",
      thinking: [{ seq: 1, kind: "summary", delta: "开工" }],
      phases: [{ seq: 2, phase: "understand", ts: 1_000 }],
    };
    const timeline = buildTimeline(state);
    expect(timeline.stages.map((stage) => stage.phase)).toEqual(["prelude", "understand"]);
    expect(timeline.stages[0]?.summaries).toEqual(["开工"]);
  });

  it("同名阶段重复出现时标第 N 次（修复环会二次进入 generate）", () => {
    const state: GenerateState = {
      ...initialGenerateState,
      status: "streaming",
      phases: [
        { seq: 1, phase: "generate", ts: 1_000 },
        { seq: 2, phase: "validate", ts: 2_000 },
        { seq: 3, phase: "generate", ts: 3_000 },
      ],
    };
    const timeline = buildTimeline(state);
    expect(timeline.stages.map((stage) => stage.occurrence)).toEqual([1, 1, 2]);
    expect(timeline.stages[2]?.phase).toBe("generate");
  });

  it("流式中最后一个阶段耗时未知 → null（界面显示「进行中」）", () => {
    const state: GenerateState = {
      ...initialGenerateState,
      status: "streaming",
      phases: [{ seq: 1, phase: "generate", ts: 1_000 }],
    };
    const timeline = buildTimeline(state);
    expect(timeline.stages[0]?.durationMs).toBeNull();
    expect(timeline.totalElapsedMs).toBe(0);
  });
});

describe("repairText", () => {
  it("失败时列出剩余错误码", () => {
    expect(
      repairText({
        seq: 1,
        id: "q1",
        round: 2,
        codesBefore: ["E_ANSWER_MISSING"],
        codesAfter: ["E_OPTIONS_INVALID"],
        status: "failed",
      }),
    ).toBe("第 2 轮：E_ANSWER_MISSING → 仍失败（E_OPTIONS_INVALID）");
  });
});

describe("协议异常", () => {
  it("每种 seq 异常都有作者可读的中文名（新增 kind 会编译报错）", () => {
    expect(ANOMALY_LABELS["gap-buffered"]).toBe("跳号先缓存");
    expect(ANOMALY_LABELS["out-of-order-drained"]).toBe("迟到归位");
    expect(ANOMALY_LABELS["stale-dropped"]).toBe("过期丢弃");
    expect(ANOMALY_LABELS.malformed).toBe("坏帧");
    expect(ANOMALY_LABELS["gap-skipped"]).toBe("缺号跳过");
  });

  it("timeline.anomalies 把 kind 翻成 label 并保留 seq 与说明", () => {
    const state: GenerateState = {
      ...initialGenerateState,
      status: "streaming",
      anomalies: [
        { kind: "gap-buffered", seq: 3, note: "期待 seq 2，先收到 3" },
        {
          kind: "gap-skipped",
          seq: 2,
          note: "seq 2 等了 3.0s 仍未到达，已跳过 1 个号继续应用后续事件（这一帧确实丢了）",
        },
      ],
    };

    const timeline = buildTimeline(state);

    expect(timeline.anomalyCount).toBe(2);
    expect(timeline.anomalies.map((item) => item.label)).toEqual(["跳号先缓存", "缺号跳过"]);
    expect(timeline.anomalies[1]?.seq).toBe(2);
    expect(timeline.anomalies[1]?.note).toContain("这一帧确实丢了");
  });
});
