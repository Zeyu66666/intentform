/**
 * 学生页的一题（作答控件）。只做渲染，所有状态都在 `answers.ts` / `validate.ts` 里。
 *
 * 为什么还要过 `toFillRenderPlan()` 而不是直接吃 `PublicFormItem`：
 * `PublicFormItem` 已经结构上不含答案（`publicView()` 剥过一层），但**仍带 `score`**。
 * 学生页不需要分值，再投影一次（I3 的第二道闸门）能保证"学生页 DOM 里连分值都没有"，
 * 也顺手复用了 I3 的题型分支与 `FillOption` 形状，两边视觉语言是同一套。
 *
 * 触控目标：所有可点行高 `min-h-[44px]`（WCAG 2.5.5 的最小触控尺寸）。窄屏单列，
 * 不做两列排布——手机上两列会让选项文字挤成两行。
 */

import type { PublicFormItem } from "@intentform/schema";

import { MathText } from "../render/Latex";
import { TYPE_LABELS } from "../render/FieldRegistry";
import { toFillRenderPlan, type FillOption, type FillPlanOf, type FillRenderPlan } from "../render/fill-plan";
import { choiceValues, stringValue, type AnswerAction, type AnswerState } from "./answers";
import { BLANK_INPUT_PLACEHOLDER, splitBlanks } from "./submit";

export interface StudentFieldProps {
  readonly item: PublicFormItem;
  readonly answers: AnswerState;
  /** 必答校验没过：高亮这一题（清单由页面统一列在提交按钮上方）。 */
  readonly invalid: boolean;
  readonly dispatch: (action: AnswerAction) => void;
}

const CARD_BASE = "rounded-md border bg-surface p-2";
const INPUT_BASE =
  "mt-2 w-full rounded-sm border border-line bg-surface p-2 text-base text-ink focus:outline-none focus:ring-1 focus:ring-accent";

export function StudentField({ item, answers, invalid, dispatch }: StudentFieldProps): JSX.Element {
  const plan = toFillRenderPlan(item);

  if (plan.type === "section") {
    return (
      <section id={`fill-${plan.id}`} data-testid={`fill-${plan.id}`} className="mt-3 first:mt-0">
        <h3 className="m-0 border-b border-line pb-1 text-lg font-semibold">
          <MathText text={plan.title} />
        </h3>
        {plan.description === null ? null : (
          <p className="m-0 mt-1 text-sm text-muted">
            <MathText text={plan.description} />
          </p>
        )}
      </section>
    );
  }

  return (
    <article
      id={`fill-${plan.id}`}
      className={`${CARD_BASE} ${invalid ? "border-danger ring-1 ring-danger" : "border-line"}`}
    >
      <div className="flex items-start justify-between gap-1">
        <p className="m-0 text-base font-medium text-ink">
          <MathText text={plan.title} />
          {plan.required ? (
            <span className="ml-1 text-danger" aria-label="必答">
              *
            </span>
          ) : null}
        </p>
        <span className="shrink-0 rounded-sm border border-line px-[6px] py-[1px] text-xs text-muted">
          {TYPE_LABELS[plan.type]}
        </span>
      </div>

      {renderControl(plan, answers, dispatch)}

      {invalid ? (
        <p className="m-0 mt-1 text-sm text-danger" role="alert">
          这是必答题，请先填写
        </p>
      ) : null}
    </article>
  );
}

