/**
 * 题目配图上传。
 *
 * 走 JSON + base64（与参考卷一致），不引 multipart；前端先挡 5 MiB，
 * 服务端再按文件头确认 PNG/JPEG/WebP。删除配图只是把题目里的 `image` 置空，
 * 不单独删资产：历史版本可能还引用它。
 */

import {
  API_PATHS,
  ASSET_UPLOAD_MAX_BYTES,
  type AssetUploadResponse,
} from "@intentform/schema";

import type { ReferenceFileLike } from "./reference";
import { fileToBase64 } from "./reference";
import type { ApiResult, HttpClient } from "./http";

export interface AssetApi {
  readonly upload: (
    formId: string,
    file: ReferenceFileLike,
  ) => Promise<ApiResult<AssetUploadResponse>>;
}

export function createAssetApi(client: HttpClient): AssetApi {
  return {
    upload: async (formId, file) => {
      if (file.size > ASSET_UPLOAD_MAX_BYTES) {
        return {
          ok: false,
          failure: { status: null, code: "payload_too_large", message: "图片超过 5 MiB" },
        };
      }
      let data: string;
      try {
        data = fileToBase64(await file.arrayBuffer());
      } catch {
        return {
          ok: false,
          failure: { status: null, code: null, message: "读取图片失败，请重试" },
        };
      }
      return client.request<AssetUploadResponse>(API_PATHS.formAssets(formId), {
        method: "POST",
        body: { filename: file.name, data },
        csrf: true,
      });
    },
  };
}
