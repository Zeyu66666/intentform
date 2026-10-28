/**
 * 测试脚手架：真的起一个 `node:http` 服务、真的发 HTTP 请求。
 *
 * 不用 supertest / 不起 mock：`generate-route.test.ts` 已经立了这个先例——
 * 我们关心的是「线上那条路能不能走通」，绕开 server 直接调 handler 就测不到
 * cookie、content-type、状态码这些真正会出问题的地方。
 *
 * 每个测试一个 `:memory:` 数据库（隔离、零清理），`afterEach` 里 close 掉连接。
 * argon2 的内存成本在测试里降到 8 MiB：验证逻辑与生产一致，只是别让 40 个
 * 用例各花 50ms 在 KDF 上。
 */

import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { hashSync } from "@node-rs/argon2";
import type { CreateFormResponse, FormSchema, PublishResponse } from "@intentform/schema";
import { resolveLlmRuntimeConfig, silentLogger } from "@intentform/llm";

import { createApiApp } from "../app.ts";
import { openDatabase, type Db } from "../db/index.ts";
import { insertTeacher } from "../db/teachers.ts";
import { newId } from "../ids.ts";
import { readServerEnv, type ServerEnv } from "../env.ts";
import { createFormBody } from "./fixtures.ts";

export const TEST_APP_ORIGIN = "http://127.0.0.1:5173";
// 测试用固定会话密钥：只在本进程的内存库里签 cookie，不是任何环境的凭据。
// 扫描器按 `SECRET = <24+ 字符>` 的形状报警，这里显式标注为误报并写明理由。
export const TEST_SESSION_SECRET = "test-session-secret-not-a-real-key"; // secret-scan:allow
export const TEST_PASSWORD = "intentform-test-password";

export interface TestServer {
  readonly baseUrl: string;
  readonly db: Db;
  readonly env: ServerEnv;
  close(): Promise<void>;
}

export function createTestEnv(overrides: NodeJS.ProcessEnv = {}): ServerEnv {
  return readServerEnv({
    APP_ORIGIN: TEST_APP_ORIGIN,
    DATABASE_PATH: ":memory:",
    SESSION_SECRET: TEST_SESSION_SECRET,
    COOKIE_SECURE: "false",
    ARGON2_MEMORY_KIB: "8192",
    ...overrides,
  });
}

export async function startTestServer(env: ServerEnv = createTestEnv()): Promise<TestServer> {
  const db = openDatabase(env.databasePath);
  // 测试默认给 mock 模式的模型依赖：`/api/plan` 因此能真打，且不联网、不花钱。
  const llm = {
    config: resolveLlmRuntimeConfig("mock", {}, {}),
    logger: silentLogger,
  };
  const app = createApiApp({ db, env, llm });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (app.handle(req, res)) return;
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server failed to bind");
  }
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;
  return {
    baseUrl,
    db,
    env,
    close: async (): Promise<void> => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      db.close();
    },
  };
}

export interface TestTeacher {
  readonly id: string;
  readonly email: string;
  readonly password: string;
}

export function seedTeacher(db: Db, email = "teacher@example.com", password = TEST_PASSWORD): TestTeacher {
  const id = newId("t");
  insertTeacher(db, {
    id,
    email,
    password_hash: hashSync(password, { memoryCost: 8192 }),
    created_at: new Date().toISOString(),
  });
  return { id, email, password };
}

export interface CallOptions {
  readonly body?: unknown;
  /** 直接发原始文本（测非法 JSON / 超长体）。 */
  readonly rawBody?: string;
  readonly cookie?: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** 省略时用 APP_ORIGIN；传 null 表示故意不发 Origin。 */
  readonly origin?: string | null;
  readonly csrf?: boolean;
}

export interface ApiResponse<T> {
  readonly status: number;
  readonly text: string;
  readonly json: T;
  readonly setCookies: readonly string[];
  readonly contentType: string | null;
}

export async function call<T = unknown>(
  server: TestServer,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { ...options.headers };
  const origin = options.origin === undefined ? TEST_APP_ORIGIN : options.origin;
  if (origin !== null) headers["origin"] = origin;
  if (options.csrf !== false) headers["x-intentform-csrf"] = "1";
  if (options.cookie !== undefined) headers["cookie"] = options.cookie;
  let payload: string | undefined;
  if (options.rawBody !== undefined) {
    payload = options.rawBody;
    headers["content-type"] = headers["content-type"] ?? "application/json";
  } else if (options.body !== undefined) {
    payload = JSON.stringify(options.body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${server.baseUrl}${path}`, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
  const text = await response.text();
  let json: T;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = undefined as T;
  }
  return {
    status: response.status,
    text,
    json,
    setCookies: response.headers.getSetCookie(),
    contentType: response.headers.get("content-type"),
  };
}

/** 从 `set-cookie` 里取出 `name=value` 片段，供后续请求拼 Cookie 头。 */
export function cookieFrom(setCookies: readonly string[], name = "intentform_session"): string {
  for (const raw of setCookies) {
    const first = raw.split(";")[0];
    if (first !== undefined && first.startsWith(`${name}=`)) return first;
  }
  throw new Error(`set-cookie 里没有 ${name}：${setCookies.join(" | ")}`);
}

/** 登录并返回可复用的 Cookie 头。 */
export async function login(
  server: TestServer,
  email = "teacher@example.com",
  password = TEST_PASSWORD,
): Promise<string> {
  const response = await call(server, "POST", "/api/auth/login", {
    body: { email, password },
  });
  if (response.status !== 200) {
    throw new Error(`登录失败 ${String(response.status)}：${response.text}`);
  }
  return cookieFrom(response.setCookies);
}

/** 测试里要断言「响应体字节里没有敏感键」时用。 */
export function byteLength(text: string): number {
  return createHash("sha256").update(text).digest("hex").length;
}

export interface PublishedQuiz {
  readonly formId: string;
  readonly versionId: string;
  readonly slug: string;
}

/** 建卷 → 发布，一条龙。学生端/看板/提交的测试都从这里起步。 */
export async function createPublishedQuiz(
  server: TestServer,
  cookie: string,
  kind: "quiz" | "survey" = "quiz",
  schema?: FormSchema,
): Promise<PublishedQuiz> {
  const created = await call<CreateFormResponse>(server, "POST", "/api/forms", {
    body: createFormBody(kind, schema),
    cookie,
  });
  if (created.status !== 201) {
    throw new Error(`建表单失败 ${String(created.status)}：${created.text}`);
  }
  const published = await call<PublishResponse>(
    server,
    "POST",
    `/api/forms/${created.json.form.id}/publish`,
    { body: { versionId: created.json.version.id }, cookie },
  );
  if (published.status !== 200) {
    throw new Error(`发布失败 ${String(published.status)}：${published.text}`);
  }
  return {
    formId: created.json.form.id,
    versionId: created.json.version.id,
    slug: published.json.slug,
  };
}
