/**
 * 教师看板 `/dashboard`、`/dashboard/:formId`。
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
 *
 * 版面按「表单身份 → 关键数字 → 明细表」排：教师打开看板先确认自己在看哪份卷子，
 * 再看提交数与平均分，最后才逐题、逐提交地读。设置项排在数据之后，避免和数字抢视线。
 */

import { Fragment, useEffect, useMemo, useState } from "react";

import {
  BLOOM_LEVELS,
  type CollectionStat,
  type FormSummary,
  type ItemStat,
  type SubmissionRow,
  type SubmissionsResponse,
} from "@intentform/schema";

import { describeFailure, isUnauthorized } from "../api/failures";
import type { ApiFailure } from "../api/http";
import { createHttpClient } from "../api/http";
import { createTeacherApi, type TeacherApi } from "../api/teacher";
import { csvFileName, csvHref } from "../dashboard/csv";
import { GradeForm } from "../dashboard/GradeForm";
import {
  EMPTY_SUBMISSIONS_TEXT,
  UNPUBLISHED_TEXT,
  collectionRateBarWidth,
  collectionRateText,
  correctRateText,
  ratePercentText,
  formOptionLabel,
  isPublished,
  needsGrading,
  pickInitialForm,
  rateBarWidth,
  rowScoreText,
  sharePath,
  sortRowsNewestFirst,
  statsOf,
  statusLabel,
  type DashboardStats,
} from "../dashboard/model";
import { formatDateTime } from "../format";
import { Link } from "../Link";
import { MathText } from "../render/Latex";
import { LOGIN_PATH, editorAddItemPath, routeToPath } from "../router";
import { navigate } from "../useRoute";

const PAGE = "mx-auto w-full max-w-6xl px-2 py-4";

/** 两种按钮共用同一套触控高度；主操作只有一个，避免一屏里全是蓝色块。 */
const PRIMARY_LINK =
  "inline-flex min-h-[44px] items-center justify-center rounded-sm bg-accent px-3 text-sm font-medium text-white transition-opacity hover:opacity-90";
const SECONDARY_LINK =
  "inline-flex min-h-[44px] items-center justify-center rounded-sm border border-line px-3 text-sm text-ink transition-colors hover:border-accent hover:text-accent";
const SECONDARY_BUTTON =
  "min-h-[44px] rounded-sm border border-line px-3 text-sm text-ink transition-colors hover:border-accent hover:text-accent disabled:opacity-50";
const DANGER_BUTTON =
  "min-h-[44px] rounded-sm border border-danger px-3 text-sm text-danger transition-colors hover:bg-danger hover:text-white disabled:opacity-50";

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
    <main className={PAGE}>
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="m-0 text-xl font-semibold tracking-tight text-ink">教师看板</h1>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            data-testid="dash-refresh"
            onClick={() => {
              setReloadToken((token) => token + 1);
            }}
          >
            刷新数据
          </button>
          <Link href="/" className={PRIMARY_LINK}>
            生成新表单
          </Link>
        </div>
      </header>

      {formsState.status === "loading" ? <LoadingCard text="正在加载表单列表…" /> : null}

      {formsState.status === "error" ? <FormsError failure={formsState.failure} /> : null}

      {formsState.status === "ready" && forms.length === 0 ? <EmptyForms /> : null}

      {selected === null ? null : (
        <>
          <FormHero
            form={selected}
            forms={forms}
            api={api}
            onSelect={(nextFormId) => {
              setGradingId(null);
              navigate(routeToPath({ name: "dashboard", formId: nextFormId }));
            }}
            onDeleted={(deletedId) => {
              setFormsState((current) =>
                current.status === "ready"
                  ? { status: "ready", forms: current.forms.filter((form) => form.id !== deletedId) }
                  : current,
              );
              setGradingId(null);
              navigate(routeToPath({ name: "dashboard", formId: null }));
            }}
          />

          <SubmissionsSection
            state={submissionsState}
            form={selected}
            api={api}
            gradingId={gradingId}
            onToggleGrading={(submissionId) => {
              setGradingId((current) => (current === submissionId ? null : submissionId));
            }}
            onGraded={() => {
              setReloadToken((token) => token + 1);
            }}
          />

          <SettingsRow formId={selected.id} kind={selected.kind} api={api} />
        </>
      )}
    </main>
  );
}