function renderControl(
  // 分节在上面已经提前 return，所以这里收窄掉：`section` 没有作答控件。
  plan: Exclude<FillRenderPlan, { readonly type: "section" }>,
  answers: AnswerState,
  dispatch: (action: AnswerAction) => void,
): JSX.Element {
  switch (plan.type) {
    case "single":
      return (
        <ChoiceList
          fieldId={plan.id}
          options={plan.control.options}
          multiple={false}
          answers={answers}
          dispatch={dispatch}
        />
      );
    case "multi":
      return (
        <ChoiceList
          fieldId={plan.id}
          options={plan.control.options}
          multiple
          answers={answers}
          dispatch={dispatch}
        />
      );
    case "fill":
      // 空位数量在公开视图里拿不到（`answer` 被剥了），所以是"一个多行输入 + ／ 分隔"：
      // 提交时按全角 ／ 切开，服务端按下标逐个比（两边同一口径，见 `submit.ts`）。
      return <BlankInput plan={plan} answers={answers} dispatch={dispatch} />;
    case "short":
      return <ShortInput plan={plan} answers={answers} dispatch={dispatch} />;
    case "number":
      return (
        <input
          className={INPUT_BASE}
          type="number"
          inputMode="decimal"
          step="any"
          data-testid={`fill-${plan.id}`}
          value={stringValue(answers, plan.id)}
          onChange={(event) => {
            dispatch({ type: "type", fieldId: plan.id, value: event.target.value });
          }}
        />
      );
    case "scale":
      return <ScaleChoices plan={plan} answers={answers} dispatch={dispatch} />;
    default:
      return assertNeverPlan(plan);
  }
}

function ChoiceList({
  fieldId,
  options,
  multiple,
  answers,
  dispatch,
}: {
  readonly fieldId: string;
  readonly options: readonly FillOption[];
  readonly multiple: boolean;
  readonly answers: AnswerState;
  readonly dispatch: (action: AnswerAction) => void;
}): JSX.Element {
  // 单选存字符串、多选存数组，统一用 `choiceValues()` 取选中集合（见该函数注释）。
  const selected = choiceValues(answers, fieldId);

  return (
    <div className="mt-2 flex flex-col gap-1">
      {options.map((option) => {
        const checked = selected.includes(option.id);
        return (
          <label
            key={option.id}
            // testid 挂在 `label` 上而不是里面的 `input`：学生点的是整行（`min-h-[44px]`），
            // 而 `input` 只有 16px——量触控目标要量真实热区。勾选态查 `input:checked`。
            data-testid={`fill-${fieldId}-${option.id}`}
            className={`flex min-h-[44px] cursor-pointer items-center gap-1 rounded-sm border px-2 py-1 text-base ${
              checked ? "border-accent text-ink" : "border-line text-ink"
            }`}
          >
            <input
              // name 必须一致，原生 radio 的分组靠它：同名的只会有一个选中。
              name={fieldId}
              type={multiple ? "checkbox" : "radio"}
              className="size-4 shrink-0 accent-accent"
              aria-label={option.text}
              checked={checked}
              onChange={() => {
                if (multiple) {
                  dispatch({ type: "toggle", fieldId, optionId: option.id });
                  return;
                }
                dispatch({ type: "choose", fieldId, value: option.id });
              }}
            />
            <span>
              <MathText text={option.text} />
            </span>
          </label>
        );
      })}
    </div>
  );
}

function BlankInput({
  plan,
  answers,
  dispatch,
}: {
  readonly plan: FillPlanOf<"fill">;
  readonly answers: AnswerState;
  readonly dispatch: (action: AnswerAction) => void;
}): JSX.Element {
  const raw = stringValue(answers, plan.id);
  const filledBlanks = raw.trim() === "" ? 0 : splitBlanks(raw).length;

  return (
    <>
      <textarea
        className={INPUT_BASE}
        rows={2}
        // 填不了 200 字以上：与服务端字段上限一致，避免"能写进去但提交被拒"。
        maxLength={plan.control.maxLength}
        // 分隔符提示放 `placeholder` 而不是下面再挂一行说明：多空填空本来就窄，
        // 说明文字会和「已填 N 个空」抢同一行。文案来源是 `submit.ts` 的常量，有测试钉着。
        placeholder={BLANK_INPUT_PLACEHOLDER}
        aria-label={`${plan.title}（作答）`}
        data-testid={`fill-${plan.id}`}
        value={raw}
        onChange={(event) => {
          dispatch({ type: "type", fieldId: plan.id, value: event.target.value });
        }}
      />
      {filledBlanks === 0 ? null : (
        <p className="m-0 mt-1 text-xs text-muted">{`已填 ${String(filledBlanks)} 个空`}</p>
      )}
    </>
  );
}

