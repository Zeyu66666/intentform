/**
 * 单题编辑面板（P18，P25 重排视觉）。
 *
 * 一道题的全貌按「题干 → 选项与答案 → 解析 → 评分与标注 → 排序」分组，
 * 每组一张浅色卡片：教师扫一眼就知道该改哪一块，而不是面对一串等权的输入框。
 *
 * 三种题型刻意长得不一样：
 * - 选择/多选：正确答案通过在选项行左侧勾选来表达（再多一个"答案输入框"等于让教师
 *   在两个地方维护同一个事实）；
 * - 填空：一行一个空；数值：值 + 容差；
 * - 分节：只有标题与说明，其余栏目结构上就不存在。
 *
 * 题干与解析下方各有一块**渲染预览**：输入框里写的是 `$...$` 原文，预览用 MathText
 * 立刻显示学生看到的样子。改公式时不用保存、发布、再打开学生页去确认。
 *
 * 组件本身**不拼 Schema、不算总分**：所有回调都落到 `patch-plan` 的纯函数，
 * 预览与保存仍走同一条 `applyPatch`。
 */

import type { ReactNode } from "react";

import {
  BLOOM_LEVELS,
  LIMITS,
  type BloomLevel,
  type ChoiceOption,
  type FormItem,
  type Objective,
} from "@intentform/schema";

import { TYPE_LABELS } from "../render/FieldRegistry";
import { MathText } from "../render/Latex";
import type { AnswerDraft } from "./answer-input";
import { scoreOfItem, type ItemDraft } from "./patch-plan";

export const BLOOM_LABELS: Readonly<Record<BloomLevel, string>> = {
  remember: "记忆",
  understand: "理解",
  apply: "应用",
  analyze: "分析",
  evaluate: "评价",
  create: "创造",
};

const FIELD =
  "min-h-[44px] w-full rounded-sm border border-line bg-surface px-2 py-2 text-base text-ink transition-colors focus:border-accent";

const LABEL = "text-xs font-medium text-muted";

const GROUP = "rounded-md border border-line bg-bg p-2";

const BUTTON =
  "min-h-[44px] rounded-sm border border-line bg-surface px-2 text-sm text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50";