/**
 * 表单身份卡：切换表单、状态、学生链接与三个入口。
 *
 * 切换器放在卡片顶部而不是页面顶上：它影响的是**这一张卡**的全部内容，
 * 视觉上贴着表单名，教师不会误以为它换的是「整个看板的视图」。
 */
function FormHero({
  form,
  forms,
  api,
  onSelect,
  onDeleted,
}: {
  readonly form: FormSummary;
  readonly forms: readonly FormSummary[];
  readonly api: TeacherApi;
  readonly onSelect: (formId: string) => void;
  readonly onDeleted: (formId: string) => void;
}): JSX.Element {
  const path = sharePath(form);
  const published = isPublished(form);

  return (
    <section className="mt-3 rounded-md border border-line bg-surface px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <span
            className={`inline-block rounded-sm border px-1.5 py-0.5 text-xs font-medium ${
              published ? "border-success text-success" : "border-line text-muted"
            }`}
          >
            {statusLabel(form.status)}
          </span>
          <h2 className="m-0 mt-1 break-words text-lg font-semibold tracking-tight text-ink">
            <MathText text={form.title} />
          </h2>
          <div className="mt-1 text-sm">
            {path === null ? (
              <span className="inline-flex flex-wrap items-center gap-2">
                <span className="text-muted">{UNPUBLISHED_TEXT}</span>
                <Link
                  href={routeToPath({ name: "edit", formId: form.id })}
                  className="text-accent underline underline-offset-2"
                >
                  去发布
                </Link>
              </span>
            ) : (
              <Link
                href={path}
                data-testid="dash-student-link"
                className="break-all text-accent underline underline-offset-2"
              >
                {path}
              </Link>
            )}
          </div>
        </div>

        <div className="flex w-full min-w-0 flex-col gap-2 sm:w-auto sm:shrink-0 sm:items-end">
          <label htmlFor="dashboard-form" className="sr-only">
            切换表单
          </label>
          <select
            id="dashboard-form"
            data-testid="dash-form-select"
            className="min-h-[44px] w-full rounded-sm border border-line bg-surface px-2 text-sm text-ink sm:w-[18rem]"
            value={form.id}
            onChange={(event) => {
              onSelect(event.target.value);
            }}
          >
            {forms.map((option) => (
              <option key={option.id} value={option.id}>
                {formOptionLabel(option)}
              </option>
            ))}
          </select>
          <div className="flex flex-wrap items-center gap-1 sm:justify-end">
            <Link href={routeToPath({ name: "edit", formId: form.id })} className={PRIMARY_LINK}>
              编辑题目
            </Link>
            <Link
              href={routeToPath({ name: "print", formId: form.id })}
              className={SECONDARY_LINK}
              data-testid="dash-print-link"
            >
              打印版考卷
            </Link>
            <DeleteFormAction formId={form.id} api={api} onDeleted={onDeleted} />
          </div>
        </div>
      </div>
    </section>
  );
}

/** 删除用就地二次确认，不弹 `window.confirm`：确认按钮与触发按钮在同一位置，误点后能看见「取消」。 */
function DeleteFormAction({
  formId,
  api,
  onDeleted,
}: {
  readonly formId: string;
  readonly api: TeacherApi;
  readonly onDeleted: (formId: string) => void;
}): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!confirming) {
    return (
      <button
        type="button"
        data-testid="dash-delete"
        className={DANGER_BUTTON}
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
      >
        删除表单
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <button
        type="button"
        data-testid="dash-delete-confirm"
        className={DANGER_BUTTON}
        disabled={busy}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          setError(null);
          void api.deleteForm(formId).then((outcome) => {
            if (outcome.ok) {
              onDeleted(formId);
              return;
            }
            setBusy(false);
            setError(describeFailure(outcome.failure, { notFound: "这份表单已经不存在" }));
          });
        }}
      >
        {busy ? "删除中…" : "确认删除"}
      </button>
      <button
        type="button"
        data-testid="dash-delete-cancel"
        className={SECONDARY_BUTTON}
        disabled={busy}
        onClick={() => {
          setConfirming(false);
          setError(null);
        }}
      >
        取消
      </button>
      {error === null ? null : (
        <span className="text-xs text-danger" role="alert" data-testid="dash-delete-error">
          {error}
        </span>
      )}
    </span>
  );
}

