/**
 * 教师看板 v1 `/dashboard`、`/dashboard/:formId`。
 *
 * 两个数字口径必须守住（`dashboard/model.ts` 里的纯函数 + 测试钉着）：
 *   1. `avgScore: null` 是"还没有人提交"，显示 `—` 与"还没有人提交"，
 *      **不能**显示成 0；
 *   2. 行序按提交时间倒序（同一秒用 submissionId 兜底），不依赖服务端顺序。
 *
 * 选中哪份表单由 URL 决定（`/dashboard/:formId`）：下拉框只负责 `pushState`，
 * 页面永远从 `formId` prop 重新取数。这样刷新、分享链接、后退键三件事都对，
 * 也不需要第二份"当前选中"状态。
 *
 * CSV 走 `<a download>` 而非 fetch：导出是浏览器下载（`Content-Disposition`），
 * 用 fetch 取 blob 再触发下载要多写一遍错误处理，拿不到 200 时用户只会看到"没动静"。
 */

import { Fragment, useEffect, useMemo, useState } from "react";

import { BLOOM_LEVELS, type FormSummary, type SubmissionsResponse } from "@intentform/schema";

import { describeFailure, isUnauthorized } from "../api/failures";
import type { ApiFailure } from "../api/http";
import { createHttpClient } from "../api/http";
import { createTeacherApi, type TeacherApi } from "../api/teacher";
import { csvFileName, csvHref } from "../dashboard/csv";
import { GradeForm } from "../dashboard/GradeForm";
import {
  EMPTY_SUBMISSIONS_TEXT,
  NO_AVERAGE_TEXT,
  UNPUBLISHED_TEXT,
  collectionRateBarWidth,
  collectionRateText,
  correctRateText,
  ratePercentText,
  formOptionLabel,
  needsGrading,
  pickInitialForm,
  rateBarWidth,
  rowScoreText,
  sharePath,
  sortRowsNewestFirst,
  statsOf,
} from "../dashboard/model";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { DASHBOARD_PATH, LOGIN_PATH, editorAddItemPath, routeToPath } from "../router";
import { navigate } from "../useRoute";

const MAX_WIDTH = "mx-auto w-full max-w-4xl px-2 py-3";

type FormsState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly forms: readonly FormSummary[] }
  | { readonly status: "error"; readonly failure: ApiFailure };

type SubmissionsState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly data: SubmissionsResponse }
  | { readonly status: "error"; readonly failure: ApiFailure };

