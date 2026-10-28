/**
 * `POST /api/clarify`（省赛 R-05）。
 *
 * 只做一件事：读需求 → 找缺失槽位 → 回最多 3 个追问。它**不生成、不写库、不调模型**：
 * - 生成是 `/api/generate` 的职责，这里多写一行字都会让"追问到底问过没有"变得不可核；
 * - 规则在 `@intentform/schema` 的 `clarify.ts` 里，纯函数，replay/mock/live 三种模式
 *   行为完全一致（这也是用户 2026-10-28 裁定「规则层」的直接好处）。
 *
 * 与生成同一条限流配额：它虽然便宜，但仍然是匿名可打的写接口，不能被拿来刷。
 */

import {
  buildClarifyQuestions,
  clarifyRequestSchema,
  inferFormKind,
  LIMITS,
  type ClarifyResponse,
} from "@intentform/schema";

import {
  describeZodError,
  readJsonBody,
  sendApiError,
  sendJson,
  type RouteContext,
} from "./http.ts";

export const CLARIFY_PATH = "/api/clarify";

/** 请求体上限：4000 字需求 + JSON 包装，与生成同量级。 */
const MAX_BODY_BYTES = 64 * 1024;

export async function handleClarify(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx, MAX_BODY_BYTES, "需求过大");
  if (!body.ok) return;
  // 「超长」与 `/api/generate` 同语义：422 而不是笼统的 400。前端只需一套错误分支。
  const rawRequirement =
    typeof body.value === "object" && body.value !== null
      ? (body.value as Record<string, unknown>)["requirement"]
      : undefined;
  if (typeof rawRequirement === "string" && rawRequirement.trim().length > LIMITS.requirementMaxChars) {
    sendApiError(
      ctx.res,
      "unprocessable",
      `需求最多 ${String(LIMITS.requirementMaxChars)} 字，当前 ${String(rawRequirement.trim().length)} 字`,
    );
    return;
  }
  const parsed = clarifyRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  const { requirement, kind } = parsed.data;
  const resolvedKind = kind ?? inferFormKind(requirement);
  const response: ClarifyResponse = {
    ok: true,
    kind: resolvedKind,
    questions: buildClarifyQuestions(requirement, resolvedKind),
  };
  sendJson(ctx.res, 200, response);
}

/** 供路由表 / 测试引用：请求体里需求的上限就是契约里那一份，不另写数字。 */
export const CLARIFY_REQUIREMENT_MAX = LIMITS.requirementMaxChars;
