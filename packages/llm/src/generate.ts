/**
 * 生成编排：需求 → 事件体序列（`SseEventBody`，未挂 `seq`）。
 *
 * 三条不变量：
 * 1. **事件只在这里构造**。server 层只做「挂 seq + 写帧 + 心跳」，前端拿不到 HTTP
 *    细节；换传输（WebSocket、IPC）时这一层不用改。
 * 2. **坏行不掐流**。逐行校验失败发 `field_error` 并继续读后面，只有「一个字段都
 *    没成功」时才终结为 `llm_invalid_output`。
 * 3. **修复必须单调**。每轮 `codesAfter ⊂ codesBefore` 才算前进，否则立即停止并
 *    如实发 `status: "failed"`——「越修越错」比不修更危险，因为它让人以为在收敛。
 */

import {
  LIMITS,
  SCHEMA_VERSION,
  compareWithBlueprint,
  inferFormKind,
  summarizeBlueprint,
  type FormBlueprint,
} from "@intentform/schema";
import type { ErrorCode, FormKind, SseEventBody } from "@intentform/schema";

import type { LlmRuntimeConfig } from "./config.ts";
import { LlmError, toErrorEventBody } from "./errors.ts";
import { silentLogger } from "./logger.ts";
import type { LlmLogger } from "./logger.ts";
import { LineSplitter } from "./line-splitter.ts";
import { createMockRepairHook, createProviderRepairHook, noopRepairHook } from "./repair.ts";
import type { FailedLine, RepairHook } from "./repair.ts";
import { replayKey } from "./replay-key.ts";
import {
  createLiveSource,
  createMockSource,
  createRecordSource,
  createReplaySource,
} from "./sources.ts";
import type { Clock, DeltaSource } from "./sources.ts";
import type { TokenUsage } from "./provider.ts";
import { runPublishGate } from "./publish-gate.ts";
import { isStrictSubset, normalizeCodes, validateLine } from "./validate-line.ts";
import type { GeneratedNode } from "./validate-line.ts";

/** 生成结果的占位版本 id：I2 没有数据库，但契约要求非空字符串。 */
export function placeholderVersionId(requirement: string, model: string): string {
  const hash = replayKey({
    requirement,
    model,
    promptVersion: "version-id",
    schemaVersion: SCHEMA_VERSION,
  });
  return `gen_${hash.slice(0, 16)}`;
}

/**
 * 从需求猜表单类型。R-05 起实现搬进 `@intentform/schema`（澄清层要用同一套词表，
 * 两处各写一份必然漂移），这里保留同名 re-export，调用方不用改。
 */
export { inferFormKind };

export interface GenerateOptions {
  readonly requirement: string;
  readonly signal?: AbortSignal;
  readonly kind?: FormKind;
  /**
   * 已确认的蓝图（省赛 R-06）。有它才发 `plan` 阶段——蓝图是教师确认后才开始生成，
   * 这个阶段因此是**真实发生**的；没有蓝图时不许在时间线上演出（只发真实事件）。
   */
  readonly blueprint?: FormBlueprint;
  /**
   * 澄清说明（省赛 R-05）：教师补答了几项之后，路由把它压成一句人话传进来。
   * 有值才发那条 `thinking`——没澄清就不许在时间线上演出澄清（只发真实事件）。
   * 它**不影响回放键**：键只认 `requirement` 原文（补答已拼进那一串里）。
   */
  readonly clarifyNote?: string;
}

export interface GeneratorDeps {
  readonly config: LlmRuntimeConfig;
  /** 注入来源（测试用）。不传则按 `config.mode` 选择。 */
  readonly source?: DeltaSource;
  /** 修复实现。不传时 live/record 走真实上游，其余模式不修复。 */
  readonly repair?: RepairHook;
  readonly logger?: LlmLogger;
  readonly clock?: Clock;
}

/** 按模式挑来源。非法模式在 `resolveLlmMode()` 那一步就已经抛过了。 */
export function resolveSource(config: LlmRuntimeConfig, clock: Clock = Date.now): DeltaSource {
  switch (config.mode) {
    case "live":
      return createLiveSource(config, { clock });
    case "record":
      return createRecordSource(config, { clock });
    case "replay":
      return createReplaySource(config, { clock });
    case "mock":
      return createMockSource({ clock, chunkDelayMs: 0 });
  }
}

interface AcceptedField {
  readonly index: number;
  readonly node: GeneratedNode;
}

/** 一行校验后的归类结果。 */
type LineOutcome =
  | { readonly kind: "accepted"; readonly field: AcceptedField }
  | { readonly kind: "rejected"; readonly failure: FailedLine };

export interface GenerationSummary {
  readonly fields: number;
  readonly errors: number;
  readonly repairs: number;
  readonly ms: number;
}

/**
 * 核心编排。产出 `SseEventBody`，**最后一个**一定是 `done` 或 `error`。
 *
 * 用异步生成器而不是回调：server 侧要按帧写、测试侧要按序列断言，两者都只需要
 * `for await` 一个循环，不需要自己维护状态机。
 */
