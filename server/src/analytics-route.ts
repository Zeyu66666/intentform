/**
 * 教师端看板：数字表与 CSV 导出。
 *
 * 三条硬约束：
 * 1. **默认当前发布版**，`?versionId=` 可切历史版；**跨版本不合并**——不同版本的
 *    题目集合与满分都可能不同，混在一起算平均分是错的（《计划 v3.0》§3.5 规则 2）。
 * 2. `count === 0` 时 `avgScore` 是 `null` 而不是 `0`：0 分和「还没人交」不是一回事。
 * 3. CSV 表头 = `CSV_BASE_COLUMNS` 四列 + 每个字段 id 一列；**绝不出现 `answer` 列**，
 *    单元格按 RFC 4180 转义（含 `,` `"` 换行时加引号、内部 `"` 变 `""`）。
 *    多选答案用 `|` 连接，因为逗号已经是列分隔符了。
 */

import {
  CSV_BASE_COLUMNS,
  CSV_CONTENT_TYPE,
  formSchema,
  type FormSchema,
  type ItemStat,
  type SubmissionRow as SubmissionRowDto,
  type SubmissionSummary,
  type SubmissionsResponse,
  coverageMatrixOf,
} from "@intentform/schema";
import { findVersion } from "./db/forms.ts";
import { listManualGrades, listSubmissionsByVersion, type SubmissionRow } from "./db/submissions.ts";
import { requireOwnedForm } from "./forms-route.ts";
import { parseAnswers } from "./grade-route.ts";
import {
  answerableFieldIds,
  applyManualGrades,
  correctnessItemsOf,
  isAnswered,
  judgeItem,
  maxScoreOf,
  shortItemsOf,
  type AnswerValue,
} from "./grading.ts";
import type { RouteContext } from "./http.ts";
import { sendApiError, sendJson } from "./http.ts";

interface ResolvedVersion {
  readonly versionId: string;
  readonly versionN: number;
  readonly schema: FormSchema;
}

/**
 * 解析「要看哪个版本」：缺省当前发布版。
 * 未发布的表单没有可看的版本——`SubmissionSummary.versionId` 不可空，塞不了 null，
 * 所以直接 404，而不是编一个空版本出来。
 */
function resolveAnalyticsVersion(
  ctx: RouteContext,
  formId: string,
  publishedVersionId: string | null,
): ResolvedVersion | undefined {
  const requested = ctx.url.searchParams.get("versionId");
  const versionId =
    requested === null || requested === "" ? publishedVersionId : requested;
  if (versionId === null) {
    sendApiError(ctx.res, "not_found", "表单尚未发布，暂无看板数据");
    return undefined;
  }
  const version = findVersion(ctx.db, formId, versionId);
  if (version === undefined) {
    sendApiError(ctx.res, "not_found", "该版本不属于这份表单");
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(version.schema_json);
  } catch {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return undefined;
  }
  const schema = formSchema.safeParse(raw);
  if (!schema.success) {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return undefined;
  }
  return { versionId: version.id, versionN: version.n, schema: schema.data };
}

/**
 * 一条提交的对外形状：自动分 + 人工分 + 待批改额度 + 学生答案。
 *
 * `applyManualGrades` 是**唯一**的合并口径，看板、批改响应、CSV 都调它；
 * 三处各算一遍迟早会出现"看板 28 分、CSV 30 分"这种对不上的账。
 */
function toDto(
  row: SubmissionRow,
  gradeMap: Readonly<Record<string, number>>,
  schema: FormSchema,
): SubmissionRowDto {
  const effect = applyManualGrades(schema, gradeMap);
  return {
    submissionId: row.id,
    createdAt: row.created_at,
    score: row.score + effect.manualScore,
    maxScore: row.max_score,
    pendingScore: effect.pendingScore,
    manualScores: gradeMap,
    answers: parseAnswers(row.answers_json),
  };
}

/**
 * 平均分保留两位小数；**没有提交时是 `null`**。
 *
 * 口径要写死在这里，免得后来人误判：`null` 只表示「这个版本一条提交都没有」。
 * survey 的提交 `max_score` 是 0（没有判分题），`score` 也是 0，所以 survey 有提交时
 * `avgScore` 是 `0` 而不是 `null`——看起来一样，语义完全不同：
 * 「没人交」看 `summary.count === 0`，「交了的都是 0 分」看 `avgScore === 0 && count > 0`。
 * 想区分这两件事只靠 `avgScore` 是做不到的，这也是 `count` 必须在 `summary` 里的原因。
 *
 * 省赛 R-02 之后**平均分用合并后的分数**（自动分 + 人工分）：教师看到的均分
 * 应当随批改进度上升，否则"批了 20 份还是一条平线"会让人以为批改没生效。
 * 未批完的卷子按"人工分已录部分"计入，`pendingCount` 同时给出还有几条没批完。
 */
/**
 * 逐题正确率（省赛 R-04）。
 *
 * 三个口径钉在这里，看板不再自己算：
 * 1. **分母是提交份数**，未作答按未答对计——把没做的题从分母里剔掉，会让
 *    「一半人跳过这题」看起来像「所有人都会」；
 * 2. **判定调 `judgeItem`**，与 `gradeSubmission` 同一个函数，不存在第二套口径；
 * 3. `total === 0` 时 `rate` 是 `null`。`0` 会被读成「全班全错」。
 *
 * 只遍历 `correctnessItemsOf`：分节、简答、量表与 survey 字段都不进来。
 */
