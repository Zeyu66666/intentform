/**
 * 表单展示设置：`POST /api/forms/:id/settings`（省赛附加 A-18）。
 *
 * 目前只有一个开关「提交后向学生展示答案解析」。三条设计：
 *
 * 1. **不进版本快照**。它是展示策略，不是卷面内容；改它不产生新版本，
 *    也不影响任何历史提交的判分依据（判分只看版本行）。
 * 2. **默认关闭**。没有记录 = 关闭，所以老数据不需要回填；只有教师显式打开，
 *    提交响应里才会出现 `review`。开启的代价（交一次就能把答案转给别人）写在
 *    契约注释与 AGENTS §5 里，不藏在代码里。
 * 3. **归属走 SQL**（`requireOwnedForm`），别人的表单连设置都读不到。
 */

import { formSettingsRequestSchema, type FormSettingsResponse } from "@intentform/schema";
import { requireTeacher } from "./auth.ts";
import { getFormSettings, setFormSettings } from "./db/forms.ts";
import { requireOwnedForm } from "./forms-route.ts";
import {
  describeZodError,
  readJsonBody,
  sendApiError,
  sendJson,
  type RouteContext,
} from "./http.ts";

const SETTINGS_BODY_MAX_BYTES = 4 * 1024;

/** `GET /api/forms/:id/settings`：读当前展示设置（没有记录 = 全部默认值）。 */
export async function handleGetFormSettings(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  const stored = getFormSettings(ctx.db, form.id);
  const response: FormSettingsResponse = {
    ok: true,
    showAnswersAfterSubmit: stored.showAnswersAfterSubmit,
    aiGradingEnabled: stored.aiGradingEnabled,
  };
  sendJson(ctx.res, 200, response);
}

export async function handleUpdateFormSettings(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;

  const body = await readJsonBody(ctx, SETTINGS_BODY_MAX_BYTES, "设置请求体过大");
  if (!body.ok) return;
  const parsed = formSettingsRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }

  const current = getFormSettings(ctx.db, form.id);
  setFormSettings(
    ctx.db,
    form.id,
    {
      showAnswersAfterSubmit: parsed.data.showAnswersAfterSubmit,
      // 未传 = 不改这一项：老客户端只发 showAnswers 时不会把 AI 开关顺手关掉。
      aiGradingEnabled: parsed.data.aiGradingEnabled ?? current.aiGradingEnabled,
    },
    new Date().toISOString(),
  );
  const stored = getFormSettings(ctx.db, form.id);
  const response: FormSettingsResponse = {
    ok: true,
    showAnswersAfterSubmit: stored.showAnswersAfterSubmit,
    aiGradingEnabled: stored.aiGradingEnabled,
  };
  sendJson(ctx.res, 200, response);
}
