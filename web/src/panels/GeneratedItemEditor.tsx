/**
 * 生成页预览里的就地编辑（发布前改题）。
 *
 * 和编辑器页的 `ItemEditor` 不同：这里没有版本、没有撤销、没有 diff——改的是
 * 还没落库的生成结果，`保存为草稿` 时才一次性提交。所以它只做一件事：
 * 把一张题目卡改成可编辑的受控表单。
 *
 * 教学标注（认知层次/知识点）默认折叠：它们是分析口径，不是每题必填项。
 */

import { useState } from "react";

import {
  BLOOM_LEVELS,
  LIMITS,
  type BloomLevel,
  type ChoiceOption,
  type FormItem,
  type Objective,
} from "@intentform/schema";

import { BLOOM_LABELS } from "../edit/ItemEditor";

export interface GeneratedItemEditorProps {
  readonly item: FormItem;
  readonly objectives: readonly Objective[];
  readonly onChange: (item: FormItem) => void;
}

interface Draft {
  readonly title: string;
  readonly score: string;
  readonly explanation: string;
  readonly required: boolean;
  readonly options: readonly ChoiceOption[];
  readonly single: string;
  readonly multi: readonly string[];
  readonly fill: string;
  readonly numberValue: string;
  readonly tolerance: string;
  readonly maxLength: string;
  readonly bloom: BloomLevel | "";
  readonly knowledgePoint: string;
  readonly min: string;
  readonly max: string;
}

function scoreTextOf(item: FormItem): string {
  return "score" in item && item.score !== undefined ? String(item.score) : "";
}

function draftOf(item: FormItem): Draft {
  const options = "options" in item ? item.options : [];
  return {
    title: item.title,
    score: scoreTextOf(item),
    explanation:
      item.type === "section"
        ? item.description ?? ""
        : "explanation" in item
          ? item.explanation ?? ""
          : "",
    required: "required" in item ? item.required : true,
    options,
    single: item.type === "single" ? item.answer ?? "" : "",
    multi: item.type === "multi" ? item.answer ?? [] : [],
    fill: item.type === "fill" ? (item.answer ?? []).join("\n") : "",
    numberValue: item.type === "number" ? String(item.answer?.value ?? "") : "",
    tolerance: item.type === "number" ? String(item.answer?.tolerance ?? 0) : "0",
    maxLength: item.type === "short" ? String(item.maxLength) : String(LIMITS.shortDefaultMaxLength),
    bloom: "bloom" in item && item.bloom !== undefined ? item.bloom : "",
    knowledgePoint: "knowledgePoint" in item && item.knowledgePoint !== undefined ? item.knowledgePoint : "",
    min: item.type === "scale" ? String(item.min) : "1",
    max: item.type === "scale" ? String(item.max) : "5",
  };
}

type OptionalCommon = {
  readonly score?: number;
  readonly explanation?: string;
  readonly bloom?: BloomLevel;
  readonly knowledgePoint?: string;
};

function optionalCommon(draft: Draft): OptionalCommon {
  const score = Number(draft.score);
  return {
    ...(draft.score.trim() === "" || !Number.isFinite(score) ? {} : { score }),
    ...(draft.explanation.trim() === "" ? {} : { explanation: draft.explanation }),
    ...(draft.bloom === "" ? {} : { bloom: draft.bloom }),
    ...(draft.knowledgePoint === "" ? {} : { knowledgePoint: draft.knowledgePoint }),
  };
}

