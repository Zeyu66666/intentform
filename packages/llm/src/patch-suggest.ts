/**
 * 「一句话改这份表单」：让模型输出**受限操作集**（R-03），而不是重发整份 JSON。
 *
 * 为什么不让模型直接改整份 schema：
 * - 整份重发时，只要模型少写一个字段，整卷就退化成"生成失败"；改一份已有表单的
 *   代价必须小于重生成，否则使用者宁可自己手改。
 * - 受限操作集只有六种 op，每一种都是可枚举、可校验、可撤销的。撤销能成立，前提
 *   正是"每一步改动都是一个有限集合里的元素"，而不是一坨自由文本。
 *
 * 与 `generate.ts` 的关系：两者都不信任模型，但**信任的方式不同**。
 * 生成是 NDJSON 逐行校验；这里是"整块 JSON → 结构校验 → 应用一次 → 跑一遍全表校验"，
 * 任何一步不过都不把 ops 交给调用方，而是在这里抛 `llm_invalid_output`。
 *
 * 已实现模式：`live` / `record`（同一路）、`mock`（内置脚本）。`replay` 暂缺录像，
 * 会显式报错而不是静默返回空改动——`patch.v1` 需要单独录，见 `docs/prompt-log/P08`。
 */

import { formSchema, patchOpsSchema, applyPatch } from "@intentform/schema";
import type { FormSchema, PatchChange, PatchOp } from "@intentform/schema";

import { LlmError } from "./errors.ts";
import type { LlmRuntimeConfig } from "./config.ts";
import type { FetchLike } from "./provider.ts";
import type { SourceLabel } from "./sources.ts";
import type { ChatMessage } from "./provider.ts";
import { streamChatCompletion } from "./provider.ts";
/** 提示词版本进日志与响应，不进回放键（patch 还没有回放）。 */
export const PATCH_PROMPT_VERSION = "patch.v1";

/** 一次建议最多接受多少条 op：防止模型把「重排整卷」写成几十条细碎移动。 */
export const MAX_SUGGESTED_OPS = 24;

export interface PatchSuggestInput {
  readonly config: LlmRuntimeConfig;
  readonly schema: FormSchema;
  readonly instruction: string;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: FetchLike;
}

export interface PatchSuggestResult {
  readonly ops: readonly PatchOp[];
  readonly changes: readonly PatchChange[];
  /** 实际生效的来源，界面据此显示「本次由 mock 脚本产生」。 */
  readonly source: SourceLabel;
  readonly promptVersion: string;
}

/** 指令定界块：指令是用户输入，必须当数据看，不能拼进系统提示的指令位置。 */
export const INSTRUCTION_OPEN = "<<<INSTRUCTION";
export const INSTRUCTION_CLOSE = "INSTRUCTION>>>";

/**
 * 系统提示。刻意把「六种 op 的完整形状 + 三条禁令」写在最前面，样例放最后：
 * 模型对末尾样例的服从度最高，而样例必须是合法 JSON（多一个逗号就整条失效）。
 */
export function buildPatchSystemPrompt(): string {
  return [
    `你是「意卷 IntentForm」的表单修改器（prompt ${PATCH_PROMPT_VERSION}）。`,
    "任务：把用户的一句中文修改要求，翻译成一个**受限操作集**。",
    "",
    "输出协议（必须严格遵守）：",
    '1. 只输出一个 JSON 对象：{"ops": [...]}。不要代码围栏、不要解释文字、不要注释。',
    `2. ops 最多 ${String(MAX_SUGGESTED_OPS)} 条；能一条改完的不要拆成多条。`,
    "3. 只能用下面六种 op，字段名一个都不能造：",
    '   - {"op":"setStem","itemId":"…","title":"新题干"}',
    '   - {"op":"setOptions","itemId":"…","options":[{"id":"a","text":"…"}]}（整组替换，不是追加）',
    '   - {"op":"setScore","itemId":"…","score":5}（整数；简答题也可以带分值，表示人工批改额度）',
    '   - {"op":"addItem","index":0,"item":{…完整的 FormItem…}}（index 从 0 开始，0 表示插到最前）',
    '   - {"op":"removeItem","itemId":"…"}',
    '   - {"op":"moveItem","itemId":"…","toIndex":2}',
    "4. 不许改 section 的题干以外的任何东西；不许给 survey 加 answer/score；不许编造不存在的 itemId。",
    "5. 如果用户的这句话用这六种 op 表达不了（比如「把整卷改成英语」），就输出 {\"ops\": []}，不要硬凑。",
    "",
    "样例（把第 2 题分值改成 8 分、并把它的题干换成新说法）：",
    '{"ops":[{"op":"setScore","itemId":"q_2","score":8},{"op":"setStem","itemId":"q_2","title":"下列哪个是质数？"}]}',
  ].join("\n");
}

/** 把当前表单压成「模型够用的最小事实」：id / 题型 / 题干 / 分值 / 选项 id。 */
export function describeForm(schema: FormSchema): string {
  const lines = schema.items.map((item, index) => {
    const parts = [`#${String(index)}`, `id=${item.id}`, `type=${item.type}`, `title=${item.title}`];
    if ("score" in item && item.score !== undefined) parts.push(`score=${String(item.score)}`);
    if ((item.type === "single" || item.type === "multi") && Array.isArray(item.options)) {
      parts.push(`options=${item.options.map((option) => option.id).join(",")}`);
    }
    return parts.join(" ");
  });
  return [`卷名：${schema.meta.title}`, `满分：${String(schema.meta.totalScore)}`, ...lines].join("\n");
}

