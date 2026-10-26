/**
 * 修复（repair）：把坏行连同错误码回喂给模型，要它只重写这几行。
 *
 * 这一层刻意做成可注入的 `RepairHook`：
 * - 真实修复要打第二次上游请求，`replay` 模式没有上游可打（回放只能重放录下来的那段），
 *   所以默认实现返回空（=没有进展），generate 据此停止后续轮次并如实报告 `failed`；
 * - `mock` 模式有内置脚本，坏行与修法都是我们自己写的，所以给它一个**确定性**修复钩子
 *   （`createMockRepairHook`），让「校验失败 → 回喂 → 重发 → 通过」在 mock 里是真实路径；
 * - 单测可以注入一个「假装修好了」的 hook，去验证**单调性判定**本身，而不必造上游。
 *
 * 提示词只回喂坏行而不是整份表单：整份回喂会让模型顺手重写已经通过的题，
 * 输出量翻倍且极易引入新的不一致。
 */

import { isBloomLevel } from "@intentform/schema";
import type { ErrorCode } from "@intentform/schema";

import type { LlmRuntimeConfig } from "./config.ts";
import { LlmError } from "./errors.ts";
import { MOCK_BROKEN_LINE_ID } from "./sources.ts";
import { LineSplitter } from "./line-splitter.ts";
import type { ChatMessage, FetchLike } from "./provider.ts";
import { streamChatCompletion } from "./provider.ts";
import { buildSystemPrompt } from "./prompt.ts";

export interface FailedLine {
  /** 该行在本次流里的到达序号（从 0 开始，与 `field.index` 同一计数空间）。 */
  readonly index: number;
  readonly id: string;
  readonly raw: string;
  readonly codes: readonly ErrorCode[];
  readonly detail: string;
}

export interface RepairRequest {
  readonly requirement: string;
  /** 计划 §5：最多 2 轮。 */
  readonly round: 1 | 2;
  readonly lines: readonly FailedLine[];
}

/** 返回替换行（只包含请求里那些 id 的新版本）；返回空数组表示「没有进展」。 */
export type RepairHook = (request: RepairRequest) => Promise<readonly string[]>;

export interface RepairPromptOptions {
  readonly promptVersion: string;
}

/** 修复提示：逐条列出坏行 + 错误码 + 该修什么。 */
export function buildRepairMessages(
  request: RepairRequest,
  options: RepairPromptOptions,
): readonly ChatMessage[] {
  const failures = request.lines
    .map((line) =>
      [
        `第 ${String(line.index)} 行（id=${line.id === "" ? "<无>" : line.id}）错误码：${line.codes.join(", ")}`,
        `原因：${line.detail}`,
        `原文：${line.raw}`,
      ].join("\n"),
    )
    .join("\n\n");

  return [
    { role: "system", content: buildSystemPrompt(options.promptVersion) },
    {
      role: "user",
      content: [
        "原始需求：",
        request.requirement,
        "",
        "下面这些行没有通过校验。请**只重新输出这几行**（一行一个 JSON，不要解释、不要代码围栏），",
        "保持 id 不变，并修掉指出的问题：",
        "",
        failures,
      ].join("\n"),
    },
  ];
}

export interface ProviderRepairOptions {
  readonly fetchImpl?: FetchLike;
}

/**
 * 真实修复：打上游，收集整段输出，按行返回。
 *
 * 这里复用 `streamChatCompletion`（而不是非流式接口）只有一个原因：零依赖约束下
 * 只有一条上游实现，少一条分支就少一处「录制和修复走了不同代码」的风险。
 */
export function createProviderRepairHook(
  config: LlmRuntimeConfig,
  options: ProviderRepairOptions = {},
): RepairHook {
  return async (request: RepairRequest): Promise<readonly string[]> => {
    if (config.apiKey === null) {
      throw new LlmError("llm_config", "修复需要上游凭据", { detail: "apiKey is null" });
    }
    const messages = buildRepairMessages(request, { promptVersion: config.promptVersion });
    const splitter = new LineSplitter();
    const lines: string[] = [];
    for await (const event of streamChatCompletion(
      {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        model: config.model,
        timeoutMs: config.timeoutMs,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        seed: config.seed,
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      },
      messages,
    )) {
      if (event.kind !== "content") continue;
      for (const line of splitter.push(event.delta)) {
        if (line.trim() !== "") lines.push(line);
      }
    }
    for (const line of splitter.flush()) {
      if (line.trim() !== "") lines.push(line);
    }
    return lines;
  };
}

/** 没有上游可用时的修复实现：如实报告「没有进展」。 */
export const noopRepairHook: RepairHook = async () => [];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * `mock` 模式的确定性修复：只动内置脚本里那条坏行，且只动它错的那两个字段。
 *
 * 两条修法都对应「模型真实会犯的错」，且都能被规则机械地判对错：
 * - `bloom` 不在 6 级里 → 改成 `apply`（题目是计算题，本来就该是 apply）；
 * - `answer` 不在选项集合里 → 指到第一个选项（脚本里第一个选项就是正确的那一个）。
 *
 * 它不是测试桩——`generate` 会拿 `validateLine` 复核返回值，错误码必须严格收敛
 * 才算 `fixed`（见 `isStrictSubset`）。改不动就返回空数组 = 没有进展，照实报 `failed`。
 * 未知 id 一律不动：不猜别人的坏行，也不顺手重写已经通过的题。
 */
export function createMockRepairHook(): RepairHook {
  return async (request: RepairRequest): Promise<readonly string[]> => {
    const fixed: string[] = [];
    for (const line of request.lines) {
      if (line.id !== MOCK_BROKEN_LINE_ID) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line.raw);
      } catch {
        continue;
      }
      const node = asRecord(parsed);
      if (node === null) continue;
      const patch: Record<string, unknown> = {};
      if (!isBloomLevel(node["bloom"])) patch["bloom"] = "apply";
      const options = node["options"];
      const optionIds: string[] = [];
      if (Array.isArray(options)) {
        for (const option of options) {
          const id = asRecord(option)?.["id"];
          if (typeof id === "string") optionIds.push(id);
        }
      }
      const answer = node["answer"];
      const firstOptionId = optionIds[0];
      if (typeof answer === "string" && firstOptionId !== undefined && !optionIds.includes(answer)) {
        patch["answer"] = firstOptionId;
      }
      if (Object.keys(patch).length === 0) continue;
      fixed.push(JSON.stringify({ ...node, ...patch }));
    }
    return fixed;
  };
}
