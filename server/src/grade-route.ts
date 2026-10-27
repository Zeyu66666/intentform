/**
 * 教师给简答打分：`POST /api/forms/:id/submissions/:submissionId/grades`。
 *
 * 顺序与每条的理由：
 *
 * 1. **归属**：`requireOwnedForm` 走 SQL 里的 `teacher_id`，不是"先查再判断"；
 * 2. **提交必须属于这份表单**：`findSubmission(formId, submissionId)` 两个条件进同一条
 *    SQL，别人的提交在这份表单下查不到，回 404 而不是 403（不泄漏"那条提交存在"）；
 * 3. **按提交自己携带的版本判题**：题目标题/满分来自 `submissions.form_version_id`
 *    指向的那个版本，不是"当前发布版"。老师改版后再批旧卷，满分口径必须还是旧的；
 * 4. **只收简答**：给单选录人工分是坏输入，直接 400。判分口径只能有一个来源，
 *    否则同一条提交会出现"自动判错了 + 人工补分"的糊涂账；
 * 5. 落库是 `(submission_id, item_id)` 覆盖写，所以重复打分 = 改分数，不需要撤销接口。
 *
 * 响应回**整条**提交的最新状态（含重算后的 score/pendingScore），
 * 前端因此不必自己算一遍——"前端重算总分"是这类界面最常见的漂移点。
 */

import { formSchema, gradeRequestSchema, type GradeResponse } from "@intentform/schema";
import { requireTeacher } from "./auth.ts";
import { findVersion } from "./db/forms.ts";
import {
  findSubmission,
  listManualGrades,
  upsertManualGrade,
} from "./db/submissions.ts";
import { requireOwnedForm } from "./forms-route.ts";
import { applyManualGrades, shortItemsOf } from "./grading.ts";
import {
  describeZodError,
  readJsonBody,
  sendApiError,
  sendJson,
  type RouteContext,
} from "./http.ts";

const GRADE_BODY_MAX_BYTES = 4 * 1024;

export async function handleGradeSubmission(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;
  const formId = ctx.params["id"];
  const submissionId = ctx.params["submissionId"];
  if (formId === undefined || submissionId === undefined) {
    sendApiError(ctx.res, "not_found", "提交不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;

  const body = await readJsonBody(ctx, GRADE_BODY_MAX_BYTES, "批改请求体过大");
  if (!body.ok) return;
  const parsed = gradeRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }

  const submission = findSubmission(ctx.db, form.id, submissionId);
  if (submission === undefined) {
    sendApiError(ctx.res, "not_found", "提交不存在");
    return;
  }
  const version = findVersion(ctx.db, form.id, submission.form_version_id);
  if (version === undefined) {
    sendApiError(ctx.res, "internal", "版本快照缺失，无法批改");
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(version.schema_json);
  } catch {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return;
  }
  const schema = formSchema.safeParse(raw);
  if (!schema.success) {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return;
  }

  const shortItems = shortItemsOf(schema.data);
  const target = shortItems.find((item) => item.itemId === parsed.data.itemId);
  if (target === undefined) {
    sendApiError(ctx.res, "bad_request", `该字段不是简答题，不能人工批改：${parsed.data.itemId}`);
    return;
  }
  if (parsed.data.score > target.score) {
    sendApiError(
      ctx.res,
      "bad_request",
      `分值超出该题满分：${parsed.data.itemId} 满分 ${String(target.score)}，收到 ${String(parsed.data.score)}`,
    );
    return;
  }

  upsertManualGrade(ctx.db, {
    submissionId: submission.id,
    itemId: parsed.data.itemId,
    score: parsed.data.score,
    teacherId: teacher.id,
    gradedAt: new Date().toISOString(),
  });

  const grades = gradesMapOf(ctx, submission.id);
  const effect = applyManualGrades(schema.data, grades);
  const response: GradeResponse = {
    ok: true,
    submission: {
      submissionId: submission.id,
      createdAt: submission.created_at,
      // `submission.score` 是**自动判分**的成绩，从未被人工分污染；
      // 展示给教师的分数 = 自动分 + 人工分。两者都留在库里，可追溯。
      score: submission.score + effect.manualScore,
      maxScore: submission.max_score,
      pendingScore: effect.pendingScore,
      manualScores: grades,
      answers: parseAnswers(submission.answers_json),
    },
  };
  sendJson(ctx.res, 200, response);
}

/** 取某条提交已录入的人工分。批改一次只写一题，所以这里查一条提交即可。 */
function gradesMapOf(ctx: RouteContext, submissionId: string): Readonly<Record<string, number>> {
  const rows = listManualGrades(ctx.db, [submissionId]);
  const map: Record<string, number> = {};
  for (const row of rows) {
    map[row.item_id] = row.score;
  }
  return map;
}

/**
 * `answers_json` 的形状在 `submissions-route.ts` 落库时已被契约卡过，
 * 这里仍然逐值判类型：库是长期资产，手改过一行 bad data 也不该让看板整页 500。
 * 非字符串/字符串数组的值一律丢弃（丢弃即"没作答"，比抛异常好）。
 */
function parseAnswers(json: string): Readonly<Record<string, string | readonly string[]>> {
  try {
    const parsed: unknown = JSON.parse(json);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const result: Record<string, string | readonly string[]> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      } else if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        result[key] = value as string[];
      }
    }
    return result;
  } catch {
    return {};
  }
}

export { parseAnswers };
