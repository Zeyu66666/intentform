/**
 * `POST /api/plan`（省赛 R-06）：生成前的**第一步**——让模型先规划结构。
 *
 * 为什么放在 API 应用里（而不是像 `/api/generate` 那样在 `main.ts` 手挂）：
 * 它不流式、要写库之外的一切保护都要（CSRF、限流、统一错误形状）。放进路由表
 * 就能白拿这三样，不必再手写一遍。
 *
 * 它**不写库**：蓝图只是教师确认的对象，确认后由 `/api/generate` 带回来。
 */

import {
  LIMITS,
  composeRequirement,
  planRequestSchema,
  summarizeBlueprint,
  type PlanResponse,
} from "@intentform/schema";
import { planForm } from "@intentform/llm";

import { describeZodError, readJsonBody, sendApiError, sendJson, type RouteContext } from "./http.ts";

export const PLAN_PATH = "/api/plan";

const MAX_BODY_BYTES = 64 * 1024;

export async function handlePlan(ctx: RouteContext): Promise<void> {
  if (ctx.llm === undefined) {
    sendApiError(ctx.res, "internal", "服务端未配置模型，无法规划蓝图");
    return;
  }
  const body = await readJsonBody(ctx, MAX_BODY_BYTES, "请求体过大");
  if (!body.ok) return;

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

  const parsed = planRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  const { requirement, kind, clarifications } = parsed.data;
  // 补答先拼进需求：规划与生成看到的是同一段需求，否则两步的口径会岔开。
  const composed = composeRequirement(requirement, clarifications ?? []);
  if (composed.length > LIMITS.requirementMaxChars) {
    sendApiError(ctx.res, "unprocessable", `需求（含补充约束）最多 ${String(LIMITS.requirementMaxChars)} 字`);
    return;
  }

  try {
    const blueprint = await planForm(
      { config: ctx.llm.config, logger: ctx.llm.logger },
      { requirement: composed, ...(kind === undefined ? {} : { kind }) },
    );
    const response: PlanResponse = {
      ok: true,
      kind: blueprint.kind,
      blueprint,
      summary: summarizeBlueprint(blueprint),
      requirement: composed,
    };
    sendJson(ctx.res, 200, response);
  } catch (error) {
    // 蓝图不合法是模型的问题，不是请求的问题：502（上游给不出可用结构）。
    const message = error instanceof Error ? error.message : "蓝图生成失败";
    sendApiError(ctx.res, "internal", message);
  }
}
