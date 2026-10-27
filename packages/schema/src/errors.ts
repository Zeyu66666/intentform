/**
 * 语义规则的错误码与修复提示（计划 v1.1 附录 A.2）。
 *
 * 每条错误同时携带两份文本：
 * - `message`：面向人的短句，给日志与界面提示；
 * - `repair` ：面向模型的**修复指令**，repairer 会把它连同字段一起回喂给 LLM。
 *
 * 两者分开是因为用途不同：给人看要短，给模型看要说清「期望什么」。
 * `ERROR_HINTS` 用 `Record<ErrorCode, string>`，新增错误码却漏写提示时编译期直接报错。
 */

export const ERROR_CODES = [
  "E_DUP_ID",
  "E_ANSWER_NOT_IN_OPTIONS",
  "E_MULTI_ANSWER_INVALID",
  "E_OPTIONS_INVALID",
  "E_ANSWER_MISSING",
  "E_SCORE_SUM",
  "E_SURVEY_HAS_ANSWER",
  "E_LATEX_INVALID",
  "E_BLOOM_INVALID",
  "E_KP_UNKNOWN",
  /** Zod 结构校验失败。附录 A.2 未单列——它不是语义规则，而是「形状不对」。 */
  "E_SCHEMA_SHAPE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 只给测试用的错误码：C1 契约测试用它表达「学生端视图里出现了答案」。
 * 不并入 `ERROR_CODES`，避免 repairer 把 E_LEAK 当成可修复的语义错误去回喂模型。
 */
export const TEST_ONLY_ERROR_CODES = ["E_LEAK"] as const;

export type TestOnlyErrorCode = (typeof TEST_ONLY_ERROR_CODES)[number];

/** 固定修复提示。每条都要说清「期望什么形态」，而不是只描述现状。 */
export const ERROR_HINTS: Record<ErrorCode, string> = {
  E_DUP_ID: "字段与分节的 id 必须全表单唯一：请给重复项换一个新的小写短标识。",
  E_ANSWER_NOT_IN_OPTIONS: "单选题的 answer 必须是该题 options 里已存在的选项 id。",
  E_MULTI_ANSWER_INVALID: "多选题的 answer 必须是非空、无重复、且全部来自 options 的 id 数组。",
  E_OPTIONS_INVALID: "选项需 2–8 个，且同一题内选项 id 与选项文本都不得重复。",
  E_ANSWER_MISSING: "该题缺少可用答案：填空题至少给 1 个非空答案，数值题的 tolerance 必须 ≥ 0。",
  E_SCORE_SUM: "quiz 的 meta.totalScore 必须等于所有带分值题目（含简答）score 之和（整数）。",
  E_SURVEY_HAS_ANSWER:
    "survey 只收集不判分：请移除 single/multi/fill/number 题型，只保留 short/scale/section。",
  E_LATEX_INVALID: "公式无法被 KaTeX 解析：请修正 $...$ 或 $$...$$ 内的语法，或改用纯文本。",
  E_BLOOM_INVALID: "bloom 必须是 remember/understand/apply/analyze/evaluate/create 之一。",
  E_KP_UNKNOWN: "knowledgePoint 必须引用 meta.objectives 中已存在的 id。",
  E_SCHEMA_SHAPE: "结构不符合 FormSchema v1：请对照字段类型定义补齐或修正该字段。",
};

/** 一条可回喂的校验错误。`path` 用 `items[3].answer` 这种形式，人能直接定位。 */
export interface SchemaError {
  readonly code: ErrorCode;
  /** 出错位置，例如 `items[3].answer`、`meta.totalScore`。 */
  readonly path: string;
  /** 面向人的短句。 */
  readonly message: string;
  /** 面向模型的修复指令（含位置与具体问题）。 */
  readonly repair: string;
}

/**
 * 构造一条错误。`detail` 是本次的具体问题（如「与 items[1] 重复」），
 * 会同时进入 `message` 与 `repair`，这样模型不必回头翻表单就能改。
 */
export function schemaError(code: ErrorCode, path: string, detail?: string): SchemaError {
  const hint = ERROR_HINTS[code];
  return {
    code,
    path,
    message: detail ?? hint,
    repair: detail ? `${hint}具体问题：${detail}（位置 ${path}）` : `${hint}（位置 ${path}）`,
  };
}

/**
 * 把错误列表拼成给 repairer 的一段文本。
 *
 * 排序按 `path` 字典序：同一份表单每次生成的提示文本完全一致，
 * 否则回放键与「错误集合单调减少」的判定都会被无意义的顺序抖动干扰。
 */
export function formatRepairs(errors: readonly SchemaError[]): string {
  const ordered = [...errors].sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  return ordered.map((error) => `- [${error.code}] ${error.repair}`).join("\n");
}
