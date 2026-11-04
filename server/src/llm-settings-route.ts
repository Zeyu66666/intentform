/**
 * `GET/POST /api/settings/llm` —— 网页修改全局模型运行设置。
 *
 * 边界：
 * 1. 必须登录；`ADMIN_EMAIL` 非空时只有该邮箱可写，空串表示单教师演示下任意教师可写。
 * 2. 设置只改当前进程内存，不写 `.env`、不落库；重启回到启动配置。
 * 3. Key 只进不出：响应只有 `hasApiKey`，错误信息不含 Key。
 */

import {
  llmSettingsRequestSchema,
  type LlmSettingsResponse,
} from "@intentform/schema";

import { requireTeacher } from "./auth.ts";
import {
  describeZodError,
  readJsonBody,
  sendApiError,
  sendJson,
  type RouteContext,
} from "./http.ts";

const BODY_MAX_BYTES = 8 * 1024;

function canEdit(ctx: RouteContext, email: string): boolean {
  const admin = ctx.env.adminEmail;
  return admin === "" || admin === email.toLowerCase();
}

function viewOf(ctx: RouteContext, email: string): LlmSettingsResponse | undefined {
  const settings = ctx.llm?.settings?.();
  if (settings === undefined) {
    sendApiError(ctx.res, "internal", "服务端未配置模型运行时");
    return undefined;
  }
  return {
    ok: true,
    mode: settings.mode,
    baseUrl: settings.baseUrl,
    model: settings.model,
    hasApiKey: settings.hasApiKey,
    searchBaseUrl: settings.searchBaseUrl,
    hasSearchKey: settings.hasSearchKey,
    canEdit: canEdit(ctx, email),
  };
}

export async function handleGetLlmSettings(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;
  const view = viewOf(ctx, teacher.email);
  if (view !== undefined) sendJson(ctx.res, 200, view);
}

export async function handleUpdateLlmSettings(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;
  if (!canEdit(ctx, teacher.email)) {
    sendApiError(ctx.res, "forbidden", "当前账号没有修改全局模型设置的权限");
    return;
  }
  if (ctx.llm?.updateSettings === undefined) {
    sendApiError(ctx.res, "internal", "服务端未配置模型运行时");
    return;
  }

  const body = await readJsonBody(ctx, BODY_MAX_BYTES, "模型设置请求体过大");
  if (!body.ok) return;
  const parsed = llmSettingsRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }

  try {
    const { mode, baseUrl, model, apiKey, searchBaseUrl, searchApiKey } = parsed.data;
    const settings = ctx.llm.updateSettings({
      mode,
      baseUrl,
      model,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(searchBaseUrl === undefined ? {} : { searchBaseUrl }),
      ...(searchApiKey === undefined ? {} : { searchApiKey }),
    });
    const response: LlmSettingsResponse = {
      ok: true,
      mode: settings.mode,
      baseUrl: settings.baseUrl,
      model: settings.model,
      hasApiKey: settings.hasApiKey,
      searchBaseUrl: settings.searchBaseUrl,
      hasSearchKey: settings.hasSearchKey,
      canEdit: true,
    };
    sendJson(ctx.res, 200, response);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : "模型设置未通过校验";
    sendApiError(ctx.res, code === "llm_config" ? "bad_request" : "internal", message);
  }
}
