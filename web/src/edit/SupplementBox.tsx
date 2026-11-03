/**
 * 覆盖矩阵点击补题：进入编辑页后的「这一格」面板。
 *
 * 两条路径都只到「草稿」为止：
 * - 手动填写：插入一道预填知识点/层级的模板题，教师在右侧面板继续改；
 * - 模型生成：先调 `/supplement` 拿一道候选题，教师看得到题干/选项后才点「加入草稿」。
 *
 * 组件本身不写库：它只把「加一道题」的意图交给 EditorPage，后者拼成 `addItem`。
 */

import { useState } from "react";

import type { BloomLevel, FormItem, SupplementItemResponse } from "@intentform/schema";

import { describeFailure } from "../api/failures";
import type { TeacherApi } from "../api/teacher";
import { TYPE_LABELS } from "../render/FieldRegistry";

export interface SupplementBoxProps {
  readonly api: TeacherApi;
  readonly formId: string;
  readonly baseVersionId: string;
  readonly knowledgePoint: string;
  readonly objectiveName: string;
  readonly bloom: BloomLevel;
  readonly onManual: () => void;
  readonly onGenerated: (item: FormItem) => void;
}

export function SupplementBox({
  api,
  formId,
  baseVersionId,
  knowledgePoint,
  objectiveName,
  bloom,
  onManual,
  onGenerated,
}: SupplementBoxProps): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [proposal, setProposal] = useState<SupplementItemResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const generate = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setProposal(null);
    void api
      .supplementItem(formId, { baseVersionId, knowledgePoint, bloom })
      .then((outcome) => {
        setBusy(false);
        if (!outcome.ok) {
          setError(describeFailure(outcome.failure, { notFound: "这份表单不存在" }));
          return;
        }
        setProposal(outcome.data);
      });
  };

  return (
    <section
      data-testid="edit-supplement"
      className="rounded-md border border-accent bg-bg p-2"
      aria-label="覆盖矩阵补题"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="m-0 text-sm font-semibold text-ink">补题</h3>
        <p className="m-0 text-xs text-muted" data-testid="edit-supplement-scope">
          {`${objectiveName} · ${bloom}`}
        </p>
      </div>
      <p className="m-0 mt-1 text-xs text-muted">
        先手动填，或让模型按这一格生成一道题；两道都只进草稿，确认保存前不会写库。
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="edit-supplement-manual"
          className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-ink"
          onClick={onManual}
        >
          手动填写这题
        </button>
        <button
          type="button"
          data-testid="edit-supplement-generate"
          className="min-h-[44px] rounded-sm border border-accent px-2 text-sm text-accent disabled:opacity-50"
          disabled={busy}
          onClick={generate}
        >
          {busy ? "生成中…" : "用模型生成这题"}
        </button>
      </div>

      {error === null ? null : (
        <p className="m-0 mt-2 text-sm text-danger" role="alert" data-testid="edit-supplement-error">
          {error}
        </p>
      )}

      {proposal === null ? null : (
        <div className="mt-2 rounded-sm border border-line bg-surface p-2" data-testid="edit-supplement-proposal">
          <p className="m-0 text-xs text-muted" data-testid="edit-supplement-source">
            {`${TYPE_LABELS[proposal.item.type]} · ${proposal.source} · ${proposal.promptVersion}`}
          </p>
          <p className="m-0 mt-1 text-sm font-medium text-ink">{proposal.item.title}</p>
          {"options" in proposal.item ? (
            <ol className="m-0 mt-1 list-none p-0 text-xs text-muted">
              {proposal.item.options.map((option) => (
                <li key={option.id}>{`${option.id}. ${option.text}`}</li>
              ))}
            </ol>
          ) : null}
          <button
            type="button"
            data-testid="edit-supplement-adopt"
            className="mt-2 min-h-[44px] rounded-sm border border-accent px-2 text-sm text-accent"
            onClick={() => {
              onGenerated(proposal.item);
            }}
          >
            加入草稿
          </button>
        </div>
      )}
    </section>
  );
}
