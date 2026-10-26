/**
 * 鉴权：登录 / 登出 / 我是谁。
 *
 * 会话不用表：cookie 的值是 `teacherId.exp.sig`，`sig = HMAC-SHA256(secret, "teacherId.exp")`。
 * 于是「校验会话」= 一次 HMAC + 一次主键查询，不存明文 token、不用清理过期行、
 * 服务器重启（只要 SESSION_SECRET 来自环境）会话还在。
 *
 * cookie 属性按 AGENTS.md §5：`HttpOnly`、`SameSite=Lax`、`Path=/`，
 * `Secure` 由 `COOKIE_SECURE` 控制（本地 http 必须关，否则登录当场失效）。
 *
 * 失败锁定：`login_attempts` 按 `sha256(email)` 计数（不存明文邮箱以外的任何东西，
 * 也不存 IP），连续 5 次失败锁 15 分钟，成功即清零。用 email 而不是 IP 做 key，
 * 是因为共享出口 IP 的课堂里按 IP 锁会连坐整个班。
 *
 * 「邮箱不存在」与「密码错」对外是同一件事：同一句话术、同一个 401、**同量级的
 * 耗时**（不存在的邮箱也会陪跑一次 argon2 校验，见 `dummyPasswordHash`）。
 *
 * 不做开放注册：教师只有 seed 建出来的那个。
 */

import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { loginRequestSchema, type TeacherIdentity } from "@intentform/schema";
import { hashSync, verify as verifyPassword } from "@node-rs/argon2";
import {
  clearLoginFailures,
  lockRemainingMs,
  recordLoginFailure,
} from "./db/submissions.ts";
import { findTeacherByEmail, findTeacherById, type TeacherRow } from "./db/teachers.ts";
import type { ServerEnv } from "./env.ts";
import {
  describeZodError,
  parseCookies,
  readJsonBody,
  sendApiError,
  sendJson,
  serializeCookie,
  type RouteContext,
} from "./http.ts";

export const SESSION_COOKIE = "intentform_session";
const MAX_LOGIN_FAILURES = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
/** 登录请求体很小；给 4 KiB 就够，超了直接 413。 */
const AUTH_BODY_MAX_BYTES = 4 * 1024;

