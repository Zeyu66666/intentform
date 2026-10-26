/**
 * 手写 HTTP 小工具（零框架，`node:http` 直接用）。
 *
 * 这一层只做四件事：把身体读成 JSON、把 JSON 写回去（带正确的错误码映射）、
 * 解析/序列化 cookie、按 `:param` 模式匹配路径。业务判断一律在路由模块里。
 *
 * 有意的克制：没有中间件链、没有 ctx 魔法属性。路由签名就是
 * `(ctx: RouteContext) => Promise<void>`，评审读一个文件能看完整条链路。
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { API_ERROR_STATUS, type ApiErrorCode } from "@intentform/schema";
import { readRequestBody } from "./generate-route.ts";
import type { ServerEnv } from "./env.ts";
import type { Db } from "./db/index.ts";

export interface RouteContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly params: Readonly<Record<string, string>>;
  readonly db: Db;
  readonly env: ServerEnv;
}

export type RouteHandler = (ctx: RouteContext) => Promise<void>;

/**
 * 路由级限流声明。`limitPerWindow` 是**函数**而不是数字：路由表在模块加载时就要
 * 定下来，而配额来自 `ServerEnv`（每个进程/每个测试各不相同）。
 */
export interface RateLimitSpec {
  /** 进限流 key 的路由名；同一路由的不同配额互不影响。 */
  readonly name: string;
  readonly limitPerWindow: (env: ServerEnv) => number;
}

export interface RouteDef {
  readonly method: string;
  /** 形如 `/api/forms/:id/publish`；`:` 开头的段是参数。 */
  readonly pattern: string;
  readonly handler: RouteHandler;
  /** 省略表示这条路由不限流（读接口无不限流的意义，写接口才有）。 */
  readonly rateLimit?: RateLimitSpec;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // 教师端与学生端的响应都带身份/版本信息，一律不进缓存。
  res.setHeader("cache-control", "no-store");
  for (const [name, value] of Object.entries(extraHeaders)) {
    res.setHeader(name, value);
  }
  res.end(payload);
}

export function sendApiError(
  res: ServerResponse,
  code: ApiErrorCode,
  message: string,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  sendJson(res, API_ERROR_STATUS[code], { ok: false, error: code, message }, extraHeaders);
}

/** 路径匹配：逐段比较，`:` 段收集参数。返回 `null` 表示不匹配。 */
export function matchPath(
  pattern: string,
  pathname: string,
): Readonly<Record<string, string>> | null {
  const patternParts = pattern.split("/").filter((part) => part !== "");
  const pathParts = pathname.split("/").filter((part) => part !== "");
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (const [index, expected] of patternParts.entries()) {
    const actual = pathParts[index];
    if (actual === undefined) return null;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export type JsonBodyResult = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

/**
 * 读请求体并 `JSON.parse`。
 *
 * 失败时**自己**把响应写完（413 / 400），调用方只要 `if (!result.ok) return;`——
 * 这样每个路由不会各写一遍错误分支，也就不会各写错一遍。
 */
export async function readJsonBody(
  ctx: RouteContext,
  maxBytes: number,
  tooLargeMessage: string,
): Promise<JsonBodyResult> {
  const body = await readRequestBody(ctx.req, maxBytes);
  if (!body.ok) {
    if (body.status === 413) {
      sendApiError(ctx.res, "payload_too_large", tooLargeMessage);
    } else {
      sendApiError(ctx.res, "bad_request", "请求体读取失败");
    }
    return { ok: false };
  }
  try {
    return { ok: true, value: JSON.parse(body.text) };
  } catch {
    sendApiError(ctx.res, "bad_request", "请求体不是合法 JSON");
    return { ok: false };
  }
}

export function parseCookies(header: string | undefined): ReadonlyMap<string, string> {
  const jar = new Map<string, string>();
  if (header === undefined) return jar;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name === "") continue;
    jar.set(name, decodeURIComponent(value));
  }
  return jar;
}