export function DashboardPage({ formId }: { readonly formId: string | null }): JSX.Element {
  const api = useMemo(() => createTeacherApi(createHttpClient()), []);

  const [formsState, setFormsState] = useState<FormsState>({ status: "loading" });
  const [submissionsState, setSubmissionsState] = useState<SubmissionsState>({ status: "idle" });
  /** 正在批改的提交；`null` 表示面板收起。 */
  const [gradingId, setGradingId] = useState<string | null>(null);
  /** 批完一题就 +1，触发提交记录重新拉取：均分与待批数都只有服务端算得对。 */
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setFormsState({ status: "loading" });
    void api.listForms().then((outcome) => {
      if (cancelled) return;
      setFormsState(
        outcome.ok
          ? { status: "ready", forms: outcome.data.forms }
          : { status: "error", failure: outcome.failure },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const forms = formsState.status === "ready" ? formsState.forms : [];
  const selected = pickInitialForm(forms, formId);
  const selectedId = selected === null ? null : selected.id;

  useEffect(() => {
    if (selectedId === null) {
      setSubmissionsState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setSubmissionsState({ status: "loading" });
    void api.submissions(selectedId).then((outcome) => {
      if (cancelled) return;
      setSubmissionsState(
        outcome.ok
          ? { status: "ready", data: outcome.data }
          : { status: "error", failure: outcome.failure },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [api, selectedId, reloadToken]);

  return (
    <main className={MAX_WIDTH}>
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h1 className="m-0 text-lg font-semibold text-ink">教师看板</h1>
        <nav className="flex gap-2 text-sm">
          <Link href="/" className="text-muted underline">
            生成页
          </Link>
          <Link href={LOGIN_PATH} className="text-muted underline">
            登录
          </Link>
        </nav>
      </header>

      {formsState.status === "loading" ? <p className="text-sm text-muted">正在加载表单列表…</p> : null}

      {formsState.status === "error" ? (
        <FormsError failure={formsState.failure} />
      ) : null}

      {formsState.status === "ready" && forms.length === 0 ? (
        <section className="rounded-md border border-line bg-surface p-3">
          <p className="m-0 text-base text-ink">还没有任何表单</p>
          <p className="m-0 mt-1 text-sm text-muted">
            先去
            <Link href="/" className="mx-1 text-accent underline">
              生成页
            </Link>
            用一句话描述你要出的题。
          </p>
        </section>
      ) : null}

      {selected === null ? null : (
        <>
          <section className="mt-2 flex flex-col gap-1 rounded-md border border-line bg-surface p-2">
            <label className="text-xs text-muted" htmlFor="dashboard-form">
              选择表单
            </label>
            <select
              id="dashboard-form"
              data-testid="dash-form-select"
              className="min-h-[44px] w-full rounded-sm border border-line bg-surface p-1 text-base text-ink"
              value={selected.id}
              onChange={(event) => {
                navigate(routeToPath({ name: "dashboard", formId: event.target.value }));
              }}
            >
              {forms.map((form) => (
                <option key={form.id} value={form.id}>
                  {formOptionLabel(form)}
                </option>
              ))}
            </select>
            <ShareLine form={selected} />
            {/* 编辑入口放在选择区、一行之内：看板一行的布局（表单 / 提交数 / 批改）
                不因为多一个入口而换行；表单选谁就编辑谁，不需要再传一个 id。 */}
            <p className="m-0 flex flex-wrap gap-2 text-sm">
              <Link
                href={routeToPath({ name: "edit", formId: selected.id })}
                className="text-accent underline"
              >
                编辑这份表单的题目与分值
              </Link>
              <Link
                href={routeToPath({ name: "print", formId: selected.id })}
                className="text-accent underline"
                data-testid="dash-print-link"
              >
                打印版考卷
              </Link>
            </p>
            <SettingsRow formId={selected.id} kind={selected.kind} api={api} />
          </section>

          <SubmissionsSection
            state={submissionsState}
            formId={selected.id}
            isPublished={selected.publishedVersionId !== undefined}
            api={api}
            gradingId={gradingId}
            onToggleGrading={(submissionId) => {
              setGradingId((current) => (current === submissionId ? null : submissionId));
            }}
            onGraded={() => {
              setReloadToken((token) => token + 1);
            }}
          />
        </>
      )}

      <p className="mt-2 text-center text-xs text-muted">
        <Link href={DASHBOARD_PATH} className="text-muted underline">
          刷新看板
        </Link>
      </p>
    </main>
  );
}

function FormsError({ failure }: { readonly failure: ApiFailure }): JSX.Element {
  const needsLogin = isUnauthorized(failure);
  return (
    <section className="rounded-md border border-danger bg-surface p-3" role="alert">
      <p className="m-0 text-base text-danger">
        {describeFailure(failure, { notFound: "表单列表接口不存在（服务端可能没启动）" })}
      </p>
      {needsLogin ? (
        <p className="m-0 mt-1 text-sm text-muted">
          <Link href={LOGIN_PATH} className="text-accent underline">
            去登录
          </Link>
        </p>
      ) : null}
    </section>
  );
}

/**
 * 表单展示设置（A-18）：目前只有「提交后向学生展示答案解析」。
 *
 * 三条界面规矩：
 * 1. 问卷不显示这个开关——问卷没有标准答案，开了也没有内容可展示；
 * 2. 开关**默认关闭**，且改动立即生效（它是展示策略，不产生新版本，也不用重新发布）；
 * 3. 保存失败把开关退回原值并说明原因：留着「看起来开着的开关」比直接报错更危险。
 */
function SettingsRow({
  formId,
  kind,
  api,
}: {
  readonly formId: string;
  readonly kind: FormSummary["kind"];
  readonly api: TeacherApi;
}): JSX.Element {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [aiEnabled, setAiEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEnabled(null);
    setAiEnabled(null);
    setMessage(null);
    void api.getSettings(formId).then((outcome) => {
      if (cancelled) return;
      if (outcome.ok) {
        setEnabled(outcome.data.showAnswersAfterSubmit);
        setAiEnabled(outcome.data.aiGradingEnabled);
        return;
      }
      setMessage(describeFailure(outcome.failure, { notFound: "读不到这份表单的设置" }));
    });
    return () => {
      cancelled = true;
    };
  }, [api, formId]);

  if (kind !== "quiz") return <></>;

  const save = (nextShow: boolean, nextAi: boolean): void => {
    if (busy) return;
    const previousShow = enabled;
    const previousAi = aiEnabled;
    setBusy(true);
    setMessage(null);
    setEnabled(nextShow);
    setAiEnabled(nextAi);
    void api
      .updateSettings(formId, { showAnswersAfterSubmit: nextShow, aiGradingEnabled: nextAi })
      .then((outcome) => {
        setBusy(false);
        if (outcome.ok) {
          setEnabled(outcome.data.showAnswersAfterSubmit);
          setAiEnabled(outcome.data.aiGradingEnabled);
          return;
        }
        // 失败时把开关拨回去：界面上的状态必须和服务端一致。
        setEnabled(previousShow);
        setAiEnabled(previousAi);
        setMessage(describeFailure(outcome.failure, { notFound: "这份表单不存在" }));
      });
  };

  const toggle = (next: boolean): void => {
    save(next, aiEnabled === true);
  };

  const toggleAi = (next: boolean): void => {
    save(enabled === true, next);
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          data-testid="dash-show-answers"
          className="size-4 accent-accent"
          checked={enabled === true}
          disabled={enabled === null || busy}
          onChange={(event) => {
            toggle(event.target.checked);
          }}
        />
        提交后向学生展示答案解析
        <span className="text-xs text-muted">
          {enabled === null ? "（读取中…）" : enabled ? "（已开启）" : "（默认关闭）"}
        </span>
      </label>
      <label className="flex min-h-[44px] items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          data-testid="dash-ai-grading"
          className="size-4 accent-accent"
          checked={aiEnabled === true}
          disabled={aiEnabled === null || busy}
          onChange={(event) => {
            toggleAi(event.target.checked);
          }}
        />
        允许 AI 辅助评分
        <span className="text-xs text-muted">
          {aiEnabled === null
            ? "（读取中…）"
            : aiEnabled
              ? "（已开启：批改简答时会把该题原文发送给模型）"
              : "（默认关闭）"}
        </span>
      </label>
      {message === null ? null : (
        <p className="m-0 text-sm text-danger" role="alert" data-testid="dash-settings-error">
          {message}
        </p>
      )}
    </div>
  );
}

function ShareLine({ form }: { readonly form: FormSummary }): JSX.Element {
  const path = sharePath(form);
  if (path === null) {
    return <p className="m-0 text-sm text-muted">{`学生链接：${UNPUBLISHED_TEXT}`}</p>;
  }
  return (
    <p className="m-0 text-sm text-muted">
      学生链接：
      <Link href={path} className="text-accent underline">
        {path}
      </Link>
    </p>
  );
}

function SubmissionsSection({
  state,
  formId,
  isPublished,
  api,
  gradingId,
  onToggleGrading,
  onGraded,
}: {
  readonly state: SubmissionsState;
  readonly formId: string;
  readonly isPublished: boolean;
  readonly api: TeacherApi;
  readonly gradingId: string | null;
  readonly onToggleGrading: (submissionId: string) => void;
  readonly onGraded: () => void;
}): JSX.Element {
  if (state.status === "loading" || state.status === "idle") {
    return <p className="mt-2 text-sm text-muted">正在加载提交记录…</p>;
  }

  if (state.status === "error") {
    return (
      <section className="mt-2 rounded-md border border-danger bg-surface p-3" role="alert">
        <p className="m-0 text-base text-danger">
          {describeFailure(state.failure, {
            notFound: isPublished ? "这份表单不存在" : "这份表单还没有发布过，没有提交记录",
          })}
        </p>
      </section>
    );
  }

  const summary = state.data.summary;
  const stats = statsOf(summary);
  const rows = sortRowsNewestFirst(state.data.rows);
  const gradingRow = gradingId === null ? null : (rows.find((row) => row.submissionId === gradingId) ?? null);
  const hasManualItems = state.data.shortItems.length > 0;
  const isSurvey = summary.kind === "survey";

  return (
    <section className="mt-2 rounded-md border border-line bg-surface p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <dl className="m-0 flex flex-wrap gap-3 text-sm">
          <div className="flex items-baseline gap-1">
            <dt className="text-muted">提交数</dt>
            <dd className="m-0 font-medium tabular-nums text-ink">{stats.count}</dd>
          </div>
          {isSurvey ? null : (
            <>
              <div className="flex items-baseline gap-1">
                <dt className="text-muted">平均分</dt>
                <dd
                  className={`m-0 font-medium tabular-nums ${stats.averageIsUnknown ? "text-muted" : "text-ink"}`}
                >
                  {stats.averageText}
                </dd>
              </div>
              <div className="flex items-baseline gap-1">
                <dt className="text-muted">满分</dt>
                <dd className="m-0 font-medium tabular-nums text-ink">{stats.maxScoreText}</dd>
              </div>
            </>
          )}
          <div className="flex items-baseline gap-1">
            <dt className="text-muted">版本</dt>
            <dd className="m-0 font-medium tabular-nums text-ink">{stats.versionLabel}</dd>
          </div>
        </dl>
        <a
          href={csvHref(formId)}
          download={csvFileName(formId)}
          data-testid="dash-csv"
          className="min-h-[44px] rounded-sm border border-accent px-2 py-1 text-sm leading-[44px] text-accent"
        >
          导出 CSV
        </a>
      </div>

      {isSurvey ? (
        <section className="mt-2" data-testid="dash-collection-stats">
          <div className="flex flex-wrap items-baseline justify-between gap-1">
            <h2 className="m-0 text-base font-semibold text-ink">回收情况</h2>
            <p className="m-0 text-xs text-muted">分母 = 提交份数，未填写按未填写计</p>
          </div>
          {state.data.collectionStats.length === 0 ? (
            <p className="m-0 mt-1 text-sm text-muted">这份问卷没有可回收字段</p>
          ) : (
            <table className="mt-1 w-full border-collapse text-sm">
              <caption className="sr-only">问卷回收情况</caption>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="py-1 pr-2 font-medium">字段</th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">已填写</th>
                  <th scope="col" className="py-1 font-medium">填写率</th>
                </tr>
              </thead>
              <tbody>
                {state.data.collectionStats.map((stat) => (
                  <Fragment key={stat.itemId}>
                    <tr className="border-b border-line last:border-0" data-testid="dash-collection-stat">
                      <td className="py-1 pr-2 text-ink">{stat.title}</td>
                      <td className="py-1 pr-2 text-right tabular-nums text-ink">
                        {`${String(stat.answered)}/${String(stat.total)}`}
                      </td>
                      <td className="py-1">
                        <div className="flex items-center gap-2">
                          <span className={`w-12 text-right tabular-nums ${stat.rate === null ? "text-muted" : "text-ink"}`}>
                            {collectionRateText(stat)}
                          </span>
                          {stat.rate === null ? null : (
                            <span aria-hidden="true" className="h-2 w-16 overflow-hidden rounded-sm bg-line">
                              <span className="block h-full bg-accent" style={{ width: `${String(collectionRateBarWidth(stat))}%` }} />
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {stat.options === undefined ? null : (
                      <tr className="border-b border-line last:border-0">
                        <td colSpan={3} className="pb-1 pl-2">
                          {/* 各选项分布（A-09）：分母与上一行一致；多选的占比之和可能超过 100%。 */}
                          <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs">
                            {stat.options.map((option) => (
                              <li
                                key={option.optionId}
                                data-testid="dash-collection-option"
                                className="flex items-center gap-1"
                              >
                                <span className="text-muted">{option.label}</span>
                                <span className="tabular-nums text-ink">{String(option.count)}</span>
                                <span className="text-muted">{`（${ratePercentText(option.rate)}）`}</span>
                              </li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      {/* 每题正确率（R-04）。survey 与纯人工判分的表没有可判对错的题，整块不出现：
          渲染一张全是 `—` 的表，比不渲染更容易被误读成「数据坏了」。 */}
      {state.data.itemStats.length === 0 ? null : (
        <section className="mt-2" data-testid="dash-item-stats">
          <div className="flex flex-wrap items-baseline justify-between gap-1">
            <h2 className="m-0 text-base font-semibold text-ink">每题正确率</h2>
            <p className="m-0 text-xs text-muted">分母 = 提交份数，未作答按未答对计</p>
          </div>
          <table className="mt-1 w-full border-collapse text-sm">
            <caption className="sr-only">每题正确率</caption>
            <thead>
              <tr className="border-b border-line text-left text-muted">
                <th scope="col" className="py-1 pr-2 font-medium">
                  题目
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  作答
                </th>
                <th scope="col" className="py-1 pr-2 text-right font-medium">
                  答对
                </th>
                <th scope="col" className="py-1 font-medium">
                  正确率
                </th>
              </tr>
            </thead>
            <tbody>
              {state.data.itemStats.map((stat) => (
                <tr
                  key={stat.itemId}
                  className="border-b border-line last:border-0"
                  data-testid="dash-item-stat"
                >
                  <td className="py-1 pr-2 text-ink">
                    {stat.title}
                    <span className="ml-1 text-xs text-muted">{`${String(stat.score)} 分`}</span>
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-ink">
                    {`${String(stat.answered)}/${String(stat.total)}`}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums text-ink">
                    {String(stat.correct)}
                  </td>
                  <td className="py-1">
                    <div className="flex items-center gap-2">
                      <span
                        className={`w-12 text-right tabular-nums ${stat.rate === null ? "text-muted" : "text-ink"}`}
                      >
                        {correctRateText(stat)}
                      </span>
                      {/* 条只是辅助读数的视觉，数字才是事实：条对屏幕阅读器隐藏。
                          无数据（`—`）时整根条不画：一条空轨道看起来仍像「0%」。 */}
                      {stat.rate === null ? null : (
                        <span
                          aria-hidden="true"
                          className="h-2 w-16 overflow-hidden rounded-sm bg-line"
                        >
                          <span
                            className="block h-full bg-accent"
                            style={{ width: `${String(rateBarWidth(stat))}%` }}
                          />
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {state.data.coverageMatrix.rows.length === 0 ? null : (
        <section className="mt-3" data-testid="dash-coverage-matrix">
          <div className="flex flex-wrap items-baseline justify-between gap-1">
            <h2 className="m-0 text-base font-semibold text-ink">知识点 × 布鲁姆覆盖</h2>
            <p className="m-0 text-xs text-muted">按当前版本实际题目统计，0 表示尚未覆盖</p>
          </div>
          <div className="mt-1 overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <caption className="sr-only">知识点 × 布鲁姆覆盖矩阵</caption>
              <thead>
                <tr className="border-b border-line text-left text-muted">
                  <th scope="col" className="py-1 pr-2 font-medium">知识点</th>
                  {BLOOM_LEVELS.map((bloom) => (
                    <th key={bloom} scope="col" className="px-1 py-1 text-center font-medium">
                      {bloomLabel(bloom)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.data.coverageMatrix.rows.map((row) => (
                  <tr key={row.objectiveId} className="border-b border-line last:border-0">
                    <th scope="row" className="py-1 pr-2 text-left font-medium text-ink">
                      {row.objectiveName}
                    </th>
                    {BLOOM_LEVELS.map((bloom) => (
                      <td key={bloom} className="px-1 py-1 text-center tabular-nums text-ink">
                        {/* 点击任一格进入补题：预填这一行的知识点与这一列的层级。
                            0 与已有覆盖都允许再补，矩阵不替教师判断「够了」。 */}
                        <Link
                          href={editorAddItemPath(formId, row.objectiveId, bloom)}
                          data-testid={`coverage-cell-${row.objectiveId}-${bloom}`}
                          aria-label={`为${row.objectiveName}补一道${bloomLabel(bloom)}题`}
                          className="inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded-sm text-accent underline decoration-dotted underline-offset-2"
                        >
                          {String(row.counts[bloom])}
                        </Link>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* R-04 之后上面多了一张「每题正确率」表，两张表挨着时第二张的表头会被
          读成第一张的续行；给提交表一个标题，边界不靠间距猜。 */}
      {/* 问卷不判分（R-09）：没有「得分」可言，行里只留提交时间，标题叫「回收记录」。
          给每条回收行挂一个 `0 / 0` 会被读成「全员 0 分」，正是 0.2 #5 要修的缺陷。 */}
      <h2 className="m-0 mt-3 text-base font-semibold text-ink">{isSurvey ? "回收记录" : "提交记录"}</h2>

      {stats.isEmpty ? (
        <p className="m-0 mt-2 text-base text-ink" data-testid="dash-empty">
          {EMPTY_SUBMISSIONS_TEXT}
          {/* 空数据时平均分是"未知"而不是 0，这一句是防止误解的关键。 */}
          {isSurvey ? null : <span className="ml-1 text-sm text-muted">{`（平均分 ${NO_AVERAGE_TEXT}，不是 0 分）`}</span>}
        </p>
      ) : (
        <table className="mt-2 w-full border-collapse text-sm" data-testid="dash-rows">
          <caption className="sr-only">{isSurvey ? "回收记录" : "提交记录"}</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className="py-1 pr-2 font-medium">
                提交时间
              </th>
              {isSurvey ? null : (
                <>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">
                    得分
                  </th>
                  <th scope="col" className="py-1 pr-2 text-right font-medium">
                    简答
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.submissionId} className="border-b border-line last:border-0" data-testid="dash-row">
                <td className="py-1 pr-2 text-ink">{formatDateTime(row.createdAt)}</td>
                {isSurvey ? null : (
                  <>
                    <td className="py-1 pr-2 text-right tabular-nums text-ink">{rowScoreText(row)}</td>
                    <td className="py-1 pr-2 text-right">
                      {needsGrading(row) ? (
                        <button
                          type="button"
                          data-testid={`dash-grade-${row.submissionId}`}
                          className="min-h-[44px] rounded-sm border border-accent px-2 text-sm text-accent"
                          onClick={() => {
                            onToggleGrading(row.submissionId);
                          }}
                        >
                          {gradingId === row.submissionId ? "收起批改" : "批改"}
                        </button>
                      ) : (
                        <span className="text-xs text-muted">{pendingLabel(row.pendingScore, hasManualItems)}</span>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {gradingRow === null ? null : (
        <GradeForm
          formId={formId}
          row={gradingRow}
          shortItems={state.data.shortItems}
          api={api}
          onGraded={onGraded}
          onClose={() => {
            onToggleGrading(gradingRow.submissionId);
          }}
        />
      )}
    </section>
  );
}

const BLOOM_LABELS = {
  remember: "记忆",
  understand: "理解",
  apply: "应用",
  analyze: "分析",
  evaluate: "评价",
  create: "创造",
} as const;

function bloomLabel(bloom: (typeof BLOOM_LEVELS)[number]): string {
  return BLOOM_LABELS[bloom];
}

/**
 * 批完的标记。
 *
 * 「已批完」只有在**这张表确实有需要人工批改的题**时才有信息量；一份纯客观题的表
 * 每行都挂个「已批完」，等于告诉教师「这里有东西要批、已经批完了」，而实际上从来没有。
 * 省赛 R-02 加人工批改时踩到过这个措辞问题，所以判定改成两段：有简答分值才算「批完」。
 */
function pendingLabel(pendingScore: number, hasManualItems: boolean): string {
  if (!hasManualItems) return "";
  return pendingScore > 0 ? "" : "已批完";
}
