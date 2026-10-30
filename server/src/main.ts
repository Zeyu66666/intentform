/**
 * @intentform/server 入口。
 *
 * I0 交付零第三方依赖的探活端点；I2 在同一个 node:http 上外加 `POST /api/generate`
 * （SSE 流式生成）。用 node:http 而不是 Hono：这条链路的全部难点在「分帧 + 背压 +
 * 断开取消」，框架只会把它藏起来。证明三件事：
 *   1. monorepo 三个包能互相 import（paths / workspace link 生效）；
 *   2. LLM 模式解析在启动期就失败快速（配置错不拖到第一次生成）；
 *   3. `pnpm typecheck` 在没有任何运行时依赖时也能通过。
 *
 * I4 的落库/鉴权/提交/看板都挂在这一层上（见 `app.ts` 的路由表）。原计划写的是
 * 「I4 用 Hono 替换这一层」，实际不换：拒掉框架是本作品的对冲手段之一，
 * 路由表 + 三个横切点（CORS 预检、跨站写保护、错误兜底）手写一共几十行，
 * 换来的是评审能把整条 HTTP 链路一次读完。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  createLogger,
  resolveLlmMode,
  resolveLlmRuntimeConfig,
  requiresUpstreamCredentials,
} from "@intentform/llm";
import { FIELD_TYPES, SCHEMA_VERSION } from "@intentform/schema";

import { GENERATE_PATH, createGenerateHandler } from "./generate-route.ts";
import { createApiApp } from "./app.ts";
import { openDatabase } from "./db/index.ts";
import { readServerEnv, type ServerEnv } from "./env.ts";
import { clientIp } from "./http.ts";
import { createRateLimiter, rateLimitKey } from "./rate-limit.ts";
import { isProductionEnvironment, PRODUCTION_CONTENT_SECURITY_POLICY } from "./security.ts";

export interface ServerConfig {
  readonly port: number;
  readonly llmMode: ReturnType<typeof resolveLlmMode>;
  readonly needsApiKey: boolean;
}

function parsePort(raw: string | undefined): number {
  const fallback = 8787;
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`invalid PORT: ${raw}`);
  }
  return parsed;
}

function acceptsHtml(accept: string | string[] | undefined): boolean {
  const value = Array.isArray(accept) ? accept.join(",") : (accept ?? "");
  return value.includes("text/html");
}

function contentTypeFor(pathname: string): string {
  const extension = extname(pathname).toLowerCase();
  if (extension === ".js" || extension === ".mjs") return "text/javascript; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".json") return "application/json; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".woff2") return "font/woff2";
  return "application/octet-stream";
}

function readWebFile(indexHtml: string, pathname: string): { readonly body: Buffer; readonly contentType: string } | undefined {
  const root = resolve(indexHtml, "..");
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(root, relative);
  if (candidate !== root && !candidate.startsWith(`${root}\\`) && !candidate.startsWith(`${root}/`)) {
    return undefined;
  }
  try {
    if (!statSync(candidate).isFile()) return undefined;
    return { body: readFileSync(candidate), contentType: contentTypeFor(candidate) };
  } catch {
    return undefined;
  }
}

function sendWebFile(res: ServerResponse, file: { readonly body: Buffer; readonly contentType: string }): void {
  res.statusCode = 200;
  res.setHeader("content-type", file.contentType);
  res.setHeader("cache-control", file.contentType.startsWith("text/html") ? "no-store" : "public, max-age=31536000, immutable");
  res.end(file.body);
}

/** 读取并校验启动配置。任何非法值在启动阶段就抛错。 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const llmMode = resolveLlmMode(env);
  return {
    port: parsePort(env["PORT"]),
    llmMode,
    needsApiKey: requiresUpstreamCredentials(llmMode),
  };
}

export function healthPayload(config: ServerConfig): Record<string, unknown> {
  return {
    ok: true,
    service: "intentform-server",
    schemaVersion: SCHEMA_VERSION,
    fieldTypes: FIELD_TYPES,
    llmMode: config.llmMode,
    needsApiKey: config.needsApiKey,
  };
}

export function startServer(env: NodeJS.ProcessEnv = process.env): ReturnType<typeof createServer> {
  const config = readConfig(env);

  // 上游配置在启动期解析：缺 Key / 非法 LLM_TIMEOUT_MS 现在就抛，而不是等第一次生成。
  const llmConfig = resolveLlmRuntimeConfig(config.llmMode, env);
  const logger = createLogger({
    secrets: llmConfig.apiKey === null ? [] : [llmConfig.apiKey],
    verbose: env["LLM_LOG_VERBOSE"] === "1",
  });
  const generateRoute = createGenerateHandler({ config: llmConfig, logger });

  // I4 持久层：数据库打开即完成幂等迁移，句柄跟着这条连接活。
  const serverEnv: ServerEnv = readServerEnv(env);
  const production = isProductionEnvironment(serverEnv.rawEnv);
  const db = openDatabase(serverEnv.databasePath);
  // 限流器在 `main.ts` 建、同时交给 API 应用和 `/api/generate`：两条写路径共用
  // 同一份内存计数，否则「生成限流」和「提交限流」会各自从 0 开始，也就没有全局视图。
  const limiter = createRateLimiter();
  const api = createApiApp({ db, env: serverEnv, limiter, llm: { config: llmConfig, logger } });

  const server = createServer((req, res) => {
    const pathname = (req.url ?? "/").split("?")[0] ?? "/";

    if (production) {
      res.setHeader("content-security-policy", PRODUCTION_CONTENT_SECURITY_POLICY);
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("referrer-policy", "strict-origin-when-cross-origin");
    }

    // 生产同源部署直接由 Node 托管 Vite 产物；开发期仍由 Vite dev server 负责。
    // `/f/:slug` 留给 API 应用处理，它要区分 HTML 壳与学生 JSON。
    if (production && serverEnv.webIndexHtml !== "" && req.method === "GET" && pathname !== "/healthz" && !pathname.startsWith("/api/") && !pathname.startsWith("/f/") && acceptsHtml(req.headers.accept)) {
      const file = readWebFile(serverEnv.webIndexHtml, "/");
      if (file === undefined) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "not_found", message: "未找到前端构建产物" }));
      } else {
        sendWebFile(res, file);
      }
      return;
    }

    if (production && serverEnv.webIndexHtml !== "" && req.method === "GET" && pathname.startsWith("/assets/")) {
      const file = readWebFile(serverEnv.webIndexHtml, pathname);
      if (file === undefined) {
        res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "not_found" }));
      } else {
        sendWebFile(res, file);
      }
      return;
    }

    if (req.method === "GET" && pathname === "/healthz") {
      const body = JSON.stringify(healthPayload(config));
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(body);
      return;
    }

    if (pathname === GENERATE_PATH) {
      // 生成是唯一一条会花真金白银的写路径（LLM 调用），限额在进 SSE 之前判：
      // 超限时回一个普通 429 JSON，客户端拿到的不是半截事件流。
      const limited = limiter.hit(
        rateLimitKey("generate", serverEnv.sessionSecret, clientIp(req)),
        serverEnv.rateGeneratePerMin,
      );
      if (!limited.ok) {
        const body = JSON.stringify({
          ok: false,
          error: "rate_limited",
          message: `请求过于频繁，请 ${String(limited.retryAfterSeconds)} 秒后再试`,
        });
        res.writeHead(429, {
          "content-type": "application/json; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "no-store",
          "retry-after": String(limited.retryAfterSeconds),
        });
        res.end(body);
        return;
      }
      void generateRoute.handle(req, res).catch((error: unknown) => {
        logger("error", "generate route crashed", error instanceof Error ? error.message : String(error));
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "internal" }));
        } else if (!res.writableEnded) {
          res.end();
        }
      });
      return;
    }

    if (api.handle(req, res)) return;

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  // 关服务时把 SQLite 连接收掉，避免测试里临时文件句柄悬空（Windows 上尤其会挡删除）。
  server.on("close", () => {
    db.close();
  });

  server.listen(config.port, () => {
    const address = server.address();
    const boundPort = address !== null && typeof address === "object" ? address.port : config.port;
    process.stdout.write(
      `intentform-server listening on http://127.0.0.1:${String(boundPort)} (LLM_MODE=${config.llmMode})\n`,
    );
    process.stdout.write(`intentform-server db: ${serverEnv.databasePath}\n`);
    // 允许来源要打印：跨站写保护拒掉的第一个请求永远长成「403 缺少 Origin / Origin 不被允许」，
    // 而唯一能解释它的信息就是「服务端认哪个来源」。不打印的话，联调只能靠猜。
    if (serverEnv.appOrigin === "") {
      process.stdout.write(
        "intentform-server origin: inferred from Host（APP_ORIGIN 为空）\n",
      );
      process.stdout.write(
        "intentform-server warn: 代理会改写 Host，dev 跨端口联调请显式设置 APP_ORIGIN=http://127.0.0.1:5173\n",
      );
    } else {
      process.stdout.write(`intentform-server origin: ${serverEnv.appOrigin}\n`);
    }
    if (serverEnv.sessionSecretSource === "ephemeral") {
      process.stdout.write(
        "intentform-server warn: SESSION_SECRET 未设置，本次使用一次性密钥（重启后已登录会话失效）\n",
      );
    }
    // 生产同源托管：`/` 与 `/f/:slug` 的 HTML 请求要回一张壳。路径配错时的症状是
    // 「学生扫码后白屏 / 只看到一段 JSON」，而那时已经离开终端了 —— 所以在启动期就说清楚。
    if (serverEnv.webIndexHtml !== "") {
      const ok = existsSync(serverEnv.webIndexHtml);
      process.stdout.write(
        ok
          ? `intentform-server html: ${serverEnv.webIndexHtml}\n`
          : `intentform-server warn: WEB_INDEX_HTML=${serverEnv.webIndexHtml} 不存在，HTML 请求会退回 404 JSON（先跑 pnpm build:web）\n`,
      );
    }
  });

  return server;
}

const entrypoint = process.argv[1];
const isEntrypoint = entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;

if (isEntrypoint) {
  startServer();
}
