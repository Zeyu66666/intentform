/**
 * 发布流程纯决策层的测试。
 *
 * 三条最容易被"顺手优化"掉的规则，在这里钉死：
 *   1. 401 → 给登录入口，且**不**自动跳转（`showLogin`，没有 navigate）；
 *   2. 400 → 服务端 `message` 原样透出（它带着 `E_X@items[3].answer` 的定位）；
 *   3. 学生路径只能来自 `API_PATHS.fill()`，前端不手写 `/f/`。
 */

import type { CreateFormResponse } from "@intentform/schema";
import { API_PATHS } from "@intentform/schema";
import { describe, expect, it } from "vitest";

import {
  PUBLISH_LOGIN_MESSAGE,
  describeDraftFailure,
  describePublishFailure,
  formatStudentUrl,
  toPublishedForm,
} from "./publish-flow";

const FORM: CreateFormResponse["form"] = {
  id: "form-1",
  title: "初二数学《二次函数》入门测验",
  kind: "quiz",
  status: "draft",
  slug: "abc123",
  draftVersionId: "version-1",
  updatedAt: "2026-10-27T08:00:00.000Z",
};

const VERSION: CreateFormResponse["version"] = {
  id: "version-1",
  n: 1,
  source: "generate",
  promptVersion: "p1",
  createdAt: "2026-10-27T08:00:00.000Z",
};

describe("describePublishFailure", () => {
  it("401：给登录入口，且不改写服务端原因之外的跳转行为", () => {
    const view = describePublishFailure({ status: 401, code: "unauthorized", message: "请先登录" });
    expect(view.kind).toBe("unauthorized");
    expect(view.showLogin).toBe(true);
    expect(view.message).toBe(PUBLISH_LOGIN_MESSAGE);
  });

  it("只有错误码没有状态码的 401 也算未登录", () => {
    expect(describePublishFailure({ status: null, code: "unauthorized", message: "" }).showLogin).toBe(
      true,
    );
  });

  it("400：原样显示服务端 message（含 code@path 定位）", () => {
    const message = "表单未通过发布校验：E_ANSWER_MISSING@items[3].answer";
    const view = describePublishFailure({ status: 400, code: "bad_request", message });
    expect(view.kind).toBe("gate");
    expect(view.message).toBe(message);
    expect(view.showLogin).toBe(false);
  });

  it("断网：可重试，不给登录入口", () => {
    const view = describePublishFailure({
      status: null,
      code: null,
      message: "网络异常，请检查连接后重试",
    });
    expect(view.kind).toBe("network");
    expect(view.showLogin).toBe(false);
    expect(view.message).toBe("网络异常，请检查连接后重试");
  });

  it("5xx 是服务端的错，不是用户填错", () => {
    const view = describePublishFailure({ status: 500, code: "internal", message: "服务端炸了" });
    expect(view.kind).toBe("server");
    expect(view.showLogin).toBe(false);
  });

  it("403 / 429 归到 other，仍显示服务端原话", () => {
    expect(describePublishFailure({ status: 403, code: "forbidden", message: "无权访问该表单" })).toEqual({
      kind: "other",
      message: "无权访问该表单",
      showLogin: false,
    });
    expect(describePublishFailure({ status: 429, code: "rate_limited", message: "太频繁" }).kind).toBe(
      "other",
    );
  });
});

describe("describeDraftFailure", () => {
  it("本地预检失败也走同一种视图，界面只有一条渲染分支", () => {
    const view = describeDraftFailure({
      ok: false,
      reason: "invalid-schema",
      message: "表单未通过发布校验：E_OPTIONS_INVALID@items[2].options",
    });
    expect(view).toEqual({
      kind: "draft",
      message: "表单未通过发布校验：E_OPTIONS_INVALID@items[2].options",
      showLogin: false,
    });
  });
});

describe("toPublishedForm", () => {
  it("学生路径只从 API_PATHS.fill 取，两个版本 id 各归各位", () => {
    const published = toPublishedForm(FORM, VERSION, "abc123", 20);
    expect(published).toEqual({
      formId: "form-1",
      versionId: "version-1",
      slug: "abc123",
      path: API_PATHS.fill("abc123"),
      title: FORM.title,
      kind: "quiz",
      totalScore: 20,
    });
    expect(published.path).toBe("/f/abc123");
  });

  it("survey 的 totalScore 是 null，不伪填 0", () => {
    const published = toPublishedForm({ ...FORM, kind: "survey" }, VERSION, "s1", null);
    expect(published.totalScore).toBeNull();
  });

  it("slug 里的特殊字符被 API_PATHS 转义", () => {
    expect(toPublishedForm(FORM, VERSION, "a b/c", null).path).toBe("/f/a%20b%2Fc");
  });
});

describe("formatStudentUrl", () => {
  it("拼成可直接发出去的绝对地址", () => {
    expect(formatStudentUrl("/f/abc123", "http://127.0.0.1:5173")).toBe(
      "http://127.0.0.1:5173/f/abc123",
    );
  });

  it("origin 末尾多余的斜杠去掉，不拼出 `//`", () => {
    expect(formatStudentUrl("/f/abc123", "https://example.com/")).toBe("https://example.com/f/abc123");
    expect(formatStudentUrl("/f/abc123", "https://example.com///")).toBe("https://example.com/f/abc123");
  });
});
