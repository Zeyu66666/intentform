/**
 * 覆盖矩阵补题：为「知识点 × 布鲁姆层级」生成**一道**候选题。
 *
 * 与 `suggestPatch` 的分工：
 * - `suggestPatch` 改已有题，返回 op 集；
 * - 这里只产出**一个** `FormItem`，不写库。教师确认后由编辑器发 `addItem`，
 *   所以模型永远没有直接改草稿的能力。
 *
 * `mock` 是确定性脚本（固定单选题），`replay` 没有录像时明确报错，
 * `live` / `record` 走上游。和生成链路一样，**不静默回落**。
 */

import {
  BLOOM_LEVELS,
  formItemSchema,
  type BloomLevel,
  type FormItem,
  type FormSchema,
} from "@intentform/schema";

import type { LlmRuntimeConfig } from "./config.ts";
import { LlmError } from "./errors.ts";
import type { ChatMessage, FetchLike } from "./provider.ts";
import { streamChatCompletion } from "./provider.ts";

export const SUPPLEMENT_PROMPT_VERSION = "supplement.v1";

const DEFAULT_SCORE = 5;

export function buildSupplementSystemPrompt(promptVersion: string = SUPPLEMENT_PROMPT_VERSION): string {
  return [
    `你是「意卷 IntentForm」的单题补题器（prompt ${promptVersion}）。`,
    "任务：为指定的知识点与布鲁姆层级补**一道**题，只输出一个 JSON 对象。",
    "",
    "输出协议（必须严格遵守）：",
    "1. 只输出**一行 JSON**，不要数组包装、不要代码围栏、不要解释文字。",
    "2. 字段：id / type / title / required / score / bloom / knowledgePoint / explanation。",
    "3. type 只能是 single / multi / fill / number / short；禁止 section 与 scale。",
    "4. bloom 必须是请求指定的层级；knowledgePoint 必须是请求指定的 id。",
    "5. single/multi 必须带 options（2–8 个，id 用小写字母/数字/下划线/连字符）与 answer；",
    "   fill 必须带 answer 字符串数组；number 必须带 {value,tolerance}；short 带 maxLength。",
    "6. score 是 0–10 的整数；quiz 的题必须给分值。",
    "7. explanation 用中文写清楚为什么是这个答案。",
    "",
    "样例（仅示范形状）：",
    '{"id":"q_supp","type":"single","title":"函数 y=x² 的顶点横坐标是？","required":true,"score":5,"bloom":"apply","knowledgePoint":"kp_vertex","explanation":"顶点式为 y=(x-0)²，对称轴 x=0。","options":[{"id":"a","text":"0"},{"id":"b","text":"1"}],"answer":"a"}',
  ].join("\n");
}

export interface SupplementInput {
  readonly config: LlmRuntimeConfig;
  readonly schema: FormSchema;
  readonly knowledgePoint: string;
  readonly bloom: BloomLevel;
  readonly instruction?: string;
  readonly fetchImpl?: FetchLike;
  readonly signal?: AbortSignal;
}

export function buildSupplementMessages(input: SupplementInput): readonly ChatMessage[] {
  const objective = input.schema.meta.objectives.find((entry) => entry.id === input.knowledgePoint);
  const existing = input.schema.items
    .filter((item) => item.type !== "section")
    .map((item) => `${item.type}「${item.title}」`)
    .join(" / ");
  const instruction = input.instruction === undefined || input.instruction === "" ? "（无额外要求）" : input.instruction;
  return [
    { role: "system", content: buildSupplementSystemPrompt() },
    {
      role: "user",
      content: [
        `表单标题：${input.schema.meta.title}`,
        `知识点：${input.knowledgePoint} ${objective?.name ?? ""}`.trim(),
        `布鲁姆层级：${input.bloom}（可选值：${BLOOM_LEVELS.join(" / ")}）`,
        `现有题目（避免重复）：${existing === "" ? "（无）" : existing}`,
        `额外要求：${instruction}`,
      ].join("\n"),
    },
  ];
}

