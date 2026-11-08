/**
 * 单题配图：上传 / 预览 / 移除。
 *
 * 上传是**立即发生的**（拿到 assetId 才可能落进 `setImage` op），但真正的版本变更
 * 仍等教师点保存：图片先成为表单下的资产，题目草稿只引用它的 id。这样教师传错图
 * 再换一张，不会连续产生两个版本；未保存就离开顶多留下一个没被引用的资产。
 */

import { useState } from "react";

import type { ItemImage } from "@intentform/schema";

import type { TeacherApi } from "../api/teacher";
import { QuestionImage } from "../render/QuestionImage";

const BUTTON =
  "inline-flex min-h-[36px] cursor-pointer items-center rounded-sm border border-line bg-surface px-2 text-sm text-ink hover:border-accent hover:text-accent";

export function ItemImageEditor({
  formId,
  api,
  image,
  onImage,
}: {
  readonly formId: string;
  readonly api: TeacherApi;
  readonly image: ItemImage | null;
  readonly onImage: (image: ItemImage | null) => void;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = (file: File): void => {
    setBusy(true);
    setError(null);
    void api.uploadAsset(formId, file).then((outcome) => {
      setBusy(false);
      if (!outcome.ok) {
        setError(outcome.failure.message);
        return;
      }
      const alt = file.name.replace(/\.[^.]+$/u, "").trim().slice(0, 200);
      onImage({ assetId: outcome.data.assetId, ...(alt === "" ? {} : { alt }) });
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${BUTTON} ${busy ? "cursor-not-allowed opacity-60" : ""}`}>
          {image === null ? "上传配图" : "更换配图"}
          <input
            type="file"
            data-testid="edit-image-file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            disabled={busy}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file !== undefined) upload(file);
            }}
            className="sr-only"
          />
        </label>
        {image === null ? null : (
          <button
            type="button"
            data-testid="edit-image-remove"
            disabled={busy}
            onClick={() => {
              setError(null);
              onImage(null);
            }}
            className="text-sm text-danger underline underline-offset-2 disabled:opacity-50"
          >
            移除
          </button>
        )}
        {busy ? <span className="text-xs text-muted">上传中…</span> : null}
      </div>

      {error === null ? null : (
        <p className="m-0 text-xs text-danger" role="alert" data-testid="edit-image-error">
          {error}
        </p>
      )}

      <QuestionImage image={image} />
      {image === null ? (
        <p className="m-0 text-xs text-muted">几何图形、实验装置等需要看图作答的题目，在这里上传 PNG / JPEG / WebP。</p>
      ) : null}
    </div>
  );
}
