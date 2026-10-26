/**
 * @intentform/server 入口。
 *
 * I0 只交付一个零第三方依赖的探活端点，用来证明三件事：
 *   1. monorepo 三个包能互相 import（paths / workspace link 生效）；
 *   2. LLM 模式解析在启动期就失败快速（配置错不拖到第一次生成）；
 *   3. `pnpm typecheck` 在没有任何运行时依赖时也能通过。
 *
 * I4 会用 Hono 替换这一层，保留同样的 `/healthz` 契约，不改前端调用方式。
 */

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { resolveLlmMode, requiresUpstreamCredentials } from "@intentform/llm";
import { FIELD_TYPES, SCHEMA_VERSION } from "@intentform/schema";

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

  const server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
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
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not_found" }));
  });

  server.listen(config.port, () => {
    process.stdout.write(
      `intentform-server listening on http://127.0.0.1:${config.port} (LLM_MODE=${config.llmMode})\n`,
    );
  });

  return server;
}

const entrypoint = process.argv[1];
const isEntrypoint = entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;

if (isEntrypoint) {
  startServer();
}
