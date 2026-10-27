/**
 * 路由表（唯一的分派点）。
 *
 * 为什么是「手写表 + 同步 reject 而不是中间件栈」：这个服务的路由不到十条，
 * 中间件带来的间接层会让「哪个请求会写响应」变得难查；而跨站写保护、CORS 预检、
 * 错误兜底这三件横切的事各只有一处，一眼能读完。
 *
 * 分派协议：`handle` 返回 `true` 表示已匹配并接管响应；返回 `false` 表示不认这个
 * 路径，由 `main.ts` 统一回 404。这样 `/healthz`、`/api/generate` 的既有行为
 * 一个字都不用改。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLogin, handleLogout, handleMe } from "./auth.ts";
import { handleSubmissions, handleSubmissionsCsv } from "./analytics-route.ts";
import { checkCsrf, corsHeadersFor } from "./csrf.ts";
import type { Db } from "./db/index.ts";
import { isMutatingMethod, type ServerEnv } from "./env.ts";
import { handleFillView } from "./fill-route.ts";
import { handleGradeSubmission } from "./grade-route.ts";
import {
  handleCreateForm,
  handleGetForm,
  handleListForms,
  handlePublishForm,
} from "./forms-route.ts";
import {
  clientIp,
  matchPath,
  sendApiError,
  type RouteContext,
  type RouteDef,
} from "./http.ts";
import { createRateLimiter, rateLimitKey, type RateLimiter } from "./rate-limit.ts";
import { handleSubmit } from "./submissions-route.ts";

export const ROUTES: readonly RouteDef[] = [
  { method: "POST", pattern: "/api/auth/login", handler: handleLogin },
  { method: "POST", pattern: "/api/auth/logout", handler: handleLogout },
  { method: "GET", pattern: "/api/auth/me", handler: handleMe },

  { method: "POST", pattern: "/api/forms", handler: handleCreateForm },
  { method: "GET", pattern: "/api/forms", handler: handleListForms },
  { method: "GET", pattern: "/api/forms/:id", handler: handleGetForm },
  { method: "POST", pattern: "/api/forms/:id/publish", handler: handlePublishForm },
  { method: "GET", pattern: "/api/forms/:id/submissions", handler: handleSubmissions },
  { method: "GET", pattern: "/api/forms/:id/submissions.csv", handler: handleSubmissionsCsv },
  // 省赛 R-02：人工批改。`POST` 而不是 `PUT`：路径里没有"哪个分"，分值在体里，
  // 用 POST + (提交, 题目) 覆盖写表达"录入一次"，比 PUT 一个虚拟资源更直白。
  { method: "POST", pattern: "/api/forms/:id/submissions/:submissionId/grades", handler: handleGradeSubmission },

  // 匿名写接口：限流按「来源 IP 哈希 × 每分钟」计，超了 429。
  {
    method: "POST",
    pattern: "/api/submissions",
    handler: handleSubmit,
    rateLimit: { name: "submissions", limitPerWindow: (env) => env.rateSubmitPerMin },
  },

  { method: "GET", pattern: "/f/:slug", handler: handleFillView },
];

export interface ApiAppDeps {
  readonly db: Db;
  readonly env: ServerEnv;
  /** 与 `main.ts` 共用同一个实例，`/api/generate` 的配额才和这里同源。 */
  readonly limiter?: RateLimiter;
}

export interface ApiApp {
  /** 已接管（含已写 403/404）返回 true。 */
  handle(req: IncomingMessage, res: ServerResponse): boolean;
}

function findRoute(
  method: string,
  pathname: string,
): { readonly def: RouteDef; readonly params: Readonly<Record<string, string>> } | undefined {
  for (const def of ROUTES) {
    if (def.method !== method) continue;
    const params = matchPath(def.pattern, pathname);
    if (params !== null) return { def, params };
  }
  return undefined;
}

export function createApiApp(deps: ApiAppDeps): ApiApp {
  const limiter = deps.limiter ?? createRateLimiter();
  return {
    handle(req, res) {
      const method = (req.method ?? "GET").toUpperCase();
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      // 跨端口开发时（vite 5173 → 8787）浏览器会先发预检。预检只对 APP_ORIGIN
      // 回显，别的来源拿不到 ACAO，于是带自定义头的跨站请求连第一步都过不去。
      if (method === "OPTIONS" && pathname.startsWith("/api/")) {
        res.statusCode = 204;
        for (const [name, value] of Object.entries(corsHeadersFor(req, deps.env))) {
          res.setHeader(name, value);
        }
        res.setHeader("content-length", "0");
        res.end();
        return true;
      }

      const route = findRoute(method, pathname);
      if (route === undefined) return false;

      for (const [name, value] of Object.entries(corsHeadersFor(req, deps.env))) {
        res.setHeader(name, value);
      }

      // 修改类请求的两道闸：Origin 与自定义头。GET 一律不拦（只读、无副作用）。
      if (isMutatingMethod(method)) {
        const verdict = checkCsrf(req, deps.env);
        if (!verdict.ok) {
          sendApiError(res, "forbidden", verdict.message);
          return true;
        }
      }

      // 限流放在鉴权/读体之前：被刷时最省的那条路是「什么都不做就拒绝」。
      // 超限是普通 JSON（429），不是断流——此时生成端还没开始写 SSE。
      if (route.def.rateLimit !== undefined) {
        const spec = route.def.rateLimit;
        const verdict = limiter.hit(
          rateLimitKey(spec.name, deps.env.sessionSecret, clientIp(req)),
          spec.limitPerWindow(deps.env),
        );
        if (!verdict.ok) {
          sendApiError(
            res,
            "rate_limited",
            `请求过于频繁，请 ${String(verdict.retryAfterSeconds)} 秒后再试`,
            { "retry-after": String(verdict.retryAfterSeconds) },
          );
          return true;
        }
      }

      const ctx: RouteContext = {
        req,
        res,
        url,
        params: route.params,
        db: deps.db,
        env: deps.env,
      };
      void route.def.handler(ctx).catch((error: unknown) => {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[api] ${method} ${pathname} failed: ${detail}\n`);
        if (!res.headersSent) {
          sendApiError(res, "internal", "服务器内部错误");
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      return true;
    },
  };
}
