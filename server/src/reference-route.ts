/**
 * `POST /api/reference/extract` —— 上传参考试卷并提取纯文本。
 *
 * 边界：
 * 1. 匿名可用（生成页本来就匿名），但和生成共用每分钟配额：解析 PDF/DOCX 是本地
 *    CPU 活，不能成为免限流的解压入口。
 * 2. 只认 `.docx` / `.pdf`，且**扩展名与文件头都要对**；改名文件不会进入解析器。
 * 3. 文件内容不进日志、不落盘、不回显原文；响应只回提取后的文本，供规划用。
 * 4. 超出 `PLAN_REFERENCE_MAX_CHARS` 的文本截断并回 `truncated`，不静默丢内容。
 */

import {
  PLAN_REFERENCE_MAX_CHARS,
  REFERENCE_UPLOAD_MAX_BYTES,
  referenceExtractRequestSchema,
  type ReferenceExtractResponse,
} from "@intentform/schema";

import { describeZodError, readJsonBody, sendApiError, sendJson, type RouteContext } from "./http.ts";
import { extractReference, ReferenceTextError } from "./reference/index.ts";

export const REFERENCE_EXTRACT_PATH = "/api/reference/extract";

/** base64 膨胀 4/3，再留 64 KiB 给 JSON 外壳。 */
const MAX_BODY_BYTES = Math.ceil(REFERENCE_UPLOAD_MAX_BYTES / 3) * 4 + 64 * 1024;

export async function handleExtractReference(ctx: RouteContext): Promise<void> {
  const body = await readJsonBody(ctx, MAX_BODY_BYTES, "文件超过 10 MiB");
  if (!body.ok) return;

  const parsed = referenceExtractRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }

  const encoded = parsed.data.data.replace(/\s/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    sendApiError(ctx.res, "bad_request", "文件内容不是合法的 base64");
    return;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    sendApiError(ctx.res, "bad_request", "文件内容为空");
    return;
  }
  if (bytes.length > REFERENCE_UPLOAD_MAX_BYTES) {
    sendApiError(ctx.res, "payload_too_large", "文件超过 10 MiB");
    return;
  }

  let extracted;
  try {
    extracted = extractReference(parsed.data.filename, bytes);
  } catch (error) {
    if (error instanceof ReferenceTextError) {
      sendApiError(ctx.res, "unprocessable", error.message);
      return;
    }
    sendApiError(ctx.res, "unprocessable", "这份文件无法解析，请换一份 .docx 或文字型 PDF");
    return;
  }

  const truncated = extracted.text.length > PLAN_REFERENCE_MAX_CHARS;
  const text = truncated ? extracted.text.slice(0, PLAN_REFERENCE_MAX_CHARS) : extracted.text;
  if (text.trim() === "") {
    sendApiError(ctx.res, "unprocessable", "这份文件没有可用的文字内容");
    return;
  }

  const response: ReferenceExtractResponse = {
    ok: true,
    filename: parsed.data.filename,
    kind: extracted.kind,
    text,
    charCount: text.length,
    truncated,
    warnings: truncated
      ? [...extracted.warnings, `参考卷超过 ${String(PLAN_REFERENCE_MAX_CHARS)} 字，已截断`]
      : extracted.warnings,
  };
  sendJson(ctx.res, 200, response);
}
