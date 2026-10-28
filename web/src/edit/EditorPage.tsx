/**
 * 受限修改页 `/forms/<id>/edit`（省赛 R-03）。
 *
 * 页面结构照 PublishPanel 的两步思路拆：**数据态**（这份表单的哪个版本、加载/失败）
 * 与**编辑态**（用户排的意图和草稿）各自独立，右侧面板只是编辑态的一个视图。
 *
 * 三条必须守住的界面规矩：
 *   1. **预览即所得**：底部 Diff 条展示的 `changes` 来自 `applyPatch()`，
 *      与「保存」后服务端算出来的是同一份纯函数的结果，不是前端自己比字段得出的。
 *   2. **冲突不自动重试**：收到 409 只提示「已被改动，请刷新」，刷新按钮重新 `GET`。
 *      自动用最新版本重放 op 会让另一位教师的改动被静默覆盖——那是数据事故。
 *   3. **`undone === false` 不是错误**：它只是"已经在第一个版本"，用中性提示，
 *      不要弹红色错误框吓人。
 *
 * 撤销用 `fromVersionId` 而不是「第几版」：版本号是给人看的，指针才是真的身份。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

import { LIMITS, type FormDetailResponse } from "@intentform/schema";

import { describeFailure, isUnauthorized, isVersionConflict } from "../api/failures";
import { createHttpClient, type ApiFailure } from "../api/http";
import { createTeacherApi } from "../api/teacher";
import { Link } from "../Link";
import { SuggestBox } from "./SuggestBox";
import { TYPE_LABELS } from "../render/FieldRegistry";
import { DASHBOARD_PATH, LOGIN_PATH, routeToPath } from "../router";
import {
  draftOf,
  initialEditState,
  moveTargets,
  planPatch,
  resolveSelection,
  scoreOfItem,
  withAddItem,
  withMoveItem,
  withRemoveItem,
  withScore,
  withSelection,
  withStem,
  type EditState,
  type ItemDraft,
  type PatchPlan,
} from "./patch-plan";

/** 409 的唯一文案：与看板的失败翻译分开写，因为这里要做的是"刷新"而不是"重试"。 */
const CONFLICT_TEXT = "这份表单已被改动，请刷新后重试" as const;
const FIRST_VERSION_TEXT = "已经是第一个版本" as const;

/** 页脚与正文共用的宽度：Diff 条要和列表对齐，否则看起来像两个页面的东西。 */
const PAGE = "mx-auto w-full max-w-4xl" as const;

type LoadState =
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly failure: ApiFailure }
  /** 详情与编辑态放在一起：有详情就一定有编辑态，不存在"详情到了但编辑态还没建"的中间帧。 */
  | {
      readonly status: "ready";
      readonly detail: FormDetailResponse;
      readonly edit: EditState;
    };

interface Notice {
  readonly tone: "success" | "info" | "error";
  readonly text: string;
  /** 冲突时才为真：给一个「刷新」按钮，而不是替用户覆盖。 */
  readonly needsReload: boolean;
}