export async function* generateForm(
  deps: GeneratorDeps,
  options: GenerateOptions,
): AsyncGenerator<SseEventBody, void, undefined> {
  const clock = deps.clock ?? Date.now;
  const logger = deps.logger ?? silentLogger;
  const startedAt = clock();
  const requirement = options.requirement;
  const kind = options.kind ?? inferFormKind(requirement);
  const source = deps.source ?? resolveSource(deps.config, clock);
  const repair = deps.repair ?? defaultRepairFor(deps.config);

  const streamInput: {
    readonly requirement: string;
    readonly startedAt: number;
    readonly signal?: AbortSignal;
    readonly blueprint?: FormBlueprint;
  } = {
    requirement,
    startedAt,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.blueprint === undefined ? {} : { blueprint: options.blueprint }),
  };

  yield { type: "phase", phase: "understand", ts: clock() };
  yield {
    type: "thinking",
    kind: "summary",
    delta: `读取需求：${String(requirement.length)} 字，判定为 ${kind === "quiz" ? "考卷" : "问卷"}`,
  };
  if (options.clarifyNote !== undefined && options.clarifyNote !== "") {
    // 真实发生过：教师在生成前补答了这些槽位。事件类型不新增，仍走 thinking。
    yield { type: "thinking", kind: "summary", delta: options.clarifyNote };
  }
  if (options.blueprint !== undefined) {
    yield { type: "phase", phase: "plan", ts: clock() };
    yield {
      type: "thinking",
      kind: "summary",
      delta: `蓝图已确认：${summarizeBlueprint(options.blueprint)}`,
    };
  }
  yield { type: "thinking", kind: "summary", delta: `按 ${source.label} 模式开始生成` };
  yield { type: "phase", phase: "generate", ts: clock() };

  const fields: AcceptedField[] = [];
  const failures: FailedLine[] = [];
  const seenIds = new Set<string>();
  const splitter = new LineSplitter();
  let usage: TokenUsage | null = null;
  let slot = 0;
  let repairs = 0;

  const acceptLine = (raw: string): LineOutcome => {
    if (fields.length >= LIMITS.fieldsMax) {
      return {
        kind: "rejected",
        failure: {
          index: slot,
          id: "",
          raw: raw.slice(0, LIMITS.rawLineMax),
          codes: normalizeCodes(["E_SCHEMA_SHAPE"]),
          detail: `超过单表单节点上限 ${String(LIMITS.fieldsMax)}`,
        },
      };
    }
    const outcome = validateLine(raw, { seenIds, kind });
    if (outcome.ok) {
      seenIds.add(outcome.id);
      const field: AcceptedField = { index: fields.length, node: outcome.node };
      fields.push(field);
      slot += 1;
      return { kind: "accepted", field };
    }
    const failure: FailedLine = {
      index: slot,
      id: outcome.id,
      raw: outcome.raw,
      codes: outcome.codes,
      detail: outcome.detail,
    };
    failures.push(failure);
    slot += 1;
    return { kind: "rejected", failure };
  };

  try {
    for await (const delta of source.stream(streamInput)) {
      if (delta.kind === "usage") {
        usage = delta.usage;
        continue;
      }
      for (const line of splitter.push(delta.delta)) {
        if (line.trim() === "") continue;
        const outcome = acceptLine(line);
        if (outcome.kind === "accepted") {
          yield {
            type: "field",
            index: outcome.field.index,
            node: outcome.field.node,
            tMs: delta.tMs,
          };
        } else {
          yield fieldErrorEvent(outcome.failure);
        }
      }
    }
    for (const line of splitter.flush()) {
      if (line.trim() === "") continue;
      const outcome = acceptLine(line);
      if (outcome.kind === "accepted") {
        yield { type: "field", index: outcome.field.index, node: outcome.field.node, tMs: clock() - startedAt };
      } else {
        yield fieldErrorEvent(outcome.failure);
      }
    }

    yield { type: "phase", phase: "validate", ts: clock() };
    yield {
      type: "thinking",
      kind: "summary",
      delta: `校验完成：${String(fields.length)} 个节点通过，${String(failures.length)} 行失败`,
    };

    if (failures.length > 0) {
      yield { type: "phase", phase: "repair", ts: clock() };
      for (const round of [1, 2] as const) {
        const pending = failures.slice();
        if (pending.length === 0) break;
        let replacements: readonly string[];
        try {
          replacements = await repair({ requirement, round, lines: pending });
        } catch (error) {
          logger("warn", "repair hook failed", error instanceof Error ? error.message : String(error));
          break;
        }
        if (replacements.length === 0) break;

        let progressed = false;
        for (const failure of pending) {
          const replacement = replacements.find((line) => validateLine(line).id === failure.id);
          const afterCodes: readonly ErrorCode[] =
            replacement === undefined
              ? failure.codes
              : (() => {
                  const outcome = validateLine(replacement, { seenIds, kind });
                  return outcome.ok ? [] : outcome.codes;
                })();
          const fixed = replacement !== undefined && isStrictSubset(afterCodes, failure.codes);
          if (fixed && replacement !== undefined) {
            const outcome = validateLine(replacement, { seenIds, kind });
            if (outcome.ok) {
              seenIds.add(outcome.id);
              const field: AcceptedField = { index: fields.length, node: outcome.node };
              fields.push(field);
              repairs += 1;
              progressed = true;
              yield { type: "field", index: field.index, node: field.node, tMs: clock() - startedAt };
            }
            removeFailure(failures, failure.id);
          }
          yield {
            type: "repair",
            id: failure.id === "" ? `line_${String(failure.index)}` : failure.id,
            round,
            codesBefore: [...failure.codes],
            codesAfter: [...normalizeCodes(afterCodes)],
            status: fixed ? "fixed" : "failed",
          };
        }
        if (!progressed) break;
      }
    }

    // 整表门禁（《计划 v3.0》§2.5）：逐行合法的节点拼起来未必是一份能发的表。
    // 不通过就**不发 `done`**（§3.6）——发布一个带错答案的整表，比报错更伤用户。
    const gate = runPublishGate(fields, kind);
    if (!gate.ok) {
      for (const itemError of gate.itemErrors) {
        yield {
          type: "field_error",
          index: itemError.index,
          id: itemError.id,
          codes: [...itemError.codes],
          raw: itemError.raw,
        };
      }
      const problems = [
        ...gate.itemErrors.map(
          (itemError) => `${itemError.id}: ${itemError.codes.join("/")}`,
        ),
        ...gate.formErrors.map((error) => `${error.path}: ${error.code}`),
      ];
      throw new LlmError("llm_invalid_output", "整表校验未通过，已停止发布；请按提示修正后重试", {
        detail: `rejected ${String(failures.length)} lines; gate: ${problems.join(" | ")}`,
      });
    }

    if (options.blueprint !== undefined) {
      // 蓝图 vs 成品：真实发生的偏差，写进时间线。数与判定都在 schema 的纯函数里，
      // eval 报告用的是同一份口径。
      const deviation = compareWithBlueprint(options.blueprint, {
        items: fields.map((field) => field.node),
        totalScore: fields.reduce(
          (sum, field) => sum + ("score" in field.node ? (field.node.score ?? 0) : 0),
          0,
        ),
        objectives: options.blueprint.knowledgePoints.map((point) => ({ id: point.id, name: point.name })),
      });
      yield {
        type: "thinking",
        kind: "summary",
        delta: `蓝图对照：题量 ${String(options.blueprint.totalCount)} → ${String(fields.length)}（差 ${String(deviation.countDelta)}）；总分差 ${String(deviation.scoreDelta)}；${deviation.isExact ? "题型与知识点完全对上" : "结构与蓝图有偏差"}`,
      };
    }

    const totalMs = clock() - startedAt;
    const resolvedUsage = usage ?? estimateUsage(requirement, fields);
    yield {
      type: "usage",
      promptTokens: resolvedUsage.promptTokens,
      completionTokens: resolvedUsage.completionTokens,
      ms: totalMs,
    };
    yield { type: "phase", phase: "done", ts: clock() };
    yield {
      type: "done",
      versionId: placeholderVersionId(requirement, deps.config.model),
      stats: {
        fields: fields.length,
        errors: failures.length,
        repairs,
        ms: totalMs,
      },
    };
  } catch (error) {
    if (options.signal?.aborted === true && !(error instanceof LlmError)) {
      yield toErrorEventBody(new LlmError("llm_cancelled", "生成已被取消"));
      return;
    }
    logger("warn", "generation failed", error instanceof Error ? error.message : String(error));
    yield toErrorEventBody(error);
  }
}

function fieldErrorEvent(failure: FailedLine): SseEventBody {
  return {
    type: "field_error",
    index: failure.index,
    id: failure.id,
    codes: [...failure.codes],
    raw: failure.raw.slice(0, LIMITS.rawLineMax),
  };
}

function removeFailure(failures: FailedLine[], id: string): void {
  const index = failures.findIndex((failure) => failure.id === id);
  if (index !== -1) failures.splice(index, 1);
}

/** 上游没给 usage 时的粗略估算：中文约 2 字符/token。只用于看板，不参与计费。 */
function estimateUsage(requirement: string, fields: readonly AcceptedField[]): TokenUsage {
  const completion = Math.ceil(JSON.stringify(fields.map((field) => field.node)).length / 2);
  return { promptTokens: Math.ceil(requirement.length / 2) + 240, completionTokens: completion };
}

function defaultRepairFor(config: LlmRuntimeConfig): RepairHook {
  if (config.mode === "live" || config.mode === "record") return createProviderRepairHook(config);
  // mock 的坏行是内置脚本自己写的，修法也自己知道；replay 没有第二次上游可打，只能如实报失败。
  if (config.mode === "mock") return createMockRepairHook();
  return noopRepairHook;
}
