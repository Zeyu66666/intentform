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

import { useEffect, useMemo, useState } from "react";

import type { FormSummary, SubmissionsResponse } from "@intentform/schema";

import { describeFailure, isUnauthorized } from "../api/failures";
import type { ApiFailure } from "../api/http";
import { createHttpClient } from "../api/http";
import { createTeacherApi } from "../api/teacher";
import { csvFileName, csvHref } from "../dashboard/csv";
import {
  EMPTY_SUBMISSIONS_TEXT,
  NO_AVERAGE_TEXT,
  UNPUBLISHED_TEXT,
  formOptionLabel,
  pickInitialForm,
  rowScoreText,
  sharePath,
  sortRowsNewestFirst,
  statsOf,
} from "../dashboard/model";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { DASHBOARD_PATH, LOGIN_PATH, routeToPath } from "../router";
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
  }, [api, selectedId]);

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
          </section>

          <SubmissionsSection
            state={submissionsState}
            formId={selected.id}
            isPublished={selected.publishedVersionId !== undefined}
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
}: {
  readonly state: SubmissionsState;
  readonly formId: string;
  readonly isPublished: boolean;
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

  return (
    <section className="mt-2 rounded-md border border-line bg-surface p-2">
      <div className="flex flex-wrap items-baseline justify-between gap-1">
        <dl className="m-0 flex flex-wrap gap-3 text-sm">
          <div className="flex items-baseline gap-1">
            <dt className="text-muted">提交数</dt>
            <dd className="m-0 font-medium tabular-nums text-ink">{stats.count}</dd>
          </div>
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

      {stats.isEmpty ? (
        <p className="m-0 mt-2 text-base text-ink" data-testid="dash-empty">
          {EMPTY_SUBMISSIONS_TEXT}
          {/* 空数据时平均分是"未知"而不是 0，这一句是防止误解的关键。 */}
          <span className="ml-1 text-sm text-muted">{`（平均分 ${NO_AVERAGE_TEXT}，不是 0 分）`}</span>
        </p>
      ) : (
        <table className="mt-2 w-full border-collapse text-sm" data-testid="dash-rows">
          <caption className="sr-only">提交记录</caption>
          <thead>
            <tr className="border-b border-line text-left text-muted">
              <th scope="col" className="py-1 pr-2 font-medium">
                提交时间
              </th>
              <th scope="col" className="py-1 pr-2 text-right font-medium">
                得分
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.submissionId} className="border-b border-line last:border-0" data-testid="dash-row">
                <td className="py-1 pr-2 text-ink">{formatDateTime(row.createdAt)}</td>
                <td className="py-1 pr-2 text-right tabular-nums text-ink">{rowScoreText(row)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
