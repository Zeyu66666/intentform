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

import { LIMITS, type FormDetailResponse, type FormItem } from "@intentform/schema";

import { describeFailure, isUnauthorized, isVersionConflict } from "../api/failures";
import { createHttpClient, type ApiFailure } from "../api/http";
import { createTeacherApi } from "../api/teacher";
import { Link } from "../Link";
import { ItemEditor } from "./ItemEditor";
import { SuggestBox } from "./SuggestBox";
import { SupplementBox } from "./SupplementBox";
import { parseAddQuery, type AddPrefill } from "./supplement-query";
import { TYPE_LABELS } from "../render/FieldRegistry";
import { DASHBOARD_PATH, LOGIN_PATH, routeToPath } from "../router";
import { toAnswerPayload } from "./answer-input";
import {
  draftOf,
  initialEditState,
  moveTargets,
  nextItemId,
  planPatch,
  resolveSelection,
  withAddItem,
  withAnswer,
  withClearItemDraft,
  withExplanation,
  withMaxLength,
  withMeta,
  withMoveItem,
  withOptions,
  withRemoveItem,
  withRequired,
  withScore,
  withSelection,
  withStem,
  type EditState,
  type PatchPlan,
} from "./patch-plan";

/** 409 的唯一文案：与看板的失败翻译分开写，因为这里要做的是"刷新"而不是"重试"。 */
const CONFLICT_TEXT = "这份表单已被改动，请刷新后重试" as const;
const FIRST_VERSION_TEXT = "已经是第一个版本" as const;

