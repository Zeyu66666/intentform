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
  type GradeRequest,
  type GradeResponse,
  type ListFormsResponse,
  type LoginRequest,
  type LoginResponse,
  type MeResponse,
  type PatchFormRequest,
  type PatchFormResponse,
  type PublishRequest,
  type PublishResponse,
  type SubmissionsResponse,
  type SuggestPatchRequest,
  type SuggestPatchResponse,
  type UndoDraftRequest,
  type UndoDraftResponse,
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
  /**
   * 给一条提交里的一道简答打分（省赛 R-02）。
   *
   * `score` 是这道题的**最终得分**（覆盖写），不是增量。返回该条提交的最新状态，
   * 调用方据此更新那一行，不必自己算总分——总分口径只有服务端一份。
   */
  readonly grade: (
    formId: string,
    submissionId: string,
    request: GradeRequest,
  ) => Promise<ApiResult<GradeResponse>>;
  /** 表单详情：编辑页拿它的 `version.id` 当乐观锁的 `baseVersionId`。 */
  readonly getForm: (formId: string) => Promise<ApiResult<FormDetailResponse>>;
  /**
   * 提交一批 op 生成新草稿版本（省赛 R-03）。
   *
   * `baseVersionId` 是乐观锁：它不等于服务端当前草稿指针时返回 409
   * `version_conflict`。这里**不做**自动重取重试——覆盖别人的改动是数据事故，
   * 冲突要由人看到并决定（界面给的是「刷新」按钮）。
   */
  readonly patchForm: (formId: string, request: PatchFormRequest) => Promise<ApiResult<PatchFormResponse>>;
  /**
   * 撤销：把草稿指针退回上一版本（版本行本身不删）。
   *
   * `undone === false` 不是错误——它表示已经在第一个版本，调用方据此换一句提示，
   * 不要当成失败弹红。
   */
  readonly undoDraft: (formId: string, request: UndoDraftRequest) => Promise<ApiResult<UndoDraftResponse>>;
  /**
   * 一句话改成操作集（建议半步）。
   *
   * 这条调用**不写库**：它只回 ops/changes/issues，界面先把差异摆出来，人点「采用」
   * 之后才走 `patchForm`。所以它可以用 GET 之外的安全语义——但仍然是 POST，
   * 因为指令可能很长，放 query 里会被代理截断。
   */
  readonly suggestPatch: (
    formId: string,
    request: SuggestPatchRequest,
  ) => Promise<ApiResult<SuggestPatchResponse>>;
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
    grade: (formId, submissionId, request) =>
      client.request<GradeResponse>(API_PATHS.gradeSubmission(formId, submissionId), {
        method: "POST",
        body: request,
        csrf: true,
      }),
    getForm: (formId) => client.request<FormDetailResponse>(API_PATHS.form(formId)),
    patchForm: (formId, request) =>
      client.request<PatchFormResponse>(API_PATHS.patchForm(formId), {
        // PATCH 而不是 POST：路径与语义都跟服务端注册的那条对齐，
        // 也让「改了什么」在浏览器网络面板里一眼可辨。
        method: "PATCH",
        body: request,
        csrf: true,
      }),
    undoDraft: (formId, request) =>
      client.request<UndoDraftResponse>(API_PATHS.undoDraft(formId), {
        method: "POST",
        body: request,
        csrf: true,
      }),
    suggestPatch: (formId, request) =>
      client.request<SuggestPatchResponse>(API_PATHS.suggestPatch(formId), {
        method: "POST",
        body: request,
        csrf: true,
      }),
  };
}
