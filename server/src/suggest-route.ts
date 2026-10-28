/**
 * `POST /api/forms/:id/suggest` —— 一句话改这份表单（R-03 的"建议"半步）。
 *
 * 这一层做四件事，其余推给 `@intentform/llm`：
 *   1. 教师归属校验（不是自己的表单 404——与 GET 同口径，不给"存在但不是你的"更多信息）；
 *   2. 乐观锁：`baseVersionId` 必须是当前草稿指针，否则 409。建议是基于某一版算的，
 *      套到新版上可能对不上题号，所以宁可让界面重算，也不"按最新版猜"；
 *   3. 调 `suggestPatch` 拿 ops（模型输出在那里已经过 JSON / 结构 / 可应用三重校验）；
 *   4. 顺手把"套用后的可发布状态"算出来一起回，界面就能在确认前看见后果。
 *
 * **不写库**：对数据库而言这条路由是只读的。写库只有 `PATCH /api/forms/:id` 一个入口，
 * 所以"模型理解错了"在人看见并确认之前，不会变成一次真实的版本增量。
 */

import {
  applyPatch,
  suggestPatchRequestSchema,
  validateForm,
  VERSION_CONFLICT_MESSAGE,
  type FormSchema,
  type PatchIssue,
  type SuggestPatchResponse,
} from "@intentform/schema";
import { resolveLlmMode, resolveLlmRuntimeConfig, suggestPatch } from "@intentform/llm";
import { requireTeacher } from "./auth.ts";
import { findForm, findVersion } from "./db/forms.ts";
import { describeZodError, readJsonBody, sendApiError, sendJson, type RouteContext } from "./http.ts";

/** 指令最多 4000 字，32KiB 的体上限足够，也挡住无脑大包。 */
const SUGGEST_BODY_MAX_BYTES = 32 * 1024;
const TOO_LARGE_MESSAGE = "修改要求过长";

/** 把"建议套用后的表单"跑一遍发布门禁，回成界面能直接显示的提示。 */
function issuesOf(schema: FormSchema): readonly PatchIssue[] {
  const checked = validateForm(schema);
  if (checked.ok) return [];
  return checked.errors.map((error) => ({ code: error.code, path: error.path, message: error.message }));
}

/** 读基准版本的 schema；坏快照回 500（数据坏了，不是请求的问题）。 */
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
  // 存进去时是校验过的，这里只做类型收口，不重复跑规则。
  return raw as FormSchema;
}

export async function handleSuggestPatch(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;

  const formId = ctx.params["id"] ?? "";
  const form = findForm(ctx.db, teacher.id, formId);
  if (form === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }

  const body = await readJsonBody(ctx, SUGGEST_BODY_MAX_BYTES, TOO_LARGE_MESSAGE);
  if (body.ok === false) return;

  const parsed = suggestPatchRequestSchema.safeParse(body.value);
  if (parsed.success === false) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }

  // 乐观锁：只认"界面上看到的那一版"。
  if (parsed.data.baseVersionId !== form.draft_version_id) {
    sendApiError(ctx.res, "version_conflict", VERSION_CONFLICT_MESSAGE);
    return;
  }
  const schema = readSchema(ctx, form.id, parsed.data.baseVersionId);
  if (schema === undefined) return;

  // 上游配置按请求解析：`LLM_MODE` 是进程级事实，解析一次很便宜，换来的好处是
  // 这条路由不需要在启动期就配 Key（`mock` 模式的测试与演示完全离线）。
  const rawEnv = ctx.env.rawEnv;
  const config = resolveLlmRuntimeConfig(resolveLlmMode(rawEnv), rawEnv);

  let result;
  try {
    result = await suggestPatch({ config, schema, instruction: parsed.data.instruction });
  } catch (error) {
    // 上游/模型的问题：配置类归 400（使用者能改），其余归 500（不是请求的错）。
    // message 只来自 `LlmError`，它已过滤 Key 与内网 URL，不回显上游报文。
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : "生成建议失败";
    sendApiError(ctx.res, code === "llm_config" ? "bad_request" : "internal", message);
    return;
  }

  // 套用后的表单只用于算 issues，不落库。
  const applied = applyPatch(schema, result.ops);
  const source = result.source === "mock" ? "mock" : result.source === "record" ? "record" : "live";
  const response: SuggestPatchResponse = {
    ok: true,
    ops: result.ops,
    changes: result.changes,
    // 建议为空时也要回 issues：使用者点开面板就能看到「这份草稿现在还不能发布」。
    issues: applied.ok ? issuesOf(applied.schema) : [],
    source,
    promptVersion: result.promptVersion,
  };
  sendJson(ctx.res, 200, response);
}
