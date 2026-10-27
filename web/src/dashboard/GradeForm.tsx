/**
 * 简答批改面板（省赛 R-02）。
 *
 * 一次只改一题、改完立刻 `POST` 落库，而不是"填完整页点保存"：
 *   - 一页三条简答、教师改到第二条时网断了，攒批提交会连第一条一起丢；
 *   - 每题独立提交后，返回的 `submission` 已经是重算过的权威分值，
 *     面板刷新即可，不需要前端自己维护"草稿总分"这份第二口径。
 *
 * 分值与满分的判断都在 `dashboard/model.ts` 的纯函数里（有测试），这里只负责把它画出来。
 */

import { useEffect, useState } from "react";

import type { GradableShortItem, SubmissionRow } from "@intentform/schema";

import type { ApiFailure } from "../api/http";
import type { TeacherApi } from "../api/teacher";
import { describeFailure } from "../api/failures";
import { formatScoreNumber } from "../format";
import { gradeInputValue, parseGradeInput } from "./model";

export interface GradeFormProps {
  readonly formId: string;
  readonly row: SubmissionRow;
  readonly shortItems: readonly GradableShortItem[];
  readonly api: TeacherApi;
  /** 任一题批改成功后的通知：上层据此刷新整页数据（均分、待批数都要重算）。 */
  readonly onGraded: () => void;
  readonly onClose: () => void;
}

export function GradeForm(props: GradeFormProps): JSX.Element {
  const { formId, row, shortItems, api, onGraded, onClose } = props;

  if (shortItems.length === 0) {
    return (
      <section className="mt-2 rounded-md border border-line bg-surface p-2" data-testid="grade-panel">
        <p className="m-0 text-sm text-muted">这份表单没有需要人工批改的题，全自动判分。</p>
      </section>
    );
  }

  return (
    <section
      className="mt-2 rounded-md border border-line bg-surface p-2"
      data-testid="grade-panel"
      aria-label="简答批改"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="m-0 text-base font-semibold text-ink">批改简答</h2>
        <button
          type="button"
          data-testid="grade-close"
          className="min-h-[44px] rounded-sm border border-line px-2 text-sm text-muted"
          onClick={onClose}
        >
          收起
        </button>
      </div>
      <p className="m-0 mt-1 text-xs text-muted">
        {`每题独立保存，改错了再改一次即可（覆盖，不累加）。这条提交当前 ${formatScoreNumber(row.score)} 分，` +
          `还有 ${formatScoreNumber(row.pendingScore)} 分待批改。`}
      </p>

      <ul className="m-0 mt-2 list-none space-y-2 p-0">
        {shortItems.map((item) => (
          <GradeRow
            key={item.itemId}
            formId={formId}
            row={row}
            item={item}
            api={api}
            onGraded={onGraded}
          />
        ))}
      </ul>
    </section>
  );
}

type SaveState =
  | { readonly status: "idle" }
  | { readonly status: "saving" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "saved" };

function GradeRow({
  formId,
  row,
  item,
  api,
  onGraded,
}: {
  readonly formId: string;
  readonly row: SubmissionRow;
  readonly item: GradableShortItem;
  readonly api: TeacherApi;
  readonly onGraded: () => void;
}): JSX.Element {
  const [value, setValue] = useState(() => gradeInputValue(row, item.itemId));
  const [state, setState] = useState<SaveState>({ status: "idle" });

  // 上层刷新后 `row` 换了个对象：已录过的分要跟着走，否则教师看到的还是自己刚才手打的字符串。
  useEffect(() => {
    setValue(gradeInputValue(row, item.itemId));
  }, [row, item.itemId]);

  const answer = row.answers[item.itemId];
  const answerText = typeof answer === "string" ? answer : Array.isArray(answer) ? answer.join(" / ") : "";

  const submit = (): void => {
    const parsed = parseGradeInput(value, item.score);
    if (!parsed.ok) {
      setState({ status: "error", message: parsed.reason });
      return;
    }
    setState({ status: "saving" });
    void api.grade(formId, row.submissionId, { itemId: item.itemId, score: parsed.score }).then((outcome) => {
      if (outcome.ok) {
        setState({ status: "saved" });
        onGraded();
        return;
      }
      setState({ status: "error", message: describeFailure(outcome.failure, { notFound: "这条提交不存在了" }) });
    });
  };

  return (
    <li className="rounded-sm border border-line p-2" data-testid={`grade-row-${item.itemId}`}>
      <p className="m-0 text-sm font-medium text-ink">
        {item.title}
        <span className="ml-1 text-xs font-normal text-muted">{`（满分 ${formatScoreNumber(item.score)}）`}</span>
      </p>
      <p className="m-0 mt-1 whitespace-pre-wrap break-words text-sm text-ink" data-testid={`grade-answer-${item.itemId}`}>
        {answerText.trim() === "" ? <span className="text-muted">（未作答）</span> : answerText}
      </p>
      <div className="mt-1 flex items-center gap-2">
        <label className="text-xs text-muted" htmlFor={`grade-input-${item.itemId}`}>
          得分
        </label>
        <input
          id={`grade-input-${item.itemId}`}
          data-testid={`grade-input-${item.itemId}`}
          className="min-h-[44px] w-20 rounded-sm border border-line bg-surface px-2 text-base text-ink"
          inputMode="numeric"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setState({ status: "idle" });
          }}
        />
        <button
          type="button"
          data-testid={`grade-save-${item.itemId}`}
          className="min-h-[44px] rounded-sm border border-accent px-3 text-sm text-accent disabled:opacity-50"
          disabled={state.status === "saving"}
          onClick={submit}
        >
          {state.status === "saving" ? "保存中…" : "保存"}
        </button>
        <StatusLine state={state} />
      </div>
    </li>
  );
}

function StatusLine({ state }: { readonly state: SaveState }): JSX.Element | null {
  if (state.status === "saved") {
    return (
      <span className="text-xs text-accent" data-testid="grade-saved">
        已保存
      </span>
    );
  }
  if (state.status === "error") {
    return (
      <span className="text-xs text-danger" role="alert" data-testid="grade-error">
        {state.message}
      </span>
    );
  }
  return null;
}

/** 供上层做错误摘要：`ApiFailure` 在批改面板外面也可能出现，集中一处好改文案。 */
export function gradeFailureText(failure: ApiFailure): string {
  return describeFailure(failure, { notFound: "这条提交不存在了" });
}