/**
 * 表单展示设置（A-18/A-23）：目前只有「提交后向学生展示答案解析」与「AI 辅助评分」。
 *
 * 三条界面规矩：
 * 1. 问卷不显示这个卡片——问卷没有标准答案，开了也没有内容可展示；
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
    <section className="mt-3 rounded-md border border-line bg-surface">
      <SectionHeader title="展示与批改" />
      <div className="grid gap-2 p-3 md:grid-cols-2">
        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-sm border border-line p-2 transition-colors hover:bg-bg">
          <input
            type="checkbox"
            data-testid="dash-show-answers"
            className="size-4 shrink-0 accent-accent"
            checked={enabled === true}
            disabled={enabled === null || busy}
            onChange={(event) => {
              toggle(event.target.checked);
            }}
          />
          <span className="text-sm text-ink">提交后展示答案解析</span>
          <span className="ml-auto text-xs text-muted">
            {enabled === null ? "（读取中…）" : enabled ? "（已开启）" : "（默认关闭）"}
          </span>
        </label>

        <label className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-sm border border-line p-2 transition-colors hover:bg-bg">
          <input
            type="checkbox"
            data-testid="dash-ai-grading"
            className="size-4 shrink-0 accent-accent"
            checked={aiEnabled === true}
            disabled={aiEnabled === null || busy}
            onChange={(event) => {
              toggleAi(event.target.checked);
            }}
          />
          <span className="text-sm text-ink">AI 辅助评分</span>
          <span className="ml-auto text-xs text-muted">
            {aiEnabled === null ? "（读取中…）" : aiEnabled ? "（已开启）" : "（默认关闭）"}
          </span>
        </label>
      </div>
      {message === null ? null : (
        <p className="m-0 px-3 pb-3 text-sm text-danger" role="alert" data-testid="dash-settings-error">
          {message}
        </p>
      )}
    </section>
  );
}

function FormsError({ failure }: { readonly failure: ApiFailure }): JSX.Element {
  const needsLogin = isUnauthorized(failure);
  return (
    <section className="mt-3 rounded-md border border-danger bg-surface p-3" role="alert">
      <p className="m-0 text-sm font-medium text-danger">加载表单列表失败</p>
      <p className="m-0 mt-1 text-sm text-danger">
        {describeFailure(failure, { notFound: "表单列表接口不存在（服务端可能没启动）" })}
      </p>
      {needsLogin ? (
        <p className="m-0 mt-2 text-sm text-muted">
          <Link href={LOGIN_PATH} className="text-accent underline underline-offset-2">
            去登录
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function EmptyForms(): JSX.Element {
  return (
    <section className="mt-3 rounded-md border border-dashed border-line bg-surface px-3 py-6 text-center">
      <p className="m-0 text-base font-medium text-ink">还没有表单</p>
      <Link href="/" className={`${PRIMARY_LINK} mt-3`}>
        生成表单
      </Link>
    </section>
  );
}

function LoadingCard({ text }: { readonly text: string }): JSX.Element {
  return (
    <section
      className="mt-3 flex items-center gap-2 rounded-md border border-line bg-surface p-3"
      role="status"
    >
      <span aria-hidden="true" className="size-2 animate-pulse rounded-full bg-accent" />
      <p className="m-0 text-sm text-muted">{text}</p>
    </section>
  );
}

/** 小标题带一条底边：几张表连排时，边界靠线而不是靠间距猜。 */
function SectionHeader({
  title,
  action,
}: {
  readonly title: string;
  readonly action?: JSX.Element;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
      <h2 className="m-0 text-base font-semibold text-ink">{title}</h2>
      {action ?? null}
    </div>
  );
}

