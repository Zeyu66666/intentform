/**
 * 题目配图的唯一渲染入口。
 *
 * 图片按 `assetId` 从服务端取：已发布表单公开、草稿仅教师可见。尺寸只由容器
 * 限制（`max-h` + `max-w-full`），不写死像素——同一张图在手机、打印卷和教师预览
 * 里各自缩放，避免把大图撑破版面。
 *
 * `alt` 缺省时用「题目配图」而不是空串：图片加载失败或读屏时，至少知道这里
 * 本来有一张图。`loading="lazy"` 只影响屏幕；打印媒体下浏览器会按已加载的图输出。
 */

import { API_PATHS, type ItemImage } from "@intentform/schema";

export function QuestionImage({
  image,
  className = "",
}: {
  readonly image: ItemImage | null | undefined;
  readonly className?: string;
}): JSX.Element | null {
  if (image === null || image === undefined) return null;
  return (
    <img
      data-testid={`question-image-${image.assetId}`}
      src={API_PATHS.asset(image.assetId)}
      alt={image.alt ?? "题目配图"}
      loading="lazy"
      decoding="async"
      className={`my-2 max-h-72 w-auto max-w-full rounded-sm border border-line object-contain print:border-0 ${className}`}
    />
  );
}
