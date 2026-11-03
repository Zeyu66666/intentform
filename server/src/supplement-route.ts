/**
 * `POST /api/forms/:id/supplement` —— 覆盖矩阵点击补题（2026-11-03）。
 *
 * 只回**一道候选题**，不写库。教师确认后由编辑器发 `PATCH` 的 `addItem`；
 * 和 `/api/suggest` 一样，"模型理解错了"在确认前不会变成版本增量。
 *
 * 三处校验在调模型之前：
 * 1. 归属与乐观锁：`baseVersionId` 必须是当前草稿指针；
 * 2. 知识点必须在本版 `meta.objectives` 里——矩阵的行就是这些 id；
 * 3. 请求体里只允许题目字段，不接整份 Schema。
 */

import {
  formSchema,
  supplementItemRequestSchema,
  VERSION_CONFLICT_MESSAGE,
  type FormSchema,
  type SupplementItemResponse,
} from "@intentform/schema";
import { supplementItem } from "@intentform/llm";

import { findVersion } from "./db/forms.ts";
import { requireOwnedForm } from "./forms-route.ts";
import { newId } from "./ids.ts";
import { describeZodError, readJsonBody, sendApiError, sendJson, type RouteContext } from "./http.ts";

const BODY_MAX_BYTES = 32 * 1024;

function readSchema(ctx: RouteContext, formId: string, versionId: string): FormSchema | undefined {
  const version = findVersion(ctx.db, formId, versionId);
  if (version === undefined) {
    sendApiError(ctx.res, "not_found", "基准版本不存在");
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(version.schema_json);
  } catch {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return undefined;
  }
  const parsed = formSchema.safeParse(raw);
  if (!parsed.success) {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return undefined;
  }
  return parsed.data as FormSchema;
}

export async function handleSupplementItem(ctx: RouteContext): Promise<void> {
  if (ctx.llm === undefined) {
    sendApiError(ctx.res, "internal", "服务端未配置模型，无法补题");
    return;
  }
  const formId = ctx.params["id"] ?? "";
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;

  const body = await readJsonBody(ctx, BODY_MAX_BYTES, "补题请求体过大");
  if (!body.ok) return;
  const parsed = supplementItemRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  if (parsed.data.baseVersionId !== form.draft_version_id) {
    sendApiError(ctx.res, "version_conflict", VERSION_CONFLICT_MESSAGE);
    return;
  }
  const schema = readSchema(ctx, form.id, parsed.data.baseVersionId);
  if (schema === undefined) return;

  if (!schema.meta.objectives.some((objective) => objective.id === parsed.data.knowledgePoint)) {
    sendApiError(ctx.res, "unprocessable", "这个知识点不在当前表单的大纲里，请刷新后重试");
    return;
  }

  try {
    const result = await supplementItem({
      config: ctx.llm.config,
      schema,
      knowledgePoint: parsed.data.knowledgePoint,
      bloom: parsed.data.bloom,
      ...(parsed.data.instruction === undefined ? {} : { instruction: parsed.data.instruction }),
    });
    // id 由服务端生成：模型给什么 id 都不该决定草稿里的寻址键。
    const item = { ...result.item, id: newId("q") };
    const response: SupplementItemResponse = {
      ok: true,
      item,
      source: result.source,
      promptVersion: result.promptVersion,
    };
    sendJson(ctx.res, 200, response);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : "补题失败";
    sendApiError(ctx.res, code === "llm_config" ? "bad_request" : "internal", message);
  }
}