export interface CookieOptions {
  readonly httpOnly: boolean;
  readonly sameSite: "Lax" | "Strict" | "None";
  readonly path: string;
  readonly maxAgeSeconds: number;
  readonly secure: boolean;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${options.path}`,
    `Max-Age=${String(options.maxAgeSeconds)}`,
    `SameSite=${options.sameSite}`,
  ];
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

/** 取客户端 IP（不信任 X-Forwarded-For：本作品直连 Node，没有反代要接）。 */
export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * 形状校验失败时的中文说明。
 *
 * 为什么不用 zod 的英文原文：`bad_request` 的 `message` 契约里不约束内容，那就该是
 * 给人看的。直接把 `String must contain at least 8 character(s)` 甩给教师，
 * 前端要么原样显示（英文夹在中文界面里），要么自己再维护一层翻译表——两种都比在
 * 服务端统一翻译一次差。**这里只用结构化的 `issues` 里的 `code` 与 `path`**，
 * 不解析英文句子，所以 zod 换措辞不会让这里失效。
 *
 * 结构上只要求「有 issues 数组、issue 有 path 与 code」，不 import zod 的类型：
 * server 包没有声明 zod 依赖，为了一个类型去引包名会让依赖图说谎。
 */
export interface ZodIssueLike {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly path?: readonly (string | number | symbol)[] | undefined;
}

/** 字段名 → 面向人的称呼。只有出现在请求体第一层的字段才需要在这里登记。 */
const FIELD_LABELS: Readonly<Record<string, string>> = {
  email: "邮箱",
  password: "密码",
  title: "标题",
  kind: "表单类型",
  schema: "表单结构",
  source: "来源",
  versionId: "版本 id",
  slug: "收集页短链",
  formVersionId: "版本 id",
  answers: "答卷",
};

function pathOf(issue: ZodIssueLike): readonly (string | number | symbol)[] {
  return issue.path ?? [];
}

function firstField(issue: ZodIssueLike): string | undefined {
  for (const segment of pathOf(issue)) {
    if (typeof segment === "string") return segment;
  }
  return undefined;
}

/** `items[2].answer` 这种形式，与 `SchemaError.path` 同一读法。 */
function formatPath(issue: ZodIssueLike): string {
  let text = "";
  for (const segment of pathOf(issue)) {
    if (typeof segment === "number") {
      text += `[${String(segment)}]`;
    } else if (text === "") {
      text = String(segment);
    } else {
      text += `.${String(segment)}`;
    }
  }
  return text;
}

function describeIssue(issue: ZodIssueLike): string {
  const field = firstField(issue);
  const label = field === undefined ? undefined : FIELD_LABELS[field];
  const code = issue.code;

  if (field === "email") return "邮箱格式不正确";
  if (field === "password") {
    if (code === "too_small") return "密码至少 8 位";
    if (code === "too_big") return "密码过长";
    return "密码不合法";
  }
  if (label !== undefined) {
    if (code === "too_small") return `${label}不能为空或过短`;
    if (code === "too_big") return `${label}过长`;
    return `${label}不合法`;
  }
  const location = formatPath(issue);
  return location === "" ? "请求体不符合接口约定" : `请求体不符合接口约定（位置 ${location}）`;
}

/**
 * 把 zod 的 issues 压成**一句**中文（响应体只放第一条，见各路由的 `sendApiError`）。
 *
 * 多条 issue 时不拼接：`message` 是给人一眼读完的，拼接会变成半页英文风格的长句。
 * 需要完整诊断的场景（发布门禁）另走 `forms-route.ts` 里的错误码列表。
 */
export function describeZodError(error: {
  readonly issues: readonly ZodIssueLike[];
}): string {
  const first = error.issues[0];
  if (first === undefined) return "请求体不符合接口约定";
  return describeIssue(first);
}
