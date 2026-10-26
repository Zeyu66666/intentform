/**
 * 学生页取数失败的映射。
 *
 * 学生页是**匿名**的，所以 401 不该出现；真正会撞上的只有三种：
 *   404（slug 错了 / 表单没发布 / 被下架）、断网、5xx。
 * 把"链接对不对"与"网络抖不抖"分开，是因为前者再点一次也没用，
 * 后者值得给一个"重试"按钮。
 */

import type { FillViewResponse } from "@intentform/schema";

import { describeFailure, isRetryable } from "../api/failures";
import type { ApiResult } from "../api/http";

export const FILL_NOT_FOUND_MESSAGE = "这个填写链接不存在，或表单还没有发布" as const;

export type FillLoad =
  | { readonly kind: "ready"; readonly view: FillViewResponse }
  | { readonly kind: "error"; readonly message: string; readonly retryable: boolean };

export function mapFillLoad(outcome: ApiResult<FillViewResponse>): FillLoad {
  if (outcome.ok) return { kind: "ready", view: outcome.data };

  return {
    kind: "error",
    message: describeFailure(outcome.failure, { notFound: FILL_NOT_FOUND_MESSAGE }),
    retryable: isRetryable(outcome.failure),
  };
}
