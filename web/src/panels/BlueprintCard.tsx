/**
 * 蓝图确认卡：模型给结构，教师先改再生成。
 *
 * 之前这里只读，教师不同意只能回去改需求、重新规划一遍；现在章节、题型分布、
 * 总分与知识点都能就地改。编辑动作由 `blueprint-edit.ts` 维持三条自洽：
 * 章节和 = 题型和 = 总题量；问卷总分恒为 0。
 */

import {
  FIELD_TYPE_LABELS,
  FIELD_TYPES,
  parseBlueprint,
  summarizeBlueprint,
  type FieldType,
  type FormBlueprint,
} from "@intentform/schema";

import {
  addKnowledgePoint,
  addSection,
  removeKnowledgePoint,
  removeSection,
  withKnowledgeId,
  withKnowledgeName,
  withSectionCount,
  withSectionTitle,
  withTitle,
  withTotalScore,
  withTypeCount,
} from "./blueprint-edit";

export interface BlueprintCardProps {
  readonly blueprint: FormBlueprint;
  readonly onConfirm: () => void;
  readonly onSkip: () => void;
  readonly onChange: (blueprint: FormBlueprint) => void;
}

const INPUT =
  "min-h-[36px] rounded-sm border border-line bg-surface px-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent";

export function BlueprintCard({
  blueprint,
  onConfirm,
  onSkip,
  onChange,
}: BlueprintCardProps): JSX.Element {
  const checked = parseBlueprint(blueprint);
  const summary = checked.ok ? summarizeBlueprint(checked.blueprint) : checked.message;
  const valid = checked.ok;

  return (
    <section
      className="flex flex-col gap-2 rounded-sm border border-accent/40 bg-bg p-2"
      data-testid="plan-card"
      aria-label="生成前的结构蓝图"
    >
      <header className="flex items-baseline justify-between gap-1">
        <h3 className="m-0 text-sm font-semibold text-ink">先确认结构（可以直接改）</h3>
        <span className="text-xs text-muted">{blueprint.kind === "survey" ? "问卷" : "判分卷"}</span>
      </header>

      <label className="flex flex-col gap-1 text-xs text-muted">
        标题
        <input
          className={INPUT}
          data-testid="plan-title"
          value={blueprint.title}
          onChange={(event) => {
            onChange(withTitle(blueprint, event.target.value));
          }}
        />
      </label>

      <p className="m-0 text-xs text-ink" data-testid="plan-summary">
        {summary}
      </p>

      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-medium text-muted">章节与题量</span>
          <button
            type="button"
            className="rounded-sm border border-line px-2 py-1 text-xs text-muted"
            onClick={() => {
              onChange(addSection(blueprint));
            }}
          >
            加章节
          </button>
        </div>
        {blueprint.sections.map((section, index) => (
          <div key={`section-${String(index)}`} className="flex items-center gap-1" data-testid="plan-section">
            <input
              className={`${INPUT} min-w-0 flex-1`}
              aria-label={`第 ${String(index + 1)} 章标题`}
              value={section.title}
              onChange={(event) => {
                onChange(withSectionTitle(blueprint, index, event.target.value));
              }}
            />
            <input
              className={`${INPUT} w-16`}
              aria-label={`第 ${String(index + 1)} 章题量`}
              inputMode="numeric"
              value={String(section.count)}
              onChange={(event) => {
                onChange(withSectionCount(blueprint, index, Number(event.target.value)));
              }}
            />
            <button
              type="button"
              aria-label={`删除第 ${String(index + 1)} 章`}
              className="rounded-sm border border-line px-2 py-1 text-xs text-muted disabled:opacity-40"
              disabled={blueprint.sections.length <= 1}
              onClick={() => {
                onChange(removeSection(blueprint, index));
              }}
            >
              删
            </button>
          </div>
        ))}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted">题型分布</span>
        <div className="grid grid-cols-3 gap-1">
          {FIELD_TYPES.filter((type) => type !== "section").map((type) => (
            <label key={type} className="flex items-center gap-1 text-xs text-muted">
              <span className="w-8 shrink-0">{FIELD_TYPE_LABELS[type]}</span>
              <input
                className={`${INPUT} w-full`}
                inputMode="numeric"
                aria-label={`${FIELD_TYPE_LABELS[type]}数量`}
                value={String(blueprint.typeMix[type] ?? 0)}
                onChange={(event) => {
                  onChange(withTypeCount(blueprint, type as FieldType, Number(event.target.value)));
                }}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-muted">
          总分
          <input
            className={`${INPUT} w-24`}
            data-testid="plan-total-score"
            inputMode="numeric"
            disabled={blueprint.kind === "survey"}
            value={String(blueprint.totalScore)}
            onChange={(event) => {
              onChange(withTotalScore(blueprint, Number(event.target.value)));
            }}
          />
        </label>
        <button
          type="button"
          className="min-h-[36px] rounded-sm border border-line px-2 text-xs text-muted"
          onClick={() => {
            onChange(addKnowledgePoint(blueprint));
          }}
        >
          加知识点
        </button>
      </div>

      {blueprint.knowledgePoints.length === 0 ? null : (
        <div className="flex flex-col gap-1" data-testid="plan-knowledge">
          {blueprint.knowledgePoints.map((point, index) => (
            <div key={`kp-${String(index)}`} className="flex items-center gap-1">
              <input
                className={`${INPUT} min-w-0 flex-[2]`}
                aria-label={`知识点 ${String(index + 1)} 名称`}
                value={point.name}
                onChange={(event) => {
                  onChange(withKnowledgeName(blueprint, index, event.target.value));
                }}
              />
              <input
                className={`${INPUT} min-w-0 flex-1`}
                aria-label={`知识点 ${String(index + 1)} id`}
                value={point.id}
                onChange={(event) => {
                  onChange(withKnowledgeId(blueprint, index, event.target.value));
                }}
              />
              <button
                type="button"
                aria-label={`删除知识点 ${String(index + 1)}`}
                className="rounded-sm border border-line px-2 py-1 text-xs text-muted"
                onClick={() => {
                  onChange(removeKnowledgePoint(blueprint, index));
                }}
              >
                删
              </button>
            </div>
          ))}
        </div>
      )}

      {valid ? null : (
        <p className="m-0 text-xs text-danger" role="alert">
          {checked.message}
        </p>
      )}

      <div className="sticky bottom-0 -mx-2 -mb-2 flex flex-col gap-1 border-t border-line bg-bg px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={onConfirm}
          data-testid="plan-confirm"
          disabled={!valid}
          className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          按这个结构生成
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
