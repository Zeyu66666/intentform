/**
 * `POST /api/generate` 的 HTTP 边界。
 *
 * 这一层只做四件事，别的一律推给 `@intentform/llm`：
 *   1. 读请求体（有上限）+ 校验 `{ requirement: string }`；
 *   2. 决定「能不能开始一个 SSE 响应」——一旦 `writeHead(200)` 发出去，
 *      422/500 之类的状态码就再也发不了了，所以请求校验必须在写头之前完成；
 *   3. 把 `SseEventBody` 流接到 `SseEventWriter`（挂 seq / 心跳 / 终态唯一）；
 *   4. 客户端断开时 abort 上游，别让 fetch 空转到超时。
 *
 * 纪律：
 * - 错误响应**永远**是 `{ ok: false, error: <机器可读码> }`，不含上游报文；
 * - `error.message` 只来自 `toErrorEventBody()`，它已经过滤掉 Key / 内网 URL；
 * - 探索性日志走注入的 logger，且带 secrets 打码。
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  SseEventWriter,
  generateForm,
  resolveLlmRuntimeConfig,
  silentLogger,
  writeGeneration,
} from "@intentform/llm";
import type { LlmLogger, LlmMode, LlmRuntimeConfig } from "@intentform/llm";
import { LIMITS } from "@intentform/schema";

/** 请求体上限：4000 字需求 + JSON 包装，64KiB 足够，也挡住无脑大包。 */
export const MAX_REQUEST_BYTES = 64 * 1024;

export const GENERATE_PATH = "/api/generate";

export interface GenerateRouteOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly llmMode?: LlmMode;
  readonly config?: LlmRuntimeConfig;
  readonly logger?: LlmLogger;
  /** 心跳间隔（毫秒）；测试传 0 关闭。默认沿用契约的 15s。 */
  readonly heartbeatMs?: number;
}

export type BodyReadResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly message: string };

/** 带上限地读完请求体。超限立刻停止累积并标记 413。 */
export async function readRequestBody(
  req: IncomingMessage,
  maxBytes: number = MAX_REQUEST_BYTES,
): Promise<BodyReadResult> {
  const declared = req.headers["content-length"];
  const declaredBytes = typeof declared === "string" ? Number.parseInt(declared, 10) : Number.NaN;
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: "payload_too_large",
      message: `请求体超过 ${String(maxBytes)} 字节上限`,
    };
  }

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
      total += buf.byteLength;
      if (total > maxBytes) {
        return {
          ok: false,
          status: 413,
          error: "payload_too_large",
          message: `请求体超过 ${String(maxBytes)} 字节上限`,
        };
      }
      chunks.push(buf);
    }
  } catch {
    return { ok: false, status: 400, error: "body_read_failed", message: "请求体读取失败" };
  }
  return { ok: true, text: Buffer.concat(chunks).toString("utf8") };
}

export type RequirementParseResult =
  | { readonly ok: true; readonly requirement: string }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly message: string };

/** 解析 `{ requirement: string }`。空串、纯空白、超长都在这里挡住。 */
export function parseGenerateBody(text: string): RequirementParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, status: 400, error: "invalid_json", message: "请求体不是合法 JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, error: "invalid_requirement", message: "请求体必须是对象" };
  }
  const raw = (parsed as Record<string, unknown>)["requirement"];
  if (typeof raw !== "string") {
    return {
      ok: false,
      status: 400,
      error: "invalid_requirement",
      message: "requirement 必须是字符串",
    };
  }
  const requirement = raw.trim();
  if (requirement === "") {
    return { ok: false, status: 400, error: "invalid_requirement", message: "需求不能为空" };
  }
  if (requirement.length > LIMITS.requirementMaxChars) {
    return {
      ok: false,
      status: 422,
      error: "requirement_too_long",
      message: `需求最多 ${String(LIMITS.requirementMaxChars)} 字，当前 ${String(requirement.length)} 字`,
    };
  }
  return { ok: true, requirement };
}

function sendJson(
  res: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendRejection(res: ServerResponse, result: { status: number; error: string; message: string }): void {
  sendJson(res, result.status, { ok: false, error: result.error, message: result.message });
}

export interface GenerateHandler {
  /** 处理 `/api/generate`；返回前流一定已经写出终态事件或错误响应。 */
  readonly handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  readonly config: LlmRuntimeConfig;
}

export function createGenerateHandler(options: GenerateRouteOptions = {}): GenerateHandler {
  const logger = options.logger ?? silentLogger;
  const env = options.env ?? process.env;
  const config =
    options.config ??
    resolveLlmRuntimeConfig(options.llmMode ?? "replay", env, {});

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== "POST") {
      res.setHeader("allow", "POST");
      sendJson(res, 405, { ok: false, error: "method_not_allowed", message: "只接受 POST" });
      return;
    }

    const contentType = req.headers["content-type"] ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      sendJson(res, 415, {
        ok: false,
        error: "unsupported_media_type",
        message: "content-type 必须是 application/json",
      });
      return;
    }

    const body = await readRequestBody(req);
    if (!body.ok) {
      sendRejection(res, body);
      return;
    }

    const parsed = parseGenerateBody(body.text);
    if (!parsed.ok) {
      sendRejection(res, parsed);
      return;
    }

    if (res.writableEnded || res.destroyed) return;

    // 客户端断开（curl Ctrl-C / 浏览器关闭标签）→ 取消上游，别空转到超时。
    const controller = new AbortController();
    const onClose = (): void => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", onClose);

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      // 上游模式走 HTTP 头而不是塞进 SSE 事件：《计划 v3.0》§2.6 要求「live / replay /
      // mock 始终可辨」，但 7 类事件的载荷是冻结契约，加字段就违约。放在响应头里，
      // 前端只需要一次 `response.headers.get()`，事件流本身一字不改。
      "x-intentform-llm-mode": config.mode,
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // 让 nginx / 各种反代不要缓冲：SSE 被缓冲等于「一次性吐完」，节奏全丢。
      "x-accel-buffering": "no",
      "x-content-type-options": "nosniff",
    });
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const writer = new SseEventWriter({
      write: (text) => {
        if (!res.writableEnded && !res.destroyed) res.write(text);
      },
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
      onTerminal: (event) => {
        logger(
          event.type === "error" ? "warn" : "info",
          event.type === "error"
            ? `generate failed code=${event.code}`
            : `generate done fields=${String(event.stats.fields)} errors=${String(event.stats.errors)} repairs=${String(event.stats.repairs)} ms=${String(event.stats.ms)}`,
          event.type === "error" ? event.message : undefined,
        );
      },
    });

    // 心跳 / 终态唯一性 / 「生成器没发终态」兜底都在 writeGeneration 里，
    // 这里只负责把响应收尾。
    try {
      await writeGeneration(
        writer,
        generateForm({ config, logger }, { requirement: parsed.requirement, signal: controller.signal }),
      );
    } finally {
      res.off("close", onClose);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  };

  return { handle, config };
}
