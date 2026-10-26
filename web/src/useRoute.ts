/**
 * 把手写路由接到 React 上（`useSyncExternalStore`）。
 *
 * `subscribe` / `getSnapshot` 必须是**稳定引用**：每次渲染新建一个函数会让
 * `useSyncExternalStore` 每次渲染都重新订阅，进而频繁触发快照比对。
 * 所以它们定义在模块级，只有 host 是懒创建的（首次访问 `window` 时才建）。
 */

import { useSyncExternalStore } from "react";

import { createBrowserHost, type RouteHost } from "./router";

let host: RouteHost | null = null;

function routeHost(): RouteHost {
  host ??= createBrowserHost(window);
  return host;
}

const subscribe = (listener: () => void): (() => void) => routeHost().subscribe(listener);
const getSnapshot = (): string => routeHost().currentPath();

/** 当前路径。路径一变组件就重渲染，`parseRoute()` 在渲染里现算（纯函数，很便宜）。 */
export function useRoutePath(): string {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** 程序化跳转。写入历史（可后退），不用 replace —— 学生/教师都会想按返回键。 */
export function navigate(path: string): void {
  routeHost().push(path);
}
