/**
 * 意图澄清接口（省赛 R-05）。
 *
 * 单独一个客户端而不是塞进 `TeacherApi`：这条接口**匿名可用**（生成页本来就不要求登录），
 * 混进教师端会让「哪些调用需要 cookie」这件事变得含糊。
 */

import { API_PATHS, type ClarifyRequest, type ClarifyResponse } from "@intentform/schema";

import type { ApiResult, HttpClient } from "./http";

export interface ClarifyApi {
  readonly clarify: (request: ClarifyRequest) => Promise<ApiResult<ClarifyResponse>>;
}

export function createClarifyApi(client: HttpClient): ClarifyApi {
  return {
    clarify: (request) =>
      client.request<ClarifyResponse>(API_PATHS.clarify, {
        method: "POST",
        body: request,
        // POST 要过服务端的跨站写保护：头是契约里的常量，不在各处手写。
        csrf: true,
      }),
  };
}
