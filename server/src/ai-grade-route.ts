/**
 * `POST /api/forms/:id/submissions/:submissionId/ai-grade` —— AI 辅助评分（A-23）。
 *
 * 这是 AGENTS §5 的**唯一新增例外**，四道边界全部在服务端：
 * 1. 表单级开关 `aiGradingEnabled` 默认关闭；关闭时整条路由 403。
 * 2. 只允许简答题；`itemId` 必须在该提交自己的版本快照里。
 * 3. 只把**这一题**的原文发给模型，不发送整份答卷、不带学生身份。
 * 4. 只回建议分与理由，**不写 `manual_grades`**；教师仍要点原来的「保存」。
 *
 * 日志不记录答案与模型原文：错误信息只含题号/状态码，`LlmError` 已过滤上游报文。
 */

import {
  aiGradeRequestSchema,
  formSchema,
  type AiGradeResponse,
} from "@intentform/schema";
import { aiGradeShort } from "@intentform/llm";

import { findVersion } from "./db/forms.ts";
import { getFormSettings } from "./db/forms.ts";
import { findSubmission } from "./db/submissions.ts";
import { requireOwnedForm } from "./forms-route.ts";
import { parseAnswers } from "./grade-route.ts";
import { shortItemsOf } from "./grading.ts";
import {
  describeZodError,
  readJsonBody,
  sendApiError,
  sendJson,
  type RouteContext,
} from "./http.ts";

const BODY_MAX_BYTES = 4 * 1024;

export async function handleAiGrade(ctx: RouteContext): Promise<void> {
  if (ctx.llm === undefined) {
    sendApiError(ctx.res, "internal", "服务端未配置模型，无法辅助评分");
    return;
  }
  const formId = ctx.params["id"];
  const submissionId = ctx.params["submissionId"];
  if (formId === undefined || submissionId === undefined) {
    sendApiError(ctx.res, "not_found", "提交不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  if (!getFormSettings(ctx.db, form.id).aiGradingEnabled) {
    sendApiError(ctx.res, "forbidden", "这份表单没有开启 AI 辅助评分");
    return;
  }

  const body = await readJsonBody(ctx, BODY_MAX_BYTES, "评分请求体过大");
  if (!body.ok) return;
  const parsed = aiGradeRequestSchema.safeParse(body.value);
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
    sendApiError(ctx.res, "internal", "版本快照缺失，无法评分");
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

  const target = shortItemsOf(schema.data).find((item) => item.itemId === parsed.data.itemId);
  if (target === undefined) {
    sendApiError(ctx.res, "bad_request", "AI 辅助评分只支持简答题");
    return;
  }
  if (target.score <= 0) {
    sendApiError(ctx.res, "bad_request", "这道题没有分值，无法给出建议分");
    return;
  }

  const answers = parseAnswers(submission.answers_json);
  const answer = answers[target.itemId];
  if (typeof answer !== "string" || answer.trim() === "") {
    sendApiError(ctx.res, "bad_request", "这道题没有可评分的文本答案");
    return;
  }

  try {
    const result = await aiGradeShort({
      config: ctx.llm.config,
      title: target.title,
      maxScore: target.score,
      answer,
    });
    const response: AiGradeResponse = {
      ok: true,
      itemId: target.itemId,
      suggestedScore: result.score,
      maxScore: target.score,
      rationale: result.rationale,
      source: result.source,
      promptVersion: result.promptVersion,
    };
    sendJson(ctx.res, 200, response);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : "辅助评分失败";
    sendApiError(ctx.res, code === "llm_config" ? "bad_request" : "internal", message);
  }
}
