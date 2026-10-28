/**
 * 两阶段蓝图的第一阶段（省赛 R-06）。
 *
 * 与 `clarify.ts` 同样匿名可用、单独一个客户端：生成页在登录之前就要能规划。
 */

import { API_PATHS, type PlanRequest, type PlanResponse } from "@intentform/schema";

import type { ApiResult, HttpClient } from "./http";

export interface PlanApi {
  readonly plan: (request: PlanRequest) => Promise<ApiResult<PlanResponse>>;
}

export function createPlanApi(client: HttpClient): PlanApi {
  return {
    plan: (request) =>
      client.request<PlanResponse>(API_PATHS.plan, {
        method: "POST",
        body: request,
        csrf: true,
      }),
  };
}