export function EditorPage({ formId }: { readonly formId: string }): JSX.Element {
  const api = useMemo(() => createTeacherApi(createHttpClient()), []);

  const [load, setLoad] = useState<LoadState>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  /** 点「刷新」或换表单时 +1，驱动重新取数；保存/撤销成功后不走这里（就地更新）。 */
  const [reloadToken, setReloadToken] = useState(0);

  /**
   * 手动发起的请求（保存/撤销）没有 `cancelled` 闭包可用：它们在事件回调里启动，
   * 卸载时已经没有 cleanup 可挂。用一个 ref 标记挂载状态，避免卸载后 setState。
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    setNotice(null);
    void api.getForm(formId).then((outcome) => {
      if (cancelled) return;
      if (!outcome.ok) {
        setLoad({ status: "error", failure: outcome.failure });
        return;
      }
      // `version.id` 是乐观锁基准：从这里之后的所有 op 都声明"我是基于这一版改的"。
      setLoad({
        status: "ready",
        detail: outcome.data,
        edit: initialEditState(outcome.data.schema, outcome.data.version.id),
      });
    });
    return () => {
      cancelled = true;
    };
  }, [api, formId, reloadToken]);

  /** 编辑态的唯一写入口：`updater` 是 `patch-plan` 里的纯函数，组件不自己拼状态。 */
  const update = (updater: (state: EditState) => EditState): void => {
    setLoad((current) =>
      current.status === "ready" ? { ...current, edit: updater(current.edit) } : current,
    );
  };

  if (load.status === "loading") {
    return (
      <Shell>
        <p className="m-0 text-sm text-muted">正在加载表单…</p>
      </Shell>
    );
  }

  if (load.status === "error") {
    return (
      <Shell>
        <ErrorBlock failure={load.failure} />
      </Shell>
    );
  }

  const { detail, edit } = load;
  const plan = planPatch(edit);
  // 预览用哪份 Schema：`applyPatch()` 成功时用它的输出（已补默认值），
  // 失败时回落到原始 Schema——不能让一次非法输入把整个列表清空。
  const preview = plan.ok ? plan.preview : edit.schema;
  const selected = resolveSelection(preview, edit.selectedItemId);
  // 上移/下移的落点在这里算一次，面板只负责按 null 禁用按钮。
  const targets = selected === null ? { up: null, down: null } : moveTargets(preview.items, selected.id);

  const handleReload = (): void => {
    setReloadToken((token) => token + 1);
  };

  const handleSave = (): void => {
    if (busy || !plan.ok || !plan.hasChanges) return;
    setBusy(true);
    setNotice(null);
    void api.patchForm(formId, plan.request).then((outcome) => {
      if (!alive.current) return;
      setBusy(false);
      if (!outcome.ok) {
        setNotice(noticeForFailure(outcome.failure));
        return;
      }
      // 服务端已经落好新版本：就地换成它返回的 schema/version，不再多发一次 GET。
      setLoad({
        status: "ready",
        detail: outcome.data,
        edit: initialEditState(outcome.data.schema, outcome.data.version.id),
      });
      setNotice({ tone: "success", text: `已生成 v${String(outcome.data.version.n)}`, needsReload: false });
    });
  };

  const handleUndo = (): void => {
    if (busy) return;
    setBusy(true);
    setNotice(null);
    void api.undoDraft(formId, { fromVersionId: edit.baseVersionId }).then((outcome) => {
      if (!alive.current) return;
      setBusy(false);
      if (!outcome.ok) {
        setNotice(noticeForFailure(outcome.failure));
        return;
      }
      if (!outcome.data.undone) {
        // 指针已经指向第一个版本：这不是失败，只是没有上一步可退。
        setNotice({ tone: "info", text: FIRST_VERSION_TEXT, needsReload: false });
        return;
      }
      setLoad({
        status: "ready",
        detail: outcome.data,
        edit: initialEditState(outcome.data.schema, outcome.data.version.id),
      });
      setNotice({
        tone: "success",
        text: `已撤销，当前草稿 v${String(outcome.data.version.n)}`,
        needsReload: false,
      });
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-line bg-surface">
        <div className={`${PAGE} flex flex-wrap items-baseline gap-2 px-2 py-2`}>
          <h1 className="m-0 text-lg font-semibold text-ink">编辑表单</h1>
          <p className="m-0 text-sm text-muted" data-testid="edit-form-meta">
            {`${detail.form.title} · 当前草稿 v${String(detail.version.n)} · ${String(preview.items.length)} 题`}
          </p>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="edit-undo"
              className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-ink disabled:opacity-50"
              disabled={busy}
              onClick={handleUndo}
            >
              撤销上一步
            </button>
            <Link href={routeToPath({ name: "dashboard", formId })} className="text-sm text-muted underline">
              回看板
            </Link>
          </div>
        </div>
        {notice === null ? null : <NoticeLine notice={notice} busy={busy} onReload={handleReload} />}
      </header>

      {/* 建议是"只读"的一步：它只回 ops 与差异，点采用之后才会走 PATCH。 */}
      <SuggestBox
        formId={formId}
        baseVersionId={edit.baseVersionId}
        onNotice={(text, tone, needsReload) => {
          setNotice({ tone, text, needsReload });
        }}
        onApplied={(applied) => {
          setLoad({
            status: "ready",
            detail: {
              ...detail,
              schema: applied.schema,
              version: { ...detail.version, id: applied.versionId, n: applied.versionN },
              form: { ...detail.form, draftVersionId: applied.versionId },
            },
            edit: initialEditState(applied.schema, applied.versionId),
          });
        }}
      />

      <main
        className={`${PAGE} grid min-h-0 flex-1 grid-cols-1 gap-[var(--layout-gap)] overflow-y-auto px-2 py-2 lg:grid-cols-[16rem_minmax(0,1fr)] lg:overflow-hidden`}
      >
        <section
          aria-label="题目列表"
          className="flex min-h-0 min-w-0 flex-col gap-1 overflow-y-auto rounded-md border border-line bg-surface p-2"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="m-0 text-xs text-muted">题目</h2>
            <button
              type="button"
              data-testid="edit-add"
              className="min-h-[44px] rounded-sm border border-accent px-2 text-sm text-accent disabled:opacity-50"
              disabled={preview.items.length >= LIMITS.fieldsMax}
              onClick={() => {
                update(withAddItem);
              }}
            >
              加题
            </button>
          </div>
          <ol className="m-0 flex list-none flex-col gap-1 p-0">
            {preview.items.map((item, index) => {
              const isCurrent = selected !== null && item.id === selected.id;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`edit-item-${item.id}`}
                    aria-current={isCurrent ? "true" : undefined}
                    className={`w-full rounded-sm border px-2 py-1 text-left ${
                      isCurrent ? "border-accent bg-bg" : "border-line bg-surface"
                    }`}
                    onClick={() => {
                      update((state) => withSelection(state, item.id));
                    }}
                  >
                    <span className="block text-xs text-muted">{`第 ${String(index + 1)} 题 · ${TYPE_LABELS[item.type]}`}</span>
                    <span className="block truncate text-sm text-ink">{item.title}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </section>

        <section
          aria-label="编辑面板"
          className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto rounded-md border border-line bg-surface p-2"
        >
          {selected === null ? (
            <p className="m-0 text-sm text-muted">这份表单还没有题目，点左侧「加题」开始。</p>
          ) : (
            <FieldEditor
              key={selected.id}
              itemId={selected.id}
              title={selected.title}
              score={scoreOfItem(selected)}
              draft={draftOf(edit, selected)}
              upTarget={targets.up}
              downTarget={targets.down}
              canDelete={preview.items.length > 1}
              onStem={(stem) => {
                update((state) => withStem(state, selected.id, stem));
              }}
              onScore={(score) => {
                update((state) => withScore(state, selected.id, score));
              }}
              onMove={(toIndex) => {
                update((state) => withMoveItem(state, selected.id, toIndex));
              }}
              onDelete={() => {
                update((state) => withRemoveItem(state, selected.id));
              }}
            />
          )}
        </section>
      </main>

      <DiffBar plan={plan} busy={busy} onSave={handleSave} />
    </div>
  );
}

function noticeForFailure(failure: ApiFailure): Notice {
  if (isVersionConflict(failure)) {
    return { tone: "error", text: CONFLICT_TEXT, needsReload: true };
  }
  return {
    tone: "error",
    text: describeFailure(failure, { notFound: "这份表单不存在，或已被删除" }),
    needsReload: isUnauthorized(failure),
  };
}

function Shell({ children }: { readonly children: ReactNode }): JSX.Element {
  return <main className={`${PAGE} px-2 py-3`}>{children}</main>;
}

function NoticeLine({
  notice,
  busy,
  onReload,
}: {
  readonly notice: Notice;
  readonly busy: boolean;
  readonly onReload: () => void;
}): JSX.Element {
  const toneClass = ((): string => {
    switch (notice.tone) {
      case "success":
        return "text-success";
      case "info":
        return "text-muted";
      case "error":
        return "text-danger";
    }
  })();

  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      data-testid="edit-notice"
      className={`${PAGE} flex flex-wrap items-baseline gap-2 px-2 pb-2 text-sm ${toneClass}`}
    >
      <span>{notice.text}</span>
      {notice.needsReload ? (
        <button
          type="button"
          data-testid="edit-reload"
          className="min-h-[44px] rounded-sm border border-accent px-2 text-sm text-accent disabled:opacity-50"
          disabled={busy}
          onClick={onReload}
        >
          刷新
        </button>
      ) : null}
    </div>
  );
}

function ErrorBlock({ failure }: { readonly failure: ApiFailure }): JSX.Element {
  const needsLogin = isUnauthorized(failure);
  return (
    <section className="rounded-md border border-danger bg-surface p-3" role="alert">
      <p className="m-0 text-base text-danger">
        {describeFailure(failure, { notFound: "这份表单不存在，或已被删除" })}
      </p>
      <p className="m-0 mt-1 text-sm text-muted">
        {needsLogin ? (
          <Link href={LOGIN_PATH} className="text-accent underline">
            去登录
          </Link>
        ) : (
          <Link href={DASHBOARD_PATH} className="text-accent underline">
            回看板
          </Link>
        )}
      </p>
    </section>
  );
}

/**
 * 单题编辑面板。
 *
 * `key={itemId}` 在父组件上：换题时整个面板重建，输入框的浏览器内部状态（比如
 * number 框的中间态）跟着重置，不会把上一题的半截输入带到下一题。
 */
function FieldEditor({
  itemId,
  title,
  score,
  draft,
  upTarget,
  downTarget,
  canDelete,
  onStem,
  onScore,
  onMove,
  onDelete,
}: {
  readonly itemId: string;
  /** 预览里的当前题干，只用于占位提示，不改写用户正在敲的内容。 */
  readonly title: string;
  /** `null` 表示这题没有分值（分节/量表），分值输入框不渲染。 */
  readonly score: number | null;
  readonly draft: ItemDraft;
  /** 上移/下移的**绝对**目标下标；`null` 表示到头了。 */
  readonly upTarget: number | null;
  readonly downTarget: number | null;
  readonly canDelete: boolean;
  readonly onStem: (stem: string) => void;
  readonly onScore: (score: number) => void;
  readonly onMove: (toIndex: number) => void;
  readonly onDelete: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted" htmlFor={`edit-stem-${itemId}`}>
          题干
        </label>
        <textarea
          id={`edit-stem-${itemId}`}
          data-testid="edit-stem"
          rows={3}
          value={draft.stem}
          placeholder={title}
          className="w-full rounded-sm border border-line bg-bg p-1 text-base text-ink"
          onChange={(event) => {
            onStem(event.target.value);
          }}
        />
      </div>

      {score === null ? (
        <p className="m-0 text-xs text-muted">这题不计分（分节/量表），没有分值可改。</p>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted" htmlFor={`edit-score-${itemId}`}>
            {`分值（0–${String(LIMITS.scoreMax)}）`}
          </label>
          <input
            id={`edit-score-${itemId}`}
            data-testid="edit-score"
            type="number"
            min={0}
            max={LIMITS.scoreMax}
            step={1}
            // 空串交给 NaN：空分值不该被悄悄当成 0 分写进草稿。
            value={Number.isNaN(draft.score) ? "" : draft.score}
            className="min-h-[44px] w-32 rounded-sm border border-line bg-bg p-1 text-base tabular-nums text-ink"
            onChange={(event) => {
              const raw = event.target.value;
              onScore(raw === "" ? Number.NaN : Number(raw));
            }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="edit-move-up"
          className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-ink disabled:opacity-50"
          disabled={upTarget === null}
          onClick={() => {
            if (upTarget !== null) onMove(upTarget);
          }}
        >
          上移
        </button>
        <button
          type="button"
          data-testid="edit-move-down"
          className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-ink disabled:opacity-50"
          disabled={downTarget === null}
          onClick={() => {
            if (downTarget !== null) onMove(downTarget);
          }}
        >
          下移
        </button>
        <button
          type="button"
          data-testid="edit-delete"
          className="min-h-[44px] rounded-sm border border-danger px-2 text-sm text-danger disabled:opacity-50"
          disabled={!canDelete}
          onClick={onDelete}
        >
          删除
        </button>
        {canDelete ? null : <span className="text-xs text-muted">至少要留一道题</span>}
      </div>
    </div>
  );
}

/** Diff 预览条：粘在页面底部，改了什么一眼能看到，再决定按不按保存。 */
function DiffBar({
  plan,
  busy,
  onSave,
}: {
  readonly plan: PatchPlan;
  readonly busy: boolean;
  readonly onSave: () => void;
}): JSX.Element {
  return (
    <footer className="shrink-0 border-t border-line bg-surface">
      <div className={`${PAGE} flex max-h-40 flex-col gap-1 overflow-y-auto px-2 py-2`} data-testid="edit-diff">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="m-0 text-xs text-muted">
            {plan.ok ? `改动预览（${String(plan.changes.length)} 条）` : "改动预览"}
          </h2>
          <button
            type="button"
            data-testid="edit-save"
            className="min-h-[44px] rounded-sm border border-accent px-3 text-sm text-accent disabled:opacity-50"
            disabled={busy || !plan.ok || !plan.hasChanges}
            onClick={onSave}
          >
            {busy ? "保存中…" : "保存为新草稿"}
          </button>
        </div>

        {plan.ok ? (
          plan.changes.length === 0 ? (
            <p className="m-0 text-sm text-muted">还没有改动。</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="edit-changes">
              {plan.changes.map((change, index) => (
                // `changes` 没有稳定 id（同一条 op 可能对同一题出现两次：先改分值再改回去），
                // 用下标当 key 在这里是安全的——列表只增不减地整体重渲染。
                <li
                  key={`${String(index)}-${change.op}-${change.where}`}
                  className="flex flex-wrap items-baseline gap-1 text-sm"
                >
                  <span className="text-muted">{change.where}</span>
                  <span className="tabular-nums text-ink">{change.before}</span>
                  <span aria-hidden="true" className="text-muted">
                    →
                  </span>
                  <span className="tabular-nums text-ink">{change.after}</span>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="m-0 text-sm text-danger" role="alert" data-testid="edit-plan-error">
            {plan.message}
          </p>
        )}
      </div>
    </footer>
  );
}