function buildItem(original: FormItem, draft: Draft): FormItem {
  const common = { id: original.id, title: draft.title, required: draft.required };
  const optional = optionalCommon(draft);
  switch (original.type) {
    case "single":
      return {
        type: "single",
        ...common,
        ...optional,
        options: [...draft.options],
        ...(draft.single === "" ? {} : { answer: draft.single }),
      };
    case "multi": {
      const answer = draft.multi.filter((id) => draft.options.some((option) => option.id === id));
      return {
        type: "multi",
        ...common,
        ...optional,
        options: [...draft.options],
        ...(answer.length === 0 ? {} : { answer }),
      };
    }
    case "fill": {
      const answer = draft.fill
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter((line) => line !== "");
      return {
        type: "fill",
        ...common,
        ...optional,
        ...(answer.length === 0 ? {} : { answer }),
      };
    }
    case "number": {
      const value = Number(draft.numberValue);
      const tolerance = Number(draft.tolerance);
      return {
        type: "number",
        ...common,
        ...optional,
        ...(draft.numberValue.trim() === "" || !Number.isFinite(value)
          ? {}
          : { answer: { value, tolerance: Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 0 } }),
      };
    }
    case "short": {
      const maxLength = Number(draft.maxLength);
      return {
        type: "short",
        ...common,
        ...optional,
        maxLength:
          Number.isFinite(maxLength) && maxLength >= 1
            ? Math.min(Math.floor(maxLength), LIMITS.shortMaxLengthCap)
            : LIMITS.shortDefaultMaxLength,
      };
    }
    case "section":
      return {
        type: "section",
        id: original.id,
        title: draft.title,
        ...(draft.explanation.trim() === "" ? {} : { description: draft.explanation }),
      };
    case "scale": {
      const min = Number(draft.min);
      const max = Number(draft.max);
      return {
        type: "scale",
        id: original.id,
        title: draft.title,
        required: draft.required,
        min: Number.isFinite(min) ? Math.floor(min) : 1,
        max: Number.isFinite(max) ? Math.floor(max) : 5,
        ...("labels" in original && original.labels !== undefined ? { labels: original.labels } : {}),
      };
    }
  }
}

function nextOptionId(options: readonly ChoiceOption[]): string {
  const used = new Set(options.map((option) => option.id));
  for (let index = 1; index <= LIMITS.optionsMax + 1; index += 1) {
    const candidate = `opt${String(index)}`;
    if (!used.has(candidate)) return candidate;
  }
  return `opt${String(options.length + 1)}`;
}

const INPUT =
  "min-h-[44px] w-full rounded-sm border border-line bg-surface px-2 text-sm text-ink focus:outline-none focus:ring-1 focus:ring-accent";

