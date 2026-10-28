/**
 * 「一句话改这份表单」的输入条（R-03 的界面半边）。
 *
 * 两个刻意的设计：
 * 1. **先给差异，再给按钮**：模型给的 ops 不直接落库，先把 `changes` 摆出来，
 *    人点「采用并保存」才走 `patchForm`。这样"模型理解错了"最多是一次无效建议，
 *    而不是一次真实的版本增量。
 * 2. **来源必须可见**：`source` 是 mock 时按钮上方要写明「mock 脚本」，否则演示时
 *    很容易被当成"模型真的听懂了这句中文"——那是两件完全不同的事。
 */

import { useState } from "react";
import type { FormSchema, PatchChange, PatchIssue, SuggestPatchResponse } from "@intentform/schema";

import { describeFailure, isUnauthorized, isVersionConflict } from "../api/failures";
import { createHttpClient } from "../api/http";
import { createTeacherApi } from "../api/teacher";

const PLACEHOLDER = "用一句话说你想怎么改，例如：把第二题的分值改成 8 分";
const MOCK_HINT = "本次由 mock 脚本产生，不是模型读懂了这句话";
const CONFLICT_TEXT = "这份表单已被改动，请刷新后重试";
const MAX_INSTRUCTION = 200;

type Phase =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "proposed"; readonly suggestion: SuggestPatchResponse }
  | { readonly status: "error"; readonly text: string; readonly needsReload: boolean };

export interface SuggestBoxProps {
  readonly formId: string;
  /** 乐观锁基准：建议与保存都声明"我是基于这一版"。 */
  readonly baseVersionId: string;
  /**
   * 采用后的回调：给的是新一版的三件事（schema / 版本 id / 版本号），
   * 而不是整份 `FormDetailResponse`——`PATCH` 返回的本来就没有 `form` 之外的字段，
   * 让组件顺手拼一个假的详情，会掩盖"少发了一次请求"这件事。
   */
  readonly onApplied: (applied: { readonly schema: FormSchema; readonly versionId: string; readonly versionN: number }) => void;
  readonly onNotice: (text: string, tone: "success" | "info" | "error", needsReload: boolean) => void;
}

export function SuggestBox({ formId, baseVersionId, onApplied, onNotice }: SuggestBoxProps): JSX.Element {
  const api = createTeacherApi(createHttpClient());
  const [instruction, setInstruction] = useState("");
  const [phase, setPhase] = useState<Phase>({ status: "idle" });
  const busy = phase.status === "loading";

  const request = (): void => {
    const trimmed = instruction.trim();
    if (trimmed === "" || busy) return;
    setPhase({ status: "loading" });
    void api.suggestPatch(formId, { baseVersionId, instruction: trimmed }).then((outcome) => {
      if (!outcome.ok) {
        setPhase({
          status: "error",
          text: isVersionConflict(outcome.failure) ? CONFLICT_TEXT : describeFailure(outcome.failure, { notFound: "这份表单不存在，或已被删除" }),
          needsReload: isVersionConflict(outcome.failure) || isUnauthorized(outcome.failure),
        });
        return;
      }
      if (outcome.data.ops.length === 0) {
        // 空建议不是失败：模型认为这六种 op 表达不了，如实说出来比硬凑一条改动好。
        setPhase({
          status: "error",
          text: "这句要求用受限改动表达不了（只能改题干/选项/分值，或加、删、移动题目）",
          needsReload: false,
        });
        return;
      }
      setPhase({ status: "proposed", suggestion: outcome.data });
    });
  };

  const adopt = (suggestion: SuggestPatchResponse): void => {
    if (busy || suggestion.ops.length === 0) return;
    setPhase({ status: "loading" });
    void api
      // `ops` 是 readonly：`PatchFormRequest` 要可变数组，这里拷一份。
      .patchForm(formId, { baseVersionId, ops: [...suggestion.ops] })
      .then((outcome) => {
        if (!outcome.ok) {
          setPhase({
            status: "error",
            text: isVersionConflict(outcome.failure) ? CONFLICT_TEXT : describeFailure(outcome.failure, { notFound: "这份表单不存在，或已被删除" }),
            needsReload: isVersionConflict(outcome.failure) || isUnauthorized(outcome.failure),
          });
          return;
        }
        setPhase({ status: "idle" });
        setInstruction("");
        onApplied({
          schema: outcome.data.schema,
          versionId: outcome.data.version.id,
          versionN: outcome.data.version.n,
        });
        onNotice(`已按建议生成 v${String(outcome.data.version.n)}`, "success", false);
      });
  };

  return (
    <section
      aria-label="一句话改这份表单"
      className="border-b border-line bg-bg"
      data-testid="edit-suggest"
    >
      <div className="flex flex-wrap items-center gap-2 px-2 py-2">
        <label className="min-w-0 flex-1">
          <span className="sr-only">修改要求</span>
          <input
            type="text"
            data-testid="edit-suggest-input"
            className="min-h-[44px] w-full rounded-sm border border-line bg-surface px-2 text-sm text-ink"
            placeholder={PLACEHOLDER}
            maxLength={MAX_INSTRUCTION}
            value={instruction}
            disabled={busy}
            onChange={(event) => {
              setInstruction(event.target.value);
              if (phase.status === "proposed" || phase.status === "error") setPhase({ status: "idle" });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                request();
              }
            }}
          />
        </label>
        <button
          type="button"
          data-testid="edit-suggest-run"
          className="min-h-[44px] rounded-sm border border-accent px-3 text-sm text-accent disabled:opacity-50"
          disabled={busy || instruction.trim() === ""}
          onClick={request}
        >
          {busy ? "生成中…" : "生成改动建议"}
        </button>
      </div>

      {phase.status === "proposed" ? (
        <ProposalCard suggestion={phase.suggestion} busy={busy} onAdopt={adopt} onDiscard={() => setPhase({ status: "idle" })} />
      ) : null}
      {phase.status === "error" ? (
        <p className="m-0 px-2 pb-2 text-sm text-danger" role="alert" data-testid="edit-suggest-error">
          {phase.text}
        </p>
      ) : null}
    </section>
  );
}

