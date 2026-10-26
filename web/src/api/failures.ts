/**
 * 把 `ApiFailure` 翻译成"界面要做什么"，而不是"发生了什么"。
 *
 * 判据只有两个：状态码（`ApiErrorCode` 的映射在冻结契约里，`API_ERROR_STATUS`
 * 是唯一来源）与错误码。为此单独一层，是因为三个页面对同一批失败的处置不同：
 * 学生页遇到 404 要"这个链接不存在"，看板遇到 401 要"去登录"，
 * 而登录页遇到 401 只是"邮箱或密码不对"。把这些判断散在 `.tsx` 里会写歪。
 */

import type { ApiFailure } from "./http";

export function isNetworkFailure(failure: ApiFailure): boolean {
  return failure.status === null;
}

export function isUnauthorized(failure: ApiFailure): boolean {
  return failure.status === 401 || failure.code === "unauthorized";
}

export function isForbidden(failure: ApiFailure): boolean {
  return failure.status === 403 || failure.code === "forbidden";
}

export function isNotFound(failure: ApiFailure): boolean {
  return failure.status === 404 || failure.code === "not_found";
}

/** §3.5 的旧版拒绝：服务端状态码就是这个，错误码是契约里的 `version_conflict`。 */
export function isVersionConflict(failure: ApiFailure): boolean {
  return failure.status === 409 || failure.code === "version_conflict";
}

/** 5xx / 429 / 断网值得再点一次；4xx 里除了 429 都是重试也不会变的结果。 */
export function isRetryable(failure: ApiFailure): boolean {
  if (failure.status === null) return true;
  if (failure.status === 429) return true;
  return failure.status >= 500;
}

export interface DescribeOptions {
  /** 404 时的解释。每个页面不一样：学生页是"链接不存在或没发布"，看板是"表单不存在"。 */
  readonly notFound: string;
  /** 401 时的解释。学生页不该出现 401，所以默认给中性文案。 */
  readonly unauthorized?: string;
}

/**
 * 首选服务端 `message`：它由服务端按上下文写（"请先登录"、"版本已更新"），
 * 前端再编一套就会与服务端说法打架。只有服务端没给可读消息时才用本地兜底。
 */
export function describeFailure(failure: ApiFailure, options: DescribeOptions): string {
  if (isNetworkFailure(failure)) return failure.message;
  if (isNotFound(failure)) return options.notFound;
  if (isUnauthorized(failure)) return options.unauthorized ?? failure.message;
  if (failure.code === "rate_limited") return "操作太频繁，请稍后再试";
  if (failure.status !== null && failure.status >= 500) return "服务端出错了，请稍后重试";
  return failure.message;
}
