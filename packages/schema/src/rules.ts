/**
 * 语义规则 R1–R8（计划 v1.1 附录 A.2）。
 *
 * 分层原则：`types.ts` 负责**结构**（字段有没有、类型对不对），这里负责**跨字段语义**
 * （id 是否重复、答案是否指向选项、分值是否合计、知识点是否已声明）。
 *
 * R7（LaTeX 可解析）通过 `ValidateOptions.checkLatex` 注入：这样本文件不直接依赖
 * KaTeX，单测可以注入假实现来测「发现了错误」，而不必关心 KaTeX 本身的行为。
 * 生产路径上 `index.ts` 会把 `latex.ts` 的真实实现作为默认值传进来。
 */

import type { ZodError } from "zod";

import { schemaError, type SchemaError } from "./errors.ts";
import { formSchema } from "./types.ts";
import type { FormItem, FormSchema, ScoredField } from "./types.ts";

/** LaTeX 校验函数：返回 `null` 表示可解析，返回字符串表示错误原因。 */
export type LatexChecker = (text: string) => string | null;

export interface ValidateOptions {
  /** R7 的实现。缺省时不检查 LaTeX（单测注入假实现，生产由 index 装配）。 */
  readonly checkLatex?: LatexChecker;
}

export type ValidationResult =
  | { readonly ok: true; readonly data: FormSchema }
  | { readonly ok: false; readonly errors: readonly SchemaError[] };

/**
 * 「可判分题型」：选择题 / 填空 / 数值。
 *
 * 注意它与「这道题**带不带**答案、带不带分值」是两件事——《计划 v3.0》附录 A 之后
 * 结构上四项都可选，一道 single 可能既没 score 也没 answer（survey 里的选择题就该这样）。
 * 所以判断 kind 约束时要同时看 `type` 与字段是否存在，不能只看 type。
 */
function isScoredItem(item: FormItem): item is ScoredField {
  return (
    item.type === "single" ||
    item.type === "multi" ||
    item.type === "fill" ||
    item.type === "number"
  );
}

/** 取值：没有分值的题按 0 计（survey 无分值语义）。 */
function scoreOf(item: FormItem): number {
  return isScoredItem(item) ? (item.score ?? 0) : 0;
}

/** 需要做 LaTeX 校验的文本片段（题干、分节描述、选项文本、量表锚点）。 */
function collectLatexTexts(schema: FormSchema): readonly { path: string; text: string }[] {
  const targets: { path: string; text: string }[] = [];
  schema.items.forEach((item, index) => {
    targets.push({ path: `items[${index}].title`, text: item.title });
    switch (item.type) {
      case "single":
      case "multi":
        item.options.forEach((option, optionIndex) => {
          targets.push({ path: `items[${index}].options[${optionIndex}].text`, text: option.text });
        });
        break;
      case "section":
        if (item.description !== undefined) {
          targets.push({ path: `items[${index}].description`, text: item.description });
        }
        break;
      case "scale":
        if (item.labels !== undefined) {
          item.labels.forEach((label, labelIndex) => {
            targets.push({ path: `items[${index}].labels[${labelIndex}]`, text: label });
          });
        }
        break;
      case "fill":
      case "number":
      case "short":
        break;
      default:
        break;
    }
  });
  return targets;
}

function shapeErrors(error: ZodError): readonly SchemaError[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    // R8 的 bloom 枚举由结构层的 z.enum 把关，错误码却必须与附录 A.2 一致：
    // 若原样报 E_SCHEMA_SHAPE，repairer 只会拿到「结构不对」这种无从下手的提示。
    if (issue.code === "invalid_enum_value" && path.endsWith("bloom")) {
      return schemaError("E_BLOOM_INVALID", path, issue.message);
    }
    return schemaError("E_SCHEMA_SHAPE", path, issue.message);
  });
}

/**
 * 校验一份表单。**结构不合格时不跑语义规则**——在形状上找语义错误只会产出噪音。
 */
