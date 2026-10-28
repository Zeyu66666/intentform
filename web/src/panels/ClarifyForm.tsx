/**
 * 追问表单（省赛 R-05）：生成前先把缺的槽位问清，最多 3 个。
 *
 * 三条界面口径：
 * 1. **可跳过**：『跳过，直接生成』始终在。澄清是帮忙，不是关卡——教师说「就这样出」
 *    就该立刻出，不许多点三次。
 * 2. **两种输入并存**：快捷选项与手填，手填优先（写在 `clarify-model.ts` 里，有单测）。
 * 3. **不伪造进度**：这一块只在服务端真的回了追问时渲染；没问就不出现。
 */

import type { ClarifyQuestion, ClarifySlotId } from "@intentform/schema";

import {
  answerOf,
  answeredCount,
  type ClarifyDrafts,
} from "./clarify-model";

export interface ClarifyFormProps {
  readonly questions: readonly ClarifyQuestion[];
  readonly drafts: ClarifyDrafts;
  readonly onToggleOption: (slot: ClarifySlotId, option: string) => void;
  readonly onCustomChange: (slot: ClarifySlotId, text: string) => void;
  readonly onConfirm: () => void;
  readonly onSkip: () => void;
}

export function ClarifyForm({
  questions,
  drafts,
  onToggleOption,
  onCustomChange,
  onConfirm,
  onSkip,
}: ClarifyFormProps): JSX.Element {
  const answered = answeredCount(questions, drafts);
  return (
    <section
      className="flex flex-col gap-1 rounded-sm border border-accent/40 bg-bg p-2"
      data-testid="clarify-block"
      aria-label="生成前的补充确认"
    >
      <header className="flex items-baseline justify-between gap-1">
        <h3 className="m-0 text-sm font-semibold text-ink">
          {`需要确认 ${String(questions.length)} 件事`}
        </h3>
        <span className="text-xs text-muted">{`已答 ${String(answered)}/${String(questions.length)}`}</span>
      </header>
      <p className="m-0 text-xs text-muted">
        回答会写进需求；不答也能直接生成。
      </p>

      {questions.map((question) => {
        const answer = answerOf(drafts, question.slot);
        return (
          <fieldset
            key={question.slot}
            className="m-0 flex flex-col gap-1 border-0 p-0"
            data-testid={`clarify-question-${question.slot}`}
          >
            <legend className="p-0 text-xs font-medium text-ink">{question.question}</legend>
            <div className="flex flex-wrap gap-1">
              {question.options.map((option) => {
                const selected = drafts[question.slot].options.includes(option);
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => {
                      onToggleOption(question.slot, option);
                    }}
                    className={`min-h-[32px] rounded-sm border px-2 py-0.5 text-xs ${
                      selected
                        ? "border-accent bg-accent text-white"
                        : "border-line bg-surface text-muted hover:border-accent hover:text-accent"
                    }`}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
            <input
              type="text"
              value={drafts[question.slot].custom}
              onChange={(event) => {
                onCustomChange(question.slot, event.target.value);
              }}
              placeholder={question.placeholder}
              aria-label={`${question.question}（自己填）`}
              maxLength={200}
              className="w-full rounded-sm border border-line bg-surface px-2 py-1 text-xs"
            />
            {answer === "" ? null : (
              <p className="m-0 text-xs text-muted" data-testid={`clarify-answer-${question.slot}`}>
                {`将写入：${answer}`}
              </p>
            )}
          </fieldset>
        );
      })}

      {/* 动作区吸底：追问块比左栏高时，主按钮必须始终可见（§2.6 第 1、2 条）。 */}
      <div className="sticky bottom-0 -mx-2 -mb-2 flex flex-col gap-1 border-t border-line bg-bg px-2 pb-2 pt-1">
        <button
          type="button"
          onClick={onConfirm}
          data-testid="clarify-confirm"
          className="w-full rounded-sm bg-accent px-2 py-2 text-sm font-semibold text-white"
        >
          开始生成
        </button>
        <button
          type="button"
          onClick={onSkip}
          data-testid="clarify-skip"
          className="w-full rounded-sm border border-line px-2 py-1 text-xs text-muted hover:border-accent hover:text-accent"
        >
          跳过，直接生成
        </button>
      </div>
    </section>
  );
}
