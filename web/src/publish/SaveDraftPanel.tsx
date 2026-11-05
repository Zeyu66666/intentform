/**
 * 左栏底部的「保存草稿」：把生成结果落库（`POST /api/forms`）**但不发布**。
 *
 * 发布拆成两步是刻意的：生成结果先落成草稿，教师在编辑器里改完题目、确认无误后
 * 再点「发布」。生成页只有一个「保存草稿」按钮；发布入口在编辑页，避免把
 * 「刚生成、还没检查」的卷子直接推给学生。
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

import type { CreateFormResponse, FormItem, FormKind } from "@intentform/schema";

import type { TeacherApi } from "../api/teacher";
import { FORM_KIND_LABELS } from "../dashboard/model";
import { Link } from "../Link";
import { DASHBOARD_PATH, LOGIN_PATH, routeToPath } from "../router";
import { buildPublishDraft } from "./build-draft";
import {
  describeDraftFailure,
  describePublishFailure,
  type PublishFailureView,
} from "./publish-flow";

export interface SaveDraftPanelProps {
  /** 当前生成出来的字段（`selectPreviewFields()` 的 node）。 */
  readonly fields: readonly FormItem[];
  /** 需求原文：标题从它派生。 */
  readonly requirementText: string;
  readonly kind: FormKind;
  /** 面板只调 `createForm`；收窄依赖便于单测注入桩。 */
  readonly api: Pick<TeacherApi, "createForm">;
  /** 已保存的草稿由 `App` 持有：生成页重渲染不丢「去编辑」的入口。 */
  readonly saved: CreateFormResponse | null;
  readonly onSaved: (value: CreateFormResponse) => void;
}

export function SaveDraftPanel({
  fields,
  requirementText,
  kind,
  api,
  saved,
  onSaved,
}: SaveDraftPanelProps): JSX.Element {
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<PublishFailureView | null>(null);

  // 卸载后不再 setState：请求还在路上时用户可能已经清空重来。
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
  const blocked = draft.ok ? null : describeDraftFailure(draft);

  async function handleSave(): Promise<void> {
    if (saving) return;
    setFailure(null);

    const current = buildPublishDraft(fields, requirementText, kind);
    if (!current.ok) {
      setFailure(describeDraftFailure(current));
      return;
    }

    setSaving(true);
    const created = await api.createForm(current.request);
    if (!alive.current) return;
    setSaving(false);
    if (!created.ok) {
      setFailure(describePublishFailure(created.failure));
      return;
    }
    onSaved(created.data);
  }

  const shownFailure = failure ?? blocked;

  if (saved !== null) {
    return (
      <div className="flex shrink-0 flex-col gap-1 border-t border-line p-2" data-testid="saved-draft">
        <h2 className="m-0 text-sm font-semibold">草稿已保存</h2>
        <p className="m-0 text-sm text-success" aria-live="polite">
          {`${saved.form.title} · 草稿 v${String(saved.version.n)} 已保存`}
        </p>
        <p className="m-0 text-xs text-muted">
          修改题目、分值、解析都在编辑页完成；确认无误后再点「发布」，草稿不会自动发给学生。
        </p>
        <div className="flex flex-wrap gap-1">
          <Link
            href={routeToPath({ name: "edit", formId: saved.form.id })}
            data-testid="saved-draft-link"
            className="rounded-sm bg-accent px-2 py-1 text-sm font-medium text-white hover:opacity-90"
          >
            去编辑并发布
          </Link>
          <Link
            href={DASHBOARD_PATH}
            className="rounded-sm border border-line px-2 py-1 text-sm text-muted hover:border-accent hover:text-accent"
          >
            回看板
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex shrink-0 flex-col gap-1 border-t border-line p-2">
      <h2 className="m-0 text-sm font-semibold">保存草稿</h2>

      {draft.ok ? (
        <p className="m-0 text-xs text-muted">
          将保存：{draft.title} · {FORM_KIND_LABELS[kind]} · {String(fields.length)} 项
          {draft.totalScore === null ? "" : ` · 满分 ${String(draft.totalScore)} 分`}
        </p>
      ) : null}
      <p className="m-0 text-xs text-muted">先保存，再在编辑器里改到满意后发布。</p>

      <button
        type="button"
        data-testid="save-draft"
        onClick={() => {
          void handleSave();
        }}
        disabled={saving || blocked !== null}
        className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {saving ? "正在保存草稿…" : "保存为草稿"}
      </button>

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