function ShortInput({
  plan,
  answers,
  dispatch,
}: {
  readonly plan: FillPlanOf<"short">;
  readonly answers: AnswerState;
  readonly dispatch: (action: AnswerAction) => void;
}): JSX.Element {
  const raw = stringValue(answers, plan.id);

  return (
    <>
      <textarea
        className={INPUT_BASE}
        rows={4}
        maxLength={plan.control.maxLength}
        aria-label={`${plan.title}（作答）`}
        data-testid={`fill-${plan.id}`}
        value={raw}
        onChange={(event) => {
          dispatch({ type: "type", fieldId: plan.id, value: event.target.value });
        }}
      />
      <p className="m-0 mt-1 text-right text-xs text-muted">
        {`${String(raw.length)} / ${String(plan.control.maxLength)}`}
      </p>
    </>
  );
}

/**
 * 量表。
 *
 * 1..10 以内用一排数字按钮（课堂上最常见的 1–5 / 0–10），每个 `min-h-[44px]`；
 * 跨度更大时按钮会不可点，退化成带 `min`/`max` 的数字输入——不偷偷截断范围。
 * 两种形态都走 `choose`（单值），不改答案状态机的形状。
 */
function ScaleChoices({
  plan,
  answers,
  dispatch,
}: {
  readonly plan: FillPlanOf<"scale">;
  readonly answers: AnswerState;
  readonly dispatch: (action: AnswerAction) => void;
}): JSX.Element {
  const { min, max, labels } = plan.control;
  const values = max >= min ? Array.from({ length: max - min + 1 }, (_, index) => min + index) : [];
  const current = stringValue(answers, plan.id);

  if (values.length === 0 || values.length > 11) {
    return (
      <>
        <input
          className={INPUT_BASE}
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          aria-label={`${plan.title}（可填 ${String(min)} – ${String(max)}）`}
          data-testid={`fill-${plan.id}`}
          value={current}
          onChange={(event) => {
            dispatch({ type: "choose", fieldId: plan.id, value: event.target.value });
          }}
        />
        <p className="m-0 mt-1 text-xs text-muted">{`可填 ${String(min)} – ${String(max)}`}</p>
      </>
    );
  }

  return (
    <>
      <div className="mt-2 flex flex-wrap gap-1">
        {values.map((value) => {
          const text = String(value);
          const checked = current === text;
          return (
            <label
              key={text}
              // 同 ChoiceList：热区在 `label`（44×44），`input` 被 `sr-only` 裁成 1px。
              data-testid={`fill-${plan.id}-${text}`}
              className={`flex min-h-[44px] min-w-[44px] cursor-pointer items-center justify-center rounded-sm border px-2 text-base ${
                checked ? "border-accent font-medium text-accent" : "border-line text-ink"
              }`}
            >
              <input
                className="sr-only"
                type="radio"
                name={plan.id}
                aria-label={`${plan.title}：${text}`}
                checked={checked}
                onChange={() => {
                  dispatch({ type: "choose", fieldId: plan.id, value: text });
                }}
              />
              {text}
            </label>
          );
        })}
      </div>
      {labels === null ? null : (
        <div className="mt-1 flex justify-between text-xs text-muted">
          <span>
            <MathText text={labels[0]} />
          </span>
          <span>
            <MathText text={labels[1]} />
          </span>
        </div>
      )}
      {current === "" ? <p className="m-0 mt-1 text-xs text-muted">未选择</p> : null}
    </>
  );
}

function assertNeverPlan(plan: never): never {
  throw new Error(`未处理的学生端控件: ${JSON.stringify(plan)}`);
}
