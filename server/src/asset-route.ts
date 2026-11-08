/**
 * 题目配图：上传与读取。
 *
 * 安全边界：
 * 1. 上传必须登录且是表单 owner；图片按表单归属存在 `form_assets`，不落公开目录。
 * 2. 只收 PNG/JPEG/WebP，且**按文件头嗅探**；SVG 一律拒绝（脚本/外链风险）。
 * 3. 读取时：已发布表单的图公开（学生页要用）；草稿表单的图只给 owner。
 *    未登录或非 owner 统一 404，不通过 403 泄露「这张图存在」。
 * 4. 图片字节不写日志、不进 JSON schema；版本里只有 `assetId`。
 */

import {
  ASSET_UPLOAD_MAX_BYTES,
  assetUploadRequestSchema,
  type AssetMime,
  type AssetUploadResponse,
} from "@intentform/schema";

import { currentTeacher } from "./auth.ts";
import { findAssetForRead, insertAsset } from "./db/assets.ts";
import { requireOwnedForm } from "./forms-route.ts";
import { readJsonBody, sendApiError, sendJson, type RouteContext } from "./http.ts";
import { newId } from "./ids.ts";

/** base64 膨胀 4/3，再留 64 KiB 给 JSON 外壳。 */
const MAX_BODY_BYTES = Math.ceil(ASSET_UPLOAD_MAX_BYTES / 3) * 4 + 64 * 1024;

function sniffImage(bytes: Buffer): AssetMime | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString("latin1") === "RIFF" &&
    bytes.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

export async function handleUploadAsset(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;

  const body = await readJsonBody(ctx, MAX_BODY_BYTES, "图片超过 5 MiB");
  if (!body.ok) return;
  const parsed = assetUploadRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", "图片上传请求格式不正确");
    return;
  }

  const encoded = parsed.data.data.replace(/\s/gu, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) || encoded.length % 4 !== 0) {
    sendApiError(ctx.res, "bad_request", "图片内容不是合法的 base64");
    return;
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    sendApiError(ctx.res, "bad_request", "图片内容为空");
    return;
  }
  if (bytes.length > ASSET_UPLOAD_MAX_BYTES) {
    sendApiError(ctx.res, "payload_too_large", "图片超过 5 MiB");
    return;
  }
  const mime = sniffImage(bytes);
  if (mime === null) {
    sendApiError(ctx.res, "unprocessable", "只支持 PNG / JPEG / WebP 图片");
    return;
  }

  const assetId = newId("a");
  insertAsset(ctx.db, {
    id: assetId,
    form_id: form.id,
    teacher_id: form.teacher_id,
    mime,
    byte_length: bytes.length,
    bytes,
    created_at: new Date().toISOString(),
  });
  const response: AssetUploadResponse = { ok: true, assetId, mime, byteLength: bytes.length };
  sendJson(ctx.res, 201, response);
}

export async function handleGetAsset(ctx: RouteContext): Promise<void> {
  const assetId = ctx.params["id"];
  if (assetId === undefined) {
    sendApiError(ctx.res, "not_found", "图片不存在");
    return;
  }
  const asset = findAssetForRead(ctx.db, assetId);
  if (asset === undefined) {
    sendApiError(ctx.res, "not_found", "图片不存在");
    return;
  }

  if (asset.form_status !== "published") {
    const teacher = currentTeacher(ctx);
    if (teacher === undefined || teacher.id !== asset.form_teacher_id) {
      // 草稿图不向非 owner 暴露存在性。
      sendApiError(ctx.res, "not_found", "图片不存在");
      return;
    }
  }

  ctx.res.statusCode = 200;
  ctx.res.setHeader("content-type", asset.mime);
  ctx.res.setHeader("content-length", String(asset.byte_length));
  ctx.res.setHeader("x-content-type-options", "nosniff");
  ctx.res.setHeader(
    "cache-control",
    asset.form_status === "published" ? "public, max-age=31536000, immutable" : "private, no-store",
  );
  ctx.res.end(asset.bytes);
}
