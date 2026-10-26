/**
 * 教师端接口：登录 / 登出 / 我是谁 / 表单列表 / 提交记录。
 *
 * 登录只 `POST` 邮箱密码，拿到的身份只用于显示；会话本身由服务端 `Set-Cookie`
 * 种下（httpOnly），前端**不存任何 token**（`AGENTS.md` §5）。
 */

import {
  API_PATHS,
  type ListFormsResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type SubmissionsResponse,
} from "@intentform/schema";

import type { ApiResult, HttpClient } from "./http";

export interface TeacherApi {
  readonly login: (request: LoginRequest) => Promise<ApiResult<LoginResponse>>;
  readonly logout: () => Promise<ApiResult<{ readonly ok: true }>>;
  readonly me: () => Promise<ApiResult<MeResponse>>;
  readonly listForms: () => Promise<ApiResult<ListFormsResponse>>;
  readonly submissions: (formId: string) => Promise<ApiResult<SubmissionsResponse>>;
}

export function createTeacherApi(client: HttpClient): TeacherApi {
  return {
    login: (request) =>
      client.request<LoginResponse>(API_PATHS.login, { method: "POST", body: request, csrf: true }),
    logout: () =>
      client.request<{ readonly ok: true }>(API_PATHS.logout, { method: "POST", csrf: true }),
    me: () => client.request<MeResponse>(API_PATHS.me),
    listForms: () => client.request<ListFormsResponse>(API_PATHS.forms),
    submissions: (formId) => client.request<SubmissionsResponse>(API_PATHS.submissions(formId)),
  };
}