function SubmissionsSection({
  state,
  form,
  api,
  gradingId,
  onToggleGrading,
  onGraded,
}: {
  readonly state: SubmissionsState;
  readonly form: FormSummary;
  readonly api: TeacherApi;
  readonly gradingId: string | null;
  readonly onToggleGrading: (submissionId: string) => void;
  readonly onGraded: () => void;
}): JSX.Element {
  if (state.status === "loading" || state.status === "idle") {
    return <LoadingCard text="正在加载提交记录…" />;
  }

  if (state.status === "error") {
    return (
      <section className="mt-3 rounded-md border border-danger bg-surface p-3" role="alert">
        <p className="m-0 text-sm font-medium text-danger">加载提交记录失败</p>
        <p className="m-0 mt-1 text-sm text-danger">
          {describeFailure(state.failure, {
            notFound: isPublished(form) ? "这份表单不存在" : "这份表单还没有发布过，没有提交记录",
          })}
        </p>
      </section>
    );
  }

  const summary = state.data.summary;
  const stats = statsOf(summary);
  const rows = sortRowsNewestFirst(state.data.rows);
  const isSurvey = summary.kind === "survey";

  return (
    <div className="mt-3 flex flex-col gap-2">
      <StatsGrid
        stats={stats}
        rows={rows}
        isSurvey={isSurvey}
        collectionCount={state.data.collectionStats.length}
      />

      {isSurvey ? <CollectionCard stats={state.data.collectionStats} /> : null}

      {state.data.itemStats.length === 0 ? null : <ItemStatsCard stats={state.data.itemStats} />}

      <RecordsCard
        formId={form.id}
        formPublished={isPublished(form)}
        isSurvey={isSurvey}
        stats={stats}
        rows={rows}
        shortItems={state.data.shortItems}
        api={api}
        gradingId={gradingId}
        onToggleGrading={onToggleGrading}
        onGraded={onGraded}
      />

      {state.data.coverageMatrix.rows.length === 0 ? null : (
        <CoverageCard formId={form.id} rows={state.data.coverageMatrix.rows} />
      )}
    </div>
  );
}

/**
 * 关键数字卡。四个数字回答四个问题：交了多少、均分多少、卷面多少、还要批多少。
 * 问卷没有均分与卷面，只留回收份数、可回收字段和版本——不要为了凑四格而造数字。
 */
function StatsGrid({
  stats,
  rows,
  isSurvey,
  collectionCount,
}: {
  readonly stats: DashboardStats;
  readonly rows: readonly SubmissionRow[];
  readonly isSurvey: boolean;
  readonly collectionCount: number;
}): JSX.Element {
  if (isSurvey) {
    return (
      <section aria-label="回收概览" className="grid grid-cols-3 gap-2">
        <StatCard label="提交数" value={String(stats.count)} />
        <StatCard label="可回收字段" value={String(collectionCount)} />
        <StatCard label="当前版本" value={stats.versionLabel} />
      </section>
    );
  }

  const pendingRows = rows.filter(needsGrading).length;
  return (
    <section aria-label="提交概览" className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <StatCard label="提交数" value={String(stats.count)} />
      <StatCard
        label="平均分"
        value={stats.averageText}
        muted={stats.averageIsUnknown}
      />
      <StatCard label="满分" value={stats.maxScoreText} />
      <StatCard label="待批改" value={String(pendingRows)} />
    </section>
  );
}

function StatCard({
  label,
  value,
  muted = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly muted?: boolean;
}): JSX.Element {
  return (
    <div className="rounded-md border border-line bg-surface p-3">
      <p className="m-0 text-xs font-medium text-muted">{label}</p>
      <p className={`m-0 mt-1 text-xl font-semibold tabular-nums ${muted ? "text-muted" : "text-ink"}`}>
        {value}
      </p>
    </div>
  );
}

