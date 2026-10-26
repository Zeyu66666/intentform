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
  type SubmissionRow as SubmissionRowDto,
  type SubmissionSummary,
  type SubmissionsResponse,
} from "@intentform/schema";
import { findVersion } from "./db/forms.ts";
import { listSubmissionsByVersion, type SubmissionRow } from "./db/submissions.ts";
import { answerableFieldIds, maxScoreOf, type AnswerValue } from "./grading.ts";
import { requireOwnedForm } from "./forms-route.ts";
import { sendApiError, sendJson, type RouteContext } from "./http.ts";

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

function toDto(row: SubmissionRow): SubmissionRowDto {
  return {
    submissionId: row.id,
    createdAt: row.created_at,
    score: row.score,
    maxScore: row.max_score,
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
 */
function averageScore(rows: readonly SubmissionRow[]): number | null {
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
  const summary: SubmissionSummary = {
    versionId: resolved.versionId,
    versionN: resolved.versionN,
    count: rows.length,
    avgScore: averageScore(rows),
    maxScore: maxScoreOf(resolved.schema),
  };
  const response: SubmissionsResponse = {
    ok: true,
    summary,
    rows: rows.map(toDto),
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

function cellOf(value: AnswerValue | undefined): string {
  if (value === undefined) return "";
  return Array.isArray(value) ? value.join("|") : value;
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
    const cells = [
      row.id,
      row.created_at,
      String(row.score),
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

function parseAnswers(json: string): Readonly<Record<string, AnswerValue>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, AnswerValue> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      } else if (Array.isArray(value)) {
        const strings: string[] = [];
        let allStrings = true;
        for (const entry of value) {
          if (typeof entry !== "string") {
            allStrings = false;
            break;
          }
          strings.push(entry);
        }
        if (allStrings) result[key] = strings;
      }
    }
    return result;
  } catch {
    return {};
  }
}