/** 建议卡片：改动清单 + 可发布提示 + 采用/放弃。 */
function ProposalCard({
  suggestion,
  busy,
  onAdopt,
  onDiscard,
}: {
  readonly suggestion: SuggestPatchResponse;
  readonly busy: boolean;
  readonly onAdopt: (suggestion: SuggestPatchResponse) => void;
  readonly onDiscard: () => void;
}): JSX.Element {
  return (
    <div className="px-2 pb-2" data-testid="edit-suggest-proposal">
      {suggestion.source === "mock" ? (
        <p className="m-0 mb-1 text-xs text-muted" data-testid="edit-suggest-source">
          {MOCK_HINT}
        </p>
      ) : null}
      <ChangeList changes={suggestion.changes} />
      {suggestion.issues.length === 0 ? (
        <p className="m-0 mt-1 text-xs text-muted">采用后这份表单可以直接发布。</p>
      ) : (
        <p className="m-0 mt-1 text-xs text-danger" data-testid="edit-suggest-issues">
          {`采用后仍不能发布：${issueText(suggestion.issues[0])}${suggestion.issues.length > 1 ? ` 等 ${String(suggestion.issues.length)} 处` : ""}`}
        </p>
      )}
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="edit-suggest-adopt"
          className="min-h-[44px] rounded-sm border border-accent bg-accent px-3 text-sm text-white disabled:opacity-50"
          disabled={busy}
          onClick={() => {
            onAdopt(suggestion);
          }}
        >
          采用并保存
        </button>
        <button
          type="button"
          data-testid="edit-suggest-discard"
          className="min-h-[44px] rounded-sm border border-line px-3 text-sm text-muted"
          disabled={busy}
          onClick={onDiscard}
        >
          放弃
        </button>
      </div>
    </div>
  );
}

function ChangeList({ changes }: { readonly changes: readonly PatchChange[] }): JSX.Element {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0" data-testid="edit-suggest-changes">
      {changes.map((change, index) => (
        <li key={`${String(index)}-${change.op}-${change.where}`} className="flex items-baseline gap-1 text-sm">
          <span className="text-muted">{change.where}</span>
          <span className="tabular-nums text-ink">{change.before}</span>
          <span aria-hidden="true" className="text-muted">
            →
          </span>
          <span className="tabular-nums text-ink">{change.after}</span>
        </li>
      ))}
    </ul>
  );
}

function issueText(issue: PatchIssue | undefined): string {
  if (issue === undefined) return "有未通过的校验";
  return `${issue.path} ${issue.message}`;
}
