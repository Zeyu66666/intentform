/**
 * 参考试卷上传（`.docx` / `.pdf`）。
 *
 * 解析在服务端：浏览器没有稳定的 PDF 文本层读取能力，而服务端已经有 Node 的
 * `zlib` 与统一的错误形状。这里只做两件事：把文件读成 base64、把结果交回界面。
 * 解析失败不抛异常，仍走 `ApiResult`，界面才能把服务端的「扫描件没有文字层」
 * 原样显示给教师。
 */

import {
  API_PATHS,
  REFERENCE_UPLOAD_MAX_BYTES,
  type ReferenceExtractResponse,
} from "@intentform/schema";

import type { ApiResult, HttpClient } from "./http";

/** 只需要 File 的这三样；测试可以用普通对象代替，不必构造浏览器 File。 */
export interface ReferenceFileLike {
  readonly name: string;
  readonly size: number;
  readonly arrayBuffer: () => Promise<ArrayBuffer>;
}

export interface ReferenceApi {
  readonly extract: (file: ReferenceFileLike) => Promise<ApiResult<ReferenceExtractResponse>>;
}

/** 分块 `btoa`：一次 `String.fromCharCode(...bytes)` 会把大文件的参数栈打爆。 */
export function fileToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function createReferenceApi(client: HttpClient): ReferenceApi {
  return {
    extract: async (file) => {
      if (file.size > REFERENCE_UPLOAD_MAX_BYTES) {
        return {
          ok: false,
          failure: { status: null, code: "payload_too_large", message: "文件超过 10 MiB" },
        };
      }
      let data: string;
      try {
        data = fileToBase64(await file.arrayBuffer());
      } catch {
        return {
          ok: false,
          failure: { status: null, code: null, message: "读取文件失败，请重试" },
        };
      }
      return client.request<ReferenceExtractResponse>(API_PATHS.referenceExtract, {
        method: "POST",
        body: { filename: file.name, data },
        csrf: true,
      });
    },
  };
}