export function validateForm(input: unknown, options: ValidateOptions = {}): ValidationResult {
  const parsed = formSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: shapeErrors(parsed.error) };
  }

  const schema = parsed.data as FormSchema;
  const errors: SchemaError[] = [];

  // R1：id 全表唯一
  const firstSeenAt = new Map<string, number>();
  schema.items.forEach((item, index) => {
    const first = firstSeenAt.get(item.id);
    if (first === undefined) {
      firstSeenAt.set(item.id, index);
      return;
    }
    errors.push(
      schemaError("E_DUP_ID", `items[${index}].id`, `id「${item.id}」与 items[${first}] 重复`),
    );
  });

  const objectiveIds = new Set(schema.meta.objectives.map((objective) => objective.id));

  const survey = schema.meta.kind === "survey";

  schema.items.forEach((item, index) => {
    // R4：选项自身的重复（与答案无关，两种 kind 都要查）
    if (item.type === "single" || item.type === "multi") {
      const optionIds = new Set<string>();
      const optionTexts = new Set<string>();

      item.options.forEach((option, optionIndex) => {
        if (optionIds.has(option.id)) {
          errors.push(
            schemaError(
              "E_OPTIONS_INVALID",
              `items[${index}].options[${optionIndex}].id`,
              `选项 id「${option.id}」在同一题内重复`,
            ),
          );
        }
        if (optionTexts.has(option.text)) {
          errors.push(
            schemaError(
              "E_OPTIONS_INVALID",
              `items[${index}].options[${optionIndex}].text`,
              `选项文本「${option.text}」在同一题内重复`,
            ),
          );
        }
        optionIds.add(option.id);
        optionTexts.add(option.text);
      });

      // R2/R3：答案必须落在选项集合内。survey 的答案本身就被下面那条 kind 规则禁掉了，
      // 这里不再重复报——同一处错误给 repairer 两条互相干扰的提示，等于没有提示。
      if (!survey && item.answer !== undefined) {
        if (item.type === "single") {
          if (!optionIds.has(item.answer)) {
            errors.push(
              schemaError(
                "E_ANSWER_NOT_IN_OPTIONS",
                `items[${index}].answer`,
                `answer「${item.answer}」不在选项 id [${[...optionIds].join(", ")}] 中`,
              ),
            );
          }
        } else {
          const answer = item.answer;
          const duplicates = answer.filter(
            (candidate, position) => answer.indexOf(candidate) !== position,
          );
          if (duplicates.length > 0) {
            errors.push(
              schemaError(
                "E_MULTI_ANSWER_INVALID",
                `items[${index}].answer`,
                `答案 id 重复：${[...new Set(duplicates)].join(", ")}`,
              ),
            );
          }
          const unknown = answer.filter((candidate) => !optionIds.has(candidate));
          if (unknown.length > 0) {
            errors.push(
              schemaError(
                "E_MULTI_ANSWER_INVALID",
                `items[${index}].answer`,
                `答案 id 不在选项中：${unknown.join(", ")}`,
              ),
            );
          }
        }
      }
    }

    // R5：填空题答案不能是空白串（Zod 只挡住了空串，挡不住纯空格）
    if (item.type === "fill" && item.answer !== undefined) {
      const blank = item.answer.filter((answer) => answer.trim().length === 0);
      if (blank.length > 0) {
        errors.push(
          schemaError(
            "E_ANSWER_MISSING",
            `items[${index}].answer`,
            `${blank.length} 个答案为空白串`,
          ),
        );
      }
    }

    // kind 约束（附录 A 表第 1 行）：quiz 判分题必有答案；survey 既不许答案也不许分值。
    // 这两条正是审查问题 10 说"永远不可能触发"的规则——结构放开之后才真正生效。
    if (isScoredItem(item)) {
      if (survey) {
        if (item.answer !== undefined) {
          errors.push(
            schemaError(
              "E_SURVEY_HAS_ANSWER",
              `items[${index}].answer`,
              "survey 只收集不判分，题目不该带答案",
            ),
          );
        }
        if (item.score !== undefined) {
          errors.push(
            schemaError(
              "E_SURVEY_HAS_ANSWER",
              `items[${index}].score`,
              "survey 没有分值语义，题目不该带 score",
            ),
          );
        }
      } else {
        if (item.answer === undefined) {
          errors.push(
            schemaError(
              "E_ANSWER_MISSING",
              `items[${index}].answer`,
              "quiz 的判分题必须给出答案，否则无法自动判分",
            ),
          );
        }
        if (item.score === undefined) {
          errors.push(
            schemaError(
              "E_SCORE_SUM",
              `items[${index}].score`,
              "quiz 的判分题必须给出分值，否则总分合计无从谈起",
            ),
          );
        }
      }
    }

    // R8：知识点必须已声明（可选字段，有则校验；bloom 的枚举在结构层）
    if (isScoredItem(item) && item.knowledgePoint !== undefined) {
      if (!objectiveIds.has(item.knowledgePoint)) {
        errors.push(
          schemaError(
            "E_KP_UNKNOWN",
            `items[${index}].knowledgePoint`,
            `「${item.knowledgePoint}」未在 meta.objectives 中声明（已声明：${
              [...objectiveIds].join(", ") || "无"
            }）`,
          ),
        );
      }
    }
  });

  // R6：分值合计（quiz 必须有 totalScore 且等于合计；survey 不该声明总分）
  const scoredItems = schema.items.filter(isScoredItem);
  const scoreSum = scoredItems.reduce((total, item) => total + scoreOf(item), 0);

  if (survey) {
    if (schema.meta.totalScore !== undefined) {
      errors.push(
        schemaError("E_SCORE_SUM", "meta.totalScore", "survey 没有分值语义，不应声明 totalScore"),
      );
    }
  } else if (schema.meta.totalScore === undefined) {
    errors.push(
      schemaError("E_SCORE_SUM", "meta.totalScore", `缺少 totalScore，按当前题目应为 ${scoreSum}`),
    );
  } else if (schema.meta.totalScore !== scoreSum) {
    errors.push(
      schemaError(
        "E_SCORE_SUM",
        "meta.totalScore",
        `声明为 ${schema.meta.totalScore}，实际自动判分题合计 ${scoreSum}`,
      ),
    );
  }

  // R7：LaTeX 可解析（未注入实现时跳过）
  const { checkLatex } = options;
  if (checkLatex !== undefined) {
    for (const target of collectLatexTexts(schema)) {
      const reason = checkLatex(target.text);
      if (reason !== null) {
        errors.push(schemaError("E_LATEX_INVALID", target.path, reason));
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, data: schema };
}
