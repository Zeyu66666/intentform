/**
 * 手写路由：`parseRoute()` 是纯函数，`createBrowserHost()` 是唯一的 DOM 接触面。
 *
 * 为什么不装 react-router：本项目只认四条路径（`/` 生成页、`/f/:slug` 学生页、
 * `/dashboard` 看板、`/forms/:id/edit` 编辑页，外加 `/login`），装一个路由库要引入
 * match/router context/过渡期 API 三套概念，而 `window.location.pathname` +
 * `history.pushState` 四十行就能覆盖。依赖越少，"每行都能讲清为什么"越容易做到。
 *
 * 拆两层是为了可测：`parseRoute()` 不发请求、不碰 window，vitest 直接断言字符串；
 * `createBrowserHost()` 接受一个 `WindowLike` 注入，测试用假 window 断言 push/popstate
 * 的通知行为，不依赖 jsdom。
 *
 * 路径约定（与 `config.ts` 的 `fillPathPrefix`、`API_PATHS.fill` 三处必须一致，
 * `router.test.ts` 与 `config.test.ts` 各自盯着这条不变量）。
 */

/** 学生收集页前缀。必须等于 `readWebConfig({}).fillPathPrefix`。 */
export const FILL_PATH_PREFIX = "/f" as const;

export const DASHBOARD_PATH = "/dashboard" as const;
export const LOGIN_PATH = "/login" as const;
/** 编辑页挂 `/forms/<id>/edit`：表单是资源、`edit` 是动作，读地址就能知道改了谁。 */
export const FORMS_PATH_PREFIX = "/forms" as const;
const EDIT_SUFFIX = "edit" as const;

export type Route =
  | { readonly name: "generate" }
  | { readonly name: "fill"; readonly slug: string }
  | { readonly name: "dashboard"; readonly formId: string | null }
  | { readonly name: "edit"; readonly formId: string }
  | { readonly name: "login" }
  | { readonly name: "notFound"; readonly path: string };

function notFound(pathname: string): Route {
  return { name: "notFound", path: pathname };
}

/**
 * `decodeURIComponent` 遇到 `%zz` 这种坏转义会抛 `URIError`。
 * 手输地址栏或别人的链接都可能有这种串，抛错会让整个应用白屏，所以降级成 404。
 */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/**
 * 一段路径参数"等于没写"的判定：解码后空白串（`/f/%20` 这类）也算没写。
 *
 * 为什么要在路由层拦：`/f/%20` 若被当成合法 slug，学生页会去 `GET /f/%20`，
 * 拿到服务端 404 后显示"接口错误"，而真实原因是链接坏了——错误文案会指错方向。
 */
function isBlankSegment(segment: string): boolean {
  return segment.trim() === "";
}

/** 解析 `window.location.pathname`。查询串与 hash 不参与路由（看板不靠 URL 传状态）。 */
export function parseRoute(pathname: string): Route {
  const segments = pathname.split("/").filter((segment) => segment !== "");
  const [head, second, ...rest] = segments;

  if (head === undefined) return { name: "generate" };

  if (head === FILL_PATH_PREFIX.slice(1)) {
    // `/f`、`/f/a/b` 都不是合法的收集页地址：slug 只有一段，不能嵌套。
    if (second === undefined || rest.length > 0) return notFound(pathname);
    const slug = decodeSegment(second);
    return slug === null || isBlankSegment(slug) ? notFound(pathname) : { name: "fill", slug };
  }

  if (head === DASHBOARD_PATH.slice(1)) {
    if (rest.length > 0) return notFound(pathname);
    if (second === undefined) return { name: "dashboard", formId: null };
    const formId = decodeSegment(second);
    return formId === null || isBlankSegment(formId)
      ? notFound(pathname)
      : { name: "dashboard", formId };
  }

  if (head === LOGIN_PATH.slice(1)) {
    return second === undefined ? { name: "login" } : notFound(pathname);
  }

  if (head === FORMS_PATH_PREFIX.slice(1)) {
    // 只有一个合法形状：`/forms/<id>/edit`。`/forms/<id>`、`/forms/<id>/edit/x`
    // 都不猜（编辑页没有子页签），猜出来的地址会让人以为链接对、实际打开空编辑页。
    if (second === undefined) return notFound(pathname);
    const formId = decodeSegment(second);
    if (formId === null || isBlankSegment(formId)) return notFound(pathname);
    if (rest.length !== 1 || rest[0] !== EDIT_SUFFIX) return notFound(pathname);
    return { name: "edit", formId };
  }

  return notFound(pathname);
}

/** 反向：把一个 Route 变回可写进地址栏的路径（导航与测试共用一份拼法）。 */
export function routeToPath(route: Route): string {
  switch (route.name) {
    case "generate":
      return "/";
    case "fill":
      return `${FILL_PATH_PREFIX}/${encodeURIComponent(route.slug)}`;
    case "dashboard":
      return route.formId === null
        ? DASHBOARD_PATH
        : `${DASHBOARD_PATH}/${encodeURIComponent(route.formId)}`;
    case "login":
      return LOGIN_PATH;
    case "edit":
      return `${FORMS_PATH_PREFIX}/${encodeURIComponent(route.formId)}/${EDIT_SUFFIX}`;
    case "notFound":
      return route.path;
  }
}

/** 只描述用到的那部分 window：测试注入假对象时不必伪造整个 Location/History。 */
export interface WindowLike {
  readonly location: { readonly pathname: string };
  readonly history: {
    pushState(state: unknown, title: string, url: string): void;
    replaceState(state: unknown, title: string, url: string): void;
  };
  addEventListener(type: "popstate", listener: () => void): void;
  removeEventListener(type: "popstate", listener: () => void): void;
}

export interface RouteHost {
  readonly currentPath: () => string;
  readonly push: (path: string) => void;
  readonly replace: (path: string) => void;
  /** 订阅路径变化；返回取消订阅函数（`useSyncExternalStore` 的入参形状）。 */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * 把 window 包成 `RouteHost`。
 *
 * 自己 `pushState` 不会触发 `popstate`，所以 push/replace 要手动通知订阅者；
 * 浏览器的前进/后退会触发 `popstate`，那里也要通知。两条来源合并成同一个通知入口，
 * `useSyncExternalStore` 才不会漏帧。
 */
export function createBrowserHost(win: WindowLike): RouteHost {
  const listeners = new Set<() => void>();
  const notify = (): void => {
    // 先快照：通知过程中订阅者可能订阅/退订，边遍历边改 Set 会漏发或重复发。
    for (const listener of Array.from(listeners)) listener();
  };

  const onPopState = (): void => {
    notify();
  };
  win.addEventListener("popstate", onPopState);

  return {
    currentPath: () => win.location.pathname,
    push: (path) => {
      win.history.pushState(null, "", path);
      notify();
    },
    replace: (path) => {
      win.history.replaceState(null, "", path);
      notify();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
