/**
 * 单题编辑面板（P18）。
 *
 * 从 `EditorPage` 里的 `FieldEditor` 拆出来并扩写成"一道题的全貌"：
 * 题干 / 选项与正确项 / 答案 / 解析 / 分值 / 必答 / 教学标注 / 简答字数上限。
 *
 * 三种题型刻意长得不一样：
 * - 选择/多选：正确答案通过在选项行左侧勾选来表达（再多一个"答案输入框"等于让教师
 *   在两个地方维护同一个事实）；
 * - 填空：一行一个空；数值：值 + 容差；
 * - 分节：只有题干与说明，其余栏目结构上就不存在。
 *
 * 组件本身**不拼 Schema、不算总分**：所有回调都落到 `patch-plan` 的纯函数，
 * 预览与保存仍走同一条 `applyPatch`。
 */

import { BLOOM_LEVELS, LIMITS, type BloomLevel, type ChoiceOption, type FormItem, type Objective } from "@intentform/schema";

import type { AnswerDraft } from "./answer-input";
import { scoreOfItem, type ItemDraft } from "./patch-plan";

const BLOOM_LABELS: Readonly<Record<BloomLevel, string>> = {
  remember: "记忆",
  understand: "理解",
  apply: "应用",
  analyze: "分析",
  evaluate: "评价",
  create: "创造",
};

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
  readonly onMeta: (meta: { readonly bloom: BloomLevel | null; readonly knowledgePoint: string | null }) => void;
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
  const question = `第 ${String(index + 1)} 题`;
  const isChoice = item.type === "single" || item.type === "multi";
  // 拽成局部常量，事件回调里才能保住判别联合的窄化（`draft` 是可变的属性）。
  const answer = draft.answer;

  return (
    <div className="flex flex-col gap-3" data-testid="edit-item-editor">
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted" htmlFor={`edit-stem-${item.id}`}>
          {`${question} · 题干`}
        </label>
        <textarea
          id={`edit-stem-${item.id}`}
          data-testid="edit-stem"
          rows={3}
          value={draft.stem}
          placeholder={item.title}
          className="w-full rounded-sm border border-line bg-bg p-1 text-base text-ink"
          onChange={(event) => {
            onStem(event.target.value);
          }}
        />
      </div>

      {isChoice ? (
        <OptionsEditor
          item={item}
          options={draft.options ?? []}
          answer={draft.answer}
          onOptions={onOptions}
          onAnswer={onAnswer}
        />
      ) : null}

      {item.type === "fill" && answer?.type === "fill" ? (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted">填空答案（一行一个空）</span>
          <textarea
            data-testid="edit-answer-fill"
            rows={Math.max(2, answer.blanks.length)}
            value={answer.blanks.join("\n")}
            className="w-full rounded-sm border border-line bg-bg p-1 text-base text-ink"
            onChange={(event) => {
              onAnswer({ type: "fill", blanks: event.target.value.split("\n") });
            }}
          />
        </div>
      ) : null}

      {item.type === "number" && answer?.type === "number" ? (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">正确答案</span>
            <input
              data-testid="edit-answer-number"
              type="number"
              step="any"
              value={answer.value}
              className="min-h-[44px] w-32 rounded-sm border border-line bg-bg p-1 text-base tabular-nums text-ink"
              onChange={(event) => {
                onAnswer({ ...answer, value: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">容差</span>
            <input
              data-testid="edit-answer-tolerance"
              type="number"
              step="any"
              min={0}
              value={answer.tolerance}
              className="min-h-[44px] w-28 rounded-sm border border-line bg-bg p-1 text-base tabular-nums text-ink"
              onChange={(event) => {
                onAnswer({ ...answer, tolerance: event.target.value });
              }}
            />
          </label>
        </div>
      ) : null}

      {item.type === "short" ? (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted" htmlFor={`edit-maxlength-${item.id}`}>
            {`字数上限（1–${String(LIMITS.shortMaxLengthCap)}）`}
          </label>
          <input
            id={`edit-maxlength-${item.id}`}
            data-testid="edit-maxlength"
            type="number"
            min={1}
            max={LIMITS.shortMaxLengthCap}
            step={1}
            value={draft.maxLength ?? item.maxLength}
            className="min-h-[44px] w-32 rounded-sm border border-line bg-bg p-1 text-base tabular-nums text-ink"
            onChange={(event) => {
              onMaxLength(Number(event.target.value));
            }}
          />
        </div>
      ) : null}

      {item.type === "scale" ? null : (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted" htmlFor={`edit-explanation-${item.id}`}>
            {item.type === "section" ? "分节说明" : "解析（学生开启答案回看时才显示）"}
          </label>
          <textarea
            id={`edit-explanation-${item.id}`}
            data-testid="edit-explanation"
            rows={2}
            maxLength={LIMITS.explanationMax}
            value={draft.explanation}
            className="w-full rounded-sm border border-line bg-bg p-1 text-base text-ink"
            onChange={(event) => {
              onExplanation(event.target.value);
            }}
          />
        </div>
      )}

      {scoreOfItem(item) === null ? (
        <p className="m-0 text-xs text-muted">这题不计分（分节/量表），没有分值可改。</p>
      ) : (
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted" htmlFor={`edit-score-${item.id}`}>
            {`分值（0–${String(LIMITS.scoreMax)}）`}
          </label>
          <input
            id={`edit-score-${item.id}`}
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

      {draft.required === null ? null : (
        <label className="flex items-center gap-2 text-sm text-ink">
          <input
            data-testid="edit-required"
            type="checkbox"
            checked={draft.required}
            className="h-5 w-5"
            onChange={(event) => {
              onRequired(event.target.checked);
            }}
          />
          必答
        </label>
      )}

      {item.type === "scale" || item.type === "section" ? null : (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">布鲁姆层级</span>
            <select
              data-testid="edit-bloom"
              value={draft.bloom ?? ""}
              className="min-h-[44px] rounded-sm border border-line bg-bg p-1 text-sm text-ink"
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
                  {`${BLOOM_LABELS[level]}（${level}）`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">知识点</span>
            <select
              data-testid="edit-knowledge-point"
              value={draft.knowledgePoint ?? ""}
              className="min-h-[44px] max-w-56 rounded-sm border border-line bg-bg p-1 text-sm text-ink"
              onChange={(event) => {
                const value = event.target.value;
                onMeta({ bloom: draft.bloom, knowledgePoint: value === "" ? null : value });
              }}
            >
              <option value="">（无）</option>
              {objectives.map((objective) => (
                <option key={objective.id} value={objective.id}>
                  {`${objective.name}（${objective.id}）`}
                </option>
              ))}
            </select>
          </label>
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
          data-testid="edit-item-clear"
          className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-muted disabled:opacity-50"
          disabled={!hasDraft}
          onClick={onClear}
        >
          这题改回原样
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
    answer === null ? [] : answer.type === "single" ? [answer.id] : answer.type === "multi" ? answer.ids : [],
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
    <div className="flex flex-col gap-1" data-testid="edit-options">
      <span className="text-xs text-muted">
        {multiple ? "选项（勾选所有正确答案）" : "选项（选中正确答案）"}
      </span>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {options.map((option, index) => (
          <li key={option.id} className="flex items-center gap-2">
            <input
              data-testid={`edit-option-${String(index)}-correct`}
              type={multiple ? "checkbox" : "radio"}
              name={`edit-answer-${item.id}`}
              aria-label={`选项 ${option.text} 是正确答案`}
              checked={correctIds.has(option.id)}
              className="h-5 w-5 shrink-0"
              onChange={(event) => {
                toggle(option.id, event.target.checked);
              }}
            />
            <input
              data-testid={`edit-option-${String(index)}-text`}
              type="text"
              value={option.text}
              maxLength={LIMITS.optionTextMax}
              className="min-h-[44px] min-w-0 flex-1 rounded-sm border border-line bg-bg p-1 text-sm text-ink"
              onChange={(event) => {
                updateText(index, event.target.value);
              }}
            />
            <button
              type="button"
              data-testid={`edit-option-${String(index)}-remove`}
              className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-danger disabled:opacity-50"
              disabled={options.length <= LIMITS.optionsMin}
              onClick={() => {
                remove(index);
              }}
            >
              删
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        data-testid="edit-option-add"
        className="min-h-[44px] w-fit rounded-sm border border-accent px-2 text-sm text-accent disabled:opacity-50"
        disabled={options.length >= LIMITS.optionsMax}
        onClick={add}
      >
        加一个选项
      </button>
    </div>
  );
}
