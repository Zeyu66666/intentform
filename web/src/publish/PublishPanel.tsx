/**
 * 左栏底部的「保存并发布」：把生成结果落库（`POST /api/forms`）再发布
 * （`POST /api/forms/:id/publish`），拿到学生短链。
 *
 * 两条纪律写在这里：
 *   1. **401 不自动跳转**。跳走会把时间线和预览整片抹掉，演示当场断；给一个
 *      「先登录」链接，点不点由人决定。
 *   2. **400 原样显示服务端的 `message`**。那句话是 `E_ANSWER_MISSING@items[3]` 这种
 *      定位信息，前端改写一遍就等于把"哪道题错了"删掉（见 `publish-flow.ts`）。
 *
 * 组件只管"什么时候调谁"，纯决策全在 `build-draft.ts` / `publish-flow.ts` 里（那是被测的）。
 */

import { useEffect, useRef, useState } from "react";

import type { FormItem, FormKind } from "@intentform/schema";

import type { TeacherApi } from "../api/teacher";
import { FORM_KIND_LABELS } from "../dashboard/model";
import { Link } from "../Link";
import { LOGIN_PATH } from "../router";
import { buildPublishDraft } from "./build-draft";
import {
  describeDraftFailure,
  describePublishFailure,
  formatStudentUrl,
  toPublishedForm,
  type PublishFailureView,
  type PublishedForm,
} from "./publish-flow";

export interface PublishPanelProps {
  /** 当前生成出来的字段（`selectPreviewFields()` 的 node）。 */
  readonly fields: readonly FormItem[];
  /** 需求原文：标题从它派生。 */
  readonly requirementText: string;
  readonly kind: FormKind;
  readonly api: TeacherApi;
  /** 已发布结果由 `App` 持有：生成页重渲染不丢链接。 */
  readonly published: PublishedForm | null;
  readonly onPublished: (value: PublishedForm) => void;
}

/** 两步都是网络往返，界面必须说清"卡在哪一步"。 */
type Step = "creating" | "publishing";

type CopyState = "idle" | "copied" | "failed";

const STEP_TEXT: Readonly<Record<Step, string>> = {
  creating: "正在保存草稿…",
  publishing: "正在发布…",
};

const COPY_TEXT: Readonly<Record<CopyState, string>> = {
  idle: "复制链接",
  copied: "已复制",
  failed: "复制失败",
};

export function PublishPanel({
  fields,
  requirementText,
  kind,
  api,
  published,
  onPublished,
}: PublishPanelProps): JSX.Element {
  const [step, setStep] = useState<Step | null>(null);
  const [failure, setFailure] = useState<PublishFailureView | null>(null);
  const [copy, setCopy] = useState<CopyState>("idle");

  // 卸载后不再 setState：两次 await 之间用户可能已经清空重来。
  // 挂载时置回 true —— StrictMode 的双挂载会先跑一次 cleanup，不置回就永远拿不到结果。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // 每次渲染都重算：本组件只在 `status === "done"` 之后挂载，
  // 渲染次数与"用户点了几个按钮"同级，为它加 memo 反而要维护一个不稳定的依赖数组。
  const draft = buildPublishDraft(fields, requirementText, kind);
  const busy = step !== null;
  const blocked = draft.ok ? null : describeDraftFailure(draft);

  async function handlePublish(): Promise<void> {
    if (busy) return;
    setFailure(null);
    setCopy("idle");

    const current = buildPublishDraft(fields, requirementText, kind);
    if (!current.ok) {
      setFailure(describeDraftFailure(current));
      return;
    }

    setStep("creating");
    const created = await api.createForm(current.request);
    if (!alive.current) return;
    if (!created.ok) {
      setStep(null);
      setFailure(describePublishFailure(created.failure));
      return;
    }

    setStep("publishing");
    const publishedVersion = await api.publishForm(created.data.form.id, {
      versionId: created.data.version.id,
    });
    if (!alive.current) return;
    setStep(null);
    if (!publishedVersion.ok) {
      setFailure(describePublishFailure(publishedVersion.failure));
      return;
    }

    onPublished(
      toPublishedForm(
        created.data.form,
        created.data.version,
        publishedVersion.data.slug,
        current.totalScore,
      ),
    );
  }

  async function handleCopy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      if (alive.current) setCopy("copied");
    } catch {
      // 非安全上下文（http 的局域网地址）里 clipboard 直接不可用：给出可手动选取的输入框，
      // 比"复制失败"四个字更有用，所以链接始终以只读 input 呈现。
      if (alive.current) setCopy("failed");
    }
  }

  const shownFailure = failure ?? blocked;

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-line p-2">
      <h2 className="m-0 text-sm font-semibold">发布</h2>

      {published === null ? null : (
        <div className="flex flex-col gap-1">
          <p className="m-0 text-xs text-success" aria-live="polite">
            已发布：{published.title}
            <span className="text-muted">
              {" · "}
              {FORM_KIND_LABELS[published.kind]}
              {published.totalScore === null ? " · 不判分" : ` · 满分 ${String(published.totalScore)} 分`}
            </span>
          </p>
          <label htmlFor="student-link" className="text-xs text-muted">
            学生链接
          </label>
          <input
            id="student-link"
            readOnly
            value={formatStudentUrl(published.path, window.location.origin)}
            onFocus={(event) => {
              event.currentTarget.select();
            }}
            className="w-full rounded-sm border border-line bg-surface px-2 py-1 text-xs"
          />
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => {
                void handleCopy(formatStudentUrl(published.path, window.location.origin));
              }}
              className="rounded-sm border border-accent px-2 py-1 text-xs text-accent hover:bg-bg"
            >
              {COPY_TEXT[copy]}
            </button>
            <Link
              href={published.path}
              className="rounded-sm border border-line px-2 py-1 text-xs hover:border-accent hover:text-accent"
            >
              打开学生页
            </Link>
          </div>
          <p className="m-0 text-xs text-muted">站内路径 {published.path}</p>
        </div>
      )}

      {published !== null ? null : (
        <div className="flex flex-col gap-1">
          {draft.ok ? (
            <p className="m-0 text-xs text-muted">
              将发布：{draft.title} · {FORM_KIND_LABELS[kind]} · {String(fields.length)} 项
              {draft.totalScore === null ? "" : ` · 满分 ${String(draft.totalScore)} 分`}
            </p>
          ) : null}

          <button
            type="button"
            onClick={() => {
              void handlePublish();
            }}
            disabled={busy || blocked !== null}
            className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
          >
            {step === null ? "保存并发布" : STEP_TEXT[step]}
          </button>
        </div>
      )}

      {shownFailure === null ? null : (
        <div role="alert" className="flex flex-col gap-1 rounded-sm border border-danger p-1">
          <p className="m-0 text-xs break-words text-danger">{shownFailure.message}</p>
          {shownFailure.showLogin ? (
            <Link
              href={LOGIN_PATH}
              className="w-fit rounded-sm border border-accent px-2 py-1 text-xs text-accent hover:bg-bg"
            >
              先登录
            </Link>
          ) : null}
        </div>
      )}
    </div>
  );
}