/** 页脚与正文共用的宽度：Diff 条要和列表对齐，否则看起来像两个页面的东西。 */
const PAGE = "mx-auto w-full max-w-5xl" as const;

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
  /** 重做栈是否有一步可退。服务端是唯一事实源，这里只缓存详情/撤销/重做的返回值。 */
  const [redoAvailable, setRedoAvailable] = useState(false);
  /** 覆盖矩阵点进来的补题目标（`?add=1&kp=…&bloom=…`）；处理完就清空。 */
  const [supplement, setSupplement] = useState<AddPrefill | null>(() => parseAddQuery(window.location.search));
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
    setRedoAvailable(false);
    void api.getForm(formId).then((outcome) => {
      if (cancelled) return;
      if (!outcome.ok) {
        setLoad({ status: "error", failure: outcome.failure });
        return;
      }
      // `version.id` 是乐观锁基准：从这里之后的所有 op 都声明"我是基于这一版改的"。
      setRedoAvailable(outcome.data.redoAvailable);
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
  const selectedIndex = selected === null ? -1 : preview.items.findIndex((item) => item.id === selected.id);
  // 面板与建议条上的题号：只数题目，不数分节（第一道题永远是「第 1 题」）。
  const selectedOrdinal =
    selected === null || selectedIndex < 0
      ? 0
      : preview.items
          .slice(0, selectedIndex + 1)
          .filter((item) => item.type !== "section").length;
  const selectedLabel =
    selected === null ? "" : selected.type === "section" ? "分节" : `第 ${String(selectedOrdinal)} 题`;

  const handleReload = (): void => {
    setReloadToken((token) => token + 1);
  };

  /** 补题面板处理完就从地址栏去掉查询串，刷新时不会又弹一次。 */
  const finishSupplement = (): void => {
    setSupplement(null);
    window.history.replaceState(null, "", window.location.pathname);
  };

  const handleManualSupplement = (): void => {
    if (supplement === null) return;
    const id = nextItemId(preview.items);
    update((state) =>
      withSelection(
        withAddItem(state, {
          id,
          knowledgePoint: supplement.knowledgePoint,
          bloom: supplement.bloom,
        }),
        id,
      ),
    );
    finishSupplement();
  };

  const handleGeneratedSupplement = (item: FormItem): void => {
    update((state) => withSelection(withAddItem(state, { item }), item.id));
    finishSupplement();
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
      // 新版本产生 = 旧的撤销分支作废，服务端已清空重做栈。
      setRedoAvailable(false);
      setLoad({
        status: "ready",
        detail: { ...outcome.data, redoAvailable: false },
        // 保存后停在同一题：连续打磨一道题时，回到第一题等于每保存一次就打断一次。
        edit: withSelection(initialEditState(outcome.data.schema, outcome.data.version.id), selected?.id ?? null),
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
        setRedoAvailable(outcome.data.redoAvailable);
        setNotice({ tone: "info", text: FIRST_VERSION_TEXT, needsReload: false });
        return;
      }
      setRedoAvailable(outcome.data.redoAvailable);
      setLoad({
        status: "ready",
        detail: outcome.data,
        edit: withSelection(initialEditState(outcome.data.schema, outcome.data.version.id), selected?.id ?? null),
      });
      setNotice({
        tone: "success",
        text: `已撤销，当前草稿 v${String(outcome.data.version.n)}`,
        needsReload: false,
      });
    });
  };

  const handleRedo = (): void => {
    if (busy || !redoAvailable) return;
    setBusy(true);
    setNotice(null);
    void api.redoDraft(formId, { fromVersionId: edit.baseVersionId }).then((outcome) => {
      if (!alive.current) return;
      setBusy(false);
      if (!outcome.ok) {
        setNotice(noticeForFailure(outcome.failure));
        return;
      }
      setRedoAvailable(outcome.data.redoAvailable);
      if (!outcome.data.redone) {
        setNotice({ tone: "info", text: "没有可重做的步骤", needsReload: false });
        return;
      }
      setLoad({
        status: "ready",
        detail: outcome.data,
        edit: withSelection(initialEditState(outcome.data.schema, outcome.data.version.id), selected?.id ?? null),
      });
      setNotice({
        tone: "success",
        text: `已重做，当前草稿 v${String(outcome.data.version.n)}`,
        needsReload: false,
      });
    });
  };

  const questionCount = preview.items.filter((item) => item.type !== "section").length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="no-print border-b border-line bg-surface">
        <div className={`${PAGE} flex flex-wrap items-center gap-2 px-2 py-3`}>
          <div className="min-w-0">
            <Link
              href={routeToPath({ name: "dashboard", formId })}
              className="text-sm text-muted transition-colors hover:text-accent"
            >
              ← 返回看板
            </Link>
            <div className="mt-1 flex flex-wrap items-baseline gap-2">
              <h1 className="m-0 text-lg font-semibold text-ink">编辑表单</h1>
              <p className="m-0 truncate text-sm text-muted" data-testid="edit-form-meta">
                {`${detail.form.title} · 当前草稿 v${String(detail.version.n)} · ${String(questionCount)} 题`}
              </p>
            </div>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex overflow-hidden rounded-sm border border-line bg-surface">
              <button
                type="button"
                data-testid="edit-undo"
                className="min-h-[44px] border-r border-line px-3 text-sm text-ink transition-colors hover:bg-bg disabled:opacity-50"
                disabled={busy}
                onClick={handleUndo}
              >
                撤销上一步
              </button>
              <button
                type="button"
                data-testid="edit-redo"
                className="min-h-[44px] px-3 text-sm text-ink transition-colors hover:bg-bg disabled:opacity-50"
                disabled={busy || !redoAvailable}
                onClick={handleRedo}
              >
                重做
              </button>
            </div>
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
          // 采用建议会生成新版本，旧撤销分支作废。
          setRedoAvailable(false);
          setLoad({
            status: "ready",
            detail: {
              ...detail,
              schema: applied.schema,
              version: { ...detail.version, id: applied.versionId, n: applied.versionN },
              form: { ...detail.form, draftVersionId: applied.versionId },
            },
            // 整表建议采用后也尽量停在原题：改同一题的连贯动作不该被打断。
            edit: withSelection(initialEditState(applied.schema, applied.versionId), edit.selectedItemId),
          });
        }}
      />

      <main
        className={`${PAGE} grid min-h-0 flex-1 grid-cols-1 gap-[var(--layout-gap)] overflow-y-auto px-2 py-2 lg:grid-cols-[18rem_minmax(0,1fr)] lg:overflow-hidden`}
      >
        <section
          aria-label="题目列表"
          className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto rounded-md border border-line bg-surface p-2"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-baseline gap-2">
              <h2 className="m-0 text-sm font-semibold text-ink">题目</h2>
              <span className="rounded-sm bg-bg px-1 text-xs tabular-nums text-muted">
                {String(questionCount)}
              </span>
            </div>
            <button
              type="button"
              data-testid="edit-add"
              className="min-h-[44px] rounded-sm border border-accent px-2 text-sm text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-50"
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
              const score = "score" in item ? item.score : undefined;
              const ordinal = preview.items
                .slice(0, index + 1)
                .filter((node) => node.type !== "section").length;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    data-testid={`edit-item-${item.id}`}
                    aria-current={isCurrent ? "true" : undefined}
                    className={`group w-full rounded-sm border px-2 py-2 text-left transition-colors ${
                      isCurrent
                        ? "border-line border-l-4 border-l-accent bg-bg"
                        : "border-line bg-surface hover:border-accent"
                    }`}
                    onClick={() => {
                      update((state) => withSelection(state, item.id));
                    }}
                  >
                    <span className="flex items-center gap-1 text-xs text-muted">
                      {item.type === "section" ? (
                        <span className="rounded-sm bg-bg px-1 text-muted">分节</span>
                      ) : (
                        <>
                          <span className="tabular-nums">{`第 ${String(ordinal)} 题`}</span>
                          <span aria-hidden="true">·</span>
                          <span>{TYPE_LABELS[item.type]}</span>
                        </>
                      )}
                      {score === undefined ? null : (
                        <span className="ml-auto tabular-nums text-muted">{`${String(score)} 分`}</span>
                      )}
                    </span>
                    <span className="mt-1 block truncate text-sm text-ink">{item.title}</span>
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
          {supplement === null ? null : (
            <SupplementBox
              api={api}
              formId={formId}
              baseVersionId={edit.baseVersionId}
              knowledgePoint={supplement.knowledgePoint}
              objectiveName={
                detail.schema.meta.objectives.find(
                  (objective) => objective.id === supplement.knowledgePoint,
                )?.name ?? supplement.knowledgePoint
              }
              bloom={supplement.bloom}
              onManual={handleManualSupplement}
              onGenerated={handleGeneratedSupplement}
            />
          )}
          {selected === null ? (
            <p className="m-0 text-sm text-muted">这份表单还没有题目，点左侧「加题」开始。</p>
          ) : (
            <>
              {/* 单题建议条属于"正在编辑的这题"：它在面板顶部，作用域写着这题的 id。 */}
              <SuggestBox
                key={`item-suggest-${selected.id}`}
                formId={formId}
                baseVersionId={edit.baseVersionId}
                scopeItemId={selected.id}
                scopeLabel={selectedLabel}
                onNotice={(text, tone, needsReload) => {
                  setNotice({ tone, text, needsReload });
                }}
                onApplied={(applied) => {
                  setRedoAvailable(false);
                  setLoad({
                    status: "ready",
                    detail: {
                      ...detail,
                      schema: applied.schema,
                      version: { ...detail.version, id: applied.versionId, n: applied.versionN },
                      form: { ...detail.form, draftVersionId: applied.versionId },
                    },
                    // 采用后停在同一题：连续打磨一道题是常见动作。
                    edit: withSelection(initialEditState(applied.schema, applied.versionId), selected.id),
                  });
                }}
              />
              <ItemEditor
                key={selected.id}
                item={selected}
                draft={draftOf(edit, selected)}
                hasDraft={edit.drafts[selected.id] !== undefined}
                index={selectedOrdinal < 1 ? 0 : selectedOrdinal - 1}
                objectives={detail.schema.meta.objectives}
                upTarget={targets.up}
                downTarget={targets.down}
                canDelete={preview.items.length > 1}
                onStem={(stem) => {
                  update((state) => withStem(state, selected.id, stem));
                }}
                onScore={(score) => {
                  update((state) => withScore(state, selected.id, score));
                }}
                onOptions={(options) => {
                  update((state) => withOptions(state, selected.id, options));
                }}
                onAnswer={(answer) => {
                  update((state) => withAnswer(state, selected.id, toAnswerPayload(answer)));
                }}
                onExplanation={(explanation) => {
                  update((state) => withExplanation(state, selected.id, explanation));
                }}
                onRequired={(required) => {
                  update((state) => withRequired(state, selected.id, required));
                }}
                onMeta={(meta) => {
                  update((state) => withMeta(state, selected.id, meta));
                }}
                onMaxLength={(maxLength) => {
                  update((state) => withMaxLength(state, selected.id, maxLength));
                }}
                onClear={() => {
                  update((state) => withClearItemDraft(state, selected.id));
                }}
                onMove={(toIndex) => {
                  update((state) => withMoveItem(state, selected.id, toIndex));
                }}
                onDelete={() => {
                  update((state) => withRemoveItem(state, selected.id));
                }}
              />
            </>
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
        return "border-success text-success";
      case "info":
        return "border-line text-muted";
      case "error":
        return "border-danger text-danger";
    }
  })();

  return (
    <div
      role={notice.tone === "error" ? "alert" : "status"}
      data-testid="edit-notice"
      className={`${PAGE} flex flex-wrap items-center gap-2 border-l-4 px-2 py-2 text-sm ${toneClass}`}
    >
      <span className="min-w-0 flex-1">{notice.text}</span>
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
    <footer className="no-print shrink-0 border-t border-line bg-surface">
      <div className={`${PAGE} flex max-h-48 flex-col gap-1 overflow-y-auto px-2 py-2`} data-testid="edit-diff">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="m-0 text-sm font-semibold text-ink">改动预览</h2>
          {plan.ok ? (
            <span className="rounded-sm bg-bg px-1 text-xs tabular-nums text-muted">
              {`${String(plan.changes.length)} 条`}
            </span>
          ) : null}
          <button
            type="button"
            data-testid="edit-save"
            className="ml-auto min-h-[44px] rounded-sm bg-accent px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            disabled={busy || !plan.ok || !plan.hasChanges}
            onClick={onSave}
          >
            {busy ? "保存中…" : "保存为新草稿"}
          </button>
        </div>

        {plan.ok ? (
          plan.changes.length === 0 ? (
            <p className="m-0 text-sm text-muted">
              还没有改动。改一处题干、选项或分值，这里会实时列出差异。
            </p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="edit-changes">
              {plan.changes.map((change, index) => (
                // `changes` 没有稳定 id（同一条 op 可能对同一题出现两次：先改分值再改回去），
                // 用下标当 key 在这里是安全的——列表只增不减地整体重渲染。
                <li
                  key={`${String(index)}-${change.op}-${change.where}`}
                  className="flex flex-wrap items-baseline gap-1 rounded-sm border border-line bg-bg px-2 py-1 text-sm"
                >
                  <span className="text-muted">{change.where}</span>
                  <span className="tabular-nums text-muted">{change.before}</span>
                  <span aria-hidden="true" className="text-accent">
                    →
                  </span>
                  <span className="tabular-nums font-medium text-ink">{change.after}</span>
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
