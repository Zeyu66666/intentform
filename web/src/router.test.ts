import { describe, expect, it, vi } from "vitest";

import { readWebConfig } from "./config";
import {
  DASHBOARD_PATH,
  FILL_PATH_PREFIX,
  LOGIN_PATH,
  createBrowserHost,
  parseRoute,
  routeToPath,
  type WindowLike,
} from "./router";

describe("parseRoute", () => {
  it("根路径是生成页", () => {
    expect(parseRoute("/")).toEqual({ name: "generate" });
    expect(parseRoute("")).toEqual({ name: "generate" });
    expect(parseRoute("///")).toEqual({ name: "generate" });
  });

  it("/f/:slug 解出 slug，且 /f 前缀必须与 config 的 fillPathPrefix 一致", () => {
    expect(FILL_PATH_PREFIX).toBe(readWebConfig({}).fillPathPrefix);
    expect(parseRoute("/f/abc123")).toEqual({ name: "fill", slug: "abc123" });
    // 尾斜杠与编码都要能还原：slug 是随机短串，但地址栏里可能出现转义。
    expect(parseRoute("/f/abc123/")).toEqual({ name: "fill", slug: "abc123" });
    expect(parseRoute("/f/a%20b")).toEqual({ name: "fill", slug: "a b" });
  });

  it("slug 缺失、嵌套、坏转义都归 404，不猜一个 slug 出来", () => {
    expect(parseRoute("/f")).toEqual({ name: "notFound", path: "/f" });
    expect(parseRoute("/f/")).toEqual({ name: "notFound", path: "/f/" });
    expect(parseRoute("/f/a/b")).toEqual({ name: "notFound", path: "/f/a/b" });
    // `decodeURIComponent("%zz")` 会抛 URIError：必须降级成 404 而不是白屏。
    expect(parseRoute("/f/%zz")).toEqual({ name: "notFound", path: "/f/%zz" });
  });

  it("看板可带 formId，也可不带（此时由前端选第一份）", () => {
    expect(parseRoute(DASHBOARD_PATH)).toEqual({ name: "dashboard", formId: null });
    expect(parseRoute("/dashboard/form-1")).toEqual({ name: "dashboard", formId: "form-1" });
    expect(parseRoute("/dashboard/a/b")).toEqual({ name: "notFound", path: "/dashboard/a/b" });
  });

  it("登录页只有一层", () => {
    expect(parseRoute(LOGIN_PATH)).toEqual({ name: "login" });
    expect(parseRoute("/login/x")).toEqual({ name: "notFound", path: "/login/x" });
  });

  it("未知路径归 404，不静默回落到生成页", () => {
    expect(parseRoute("/nope")).toEqual({ name: "notFound", path: "/nope" });
  });

  it("`/f/` 这种空 slug 归 404：不会拿空串去请求 /f/ 接口", () => {
    // 锁死这条：空 slug 若被当成合法 fill 路由，学生页会去 `GET /f/` 拿到服务端 404 JSON，
    // 界面就会显示"网络/接口错误"而不是"链接不对"。这里在路由层就拦掉。
    expect(parseRoute("/f/")).toEqual({ name: "notFound", path: "/f/" });
    expect(parseRoute("/f//")).toEqual({ name: "notFound", path: "/f//" });
    // 反向也不该生成带空 slug 的地址：`routeToPath` 只接受有内容的 slug（类型上是 string，
    // 这里用运行时断言确认空串拼出来会被 `parseRoute` 判成 404，形成闭环）。
    expect(parseRoute(routeToPath({ name: "fill", slug: "x" }))).toEqual({ name: "fill", slug: "x" });
    expect(parseRoute("/f/%20")).toEqual({ name: "notFound", path: "/f/%20" });
  });

  it("`/dashboard/xxx` 是 formId 而不是未知路径；多一层才 404", () => {
    expect(parseRoute("/dashboard/xxx")).toEqual({ name: "dashboard", formId: "xxx" });
    expect(parseRoute("/dashboard/xxx/")).toEqual({ name: "dashboard", formId: "xxx" });
    expect(parseRoute("/dashboard/xxx/y")).toEqual({ name: "notFound", path: "/dashboard/xxx/y" });
    // 看板的未知子路径**不**静默回落到"选第一份表单"：那会让用户以为点开的正是自己那份。
    expect(parseRoute("/dashboard/")).toEqual({ name: "dashboard", formId: null });
  });
});

describe("routeToPath", () => {
  it("与 parseRoute 往返一致（slug 做 URL 编码）", () => {
    const cases = [
      { name: "generate" } as const,
      { name: "fill", slug: "abc/def" } as const,
      { name: "dashboard", formId: null } as const,
      { name: "dashboard", formId: "form-1" } as const,
      { name: "login" } as const,
    ];
    for (const route of cases) {
      expect(parseRoute(routeToPath(route))).toEqual(route);
    }
  });
});

function fakeWindow(initialPath: string): WindowLike & {
  path: () => string;
  firePopState: () => void;
} {
  let path = initialPath;
  const listeners = new Set<() => void>();
  return {
    get location() {
      return { pathname: path };
    },
    history: {
      pushState: (_state: unknown, _title: string, url: string) => {
        path = url;
      },
      replaceState: (_state: unknown, _title: string, url: string) => {
        path = url;
      },
    },
    addEventListener: (type: "popstate", listener: () => void) => {
      if (type === "popstate") listeners.add(listener);
    },
    removeEventListener: (type: "popstate", listener: () => void) => {
      if (type === "popstate") listeners.delete(listener);
    },
    path: () => path,
    firePopState: () => {
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

describe("createBrowserHost", () => {
  it("push/replace 改路径并通知订阅者（pushState 自己不触发 popstate）", () => {
    const win = fakeWindow("/");
    const host = createBrowserHost(win);
    const listener = vi.fn();
    host.subscribe(listener);

    host.push("/dashboard");
    expect(win.path()).toBe("/dashboard");
    expect(host.currentPath()).toBe("/dashboard");
    expect(listener).toHaveBeenCalledTimes(1);

    host.replace("/login");
    expect(host.currentPath()).toBe("/login");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("浏览器前进/后退（popstate）也通知", () => {
    const win = fakeWindow("/f/abc");
    const host = createBrowserHost(win);
    const listener = vi.fn();
    host.subscribe(listener);

    win.firePopState();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("取消订阅后不再通知（组件卸载不该继续被调用）", () => {
    const win = fakeWindow("/");
    const host = createBrowserHost(win);
    const listener = vi.fn();
    const unsubscribe = host.subscribe(listener);
    unsubscribe();

    host.push("/dashboard");
    expect(listener).not.toHaveBeenCalled();
  });
});