/** 新选项 id：优先用 a…z 的单字母，用完了再 `op<n>`。 */
function nextOptionId(options: readonly ChoiceOption[]): string {
  const used = new Set(options.map((option) => option.id));
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    if (!used.has(letter)) return letter;
  }
  for (let n = 1; n <= LIMITS.optionsMax + 26; n += 1) {
    const candidate = `op${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
  return "opx";
}

/** 组标题 + 一句用途说明；每组内部的间距由此处统一，调用方不用重复 gap。 */
function Group({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <section className={GROUP}>
      <div className="mb-2 flex flex-wrap items-baseline gap-2">
        <h3 className="m-0 text-sm font-semibold text-ink">{title}</h3>
        {hint === undefined ? null : <p className="m-0 text-xs text-muted">{hint}</p>}
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

export interface ItemEditorProps {
  readonly item: FormItem;
  readonly draft: ItemDraft;
  readonly hasDraft: boolean;
  readonly index: number;
  readonly objectives: readonly Objective[];
  /** 上移/下移的**绝对**目标下标；`null` 表示到头了。 */
  readonly upTarget: number | null;
  readonly downTarget: number | null;
  readonly canDelete: boolean;
  readonly onStem: (stem: string) => void;
  readonly onScore: (score: number) => void;
  readonly onOptions: (options: readonly ChoiceOption[]) => void;
  readonly onAnswer: (answer: AnswerDraft) => void;
  readonly onExplanation: (explanation: string) => void;
  readonly onRequired: (required: boolean) => void;
  readonly onMeta: (meta: {
    readonly bloom: BloomLevel | null;
    readonly knowledgePoint: string | null;
  }) => void;
  readonly onMaxLength: (maxLength: number) => void;
  readonly onClear: () => void;
  readonly onMove: (toIndex: number) => void;
  readonly onDelete: () => void;
}

export function ItemEditor({
  item,
  draft,
  hasDraft,
  index,
  objectives,
  upTarget,
  downTarget,
  canDelete,
  onStem,
  onScore,
  onOptions,
  onAnswer,
  onExplanation,
  onRequired,
  onMeta,
  onMaxLength,
  onClear,
  onMove,
  onDelete,
}: ItemEditorProps): JSX.Element {
  const isSection = item.type === "section";
  const question = `第 ${String(index + 1)} 题`;
  const isChoice = item.type === "single" || item.type === "multi";
  // 拽成局部常量，事件回调里才能保住判别联合的窄化（`draft` 是可变的属性）。
  const answer = draft.answer;
  const score = scoreOfItem(item);
  const options = draft.options ?? [];

  return (
    <div className="flex flex-col gap-2" data-testid="edit-item-editor">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-sm bg-accent px-2 py-1 text-xs font-medium text-white">
          {TYPE_LABELS[item.type]}
        </span>
        <span className="text-sm font-semibold text-ink">{isSection ? "分节" : question}</span>
        <span className="text-xs text-muted">{item.id}</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {score === null ? null : (
            <span className="rounded-sm border border-line px-2 py-1 text-xs tabular-nums text-muted">
              {`${String(score)} 分`}
            </span>
          )}
          {draft.required === true ? (
            <span className="rounded-sm border border-line px-2 py-1 text-xs text-muted">必答</span>
          ) : null}
          {hasDraft ? (
            <span className="rounded-sm border border-accent px-2 py-1 text-xs text-accent">
              未保存
            </span>
          ) : null}
        </div>
      </div>

      <Group
        title={isSection ? "分节标题" : "题干"}
        hint={isSection ? "分节把题目分组，不计分" : "支持 $...$ 数学公式，换行会保留"}
      >
        <textarea
          id={`edit-stem-${item.id}`}
          data-testid="edit-stem"
          rows={isSection ? 2 : 4}
          value={draft.stem}
          placeholder={item.title}
          className={FIELD}
          onChange={(event) => {
            onStem(event.target.value);
          }}
        />
        <div className="rounded-sm border border-dashed border-line bg-surface p-2">
          <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
            <span className={LABEL}>渲染预览</span>
            <span className="text-xs text-muted">学生看到的样子</span>
          </div>
          <div className="text-base text-ink">
            <MathText text={draft.stem.trim() === "" ? "（题干为空）" : draft.stem} />
          </div>
          {isChoice && options.length > 0 ? (
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
              {options.map((option, at) => {
                const correct =
                  answer === null
                    ? false
                    : answer.type === "single"
                      ? answer.id === option.id
                      : answer.type === "multi"
                        ? answer.ids.includes(option.id)
                        : false;
                return (
                  <li key={option.id} className="flex items-baseline gap-2 text-sm text-ink">
                    <span className="tabular-nums text-muted">
                      {`${String.fromCharCode(65 + at)}.`}
                    </span>
                    <span className="min-w-0 flex-1">
                      <MathText text={option.text} />
                    </span>
                    {correct ? (
                      <span className="shrink-0 rounded-sm bg-accent px-1 text-xs text-white">
                        正确
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {item.type === "short" ? (
            <div className="mt-2 rounded-sm border border-line bg-bg p-2 text-sm text-muted">
              学生在这里作答……
            </div>
          ) : null}
        </div>
      </Group>

      {isChoice ? (
        <OptionsEditor
          item={item}
          options={options}
          answer={draft.answer}
          onOptions={onOptions}
          onAnswer={onAnswer}
        />
      ) : null}

      {item.type === "fill" && answer?.type === "fill" ? (
        <Group title="填空答案" hint="一行一个空，顺序与题干里的空一致">
          <textarea
            data-testid="edit-answer-fill"
            rows={Math.max(2, answer.blanks.length)}
            value={answer.blanks.join("\n")}
            className={FIELD}
            onChange={(event) => {
              onAnswer({ type: "fill", blanks: event.target.value.split("\n") });
            }}
          />
        </Group>
      ) : null}

      {item.type === "number" && answer?.type === "number" ? (
        <Group title="正确答案" hint="判分时按容差比较绝对值">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1">
              <span className={LABEL}>值</span>
              <input
                data-testid="edit-answer-number"
                type="number"
                step="any"
                value={answer.value}
                className={`${FIELD} tabular-nums`}
                onChange={(event) => {
                  onAnswer({ ...answer, value: event.target.value });
                }}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={LABEL}>容差</span>
              <input
                data-testid="edit-answer-tolerance"
                type="number"
                step="any"
                min={0}
                value={answer.tolerance}
                className={`${FIELD} tabular-nums`}
                onChange={(event) => {
                  onAnswer({ ...answer, tolerance: event.target.value });
                }}
              />
            </label>
          </div>
        </Group>
      ) : null}

      <Group
        title={isSection ? "分节说明" : "解析 / 参考答案"}
        hint={
          isSection
            ? "显示在分节标题下方"
            : item.type === "short"
              ? "写清参考答案与分步评分要点，批改时对照使用"
              : "学生开启答案解析后才可见"
        }
      >
        <textarea
          id={`edit-explanation-${item.id}`}
          data-testid="edit-explanation"
          rows={3}
          maxLength={LIMITS.explanationMax}
          value={draft.explanation}
          className={FIELD}
          onChange={(event) => {
            onExplanation(event.target.value);
          }}
        />
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs text-muted">
          <span>支持 $...$ 数学公式</span>
          <span className="tabular-nums">
            {`${String(draft.explanation.length)} / ${String(LIMITS.explanationMax)}`}
          </span>
        </div>
        {draft.explanation.trim() === "" ? null : (
          <div className="rounded-sm border border-dashed border-line bg-surface p-2">
            <div className="mb-1 text-xs text-muted">渲染预览</div>
            <div className="text-sm text-ink">
              <MathText text={draft.explanation} />
            </div>
          </div>
        )}
      </Group>

      <Group title="评分与标注" hint="分值会计入整卷总分">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {score === null ? (
            <p className="m-0 text-sm text-muted">这题不计分（分节/量表），没有分值可改。</p>
          ) : (
            <label className="flex flex-col gap-1">
              <span className={LABEL}>{`分值（0–${String(LIMITS.scoreMax)}）`}</span>
              <input
                id={`edit-score-${item.id}`}
                data-testid="edit-score"
                type="number"
                min={0}
                max={LIMITS.scoreMax}
                step={1}
                // 空串交给 NaN：空分值不该被悄悄当成 0 分写进草稿。
                value={Number.isNaN(draft.score) ? "" : draft.score}
                className={`${FIELD} tabular-nums`}
                onChange={(event) => {
                  const raw = event.target.value;
                  onScore(raw === "" ? Number.NaN : Number(raw));
                }}
              />
            </label>
          )}

          {item.type === "short" ? (
            <label className="flex flex-col gap-1">
              <span className={LABEL}>
                {`字数上限（1–${String(LIMITS.shortMaxLengthCap)}）`}
              </span>
              <input
                id={`edit-maxlength-${item.id}`}
                data-testid="edit-maxlength"
                type="number"
                min={1}
                max={LIMITS.shortMaxLengthCap}
                step={1}
                value={draft.maxLength ?? item.maxLength}
                className={`${FIELD} tabular-nums`}
                onChange={(event) => {
                  onMaxLength(Number(event.target.value));
                }}
              />
            </label>
          ) : null}

          {item.type === "scale" || item.type === "section" ? null : (
            <>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>认知层次</span>
                <select
                  data-testid="edit-bloom"
                  value={draft.bloom ?? ""}
                  className={FIELD}
                  onChange={(event) => {
                    const value = event.target.value;
                    onMeta({
                      bloom: value === "" ? null : (value as BloomLevel),
                      knowledgePoint: draft.knowledgePoint,
                    });
                  }}
                >
                  <option value="">（无）</option>
                  {BLOOM_LEVELS.map((level) => (
                    <option key={level} value={level}>
                      {BLOOM_LABELS[level]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className={LABEL}>知识点</span>
                <select
                  data-testid="edit-knowledge-point"
                  value={draft.knowledgePoint ?? ""}
                  className={FIELD}
                  onChange={(event) => {
                    const value = event.target.value;
                    onMeta({
                      bloom: draft.bloom,
                      knowledgePoint: value === "" ? null : value,
                    });
                  }}
                >
                  <option value="">（无）</option>
                  {objectives.map((objective) => (
                    <option key={objective.id} value={objective.id}>
                      {objective.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
        </div>

        {draft.required === null ? null : (
          <label className="flex min-h-[44px] items-center gap-2 rounded-sm border border-line bg-surface px-2 text-sm text-ink">
            <input
              data-testid="edit-required"
              type="checkbox"
              checked={draft.required}
              className="h-5 w-5 accent-[var(--color-accent)]"
              onChange={(event) => {
                onRequired(event.target.checked);
              }}
            />
            <span>必答</span>
            <span className="text-xs text-muted">不填会提示学生，但不会阻止保存</span>
          </label>
        )}
      </Group>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="edit-move-up"
          className={BUTTON}
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
          className={BUTTON}
          disabled={downTarget === null}
          onClick={() => {
            if (downTarget !== null) onMove(downTarget);
          }}
        >
          下移
        </button>
        <button
          type="button"
          data-testid="edit-item-clear"
          className={BUTTON}
          disabled={!hasDraft}
          onClick={onClear}
        >
          改回原样
        </button>
        <button
          type="button"
          data-testid="edit-delete"
          className="ml-auto min-h-[44px] rounded-sm border border-danger px-2 text-sm text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50"
          disabled={!canDelete}
          onClick={onDelete}
        >
          删除此题
        </button>
        {canDelete ? null : <span className="text-xs text-muted">至少要留一道题</span>}
      </div>
    </div>
  );
}

/** 选项编辑器：单选用 radio、多选用 checkbox 标正确项；行内改文本、增删条目。 */
function OptionsEditor({
  item,
  options,
  answer,
  onOptions,
  onAnswer,
}: {
  readonly item: FormItem;
  readonly options: readonly ChoiceOption[];
  readonly answer: AnswerDraft | null;
  readonly onOptions: (options: readonly ChoiceOption[]) => void;
  readonly onAnswer: (answer: AnswerDraft) => void;
}): JSX.Element {
  const multiple = item.type === "multi";
  const correctIds = new Set(
    answer === null
      ? []
      : answer.type === "single"
        ? [answer.id]
        : answer.type === "multi"
          ? answer.ids
          : [],
  );

  const toggle = (optionId: string, checked: boolean): void => {
    if (multiple) {
      const ids = new Set(answer?.type === "multi" ? answer.ids : []);
      if (checked) ids.add(optionId);
      else ids.delete(optionId);
      onAnswer({ type: "multi", ids: [...ids] });
      return;
    }
    if (checked) onAnswer({ type: "single", id: optionId });
  };

  const updateText = (index: number, text: string): void => {
    onOptions(options.map((option, at) => (at === index ? { ...option, text } : option)));
  };

  const remove = (index: number): void => {
    const removed = options[index];
    const next = options.filter((_, at) => at !== index);
    onOptions(next);
    // 多选：把被删掉的那一项从答案里摘掉；单选：保留原答案，等本地校验报「答案不在选项里」。
    if (multiple && removed !== undefined && answer?.type === "multi") {
      onAnswer({ type: "multi", ids: answer.ids.filter((id) => id !== removed.id) });
    }
  };

  const add = (): void => {
    const id = nextOptionId(options);
    onOptions([...options, { id, text: `选项 ${String(options.length + 1)}` }]);
  };

  return (
    <Group
      title="选项与正确答案"
      hint={multiple ? "勾选所有正确答案（可多选）" : "选中唯一正确答案"}
    >
      <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="edit-options">
        {options.map((option, index) => {
          const correct = correctIds.has(option.id);
          return (
            <li
              key={option.id}
              className={`flex items-center gap-2 rounded-sm border px-2 py-1 transition-colors ${
                correct ? "border-accent bg-surface" : "border-line bg-surface"
              }`}
            >
              <input
                data-testid={`edit-option-${String(index)}-correct`}
                type={multiple ? "checkbox" : "radio"}
                name={`edit-answer-${item.id}`}
                aria-label={`选项 ${option.text} 是正确答案`}
                checked={correct}
                className="h-5 w-5 shrink-0 accent-[var(--color-accent)]"
                onChange={(event) => {
                  toggle(option.id, event.target.checked);
                }}
              />
              <span className="w-5 shrink-0 text-center text-sm font-medium text-muted">
                {String.fromCharCode(65 + index)}
              </span>
              <input
                data-testid={`edit-option-${String(index)}-text`}
                type="text"
                value={option.text}
                maxLength={LIMITS.optionTextMax}
                className="min-h-[44px] min-w-0 flex-1 rounded-sm border border-line bg-surface px-2 text-sm text-ink transition-colors focus:border-accent"
                onChange={(event) => {
                  updateText(index, event.target.value);
                }}
              />
              <button
                type="button"
                data-testid={`edit-option-${String(index)}-remove`}
                className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-danger transition-colors hover:border-danger disabled:opacity-50"
                disabled={options.length <= LIMITS.optionsMin}
                onClick={() => {
                  remove(index);
                }}
              >
                删除
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        data-testid="edit-option-add"
        className="min-h-[44px] w-full rounded-sm border border-dashed border-line bg-surface text-sm text-accent transition-colors hover:border-accent disabled:opacity-50"
        disabled={options.length >= LIMITS.optionsMax}
        onClick={add}
      >
        + 加一个选项
      </button>
    </Group>
  );
}
