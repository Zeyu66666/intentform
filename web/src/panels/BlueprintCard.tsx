/**
 * 蓝图确认卡（省赛 R-06）。
 *
 * 它是两阶段的**接口**：教师先看见"要出几章、几题、什么题型、多少分、覆盖什么"，
 * 点「开始生成」之后才进入字段流；点「跳过蓝图」则退回单阶段（明确标注，不假装）。
 *
 * 这里不做编辑：改结构应该回去改需求。给蓝图加一套编辑器，等于把"表单是什么"
 * 搬到需求与 schema 之外的第三处，与本项目"意图主导"的定位冲突。
 */

import { FIELD_TYPE_LABELS, type FormBlueprint } from "@intentform/schema";

export interface BlueprintCardProps {
  readonly blueprint: FormBlueprint;
  readonly summary: string;
  readonly onConfirm: () => void;
  readonly onSkip: () => void;
}

export function BlueprintCard({
  blueprint,
  summary,
  onConfirm,
  onSkip,
}: BlueprintCardProps): JSX.Element {
  return (
    <section
      className="flex flex-col gap-1 rounded-sm border border-accent/40 bg-bg p-2"
      data-testid="plan-card"
      aria-label="生成前的结构蓝图"
    >
      <header className="flex items-baseline justify-between gap-1">
        <h3 className="m-0 text-sm font-semibold text-ink">结构蓝图</h3>
        <span className="text-xs text-muted">{blueprint.kind === "survey" ? "问卷" : "判分卷"}</span>
      </header>
      <p className="m-0 text-xs text-ink" data-testid="plan-summary">
        {summary}
      </p>

      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-xs text-muted">
        {blueprint.sections.map((section) => (
          <li key={section.title} data-testid="plan-section">
            {`${section.title} · ${String(section.count)} 题`}
          </li>
        ))}
      </ul>

      {blueprint.knowledgePoints.length === 0 ? null : (
        <p className="m-0 text-xs text-muted" data-testid="plan-knowledge">
          {`知识点：${blueprint.knowledgePoints.map((point) => point.name).join("、")}`}
        </p>
      )}
      <p className="m-0 text-xs text-muted">
        {`题型：${Object.entries(blueprint.typeMix)
          .filter(([, count]) => (count ?? 0) > 0)
          .map(([type, count]) => `${FIELD_TYPE_LABELS[type as keyof typeof FIELD_TYPE_LABELS]} ${String(count)}`)
          .join(" · ")}`}
      </p>

      <div className="sticky bottom-0 -mx-2 -mb-2 flex flex-col gap-1 border-t border-line bg-bg px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={onConfirm}
          data-testid="plan-confirm"
          className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white"
        >
          按蓝图生成
        </button>
        <button
          type="button"
          onClick={onSkip}
          data-testid="plan-skip"
          className="w-full rounded-sm border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
        >
          跳过蓝图，直接生成
        </button>
      </div>
    </section>
  );
}
