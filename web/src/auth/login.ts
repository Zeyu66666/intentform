/**
 * 登录页的状态机（纯函数）。
 *
 * 只做两件事：本地挡掉明显填错的输入（空邮箱、太短的密码），
 * 其余判断交给服务端——**失败文案用服务端 `message`**，不在这里另编一套
 * "邮箱或密码错误"，否则两边说法一旦不一致，排查的人要先猜是谁在说谎。
 *
 * 前端不保存任何 token：登录成功由服务端 `Set-Cookie`（httpOnly + SameSite=Lax），
 * 这里只把身份 email 交给界面显示（`AGENTS.md` §5：前端零 Key）。
 */

import { LIMITS, type LoginRequest, type LoginResponse } from "@intentform/schema";

import { describeFailure } from "../api/failures";
import type { ApiResult } from "../api/http";

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export type LoginState =
  | { readonly kind: "idle" }
  /** 本地校验没过：不发请求。 */
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "submitting" }
  | { readonly kind: "success"; readonly email: string }
  | { readonly kind: "failed"; readonly message: string };

export function validateCredentials(credentials: Credentials): string | null {
  if (credentials.email.trim() === "") return "请输入邮箱";
  // 只查有没有 `@`：邮箱格式的完整判定属于服务端，前端严格校验只会把
  // 少见但合法的地址（不加点的内网域）挡在门外。
  if (!credentials.email.includes("@")) return "邮箱格式看起来不对";
  if (credentials.password.length < LIMITS.passwordMin) {
    return `密码至少 ${String(LIMITS.passwordMin)} 位`;
  }
  return null;
}

/**
 * 界面值 → 线缆值。`loginRequestSchema` 会 trim + 小写化，这里提前做一遍，
 * 让"输入框里看到的"和"发出去的"一致（否则回显与请求体是两个串）。
 */
export function toLoginRequest(credentials: Credentials): LoginRequest {
  return {
    email: credentials.email.trim().toLowerCase(),
    password: credentials.password,
  };
}

export function beginLogin(credentials: Credentials): LoginState {
  const problem = validateCredentials(credentials);
  return problem === null ? { kind: "submitting" } : { kind: "invalid", message: problem };
}

export function mapLoginOutcome(
  outcome: ApiResult<LoginResponse>,
  attemptedEmail: string,
): LoginState {
  if (outcome.ok) return { kind: "success", email: outcome.data.teacher.email };
  return {
    kind: "failed",
    message: describeFailure(outcome.failure, {
      notFound: "登录接口不存在（服务端可能没启动）",
      // 401 不覆盖：服务端给的是"邮箱或密码不正确"这类可读文案，直接显示。
      unauthorized: attemptedEmail === "" ? "请输入邮箱与密码" : outcome.failure.message,
    }),
  };
}

/** 提交中禁用按钮；成功后也不再允许重复提交。 */
export function canSubmitLogin(state: LoginState): boolean {
  return state.kind !== "submitting" && state.kind !== "success";
}
