/**
 * 发布流程的**纯**决策层：把「失败长什么样」翻译成「界面该显示什么、按钮该不该出现」。
 *
 * 放在 `.ts` 而不是组件里，是因为这些判断有明确的对错：401 要给登录入口、
 * 400 要原样显示服务端 message（装着 `E_ANSWER_MISSING@items[3]` 那种定位信息）、
 * 断网要能重试。写在 `.tsx` 里就只能靠肉眼，写在这里能被 `vitest` 钉住。
 */

import { API_PATHS, type CreateFormResponse, type FormKind, type PublishResponse } from "@intentform/schema";

import { isNetworkFailure, isUnauthorized } from "../api/failures";
import type { ApiFailure } from "../api/http";
import type { PublishDraftFailure } from "./build-draft";

/** 401 时不自动跳转：跳走会把正在展示的时间线/预览整片抹掉，演示当场断掉。 */
export const PUBLISH_LOGIN_MESSAGE = "登录状态已失效（401）：请先登录，再回来点一次「保存并发布」。";

export type PublishFailureKind =
  /** 本地预检就失败了，根本没有发出请求。 */
  | "draft"
  /** 401：没有会话。 */
  | "unauthorized"
  /** 400：服务端整表门禁。`message` 原样展示，不改写。 */
  | "gate"
  /** 请求没到达服务端（断网/被拦）。 */
  | "network"
  /** 5xx：服务端自己出错。 */
  | "server"
  | "other";

export interface PublishFailureView {
  readonly kind: PublishFailureKind;
  readonly message: string;
  /** 是否给「先登录」按钮。 */
  readonly showLogin: boolean;
}

/**
 * `ApiFailure` → 视图。
 *
 * 判定次序是有讲究的：**先看是不是未登录，再看是不是连不上**。真实断网时
 * `http.ts` 给的是 `{status: null, code: null}`，所以"连不上"这一支不会误吃 401；
 * 反过来，只要服务端明确说了未登录（状态码或错误码任一命中），用户该看到的就是登录入口。
 *
 * 只有 400 与 5xx 用服务端原话：400 的 message 是**定位信息**（`E_X@items[0].answer`），
 * 前端改写就等于把"哪道题错了"删掉；5xx 的原话比"出错了"更有用。
 */
export function describePublishFailure(failure: ApiFailure): PublishFailureView {
  if (isUnauthorized(failure)) {
    return { kind: "unauthorized", message: PUBLISH_LOGIN_MESSAGE, showLogin: true };
  }
  if (isNetworkFailure(failure)) {
    return { kind: "network", message: failure.message, showLogin: false };
  }
  if (failure.status === 400) {
    return { kind: "gate", message: failure.message, showLogin: false };
  }
  if (failure.status !== null && failure.status >= 500) {
    return { kind: "server", message: failure.message, showLogin: false };
  }
  return { kind: "other", message: failure.message, showLogin: false };
}

/** 本地预检失败（没发请求）→ 同一种视图，界面只有一条渲染分支。 */
export function describeDraftFailure(draft: PublishDraftFailure): PublishFailureView {
  return { kind: "draft", message: draft.message, showLogin: false };
}

/** 发布成功后界面要留住的东西。 */
export interface PublishedForm {
  readonly formId: string;
  readonly versionId: string;
  readonly slug: string;
  /** 站内路径，例如 `/f/abc123`（`API_PATHS.fill` 的唯一来源）。 */
  readonly path: string;
  readonly title: string;
  readonly kind: FormKind;
  /** quiz 的满分；survey 为 `null`（不判分，不伪填 0）。 */
  readonly totalScore: number | null;
}

/**
 * 用两次响应拼出"已发布"。slug 来自 publish 响应，路径只从 `API_PATHS.fill` 取——
 * 前端手写 `/f/` 前缀，改一处就会和路由/后端漂。
 */
export function toPublishedForm(
  form: CreateFormResponse["form"],
  version: CreateFormResponse["version"],
  slug: PublishResponse["slug"],
  totalScore: number | null,
): PublishedForm {
  return {
    formId: form.id,
    versionId: version.id,
    slug,
    path: API_PATHS.fill(slug),
    title: form.title,
    kind: form.kind,
    totalScore,
  };
}

/**
 * 给学生看/发的绝对地址。
 *
 * `origin` 由调用方从 `window.location` 取（纯函数不碰全局）；末尾多余的 `/` 会去掉，
 * 免得拼出 `http://host//f/slug`。
 */
export function formatStudentUrl(path: string, origin: string): string {
  const base = origin.replace(/\/+$/u, "");
  return `${base}${path}`;
}