export function buildPatchMessages(schema: FormSchema, instruction: string): readonly ChatMessage[] {
  return [
    { role: "system", content: buildPatchSystemPrompt() },
    {
      role: "user",
      content: `${describeForm(schema)}\n\n${INSTRUCTION_OPEN}\n${instruction}\n${INSTRUCTION_CLOSE}`,
    },
  ];
}

/**
 * 从模型输出里抠出那个 JSON 对象。模型偶尔会包 ```json 围栏或前后加一句客气话，
 * 所以退一步找最外层的 `{...}`——但**只做这一种宽容**，不做"猜它想说什么"。
 */
export function extractOpsJson(text: string): unknown {
  const trimmed = text.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = withoutFence.indexOf("{");
  const end = withoutFence.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new LlmError("llm_invalid_output", "模型没有输出 JSON 对象", { detail: "no braces" });
  }
  const slice = withoutFence.slice(start, end + 1);
  try {
    return JSON.parse(slice) as unknown;
  } catch (error) {
    throw new LlmError("llm_invalid_output", "模型输出的 JSON 解析失败", {
      detail: error instanceof Error ? error.message : "parse error",
    });
  }
}

/**
 * mock 的确定性脚本：不改题干（那会让 demo 看起来像"模型真的懂了"），
 * 只做两件可验证的事——把第 1 题题干加一个后缀、把一个判分题的分值 +1（封顶 10）。
 * 它证明的是「链路能产出合法 ops 并算出差异」，不证明任何语义理解。
 */
export function mockPatchOps(schema: FormSchema): readonly PatchOp[] {
  const ops: PatchOp[] = [];
  const first = schema.items[0];
  if (first !== undefined) {
    ops.push({ op: "setStem", itemId: first.id, title: `${first.title}（mock 改写）` });
  }
  const scored = schema.items.find(
    (item) => "score" in item && typeof item.score === "number" && item.score < 10,
  );
  if (scored !== undefined && "score" in scored && typeof scored.score === "number") {
    ops.push({ op: "setScore", itemId: scored.id, score: Math.min(scored.score + 1, 10) });
  }
  return ops;
}

/** 把 ops 落到表单上并算出人话级差异；不合法就抛，不把半成品交给上层。 */
export function applySuggestedOps(
  schema: FormSchema,
  ops: readonly PatchOp[],
): readonly PatchChange[] {
  if (ops.length === 0) return [];
  const applied = applyPatch(schema, ops);
  if (applied.ok === false) {
    const first = applied.errors[0];
    throw new LlmError("llm_invalid_output", `建议的改动没法应用：${first?.message ?? "未知原因"}`, {
      detail: `op#${String(first?.opIndex ?? 0)} ${first?.code ?? ""}`,
    });
  }
  return applied.changes;
}

/** 校验模型给的 ops 形状：判据是 `patchOpsSchema`，与本文件之外的契约同源。 */
export function parseOpsPayload(payload: unknown): readonly PatchOp[] {
  const record = payload as { ops?: unknown } | null;
  const candidate = record !== null && typeof record === "object" ? record.ops : undefined;
  if (candidate === undefined) {
    throw new LlmError("llm_invalid_output", "模型输出里没有 ops 字段", { detail: "missing ops" });
  }
  const parsed = patchOpsSchema.safeParse(candidate);
  if (parsed.success === false) {
    const issue = parsed.error.issues[0];
    throw new LlmError("llm_invalid_output", `ops 结构不合法：${issue?.message ?? "未知"}`, {
      detail: issue?.path.join(".") ?? "",
    });
  }
  if (parsed.data.length > MAX_SUGGESTED_OPS) {
    throw new LlmError("llm_invalid_output", `一次建议超过 ${String(MAX_SUGGESTED_OPS)} 条操作`);
  }
  return parsed.data;
}

/** 一条建议：模式分派 + 上游聚合 + 三重校验（JSON / ops 结构 / 能否应用）。 */
export async function suggestPatch(input: PatchSuggestInput): Promise<PatchSuggestResult> {
  const { config, schema, instruction } = input;
  // 表单本身必须先是合法的——否则"改进"的基准不存在，报错该指向调用方而不是模型。
  if (formSchema.safeParse(schema).success === false) {
    throw new LlmError("llm_invalid_output", "当前草稿结构不合法，先修好再让模型改");
  }

  if (config.mode === "mock") {
    const ops = mockPatchOps(schema);
    return {
      ops,
      changes: applySuggestedOps(schema, ops),
      source: "mock",
      promptVersion: PATCH_PROMPT_VERSION,
    };
  }

  if (config.mode === "replay") {
    // 不静默返回空改动：那会让界面显示"改完了但什么都没变"，比报错更难查。
    throw new LlmError("llm_config", "受限修改建议还没有回放录像（patch.v1），请用 live 或 mock");
  }

  const messages = buildPatchMessages(schema, instruction);
  let text = "";
  for await (const event of streamChatCompletion(
    {
      baseUrl: config.baseUrl,
      apiKey: config.apiKey ?? "",
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxTokens: config.maxTokens,
      temperature: config.temperature,
      seed: config.seed,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
    },
    messages,
    input.signal === undefined ? {} : { signal: input.signal },
  )) {
    if (event.kind === "content") text += event.delta;
  }

  const ops = parseOpsPayload(extractOpsJson(text));
  return {
    ops,
    changes: applySuggestedOps(schema, ops),
    source: config.mode === "record" ? "record" : "live",
    promptVersion: PATCH_PROMPT_VERSION,
  };
}