function itemStatsOf(
  schema: FormSchema,
  rows: readonly SubmissionRow[],
): readonly ItemStat[] {
  const answersByRow = rows.map((row) => parseAnswers(row.answers_json));
  return correctnessItemsOf(schema).map((item) => {
    let answered = 0;
    let correct = 0;
    for (const answers of answersByRow) {
      const value = answers[item.id];
      if (value === undefined || !isAnswered(value)) continue;
      answered += 1;
      if (judgeItem(item, value)) correct += 1;
    }
    return {
      itemId: item.id,
      title: item.title,
      score: item.score ?? 0,
      total: rows.length,
      answered,
      correct,
      rate:
        rows.length === 0 ? null : Math.round((correct / rows.length) * 10000) / 10000,
    };
  });
}

function averageScore(rows: readonly SubmissionRowDto[]): number | null {
  if (rows.length === 0) return null;
  const sum = rows.reduce((acc, row) => acc + row.score, 0);
  return Math.round((sum / rows.length) * 100) / 100;
}

export async function handleSubmissions(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  const resolved = resolveAnalyticsVersion(ctx, form.id, form.published_version_id);
  if (resolved === undefined) return;
  const rows = listSubmissionsByVersion(ctx.db, form.id, resolved.versionId);
  const gradeRows = listManualGrades(
    ctx.db,
    rows.map((row) => row.id),
  );
  const gradesBySubmission = new Map<string, Record<string, number>>();
  for (const grade of gradeRows) {
    const bucket = gradesBySubmission.get(grade.submission_id) ?? {};
    bucket[grade.item_id] = grade.score;
    gradesBySubmission.set(grade.submission_id, bucket);
  }
  const dtos = rows.map((row) => toDto(row, gradesBySubmission.get(row.id) ?? {}, resolved.schema));
  const summary: SubmissionSummary = {
    versionId: resolved.versionId,
    versionN: resolved.versionN,
    count: dtos.length,
    avgScore: averageScore(dtos),
    maxScore: maxScoreOf(resolved.schema),
    pendingCount: dtos.filter((row) => row.pendingScore > 0).length,
  };
  const response: SubmissionsResponse = {
    ok: true,
    summary,
    rows: dtos,
    shortItems: shortItemsOf(resolved.schema),
    itemStats: itemStatsOf(resolved.schema, rows),
    coverageMatrix: coverageMatrixOf(resolved.schema),
  };
  sendJson(ctx.res, 200, response);
}

/** RFC 4180 单元格转义。注意先判引号再判逗号——顺序不影响结果，但少一次判断。 */
export function csvEscape(cell: string): string {
  if (/[",\r\n]/.test(cell)) {
    return `"${cell.replaceAll('"', '""')}"`;
  }
  return cell;
}

function cellOf(value: AnswerValue | readonly string[] | undefined): string {
  if (value === undefined) return "";
  // `Array.isArray` 收窄不到 `readonly string[]`（TS 的已知局限），用一次显式分支代替强转。
  return typeof value === "string" ? value : value.join("|");
}

export async function handleSubmissionsCsv(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  const resolved = resolveAnalyticsVersion(ctx, form.id, form.published_version_id);
  if (resolved === undefined) return;
  const rows = listSubmissionsByVersion(ctx.db, form.id, resolved.versionId);
  // CSV 的 score 列与看板同口径（自动分 + 人工分）：同一份数据两处不同数字，
  // 教师第一反应是"导出坏了"，而不是"看板没刷新"。
  const gradeRows = listManualGrades(
    ctx.db,
    rows.map((row) => row.id),
  );
  const gradesBySubmission = new Map<string, Record<string, number>>();
  for (const grade of gradeRows) {
    const bucket = gradesBySubmission.get(grade.submission_id) ?? {};
    bucket[grade.item_id] = grade.score;
    gradesBySubmission.set(grade.submission_id, bucket);
  }

  const fieldIds = answerableFieldIds(resolved.schema);
  // 唯一允许「拼」SQL/文本的地方就是这里：表头是固定字面量 + 字段 id，
  // 而字段 id 已经过 schema 的 `^[a-z0-9_-]{3,32}$` 约束，不含分隔符与引号。
  //
  // **不加 UTF-8 BOM，这是有意识的取舍**：
  // - 为什么：契约把表头的头四列钉成了 `CSV_BASE_COLUMNS`，BOM 会变成第一列
  //   `submission_id` 的字节前缀，任何「按字节比对表头」的校验（含 `scripts/verify.mjs`
  //   与契约测试）都要为它写特例；而 BOM 只在「Excel 双击打开」这一条路径上救人。
  // - 代价：Excel 双击打开时中文会乱码（它按系统 ANSI 猜编码）。
  // - 给用户的话术：「用 Excel 的『数据 → 从文本/CSV 导入』并选 UTF-8」，
  //   或者用 Numbers / LibreOffice / `import pandas` 打开。这条已记入 P04 的已知缺口。
  const header = [...CSV_BASE_COLUMNS, ...fieldIds].map(csvEscape).join(",");
  const lines: string[] = [header];
  for (const row of rows) {
    const answers = parseAnswers(row.answers_json);
    const merged = row.score + applyManualGrades(
      resolved.schema,
      gradesBySubmission.get(row.id) ?? {},
    ).manualScore;
    const cells = [
      row.id,
      row.created_at,
      String(merged),
      String(row.max_score),
      ...fieldIds.map((fieldId) => cellOf(answers[fieldId])),
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  const csv = `${lines.join("\r\n")}\r\n`;
  ctx.res.statusCode = 200;
  ctx.res.setHeader("content-type", CSV_CONTENT_TYPE);
  ctx.res.setHeader("cache-control", "no-store");
  ctx.res.setHeader(
    "content-disposition",
    `attachment; filename="submissions-${resolved.versionId}.csv"`,
  );
  ctx.res.end(csv);
}