export function signSession(teacherId: string, expSeconds: number, secret: string): string {
  const payload = `${teacherId}.${String(expSeconds)}`;
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

/** 校验通过返回 teacherId，否则 undefined（过期、签名错、格式错一视同仁）。 */
export function verifySession(
  raw: string,
  secret: string,
  nowSeconds: number,
): string | undefined {
  const parts = raw.split(".");
  if (parts.length !== 3) return undefined;
  const [teacherId, expText, signature] = parts;
  if (teacherId === undefined || expText === undefined || signature === undefined) return undefined;
  if (teacherId === "" || expText === "" || signature === "") return undefined;
  const expected = createHmac("sha256", secret)
    .update(`${teacherId}.${expText}`)
    .digest("base64url");
  const given = Buffer.from(signature, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  // 长度不同时 timingSafeEqual 会抛，所以先比长度（长度本身不是秘密）。
  if (given.length !== wanted.length) return undefined;
  if (!timingSafeEqual(given, wanted)) return undefined;
  const exp = Number(expText);
  if (!Number.isInteger(exp) || exp <= nowSeconds) return undefined;
  return teacherId;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionMaxAgeSeconds(env: ServerEnv): number {
  return env.sessionTtlHours * 60 * 60;
}

function buildSessionCookie(teacherId: string, env: ServerEnv, nowMs: number): string {
  const maxAge = sessionMaxAgeSeconds(env);
  const exp = Math.floor(nowMs / 1000) + maxAge;
  return serializeCookie(SESSION_COOKIE, signSession(teacherId, exp, env.sessionSecret), {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: maxAge,
    secure: env.cookieSecure,
  });
}

function clearedSessionCookie(env: ServerEnv): string {
  return serializeCookie(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    maxAgeSeconds: 0,
    secure: env.cookieSecure,
  });
}

function toIdentity(row: TeacherRow): TeacherIdentity {
  return { id: row.id, email: row.email };
}

/**
 * 邮箱不存在时用来陪跑的 argon2 哈希（每进程按内存成本懒生成一次）。
 *
 * 不写成硬编码常量：`verify` 会按哈希串里自带的参数做 KDF，参数必须与真实口令
 * 同量级才有「耗时同量级」的意义；跟着 `ARGON2_MEMORY_KIB` 走，改配置也不会失效。
 * 生成它的成本（一次 hashSync）只付一次，且只付在「有人用不存在的邮箱登录」时。
 */
let dummyHash: { readonly memoryKib: number; readonly hash: string } | undefined;

function dummyPasswordHash(memoryKib: number): string {
  if (dummyHash === undefined || dummyHash.memoryKib !== memoryKib) {
    dummyHash = {
      memoryKib,
      hash: hashSync(randomBytes(16).toString("base64url"), { memoryCost: memoryKib }),
    };
  }
  return dummyHash.hash;
}

/**
 * 当前请求的教师；未登录返回 undefined。
 * 不写响应——调用方自己决定回 401 还是按匿名处理（`/f/:slug` 就允许匿名）。
 */
export function currentTeacher(ctx: RouteContext): TeacherRow | undefined {
  const raw = parseCookies(ctx.req.headers.cookie).get(SESSION_COOKIE);
  if (raw === undefined || raw === "") return undefined;
  const teacherId = verifySession(raw, ctx.env.sessionSecret, Math.floor(Date.now() / 1000));
  if (teacherId === undefined) return undefined;
  return findTeacherById(ctx.db, teacherId);
}

/** 教师端路由的统一前置：没登录就写 401 并返回 undefined。 */
export function requireTeacher(ctx: RouteContext): TeacherRow | undefined {
  const teacher = currentTeacher(ctx);
  if (teacher === undefined) {
    sendApiError(ctx.res, "unauthorized", "请先登录");
    return undefined;
  }
  return teacher;
}

export async function handleLogin(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx, AUTH_BODY_MAX_BYTES, "登录请求体过大");
  if (!body.ok) return;
  const parsed = loginRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  const email = parsed.data.email;
  // key 只存摘要：即使数据库被读走，也拿不到教师邮箱清单（email 本身仍存在 teachers 表里，
  // 这里的意义是 login_attempts 这张「会增长的表」不额外多一份 PII）。
  const attemptKey = sha256Hex(email);
  const now = Date.now();
  const lockedMs = lockRemainingMs(ctx.db, attemptKey, now);
  if (lockedMs > 0) {
    const minutes = Math.max(1, Math.ceil(lockedMs / 60_000));
    sendApiError(ctx.res, "rate_limited", `密码错误次数过多，请 ${String(minutes)} 分钟后再试`);
    return;
  }
  const teacher = findTeacherByEmail(ctx.db, email);
  // **邮箱不存在时也要真跑一次 argon2**：否则「账号不存在」是一次主键查询（微秒级），
  // 「密码错」是一次 KDF（几十毫秒），两者差三个数量级，用响应时间就能把
  // teachers 表枚举出来。陪跑的那次校验必然失败，结果一律落到下面的 401。
  const storedHash =
    teacher === undefined ? dummyPasswordHash(ctx.env.argon2MemoryKib) : teacher.password_hash;
  const passwordOk = await verifyPassword(storedHash, parsed.data.password, {
    memoryCost: ctx.env.argon2MemoryKib,
  }).catch(() => false);
  if (teacher === undefined || !passwordOk) {
    const count = recordLoginFailure(
      ctx.db,
      attemptKey,
      now,
      MAX_LOGIN_FAILURES,
      LOGIN_LOCK_MS,
    );
    const left = MAX_LOGIN_FAILURES - count;
    // 统一话术：不区分「邮箱不存在」和「密码错」，避免枚举教师账号。
    const message =
      left > 0 ? "邮箱或密码不正确" : `邮箱或密码不正确，已锁定 ${String(LOGIN_LOCK_MS / 60_000)} 分钟`;
    sendApiError(ctx.res, "unauthorized", message);
    return;
  }
  clearLoginFailures(ctx.db, attemptKey);
  sendJson(
    ctx.res,
    200,
    { ok: true, teacher: toIdentity(teacher) },
    { "set-cookie": buildSessionCookie(teacher.id, ctx.env, now) },
  );
}

export async function handleLogout(ctx: RouteContext): Promise<void> {
  // 登出不需要登录态：重放一个「清 cookie」响应没有副作用。
  sendJson(ctx.res, 200, { ok: true }, { "set-cookie": clearedSessionCookie(ctx.env) });
}

export async function handleMe(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;
  sendJson(ctx.res, 200, { ok: true, teacher: toIdentity(teacher) });
}

export { toIdentity };
