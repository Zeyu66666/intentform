/**
 * 生成链路的错误对象：**稳定错误码 + 面向用户的一句话 + 只进日志的明细**。
 *
 * 为什么不用裸 `Error`：
 * - 终态 `error` 事件的码只能来自契约里的 `SSE_ERROR_CODES`（6 个，不许自造），
 *   前端按码决定「重试」还是「先去配 Key」，自由文本做不到这件事；
 * - 上游原始报文可能含 Key 片段或内部 URL。`message` 是**出网**的，
 *   `detail` 是**进日志**的，两者必须分开：出网文案由我们自己写，明细先脱敏。
 *
 * `retryable` 挂在错误上而不是让调用方按码查表，是为了让「同一个码在不同上下文里
 * 是否可重试」有唯一答案（今天没有这种差异，将来有也不会散落到各处）。
 */

import type { SseErrorCode, SseEventBody } from "@intentform/schema";

/** 终态 `error` 事件的 body（未挂 `seq` 的形态）。 */
export type ErrorEventBody = Extract<SseEventBody, { readonly type: "error" }>;

/** 可重试的码：超时、上游失败、模型输出不合法。其余三个都要人先动手。 */
const RETRYABLE_CODES: ReadonlySet<SseErrorCode> = new Set<SseErrorCode>([
  "llm_timeout",
  "llm_upstream",
  "llm_invalid_output",
]);

export function isRetryableErrorCode(code: SseErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

export interface LlmErrorInit {
  /** 只进服务端日志的原始信息（调用方负责先脱敏）。 */
  readonly detail?: string;
  readonly cause?: unknown;
}

export class LlmError extends Error {
  readonly code: SseErrorCode;

  readonly retryable: boolean;

  readonly detail: string | undefined;

  constructor(code: SseErrorCode, message: string, init: LlmErrorInit = {}) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "LlmError";
    this.code = code;
    this.retryable = isRetryableErrorCode(code);
    // 显式存 `undefined` 而不是省略属性：`exactOptionalPropertyTypes` 下
    // 这样调用方读 `error.detail` 的类型是 `string | undefined`，不需要再判 in。
    this.detail = init.detail;
  }
}

export function isLlmError(value: unknown): value is LlmError {
  return value instanceof LlmError;
}

const USER_MESSAGE_MAX = 200;

/** 任何 scheme 的 URL：出网文案里一律替换掉，堵住「内部地址泄到前端」这条路。 */
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** 常见密钥形态：`sk-...`、`Bearer ...`、`api_key=`。日志脱敏的兜底网。 */
const KEY_SHAPED_PATTERN = /\b(?:sk|pk|ak)[-_][A-Za-z0-9_-]{6,}/g;

const AUTH_HEADER_PATTERN = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;

const ASSIGNED_SECRET_PATTERN = /\b(api[_-]?key|authorization|token)(["']?\s*[:=]\s*)([^\s,}"']+)/gi;

/** 出网文案统一过一遍：去控制字符、抹 URL、截断、兜底非空。 */
export function sanitizeUserMessage(raw: string): string {
  const withoutUrls = raw.replace(URL_PATTERN, "<upstream>");
  const flattened = withoutUrls
    // `\p{Cc}` = Unicode 控制字符类，等价于 `\u0000-\u001f\u007f` 但不需要在源码里
    // 写裸控制字符（后者会被 lint 的 no-control-regex 拦下，也确实容易看错）。
    .replace(/[\p{Cc}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const capped =
    flattened.length > USER_MESSAGE_MAX ? `${flattened.slice(0, USER_MESSAGE_MAX - 1)}…` : flattened;
  return capped === "" ? "生成失败" : capped;
}

/**
 * 日志脱敏。`secrets` 是「本次运行确实用到的那几个值」（例如 API Key），
 * 按值替换比按形态匹配更可靠；形态匹配只作为第二道网。
 */
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim() === "") continue;
    out = out.split(secret).join("***");
  }
  out = out.replace(KEY_SHAPED_PATTERN, (match) => `${match.slice(0, 2)}***`);
  out = out.replace(AUTH_HEADER_PATTERN, "$1 ***");
  out = out.replace(ASSIGNED_SECRET_PATTERN, "$1$2***");
  return out;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

/**
 * 任意异常 → 终态 `error` 的 body。
 *
 * 非 `LlmError` 一律归到 `internal` 且文案固定：未知异常的 message 里可能有
 * 文件路径、栈片段、序列化后的请求体，不适合出网。
 */
export function toErrorEventBody(error: unknown): ErrorEventBody {
  if (error instanceof LlmError) {
    return {
      type: "error",
      code: error.code,
      message: sanitizeUserMessage(error.message),
      retryable: error.retryable,
    };
  }
  return {
    type: "error",
    code: "internal",
    message: "服务端处理生成请求时出错，请稍后重试",
    retryable: false,
  };
}

/** 日志用的一行描述：码 + 脱敏明细。调用方决定打到哪。 */
export function describeError(error: unknown, secrets: readonly string[] = []): string {
  if (error instanceof LlmError) {
    const detail = error.detail === undefined ? "" : ` detail=${redactSecrets(truncate(error.detail, 500), secrets)}`;
    return `${error.code}: ${redactSecrets(error.message, secrets)}${detail}`;
  }
  if (error instanceof Error) {
    return `internal: ${error.name}: ${redactSecrets(truncate(error.message, 500), secrets)}`;
  }
  return `internal: ${redactSecrets(truncate(String(error), 500), secrets)}`;
}
