/**
 * 路由入口：登录壳 + 页面分派。
 *
 * 教师端页面（生成 / 看板 / 编辑 / 打印）统一先过 `/api/auth/me`：
 * - 未登录：直接显示登录页，并把当前地址作为登录后的去向；
 * - 已登录：顶栏 + 页面内容；
 * - 学生收集页 `/f/:slug` 与登录页不走这层，学生匿名可填。
 */

import { useEffect, useMemo, useState } from "react";

import type { TeacherIdentity } from "@intentform/schema";

import { App } from "./App";
import { createHttpClient } from "./api/http";
import { createTeacherApi } from "./api/teacher";
import { LoginPage } from "./auth/LoginPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { EditorPage } from "./edit/EditorPage";
import { StudentPage } from "./fill/StudentPage";
import { Link } from "./Link";
import { PrintPage } from "./print/PrintPage";
import { SettingsPage } from "./settings/SettingsPage";
import { LOGIN_PATH, parseRoute, routeToPath } from "./router";
import { AppHeader } from "./shell/AppHeader";
import { ThemeToggle } from "./theme/ThemeToggle";
import { useRoutePath, navigate } from "./useRoute";

type AuthState =
  | { readonly status: "loading" }
  | { readonly status: "anonymous" }
  | { readonly status: "authed"; readonly teacher: TeacherIdentity };

export function RouteView(): JSX.Element {
  const pathname = useRoutePath();
  const route = parseRoute(pathname);
  const api = useMemo(() => createTeacherApi(createHttpClient()), []);
  const [auth, setAuth] = useState<AuthState>({ status: "loading" });
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api.me().then((outcome) => {
      if (cancelled) return;
      setAuth(outcome.ok ? { status: "authed", teacher: outcome.data.teacher } : { status: "anonymous" });
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const logout = (): void => {
    if (loggingOut) return;
    setLoggingOut(true);
    void api.logout().finally(() => {
      setLoggingOut(false);
      setAuth({ status: "anonymous" });
      navigate(LOGIN_PATH);
    });
  };

  if (route.name === "fill") {
    return (
      <PageShell>
        <StudentPage slug={route.slug} />
      </PageShell>
    );
  }

  if (route.name === "notFound") {
    return (
      <PageShell>
        <NotFound path={route.path} />
      </PageShell>
    );
  }

  if (auth.status === "loading") {
    return (
      <PageShell>
        <p className="mx-auto w-full max-w-6xl px-2 py-3 text-sm text-muted">正在确认登录状态…</p>
      </PageShell>
    );
  }

  if (auth.status === "anonymous") {
    if (route.name === "login") {
      return (
        <PageShell>
          <LoginPage onLoggedIn={(teacher) => setAuth({ status: "authed", teacher })} />
        </PageShell>
      );
    }
    return (
      <PageShell>
        <LoginPage
          next={pathname}
          onLoggedIn={(teacher) => {
            setAuth({ status: "authed", teacher });
          }}
        />
      </PageShell>
    );
  }

  const teacher = auth.teacher;
  return (
    <div className="flex min-h-screen flex-col">
      <AppHeader teacher={teacher} pathname={pathname} busy={loggingOut} onLogout={logout} />
      {route.name === "login" ? (
        <main className="mx-auto w-full max-w-6xl px-2 py-3">
          <p className="m-0 text-sm text-muted">
            已登录为 {teacher.email}。
            <Link href="/" className="ml-1 text-accent underline">
              去生成表单
            </Link>
          </p>
        </main>
      ) : (
        <div className="min-h-0 flex-1">
          {route.name === "generate" ? <App /> : null}
          {route.name === "dashboard" ? <DashboardPage formId={route.formId} /> : null}
          {route.name === "edit" ? <EditorPage formId={route.formId} /> : null}
          {route.name === "print" ? <PrintPage formId={route.formId} /> : null}
          {route.name === "settings" ? <SettingsPage /> : null}
        </div>
      )}
    </div>
  );
}

function PageShell({ children }: { readonly children: JSX.Element }): JSX.Element {
  return (
    <>
      <ThemeToggle />
      {children}
    </>
  );
}

function NotFound({ path }: { readonly path: string }): JSX.Element {
  return (
    <main className="mx-auto w-full max-w-2xl px-2 py-3">
      <h1 className="m-0 text-lg font-semibold text-ink">页面不存在</h1>
      <p className="m-0 mt-1 text-sm text-muted">{`没有找到 ${path}`}</p>
      <p className="m-0 mt-2 text-sm">
        <Link href={routeToPath({ name: "generate" })} className="text-accent underline">
          回到生成页
        </Link>
      </p>
    </main>
  );
}
