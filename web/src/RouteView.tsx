/**
 * 路由入口：`parseRoute()` 的结果在这里分派到四个页面。
 *
 * 为什么外壳这么薄：每条路径的实现（学生页 / 看板 / 登录）都是独立组件，
 * 各自负责自己的取数与失败态。路由层不持有任何业务状态，
 * 这样"学生页匿名可填"就不会被塞进一个想做登录墙的外壳里。
 */

import { App } from "./App";
import { LoginPage } from "./auth/LoginPage";
import { DashboardPage } from "./dashboard/DashboardPage";
import { StudentPage } from "./fill/StudentPage";
import { Link } from "./Link";
import { parseRoute, routeToPath } from "./router";
import { useRoutePath } from "./useRoute";

export function RouteView(): JSX.Element {
  const pathname = useRoutePath();
  const route = parseRoute(pathname);

  switch (route.name) {
    case "generate":
      return <App />;
    case "fill":
      return <StudentPage slug={route.slug} />;
    case "dashboard":
      return <DashboardPage formId={route.formId} />;
    case "login":
      return <LoginPage />;
    case "notFound":
      return <NotFound path={route.path} />;
    default:
      return assertNeverRoute(route);
  }
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

function assertNeverRoute(route: never): never {
  throw new Error(`未处理的路由: ${JSON.stringify(route)}`);
}
