import { describe, expect, it } from "vitest";

import { LIMITS } from "@intentform/schema";

import {
  beginLogin,
  canSubmitLogin,
  mapLoginOutcome,
  toLoginRequest,
  validateCredentials,
} from "./login";

const GOOD = { email: "teacher@example.com", password: "correct-horse" };

describe("validateCredentials", () => {
  it("空邮箱 / 没 @ / 密码太短都本地拦下", () => {
    expect(validateCredentials({ email: "  ", password: GOOD.password })).toBe("请输入邮箱");
    expect(validateCredentials({ email: "teacher", password: GOOD.password })).toBe(
      "邮箱格式看起来不对",
    );
    expect(validateCredentials({ email: GOOD.email, password: "short" })).toBe(
      `密码至少 ${String(LIMITS.passwordMin)} 位`,
    );
  });

  it("合格输入放过（服务端仍是最终裁决者）", () => {
    expect(validateCredentials(GOOD)).toBeNull();
  });
});

describe("toLoginRequest", () => {
  it("trim + 小写化，与 loginRequestSchema 的口径一致", () => {
    expect(toLoginRequest({ email: "  Teacher@Example.COM ", password: "x12345678" })).toEqual({
      email: "teacher@example.com",
      password: "x12345678",
    });
  });
});

describe("beginLogin", () => {
  it("本地不过 → invalid，不发请求", () => {
    const state = beginLogin({ email: "", password: "" });
    expect(state.kind).toBe("invalid");
    expect(canSubmitLogin(state)).toBe(true);
  });

  it("本地过 → submitting，按钮禁用", () => {
    const state = beginLogin(GOOD);
    expect(state).toEqual({ kind: "submitting" });
    expect(canSubmitLogin(state)).toBe(false);
  });
});

describe("mapLoginOutcome", () => {
  it("成功：拿服务端返回的身份，不保存任何 token", () => {
    const state = mapLoginOutcome(
      { ok: true, data: { ok: true, teacher: { id: "t1", email: "teacher@example.com" } } },
      GOOD.email,
    );
    expect(state).toEqual({ kind: "success", email: "teacher@example.com" });
    expect(canSubmitLogin(state)).toBe(false);
  });

  it("失败：显示服务端 message（不在前端另编一套密码错误文案）", () => {
    const state = mapLoginOutcome(
      { ok: false, failure: { status: 401, code: "unauthorized", message: "邮箱或密码不正确" } },
      GOOD.email,
    );
    expect(state).toEqual({ kind: "failed", message: "邮箱或密码不正确" });
    expect(canSubmitLogin(state)).toBe(true);
  });

  it("接口不存在（服务端没启动）也有可读文案", () => {
    const state = mapLoginOutcome(
      { ok: false, failure: { status: 404, code: "not_found", message: "not found" } },
      GOOD.email,
    );
    if (state.kind !== "failed") throw new Error("应为 failed");
    expect(state.message).toContain("登录接口不存在");
  });

  it("断网给网络提示", () => {
    const state = mapLoginOutcome(
      { ok: false, failure: { status: null, code: null, message: "网络异常，请检查连接后重试" } },
      GOOD.email,
    );
    if (state.kind !== "failed") throw new Error("应为 failed");
    expect(state.message).toBe("网络异常，请检查连接后重试");
  });
});
