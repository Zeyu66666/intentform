import { describe, expect, it } from "vitest";

import {
  describeFailure,
  isForbidden,
  isNetworkFailure,
  isNotFound,
  isRetryable,
  isUnauthorized,
  isVersionConflict,
} from "./failures";
import type { ApiFailure } from "./http";

function failure(partial: Partial<ApiFailure>): ApiFailure {
  return { status: 400, code: null, message: "请求失败", ...partial };
}

describe("failure 判定", () => {
  it("409 或 version_conflict 都算版本冲突（服务端两种写法都要认）", () => {
    expect(isVersionConflict(failure({ status: 409 }))).toBe(true);
    expect(isVersionConflict(failure({ status: 400, code: "version_conflict" }))).toBe(true);
    expect(isVersionConflict(failure({ status: 400 }))).toBe(false);
  });

  it("401/403/404 同时看状态码与错误码", () => {
    expect(isUnauthorized(failure({ status: 401 }))).toBe(true);
    expect(isUnauthorized(failure({ status: 400, code: "unauthorized" }))).toBe(true);
    expect(isForbidden(failure({ status: 403 }))).toBe(true);
    expect(isNotFound(failure({ status: 404 }))).toBe(true);
    expect(isNotFound(failure({ status: 400, code: "not_found" }))).toBe(true);
  });

  it("只有断网 / 429 / 5xx 值得重试", () => {
    expect(isNetworkFailure(failure({ status: null }))).toBe(true);
    expect(isRetryable(failure({ status: null }))).toBe(true);
    expect(isRetryable(failure({ status: 429 }))).toBe(true);
    expect(isRetryable(failure({ status: 500 }))).toBe(true);
    expect(isRetryable(failure({ status: 404 }))).toBe(false);
    expect(isRetryable(failure({ status: 409 }))).toBe(false);
  });
});

describe("describeFailure", () => {
  const notFound = "这个链接不存在";
  const options = { notFound };

  it("404 用调用方给的解释（同一状态码在不同页面含义不同）", () => {
    expect(describeFailure(failure({ status: 404, message: "not found" }), options)).toBe(notFound);
  });

  it("其他错误优先用服务端 message", () => {
    expect(describeFailure(failure({ status: 401, message: "请先登录" }), options)).toBe("请先登录");
    expect(describeFailure(failure({ status: 400, message: "缺少必答项 q1" }), options)).toBe(
      "缺少必答项 q1",
    );
  });

  it("网络失败与服务端 5xx 给可操作文案，不暴露 HTML/堆栈", () => {
    expect(describeFailure(failure({ status: null, message: "网络异常，请检查连接后重试" }), options)).toBe(
      "网络异常，请检查连接后重试",
    );
    expect(describeFailure(failure({ status: 503, message: "upstream down" }), options)).toBe(
      "服务端出错了，请稍后重试",
    );
  });

  it("401 可被调用方改写为页面自己的说法", () => {
    expect(
      describeFailure(failure({ status: 401, message: "请先登录" }), {
        notFound,
        unauthorized: "请先登录教师账号",
      }),
    ).toBe("请先登录教师账号");
  });
});
