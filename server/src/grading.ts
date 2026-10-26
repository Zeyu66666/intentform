/**
 * 客观判分。纯函数，不碰数据库、不碰 HTTP——这样它既能被路由调用，也能被
 * `scripts/verify.mjs` 之外的测试单独钉住。
 *
 * 判分口径（逐条对应任务书 / 《计划 v3.0》§3.5）：
 *
 * - **只用提交携带的那个版本的 schema**。函数签名里只有 `schema`，没有「当前
 *   发布版」这种东西，越权判分在类型上就不成立。
 * - single 比选项 id；multi **顺序无关**（排序后比集合），数组里有重复项 → 拒收
 *   整份提交（重复答案多半是前端 bug，静默按 0 分处理会把 bug 藏起来）。
 * - fill 按 `answer` 数组**逐个下标**比，字符串归一化为 `trim().toLowerCase()`，
 *   **不做模糊匹配**（"x²=4" 与 "x=±2" 不是一个答案；模糊匹配是主观题的地盘）。
 *   段数与 `answer.length` 不等 → 该题 0 分。
 * - number 解析成数字后与 `answer.value` 差 ≤ `tolerance` 才算对；解析失败只是
 *   算错，不抛异常（学生输入 "三" 不该换来一个 500）。
 * - 未作答的题得 0 分，但**不拒收整份提交**：学生点了提交就该留档。
 * - `max_score` = 该版本所有自动判分题的分值之和；`score` = 得分之和。
 */

import type { FormItem, FormSchema } from "@intentform/schema";

/** 契约里 `answers` 的值类型：`string | string[]`。 */
export type AnswerValue = string | string[];

export type GradeResult =
  | { readonly ok: true; readonly score: number; readonly maxScore: number }
  | { readonly ok: false; readonly message: string };

/**
 * 有分值的四种字段（`AUTO_GRADED_TYPES`）。用类型收窄而不是只看 `isAutoGradedType`
 * 的原因：`short` / `scale` / `section` 根本没有 `score` 字段，靠布尔守卫拿不到窄化。
 */
type ScoredItem = Extract<FormItem, { type: "single" | "multi" | "fill" | "number" }>;

function isScoredItem(item: FormItem): item is ScoredItem {
  return (
    item.type === "single" ||
    item.type === "multi" ||
    item.type === "fill" ||
    item.type === "number"
  );
}

/** 学生能作答的字段（CSV 的列、公开视图的键都取自这里）。 */
export function answerableFieldIds(schema: FormSchema): readonly string[] {
  return schema.items.filter((item) => item.type !== "section").map((item) => item.id);
}

export function maxScoreOf(schema: FormSchema): number {
  let total = 0;
  for (const item of schema.items) {
    if (!isScoredItem(item)) continue;
    total += item.score ?? 0;
  }
  return total;
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

/** 把 `string | string[]` 统一成段数组；空串/全空白的单项视为「没作答」。 */
function toSegments(value: AnswerValue): readonly string[] {
  return Array.isArray(value) ? value : [value];
}

function hasDuplicate(segments: readonly string[]): boolean {
  return new Set(segments).size !== segments.length;
}

function gradeSingle(item: Extract<FormItem, { type: "single" }>, value: AnswerValue): boolean {
  const segments = toSegments(value);
  if (segments.length !== 1) return false;
  const given = segments[0];
  if (given === undefined) return false;
  const answer = item.answer;
  if (answer === undefined) return false;
  return given.trim() === answer;
}

function gradeMulti(item: Extract<FormItem, { type: "multi" }>, value: AnswerValue): boolean {
  const segments = toSegments(value);
  const answer = item.answer;
  if (answer === undefined) return false;
  // 顺序无关：两边都排序后逐项比。
  const given = [...segments].map((entry) => entry.trim()).sort();
  const wanted = [...answer].map((entry) => entry.trim()).sort();
  if (given.length !== wanted.length) return false;
  return given.every((entry, index) => entry === wanted[index]);
}

/**
 * 把 `string` 形态的填空拆成段。
 *
 * 分隔符同时接受全角「／」与半角 `/`：中文输入法下敲出来的是全角，从聊天框/文档
 * 粘贴过来的是半角，只认一种会让另一种整题 0 分**且不报错**（fill-ui 联调时真实
 * 踩到过）。但当这题**只有一个空**时不拆——`1/2`、`(a+b)/2` 这种答案里的斜杠是
 * 内容的一部分，按斜杠拆会把正确答案判错。
 */
function splitFillInput(text: string, blanks: number): readonly string[] {
  if (blanks <= 1) return [text];
  return text.split(/[／/]/);
}

function gradeFill(item: Extract<FormItem, { type: "fill" }>, value: AnswerValue): boolean {
  const answer = item.answer;
  if (answer === undefined || answer.length === 0) return false;
  const raw = typeof value === "string" ? splitFillInput(value, answer.length) : value;
  if (raw.length !== answer.length) return false;
  return raw.every((entry, index) => {
    const expected = answer[index];
    if (expected === undefined) return false;
    return normalizeText(entry) === normalizeText(expected);
  });
}

function gradeNumber(item: Extract<FormItem, { type: "number" }>, value: AnswerValue): boolean {
  const answer = item.answer;
  if (answer === undefined) return false;
  const segments = toSegments(value);
  if (segments.length !== 1) return false;
  const given = segments[0];
  if (given === undefined) return false;
  const text = given.trim();
  if (text === "") return false;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return false;
  return Math.abs(parsed - answer.value) <= answer.tolerance;
}

/**
 * 判一份答卷。
 *
 * 返回值只有 `ok: false` 表示**整份拒收**（未知字段、重复选项、类型不对）。
 * 判错永远不是拒收：错答得 0 分，提交照样留档。
 */
export function gradeSubmission(
  schema: FormSchema,
  answers: Readonly<Record<string, AnswerValue>>,
): GradeResult {
  const byId = new Map<string, FormItem>();
  for (const item of schema.items) {
    byId.set(item.id, item);
  }
  // 未知字段一律拒收：学生改 DOM 加一个字段进来，不能静默按 0 分吞掉，
  // 否则「答案被丢掉了」这件事在服务端完全不可见。
  for (const key of Object.keys(answers)) {
    if (!byId.has(key)) {
      return { ok: false, message: `未知字段：${key}` };
    }
  }

  let score = 0;
  const maxScore = maxScoreOf(schema);
  for (const item of schema.items) {
    if (!isScoredItem(item)) continue;
    const raw = answers[item.id];
    if (raw === undefined) continue; // 未作答 → 0 分，不拒收
    const weight = item.score ?? 0;
    let correct = false;
    switch (item.type) {
      case "single":
        correct = gradeSingle(item, raw);
        break;
      case "multi": {
        const segments = toSegments(raw);
        if (hasDuplicate(segments)) {
          return { ok: false, message: `多选题答案有重复选项：${item.id}` };
        }
        correct = gradeMulti(item, raw);
        break;
      }
      case "fill":
        correct = gradeFill(item, raw);
        break;
      case "number":
        correct = gradeNumber(item, raw);
        break;
      default:
        // short / scale 不在 AUTO_GRADED_TYPES 里，走不到这里；写出来是为了
        // 让「新增字段类型忘了判分」变成编译期错误而不是静默 0 分。
        correct = false;
    }
    if (correct) score += weight;
  }
  return { ok: true, score, maxScore };
}