/** 从模型输出里抠出 JSON 对象；只容忍代码围栏与前后空白。 */
export function extractSupplementJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LlmError("llm_invalid_output", "模型没有输出题目 JSON", { detail: "no braces" });
  }
  try {
    return JSON.parse(withoutFence.slice(start, end + 1)) as unknown;
  } catch (error) {
    throw new LlmError("llm_invalid_output", "模型输出的题目 JSON 解析失败", {
      detail: error instanceof Error ? error.message : "parse error",
    });
  }
}

/**
 * 校验模型给的题目，并把「作用域事实」（知识点/层级）钉死为请求值。
 *
 * 钉死不是纵容：模型如果把知识点写错，这道题即使加进去也不会被矩阵算到目标格，
 * 补题就失去意义。教师看到的是题目内容，作用域由请求决定。
 */
export type SupplementField = Exclude<FormItem, { readonly type: "section" | "scale" }>;

export function parseSupplementItem(
  payload: unknown,
  knowledgePoint: string,
  bloom: BloomLevel,
): SupplementField {
  const parsed = formItemSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new LlmError(
      "llm_invalid_output",
      `模型给的题目结构不合法：${issue?.message ?? "未知"}`,
      { detail: issue?.path.join(".") ?? "" },
    );
  }
  const item = parsed.data;
  if (item.type === "section" || item.type === "scale") {
    throw new LlmError("llm_invalid_output", "补题不能生成分节或量表");
  }
  if ((item.type === "single" || item.type === "multi") && item.answer !== undefined) {
    const ids = new Set(item.options.map((option) => option.id));
    const answers = item.type === "single" ? [item.answer] : item.answer;
    if (answers.some((answer) => !ids.has(answer))) {
      throw new LlmError("llm_invalid_output", "模型给的答案不在选项里");
    }
  }
  const normalized: SupplementField = {
    ...item,
    bloom,
    knowledgePoint,
    score: item.score ?? DEFAULT_SCORE,
  };
  return normalized;
}

/** mock：确定性单选题，题干带上知识点名称，证明链路通电，不假装模型理解。 */
export function mockSupplementItem(input: SupplementInput): FormItem {
  const objective = input.schema.meta.objectives.find((entry) => entry.id === input.knowledgePoint);
  const name = objective?.name ?? input.knowledgePoint;
  return formItemSchema.parse({
    id: "q_supp",
    type: "single",
    title: `${name}（${input.bloom}）练习`,
    required: true,
    score: DEFAULT_SCORE,
    bloom: input.bloom,
    knowledgePoint: input.knowledgePoint,
    explanation: "mock：补题脚本生成的占位题",
    options: [
      { id: "a", text: "选项 A" },
      { id: "b", text: "选项 B" },
    ],
    answer: "a",
  });
}

export interface SupplementResult {
  readonly item: FormItem;
  readonly source: "live" | "record" | "mock";
  readonly promptVersion: string;
}

export async function supplementItem(input: SupplementInput): Promise<SupplementResult> {
  if (input.config.mode === "mock") {
    return { item: mockSupplementItem(input), source: "mock", promptVersion: SUPPLEMENT_PROMPT_VERSION };
  }
  if (input.config.mode === "replay") {
    throw new LlmError("llm_config", "补题还没有回放录像（supplement.v1），请用 live 或 mock");
  }

  let text = "";
  for await (const event of streamChatCompletion(
    {
      baseUrl: input.config.baseUrl,
      apiKey: input.config.apiKey ?? "",
      model: input.config.model,
      timeoutMs: input.config.timeoutMs,
      maxTokens: input.config.maxTokens,
      temperature: input.config.temperature,
      seed: input.config.seed,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    },
    buildSupplementMessages(input),
    input.signal === undefined ? {} : { signal: input.signal },
  )) {
    if (event.kind === "content") text += event.delta;
  }

  return {
    item: parseSupplementItem(extractSupplementJson(text), input.knowledgePoint, input.bloom),
    source: input.config.mode === "record" ? "record" : "live",
    promptVersion: SUPPLEMENT_PROMPT_VERSION,
  };
}
