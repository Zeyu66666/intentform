/**
 * 跨站写保护（《计划 v3.0》§5：**不能优先砍 CSRF**）。
 *
 * 两道独立的闸，任意一道都足以挡住表单式跨站提交，两道都留是因为成本几乎为零：
 *
 * 1. **Origin 必须等于 APP_ORIGIN**。浏览器对跨站 POST 一定带 Origin，且脚本
 *    改不了它；只校验它就不用维护 token 表。
 * 2. **必须带自定义头 `x-intentform-csrf: 1`**。跨站表单（`<form method=post>`、
 *    `enctype` 随便选）无法设置自定义头；跨站 `fetch` 想带这个头就得先过预检，
 *    而我们的预检只回显 APP_ORIGIN，别的来源一律拿不到 `access-control-allow-origin`。
 *
 * 为什么不用双提交 cookie / token 表：那要么再存一份服务端状态，要么在同步的
 * SQLite 事务之外引入第二套 token 生命周期；Origin + 自定义头是同样强度、更少零件。
 *
 * 生产同源部署时 `APP_ORIGIN` 留空（见 `.env.example` 注释），此时退化为
 * 「与请求的 Host 同源」——仍然挡跨站，因为攻击者的 Origin 不会等于我们的 Host。
 */

import type { IncomingMessage } from "node:http";
import { normalizeOrigin, type ServerEnv } from "./env.ts";

export const CSRF_HEADER = "x-intentform-csrf";
export const CSRF_HEADER_VALUE = "1";

export interface CsrfVerdict {
  readonly ok: boolean;
  /** 失败原因（写进响应体 message，方便前端/联调时一眼看出缺哪道闸）。 */
  readonly message: string;
}

function allowedOrigins(req: IncomingMessage, env: ServerEnv): readonly string[] {
  if (env.appOrigin !== "") return [env.appOrigin];
  const host = req.headers.host;
  if (host === undefined || host === "") return [];
  return [`http://${host}`, `https://${host}`].map(normalizeOrigin);
}

export function checkCsrf(req: IncomingMessage, env: ServerEnv): CsrfVerdict {
  const origin = req.headers.origin;
  if (origin === undefined || origin === "") {
    // 非同源导航（直接打开链接、curl）不带 Origin；修改类请求缺 Origin 一律拒绝，
    // 因为它无法证明自己不是从别的站点发起的。
    return { ok: false, message: "缺少 Origin 头" };
  }
  const allowed = allowedOrigins(req, env);
  if (!allowed.includes(normalizeOrigin(origin))) {
    return { ok: false, message: "Origin 不被允许" };
  }
  const token = req.headers[CSRF_HEADER];
  const value = Array.isArray(token) ? token[0] : token;
  if (value !== CSRF_HEADER_VALUE) {
    return { ok: false, message: `缺少 ${CSRF_HEADER}: ${CSRF_HEADER_VALUE} 请求头` };
  }
  return { ok: true, message: "" };
}

/** 预检用的响应头：只回显被允许的来源，绝不 `*`（`*` 与 cookie 不兼容，且等于放行所有人）。 */
export function corsHeadersFor(req: IncomingMessage, env: ServerEnv): Record<string, string> {
  const origin = req.headers.origin;
  if (origin === undefined || origin === "") return {};
  const allowed = allowedOrigins(req, env);
  if (!allowed.includes(normalizeOrigin(origin))) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-headers": `content-type, ${CSRF_HEADER}`,
    "access-control-max-age": "600",
    vary: "origin",
  };
}