/** 问卷回收：逐字段填写率 + 选项分布（A-09）。 */
function CollectionCard({ stats }: { readonly stats: readonly CollectionStat[] }): JSX.Element {
  return (
    <section className="rounded-md border border-line bg-surface" data-testid="dash-collection-stats">
      <SectionHeader title="回收情况" />
      {stats.length === 0 ? (
        <p className="m-0 px-3 py-3 text-sm text-muted">这份问卷没有可回收字段</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">问卷回收情况</caption>
            <thead>
              <tr className="border-b border-line bg-bg text-left text-xs text-muted">
                <th scope="col" className="px-3 py-2 font-medium">
                  字段
                </th>
                <th scope="col" className="px-3 py-2 text-right font-medium">
                  已填写
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  填写率
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.map((stat) => (
                <Fragment key={stat.itemId}>
                  <tr
                    className="border-b border-line last:border-0 transition-colors hover:bg-bg"
                    data-testid="dash-collection-stat"
                  >
                    <td className="px-3 py-2 text-ink">
                      <MathText text={stat.title} />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-ink">
                      {`${String(stat.answered)}/${String(stat.total)}`}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`w-12 text-right tabular-nums ${stat.rate === null ? "text-muted" : "text-ink"}`}
                        >
                          {collectionRateText(stat)}
                        </span>
                        {stat.rate === null ? null : (
                          <span aria-hidden="true" className="h-2 w-16 overflow-hidden rounded-sm bg-line">
                            <span
                              className="block h-full bg-accent"
                              style={{ width: `${String(collectionRateBarWidth(stat))}%` }}
                            />
                          </span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {stat.options === undefined ? null : (
                    <tr className="border-b border-line last:border-0">
                      <td colSpan={3} className="px-3 pb-2">
                        {/* 各选项分布（A-09）：分母与上一行一致；多选的占比之和可能超过 100%。 */}
                        <ul className="m-0 flex list-none flex-wrap gap-1 p-0 text-xs">
                          {stat.options.map((option) => (
                            <li
                              key={option.optionId}
                              data-testid="dash-collection-option"
                              className="flex items-center gap-1 rounded-sm bg-bg px-2 py-1"
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
        </div>
      )}
    </section>
  );
}

/** 每题正确率（R-04）。第四格必须只有百分比文本，CSS 条不带文本。 */
function ItemStatsCard({ stats }: { readonly stats: readonly ItemStat[] }): JSX.Element {
  return (
    <section className="rounded-md border border-line bg-surface" data-testid="dash-item-stats">
      <SectionHeader title="每题正确率" />
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">每题正确率</caption>
          <thead>
            <tr className="border-b border-line bg-bg text-left text-xs text-muted">
              <th scope="col" className="px-3 py-2 font-medium">
                题目
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                作答
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                答对
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                正确率
              </th>
            </tr>
          </thead>
          <tbody>
            {stats.map((stat) => (
              <tr
                key={stat.itemId}
                className="border-b border-line last:border-0 transition-colors hover:bg-bg"
                data-testid="dash-item-stat"
              >
                <td className="px-3 py-2 text-ink">
                  <MathText text={stat.title} />
                  <span className="ml-1 whitespace-nowrap rounded-sm bg-bg px-1 text-xs text-muted">{`${String(stat.score)} 分`}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">
                  {`${String(stat.answered)}/${String(stat.total)}`}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-ink">{String(stat.correct)}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-12 text-right tabular-nums ${stat.rate === null ? "text-muted" : "text-ink"}`}
                    >
                      {correctRateText(stat)}
                    </span>
                    {/* 条只是辅助读数的视觉，数字才是事实：条对屏幕阅读器隐藏。
                        无数据（`—`）时整根条不画：一条空轨道看起来仍像「0%」。 */}
                    {stat.rate === null ? null : (
                      <span aria-hidden="true" className="h-2 w-16 overflow-hidden rounded-sm bg-line">
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
      </div>
    </section>
  );
}

/** 提交/回收记录。批改面板紧跟在被点的那一行下面，不跳到表尾。 */
function RecordsCard({
  formId,
  formPublished,
  isSurvey,
  stats,
  rows,
  shortItems,
  api,
  gradingId,
  onToggleGrading,
  onGraded,
}: {
  readonly formId: string;
  readonly formPublished: boolean;
  readonly isSurvey: boolean;
  readonly stats: DashboardStats;
  readonly rows: readonly SubmissionRow[];
  readonly shortItems: SubmissionsResponse["shortItems"];
  readonly api: TeacherApi;
  readonly gradingId: string | null;
  readonly onToggleGrading: (submissionId: string) => void;
  readonly onGraded: () => void;
}): JSX.Element {
  const gradingRow = gradingId === null ? null : (rows.find((row) => row.submissionId === gradingId) ?? null);
  const hasManualItems = shortItems.length > 0;

  return (
    <section className="rounded-md border border-line bg-surface">
      <SectionHeader
        title={isSurvey ? "回收记录" : "提交记录"}
        action={
          <a
            href={csvHref(formId)}
            download={csvFileName(formId)}
            data-testid="dash-csv"
            className={SECONDARY_LINK}
          >
            导出 CSV
          </a>
        }
      />

      {stats.isEmpty ? (
        <div className="px-3 py-6 text-center" data-testid="dash-empty">
          <p className="m-0 text-base font-medium text-ink">{EMPTY_SUBMISSIONS_TEXT}</p>
          {isSurvey || formPublished ? null : (
            <Link
              href={routeToPath({ name: "edit", formId })}
              className={`${SECONDARY_LINK} mt-3`}
            >
              去发布
            </Link>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm" data-testid="dash-rows">
            <caption className="sr-only">{isSurvey ? "回收记录" : "提交记录"}</caption>
            <thead>
              <tr className="border-b border-line bg-bg text-left text-xs text-muted">
                <th scope="col" className="px-3 py-2 font-medium">
                  提交时间
                </th>
                {isSurvey ? null : (
                  <>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      得分
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      简答
                    </th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const stamp = stampParts(row.createdAt);
                return (
                  <Fragment key={row.submissionId}>
                    <tr
                      className="border-b border-line last:border-0 transition-colors hover:bg-bg"
                      data-testid="dash-row"
                    >
                      <td className="whitespace-nowrap px-3 py-2">
                        <span className="block tabular-nums text-ink">{stamp.date}</span>
                        {stamp.time === "" ? null : (
                          <span className="block text-xs tabular-nums text-muted">{stamp.time}</span>
                        )}
                      </td>
                      {isSurvey ? null : (
                        <>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-ink">
                            {rowScoreText(row)}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right">
                            {needsGrading(row) ? (
                              <button
                                type="button"
                                data-testid={`dash-grade-${row.submissionId}`}
                                className="min-h-[44px] rounded-sm border border-accent px-3 text-sm text-accent transition-colors hover:bg-accent hover:text-white"
                                onClick={() => {
                                  onToggleGrading(row.submissionId);
                                }}
                              >
                                {gradingId === row.submissionId ? "收起批改" : "批改"}
                              </button>
                            ) : (
                              <span className="text-xs text-muted">
                                {pendingLabel(row.pendingScore, hasManualItems)}
                              </span>
                            )}
                          </td>
                        </>
                      )}
                    </tr>
                    {gradingId === row.submissionId && gradingRow !== null ? (
                      <tr className="bg-bg">
                        <td colSpan={isSurvey ? 1 : 3} className="p-2">
                          {/* 批改面板跟着这一行走：教师点哪行，输入框就在哪行下面，
                              不再跳到整张表末尾。 */}
                          <GradeForm
                            formId={formId}
                            row={gradingRow}
                            shortItems={shortItems}
                            api={api}
                            onGraded={onGraded}
                            onClose={() => {
                              onToggleGrading(gradingRow.submissionId);
                            }}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
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

/** 覆盖矩阵默认收在 `<details>` 里：它有用，但不是每天第一眼要看的东西。 */
function CoverageCard({
  formId,
  rows,
}: {
  readonly formId: string;
  readonly rows: SubmissionsResponse["coverageMatrix"]["rows"];
}): JSX.Element {
  return (
    <details className="group rounded-md border border-line bg-surface" data-testid="dash-coverage">
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-3 transition-colors hover:bg-bg [&::-webkit-details-marker]:hidden"
        data-testid="dash-coverage-toggle"
      >
        <h2 className="m-0 text-base font-semibold text-ink">教学覆盖分析</h2>
        <span aria-hidden="true" className="text-lg leading-none text-muted">
          <span className="group-open:hidden">+</span>
          <span className="hidden group-open:inline">−</span>
        </span>
      </summary>

      <div className="border-t border-line p-3" data-testid="dash-coverage-matrix">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] border-collapse text-sm">
            <caption className="sr-only">知识点 × 认知层次覆盖矩阵</caption>
            <thead>
              <tr className="border-b border-line bg-bg text-left text-xs text-muted">
                <th scope="col" className="px-2 py-2 font-medium">
                  知识点
                </th>
                {BLOOM_LEVELS.map((bloom) => (
                  <th key={bloom} scope="col" className="px-2 py-2 text-center font-medium">
                    {bloomLabel(bloom)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.objectiveId}
                  className="border-b border-line last:border-0 transition-colors hover:bg-bg"
                >
                  <th scope="row" className="px-2 py-2 text-left font-medium text-ink">
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
                        className="inline-flex min-h-[32px] min-w-[32px] items-center justify-center rounded-sm text-accent underline decoration-dotted underline-offset-2 transition-colors hover:bg-bg"
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
      </div>
    </details>
  );
}

/** `YYYY-MM-DD HH:mm` → 日期与时间两行显示；解析失败时原样留在日期行。 */
function stampParts(iso: string): { readonly date: string; readonly time: string } {
  const stamp = formatDateTime(iso);
  const space = stamp.indexOf(" ");
  if (space < 0) return { date: stamp, time: "" };
  return { date: stamp.slice(0, space), time: stamp.slice(space + 1) };
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
