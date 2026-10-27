/**
 * 教师端接口：登录 / 登出 / 我是谁 / 表单列表 / 提交记录。
 *
 * 登录只 `POST` 邮箱密码，拿到的身份只用于显示；会话本身由服务端 `Set-Cookie`
 * 种下（httpOnly），前端**不存任何 token**（`AGENTS.md` §5）。
 */

import {
  API_PATHS,
  type CreateFormRequest,
  type CreateFormResponse,
  type FormDetailResponse,
  type ListFormsResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type PublishRequest,
  type PublishResponse,
  type SubmissionsResponse,
} from "@intentform/schema";

import type { ApiResult, HttpClient } from "./http";

export interface TeacherApi {
  readonly login: (request: LoginRequest) => Promise<ApiResult<LoginResponse>>;
  readonly logout: () => Promise<ApiResult<{ readonly ok: true }>>;
  readonly me: () => Promise<ApiResult<MeResponse>>;
  readonly listForms: () => Promise<ApiResult<ListFormsResponse>>;
  readonly submissions: (formId: string) => Promise<ApiResult<SubmissionsResponse>>;
  /**
   * 落库一条草稿（生成页的「保存并发布」第一步）。
   * 请求体由 `buildPublishDraft()` 产出，这里只负责发出去。
   */
  readonly createForm: (request: CreateFormRequest) => Promise<ApiResult<CreateFormResponse>>;
  /** 发布某个版本（第二步）：成功后拿到学生短链的 slug。 */
  readonly publishForm: (formId: string, request: PublishRequest) => Promise<ApiResult<PublishResponse>>;
  /** 只读详情：排障与回跳用，界面当前不依赖它。 */
  readonly getForm: (formId: string) => Promise<ApiResult<FormDetailResponse>>;
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
    createForm: (request) =>
      client.request<CreateFormResponse>(API_PATHS.forms, {
        method: "POST",
        body: request,
        // 写操作必须带 CSRF 头，否则服务端 403（`http.ts` 顶部第 1 条规矩）。
        csrf: true,
      }),
    publishForm: (formId, request) =>
      client.request<PublishResponse>(API_PATHS.publish(formId), {
        method: "POST",
        body: request,
        csrf: true,
      }),
    getForm: (formId) => client.request<FormDetailResponse>(API_PATHS.form(formId)),
  };
}
