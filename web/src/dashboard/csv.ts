/**
 * CSV 导出入口的链接拼法。
 *
 * 为什么要单独一个文件：CSV 是**浏览器直接下载**（`<a href>`），不走 `fetch`，
 * 所以它不经过 `api/http.ts`，拼接错了不会被任何现有测试照到。另一个坑是
 * 契约里 `CSV_BASE_COLUMNS` 是"导出里不许出现答案"的字节级断言依据，
 * 这里放一条断言把它盯着。
 */

import { API_PATHS, CSV_BASE_COLUMNS } from "@intentform/schema";

/** 下载地址。`API_PATHS.submissionsCsv` 已做 `encodeURIComponent`，不再二次编码。 */
export function csvHref(formId: string): string {
  return API_PATHS.submissionsCsv(formId);
}

/**
 * `download` 属性的建议文件名。
 *
 * 真正的文件名以服务端 `Content-Disposition` 为准（同源下载时浏览器优先用它），
 * 这里只是文件被另存为时的兜底。带 `formId` 是为了让教师同时导出几份时不互相覆盖。
 */
export function csvFileName(formId: string): string {
  return `submissions-${formId}.csv`;
}

/** 契约里的固定前缀列。界面用它判断"这份导出是否还带着答案列"的回归点。 */
export const CSV_HEADER_BASE: readonly string[] = CSV_BASE_COLUMNS;

/** 导出里任何一列都不允许是答案/解析——一旦混进去，整份就是泄题材料。 */
export function containsAnswerColumn(columns: readonly string[]): boolean {
  return columns.some((column) => column === "answer" || column === "explanation");
}
