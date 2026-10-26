/**
 * 逐行校验：把上游吐出来的一行文本判成「可用节点」或「带错误码的坏行」。
 *
 * 为什么不在整表单层面用 `validateForm()` 一把梭：流式输出时表单还不存在，
 * 一行坏掉不应该牵连其它行（前端要把坏行标红、其余照常渲染）。所以这里的判定
 * 只依赖「这一行 + 已出现过的 id 集合」，整表单规则（分值合计、知识点引用）
 * 留到 I4 落库前再做。
 *
 * 错误码只能取自 `ERROR_CODES`。Zod 的 issue 到这里被归并成少数几个语义码，
 * 因为前端与 repairer 都按码分支，发散成几十个码等于没有码。
 */

import { ERROR_CODES, formItemSchema, LIMITS } from "@intentform/schema";

import type { ErrorCode } from "@intentform/schema";
import { asRecord, readString, tryParseJson } from "./json.ts";

/** `formItemSchema.parse()` 的产物：事件 `field.node` 要的就是这个可变形态。 */
export type GeneratedNode = ReturnType<typeof formItemSchema.parse>;

export interface LineAccepted {
  readonly ok: true;
  readonly node: GeneratedNode;
  readonly id: string;
}

export interface LineRejected {
  readonly ok: false;
  /** 能从坏行里抠出 id 就填，否则空串（契约不允许 null）。 */
  readonly id: string;
  readonly codes: readonly ErrorCode[];
  /** 截断到 `LIMITS.rawLineMax` 的原文片段。 */
  readonly raw: string;
  /** 只进日志的人话描述。 */
  readonly detail: string;
}

export type LineValidation = LineAccepted | LineRejected;

const ERROR_CODE_SET: ReadonlySet<string> = new Set<string>(ERROR_CODES);

/**
 * 稳定地把 code 列表去重并按 `ERROR_CODES` 的声明顺序排序。
 * 顺序稳定才能比较「错误码集合是否严格变小」——顺序抖动会让两个相同集合判成不同。
 */
export function normalizeCodes(codes: readonly ErrorCode[]): readonly ErrorCode[] {
  const seen = new Set<ErrorCode>();
  for (const code of codes) {
    if (ERROR_CODE_SET.has(code)) seen.add(code);
  }
  return ERROR_CODES.filter((code) => seen.has(code));
}

/** `raw` 截断。用字符切片而不是字节，因为契约里的上限是「字符数」。 */
export function truncateRaw(raw: string): string {
  if (raw.length <= LIMITS.rawLineMax) return raw;
  return raw.slice(0, LIMITS.rawLineMax);
}

/**
 * 从坏行里抠 id。不用正则去「猜半个 JSON」：先用 `JSON.parse`，失败再退化成
 * 抓第一个 `"id":"..."`，两段都失败就返回空串。目的是让前端的占位槽能标红。
 */
export function extractCandidateId(raw: string): string {
  const parsed = tryParseJson(raw);
  if (parsed.ok) {
    const record = asRecord(parsed.value);
    if (record !== undefined) {
      const id = readString(record, "id");
      if (id !== undefined) return id;
    }
  }
  const match = /"id"\s*:\s*"([^"\\]{1,64})"/.exec(raw);
  return match?.[1] ?? "";
}

export interface ValidateLineOptions {
  /**
   * 本次生成已经出现过的 id（含分节）。用于在流式阶段就抓重复 id，
   * 而不是等整表单拼完再回炉。
   */
  readonly seenIds?: ReadonlySet<string>;
  /** `survey` 只收集不判分：带 `answer`/`score` 的题要被拒。 */
  readonly kind?: "quiz" | "survey";
}

/** 把 Zod issue 归并成语义码。永远带着 `E_SCHEMA_SHAPE`，再按路径补充具体码。 */
function codesFromIssues(
  issues: readonly { readonly path: readonly (string | number)[]; readonly code: string }[],
): readonly ErrorCode[] {
  const codes = new Set<ErrorCode>(["E_SCHEMA_SHAPE"]);
  for (const issue of issues) {
    const path = issue.path.join(".");
    if (path.includes("bloom")) codes.add("E_BLOOM_INVALID");
    if (path.includes("options")) codes.add("E_OPTIONS_INVALID");
    if (path.includes("answer")) {
      if (issue.code === "invalid_type" || issue.code === "too_small") {
        codes.add("E_ANSWER_MISSING");
      } else {
        codes.add("E_ANSWER_NOT_IN_OPTIONS");
      }
    }
    if (path.includes("knowledgePoint")) codes.add("E_KP_UNKNOWN");
  }
  return normalizeCodes([...codes]);
}

const SCORED_OR_ANSWERED: ReadonlySet<string> = new Set(["single", "multi", "fill", "number"]);

/** 逐行判定。纯函数，不读时钟、不碰 IO，所以能直接在单测里穷举输入。 */
export function validateLine(raw: string, options: ValidateLineOptions = {}): LineValidation {
  const parsed = tryParseJson(raw);
  if (!parsed.ok) {
    return {
      ok: false,
      id: extractCandidateId(raw),
      codes: normalizeCodes(["E_SCHEMA_SHAPE"]),
      raw: truncateRaw(raw),
      detail: `not JSON: ${parsed.reason}`,
    };
  }

  const result = formItemSchema.safeParse(parsed.value);
  if (!result.success) {
    return {
      ok: false,
      id: extractCandidateId(raw),
      codes: codesFromIssues(result.error.issues),
      raw: truncateRaw(raw),
      detail: result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    };
  }

  const node = result.data;
  const extra: ErrorCode[] = [];
  if (options.seenIds?.has(node.id) === true) extra.push("E_DUP_ID");
  if (options.kind === "survey" && SCORED_OR_ANSWERED.has(node.type)) {
    extra.push("E_SURVEY_HAS_ANSWER");
  }

  if (extra.length > 0) {
    return {
      ok: false,
      id: node.id,
      codes: normalizeCodes(extra),
      raw: truncateRaw(raw),
      detail: `semantic: ${extra.join(",")}`,
    };
  }

  return { ok: true, node, id: node.id };
}

/**
 * 两个错误码集合是否满足「严格变小」：`after ⊂ before` 且真子集。
 *
 * 单独抽出来是因为它是最容易写错的一行判定：`after.length < before.length` 不够
 * （可能换成了另一个错），`after ⊆ before` 也不够（可能一个没修好）。
 */
export function isStrictSubset(
  after: readonly ErrorCode[],
  before: readonly ErrorCode[],
): boolean {
  const beforeSet = new Set<ErrorCode>(before);
  if (after.length >= before.length) return false;
  return after.every((code) => beforeSet.has(code));
}
