/**
 * 学生提交：`POST /api/submissions`。
 *
 * 顺序是有讲究的，每一步都对应一种真实事故：
 *
 * 1. **原始请求体先卡 64 KiB**（`LIMITS.submissionMaxBytes`）——在读之前就卡，
 *    不把大包读进内存；
 * 2. 契约解析（`submitRequestSchema`）——形状不对就是 400，不是 500；
 * 3. **版本一致**：提交携带的 `formVersionId` 必须等于表单**当前**
 *    `published_version_id`，否则 409 `version_conflict`。这是「旧标签页」的
 *    兜底：老师换了版，学生手上那张旧页面点提交会被明确拒绝并提示刷新，
 *    而不是「按旧题判分后混进新版本看板」；
 * 4. **只按提交携带的那个版本判分**（版本行自己带 schema_json）；
 * 5. 判分成功后落库，响应**只有** `{ok, submissionId, score, maxScore}`——
 *    不带每题对错、不带正确答案、不回显学生答案（否则就是一个现成的刷分探针）。
 *
 * `ip_hash = sha256(SESSION_SECRET + ip)`：能按 IP 归并异常提交，又不落明文 IP。
 */

import { createHash } from "node:crypto";
import {
  LIMITS,
  submitRequestSchema,
  VERSION_CONFLICT_MESSAGE,
  type SubmitResponse,
} from "@intentform/schema";
import { formSchema } from "@intentform/schema";
import { findPublishedFormBySlug, findVersion } from "./db/forms.ts";
import { insertSubmission } from "./db/submissions.ts";
import {
  clientIp,
  describeZodError,
  readJsonBody,
  sendApiError,
  sendJson,
  type RouteContext,
} from "./http.ts";import { gradeSubmission, type AnswerValue } from "./grading.ts";
import { newId } from "./ids.ts";

export function hashIp(secret: string, ip: string): string {
  return createHash("sha256").update(`${secret}${ip}`).digest("hex");
}

export async function handleSubmit(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx, LIMITS.submissionMaxBytes, "答卷过大");
  if (!body.ok) return;
  const parsed = submitRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  const request = parsed.data;

  // 契约解析之后再过一次字节上限：值本身合法但把 100 道题都填满的项目符号，
  // 序列化后仍可能超过 64 KiB。超了就 413，而不是让它进库。
  const answersJson = JSON.stringify(request.answers);
  if (Buffer.byteLength(answersJson, "utf8") > LIMITS.submissionMaxBytes) {
    sendApiError(ctx.res, "payload_too_large", "答卷过大");
    return;
  }

  const form = findPublishedFormBySlug(ctx.db, request.slug);
  if (form === undefined || form.published_version_id === null) {
    sendApiError(ctx.res, "not_found", "收集页不存在或已下线");
    return;
  }
  if (form.published_version_id !== request.formVersionId) {
    sendApiError(ctx.res, "version_conflict", VERSION_CONFLICT_MESSAGE);
    return;
  }
  const version = findVersion(ctx.db, form.id, request.formVersionId);
  if (version === undefined) {
    sendApiError(ctx.res, "not_found", "收集页不存在或已下线");
    return;
  }
  let parsedSchema: unknown;
  try {
    parsedSchema = JSON.parse(version.schema_json);
  } catch {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return;
  }
  const schema = formSchema.safeParse(parsedSchema);
  if (!schema.success) {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return;
  }

  const answers: Record<string, AnswerValue> = {};
  for (const [key, value] of Object.entries(request.answers)) {
    answers[key] = value;
  }
  const grade = gradeSubmission(schema.data, answers);
  if (!grade.ok) {
    sendApiError(ctx.res, "bad_request", grade.message);
    return;
  }

  const submissionId = newId("s");
  insertSubmission(ctx.db, {
    id: submissionId,
    formId: form.id,
    formVersionId: version.id,
    answersJson,
    score: grade.score,
    maxScore: grade.maxScore,
    ipHash: hashIp(ctx.env.sessionSecret, clientIp(ctx.req)),
    createdAt: new Date().toISOString(),
  });
  const response: SubmitResponse = {
    ok: true,
    submissionId,
    score: grade.score,
    maxScore: grade.maxScore,
  };
  // 201 + `Location`：这是唯一一个「学生创建了资源」的接口，给它正确的语义。
  // 指向的是**该表单的提交列表**而不是某条提交——契约里没有按 id 读单条提交的路由，
  // 硬编一个不存在的 `/api/submissions/<id>` 只会让前端多点一次 404。
  // 响应体保持 `{ok, submissionId, score, maxScore}`，不加任何字段。
  sendJson(ctx.res, 201, response, { location: `/api/forms/${form.id}/submissions` });
}
