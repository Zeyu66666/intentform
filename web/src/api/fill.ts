/**
 * 学生端两个接口：取公开视图、提交答卷。
 *
 * 这一层只做"路径 + 方法 + 是否带 CSRF"，不做状态与文案：那些在 `fill/*.ts`
 * 里，纯函数、可测。这样改文案不需要碰网络代码。
 */

import {
  API_PATHS,
  type FillViewResponse,
  type SubmitRequest,
  type SubmitResponse,
} from "@intentform/schema";

import type { ApiResult, HttpClient } from "./http";

export interface FillApi {
  /** `GET /f/:slug` → 公开视图（结构上不含答案，见 `public-view.ts`）。 */
  readonly load: (slug: string) => Promise<ApiResult<FillViewResponse>>;
  readonly submit: (request: SubmitRequest) => Promise<ApiResult<SubmitResponse>>;
}

export function createFillApi(client: HttpClient): FillApi {
  return {
    load: (slug) => client.request<FillViewResponse>(API_PATHS.fill(slug)),
    submit: (request) =>
      client.request<SubmitResponse>(API_PATHS.submit, {
        method: "POST",
        body: request,
        // 服务端对写操作强制校验这个头，缺了就 403。
        csrf: true,
      }),
  };
}