export function GeneratedItemEditor({ item, objectives, onChange }: GeneratedItemEditorProps): JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => draftOf(item));
  // 跳过蓝图直接生成时，题目自带的知识点不一定出现在蓝图列表里；
  // 不补进选项的话，下拉会显示空白，教师会以为标注丢了。
  const knowledgeOptions =
    draft.knowledgePoint !== "" && !objectives.some((objective) => objective.id === draft.knowledgePoint)
      ? [...objectives, { id: draft.knowledgePoint, name: draft.knowledgePoint }]
      : objectives;

  const update = (next: Draft): void => {
    setDraft(next);
    onChange(buildItem(item, next));
  };

  const setOptions = (options: readonly ChoiceOption[]): void => {
    update({
      ...draft,
      options,
      single: options.some((option) => option.id === draft.single) ? draft.single : "",
      multi: draft.multi.filter((id) => options.some((option) => option.id === id)),
    });
  };

  return (
    <div className="flex flex-col gap-2" data-testid={`preview-editor-${item.id}`}>
      <label className="flex flex-col gap-1 text-xs text-muted">
        题干
        <textarea
          data-testid={`preview-title-${item.id}`}
          className={`${INPUT} min-h-[64px] py-1`}
          value={draft.title}
          onChange={(event) => {
            update({ ...draft, title: event.target.value });
          }}
        />
      </label>

      <div className="flex flex-wrap items-end gap-2">
        {"score" in item ? (
          <label className="flex flex-col gap-1 text-xs text-muted">
            分值
            <input
              data-testid={`preview-score-${item.id}`}
              className={`${INPUT} w-24`}
              inputMode="numeric"
              value={draft.score}
              onChange={(event) => {
                update({ ...draft, score: event.target.value });
              }}
            />
          </label>
        ) : null}
        {"required" in item ? (
          <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink">
            <input
              type="checkbox"
              className="size-4 accent-accent"
              checked={draft.required}
              onChange={(event) => {
                update({ ...draft, required: event.target.checked });
              }}
            />
            必答
          </label>
        ) : null}
      </div>

      {item.type === "single" || item.type === "multi" ? (
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="text-xs text-muted">选项（勾选正确答案）</legend>
          {draft.options.map((option, index) => (
            <div key={option.id} className="flex items-center gap-2">
              <input
                type={item.type === "single" ? "radio" : "checkbox"}
                name={`answer-${item.id}`}
                className="size-4 accent-accent"
                checked={item.type === "single" ? draft.single === option.id : draft.multi.includes(option.id)}
                onChange={() => {
                  if (item.type === "single") update({ ...draft, single: option.id });
                  else {
                    update({
                      ...draft,
                      multi: draft.multi.includes(option.id)
                        ? draft.multi.filter((id) => id !== option.id)
                        : [...draft.multi, option.id],
                    });
                  }
                }}
              />
              <input
                className={INPUT}
                value={option.text}
                aria-label={`选项 ${String(index + 1)}`}
                onChange={(event) => {
                  const options = draft.options.map((entry) =>
                    entry.id === option.id ? { ...entry, text: event.target.value } : entry,
                  );
                  setOptions(options);
                }}
              />
              <button
                type="button"
                className="min-h-[44px] rounded-sm border border-line px-2 text-xs text-muted disabled:opacity-40"
                disabled={draft.options.length <= LIMITS.optionsMin}
                onClick={() => {
                  setOptions(draft.options.filter((entry) => entry.id !== option.id));
                }}
              >
                删除
              </button>
            </div>
          ))}
          <button
            type="button"
            className="w-fit rounded-sm border border-line px-2 py-1 text-xs text-muted"
            disabled={draft.options.length >= LIMITS.optionsMax}
            onClick={() => {
              setOptions([...draft.options, { id: nextOptionId(draft.options), text: "新选项" }]);
            }}
          >
            添加选项
          </button>
        </fieldset>
      ) : null}

      {item.type === "fill" ? (
        <label className="flex flex-col gap-1 text-xs text-muted">
          答案（每行一个空）
          <textarea
            className={`${INPUT} min-h-[64px] py-1`}
            value={draft.fill}
            onChange={(event) => {
              update({ ...draft, fill: event.target.value });
            }}
          />
        </label>
      ) : null}

      {item.type === "number" ? (
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            正确答案
            <input
              className={`${INPUT} w-28`}
              inputMode="decimal"
              value={draft.numberValue}
              onChange={(event) => {
                update({ ...draft, numberValue: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            允许误差
            <input
              className={`${INPUT} w-28`}
              inputMode="decimal"
              value={draft.tolerance}
              onChange={(event) => {
                update({ ...draft, tolerance: event.target.value });
              }}
            />
          </label>
        </div>
      ) : null}

      {item.type === "short" ? (
        <label className="flex flex-col gap-1 text-xs text-muted">
          字数上限
          <input
            className={`${INPUT} w-28`}
            inputMode="numeric"
            value={draft.maxLength}
            onChange={(event) => {
              update({ ...draft, maxLength: event.target.value });
            }}
          />
        </label>
      ) : null}

      {item.type === "scale" ? (
        <div className="flex flex-wrap gap-2">
          <label className="flex flex-col gap-1 text-xs text-muted">
            最小值
            <input
              className={`${INPUT} w-24`}
              inputMode="numeric"
              value={draft.min}
              onChange={(event) => {
                update({ ...draft, min: event.target.value });
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            最大值
            <input
              className={`${INPUT} w-24`}
              inputMode="numeric"
              value={draft.max}
              onChange={(event) => {
                update({ ...draft, max: event.target.value });
              }}
            />
          </label>
        </div>
      ) : null}

      {item.type === "section" ? (
        <label className="flex flex-col gap-1 text-xs text-muted">
          分节说明
          <textarea
            className={`${INPUT} min-h-[56px] py-1`}
            value={draft.explanation}
            onChange={(event) => {
              update({ ...draft, explanation: event.target.value });
            }}
          />
        </label>
      ) : (
        <label className="flex flex-col gap-1 text-xs text-muted">
          解析
          <textarea
            className={`${INPUT} min-h-[56px] py-1`}
            value={draft.explanation}
            onChange={(event) => {
              update({ ...draft, explanation: event.target.value });
            }}
          />
        </label>
      )}

      {item.type === "section" || item.type === "scale" ? null : (
        <details className="rounded-sm border border-line px-2 py-1">
          <summary className="cursor-pointer text-xs text-muted">教学标注（可选）</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <label className="flex flex-col gap-1 text-xs text-muted">
              认知层次
              <select
                className={INPUT}
                value={draft.bloom}
                onChange={(event) => {
                  update({ ...draft, bloom: event.target.value as BloomLevel | "" });
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
            <label className="flex flex-col gap-1 text-xs text-muted">
              知识点
              <select
                className={INPUT}
                value={draft.knowledgePoint}
                onChange={(event) => {
                  update({ ...draft, knowledgePoint: event.target.value });
                }}
              >
                <option value="">（无）</option>
                {knowledgeOptions.map((objective) => (
                  <option key={objective.id} value={objective.id}>
                    {objective.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </details>
      )}
    </div>
  );
}
