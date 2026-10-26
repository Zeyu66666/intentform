/**
 * 登录页 `/login`。
 *
 * 只做"把表单值交给状态机、成功就跳看板"：
 * 本地校验与失败文案都在 `auth/login.ts`（纯函数、有测试），失败时显示的是
 * **服务端 message**，不另编一套"邮箱或密码错误"。
 *
 * 前端零 Key：密码只在这个组件的作用域里存在，提交后立刻被 React 丢弃；
 * 会话是服务端 `Set-Cookie`（httpOnly + SameSite=Lax），这里不存任何 token。
 */

import { useMemo, useState } from "react";
import type { FormEvent } from "react";

import { createHttpClient } from "../api/http";
import { createTeacherApi } from "../api/teacher";
import { beginLogin, canSubmitLogin, mapLoginOutcome, toLoginRequest, type LoginState } from "../auth/login";
import { Link } from "../Link";
import { DASHBOARD_PATH } from "../router";
import { navigate } from "../useRoute";

const MAX_WIDTH = "mx-auto w-full max-w-sm px-2 py-3";
const INPUT_BASE =
  "mt-1 min-h-[44px] w-full rounded-sm border border-line bg-surface p-2 text-base text-ink focus:outline-none focus:ring-1 focus:ring-accent";

export function LoginPage(): JSX.Element {
  const api = useMemo(() => createTeacherApi(createHttpClient()), []);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<LoginState>({ kind: "idle" });

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const credentials = { email, password };
    const next = beginLogin(credentials);
    setState(next);
    if (next.kind !== "submitting") return;

    void api.login(toLoginRequest(credentials)).then((outcome) => {
      const settled = mapLoginOutcome(outcome, credentials.email);
      setState(settled);
      if (settled.kind === "success") navigate(DASHBOARD_PATH);
    });
  };

  const message = loginMessage(state);

  return (
    <main className={MAX_WIDTH}>
      <header className="mb-2">
        <h1 className="m-0 text-lg font-semibold text-ink">教师登录</h1>
        <p className="m-0 mt-1 text-xs text-muted">登录后可以看表单的提交与得分。</p>
      </header>

      <form
        className="flex flex-col gap-2 rounded-md border border-line bg-surface p-2"
        onSubmit={(event) => {
          onSubmit(event);
        }}
        noValidate
      >
        <label className="text-sm text-ink">
          邮箱
          <input
            className={INPUT_BASE}
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
            }}
          />
        </label>

        <label className="text-sm text-ink">
          密码
          <input
            className={INPUT_BASE}
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
            }}
          />
        </label>

        {message === null ? null : (
          <p
            className={`m-0 text-sm ${state.kind === "success" ? "text-success" : "text-danger"}`}
            role="alert"
          >
            {message}
          </p>
        )}

        <button
          type="submit"
          disabled={!canSubmitLogin(state)}
          className="min-h-[44px] w-full rounded-sm bg-accent px-2 py-1 text-base font-medium text-surface disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.kind === "submitting" ? "登录中…" : "登录"}
        </button>

        <p className="m-0 text-center text-xs text-muted">
          <Link href={DASHBOARD_PATH} className="text-muted underline">
            先去看板
          </Link>
          <span className="mx-1">·</span>
          <Link href="/" className="text-muted underline">
            生成页
          </Link>
        </p>
      </form>
    </main>
  );
}

/** 只在有话说的时候给文案：`idle` / `submitting` 保持安静，不然一进页面就报错。 */
function loginMessage(state: LoginState): string | null {
  switch (state.kind) {
    case "idle":
    case "submitting":
      return null;
    case "invalid":
    case "failed":
      return state.message;
    case "success":
      return `已登录：${state.email}`;
    default:
      return assertNeverState(state);
  }
}

function assertNeverState(state: never): never {
  throw new Error(`未处理的登录状态: ${JSON.stringify(state)}`);
}
