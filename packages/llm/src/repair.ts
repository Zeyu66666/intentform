/**
 * 修复（repair）：把坏行连同错误码回喂给模型，要它只重写这几行。
 *
 * 这一层刻意做成可注入的 `RepairHook`：
 * - 真实修复要打第二次上游请求，`replay`/`mock` 模式没有上游可打，所以默认实现
 *   在这两种模式下返回空（=没有进展），generate 据此停止后续轮次并如实报告 `failed`；
 * - 单测可以注入一个「假装修好了」的 hook，去验证**单调性判定**本身，而不必造上游。
 *
 * 提示词只回喂坏行而不是整份表单：整份回喂会让模型顺手重写已经通过的题，
 * 输出量翻倍且极易引入新的不一致。
 */

import type { ErrorCode } from "@intentform/schema";

import type { LlmRuntimeConfig } from "./config.ts";
import { LlmError } from "./errors.ts";
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
