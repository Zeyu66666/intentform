/**
 * 看板的视图模型（纯函数，无 React）。
 *
 * 两个容易写错、所以必须落在这里并被测试钉住的地方：
 *   1. `avgScore: null` 是「还没有人提交」，不是「平均 0 分」。把它 `?? 0`
 *      会让教师以为全班都考了 0 分——这是看板上最严重的误读。
 *   2. 行序。服务端返回的顺序是契约的一部分吗？不是。看板要按时间**倒序**
 *      （最近提交在最上面），排序在本地做，并带一个确定性的次序键，保证
 *      同一秒的两条记录在多次渲染里顺序不变。
 */

import type {
  FormKind,
  FormStatus,
  FormSummary,
  ItemStat,
  SubmissionRow,
  SubmissionSummary,
} from "@intentform/schema";

import { formatScoreNumber } from "../format";
import { FILL_PATH_PREFIX } from "../router";

export const EMPTY_SUBMISSIONS_TEXT = "还没有人提交" as const;
/** 未知/无数据一律占位符，绝不填 0（§2.6 第 4 条：未知值不伪填）。 */
export const NO_AVERAGE_TEXT = "—" as const;
/** 正确率的「无数据」占位符。与平均分同一个值，但概念不同，各留一个名字。 */
export const NO_RATE_TEXT = "—" as const;
export const UNPUBLISHED_TEXT = "未发布" as const;

export const FORM_STATUS_LABELS: Readonly<Record<FormStatus, string>> = {
  draft: "草稿",
  published: "已发布",
};

export const FORM_KIND_LABELS: Readonly<Record<FormKind, string>> = {
  quiz: "判分测验",
  survey: "问卷",
};

export function statusLabel(status: FormStatus): string {
  return FORM_STATUS_LABELS[status];
}

export function kindLabel(kind: FormKind): string {
  return FORM_KIND_LABELS[kind];
}

/** 有没有发布过：`publishedVersionId` 缺省即从未发布（列表接口不返回 `null`，是不出现）。 */
export function isPublished(form: FormSummary): boolean {
  return form.publishedVersionId !== undefined;
}

/** 下拉框一行：`第一单元小测 · 已发布 · 判分测验`。 */
export function formOptionLabel(form: FormSummary): string {
  return `${form.title} · ${statusLabel(form.status)} · ${kindLabel(form.kind)}`;
}

/** 已发布表单才有学生链接；未发布返回 `null`，界面据此不给可点的链接。 */
export function sharePath(form: FormSummary): string | null {
  if (!isPublished(form) || form.slug === undefined) return null;
  return `${FILL_PATH_PREFIX}/${encodeURIComponent(form.slug)}`;
}

export interface DashboardStats {
  readonly count: number;
  /** 平均分的可显示文本；`null` 时是 `NO_AVERAGE_TEXT`。 */
  readonly averageText: string;
  /** 平均分是否未知（用于加"还没有人提交"的说明，而不是显示 0）。 */
  readonly averageIsUnknown: boolean;
  readonly maxScoreText: string;
  readonly versionLabel: string;
  readonly isEmpty: boolean;
}

export function statsOf(summary: SubmissionSummary): DashboardStats {
  return {
    count: summary.count,
    averageText:
      summary.avgScore === null ? NO_AVERAGE_TEXT : formatScoreNumber(summary.avgScore),
    averageIsUnknown: summary.avgScore === null,
    maxScoreText: formatScoreNumber(summary.maxScore),
    versionLabel: `v${String(summary.versionN)}`,
    isEmpty: summary.count === 0,
  };
}

/**
 * 选初始表单：URL 指定的优先（刷新/分享链接要稳定），否则按"已发布优先、
 * 再按列表原序"取第一份。返回 `null` 表示列表为空。
 */
export function pickInitialForm(
  forms: readonly FormSummary[],
  requestedFormId: string | null,
): FormSummary | null {
  if (requestedFormId !== null) {
    const matched = forms.find((form) => form.id === requestedFormId);
    if (matched !== undefined) return matched;
  }
  const published = forms.find((form) => isPublished(form));
  return published ?? forms[0] ?? null;
}

/** 时间倒序；同一时刻用 submissionId 兜底，保证渲染顺序稳定。 */
export function sortRowsNewestFirst(rows: readonly SubmissionRow[]): readonly SubmissionRow[] {
  return [...rows].sort((left, right) => {
    const delta = new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime();
    if (delta !== 0) return delta;
    return left.submissionId.localeCompare(right.submissionId);
  });
}

/**
 * 得分后面那句话：`（2 题待批改，共 10 分）`。批完了就是空串。
 *
 * 单独成函数而不是塞进 `rowScoreText`，是因为看板与批改面板都要显示它，
 * 两处各写一遍必然有一处忘了乘或忘了减。
 */
export function pendingText(row: SubmissionRow): string {
  if (row.pendingScore <= 0) return "";
  return `（另有 ${formatScoreNumber(row.pendingScore)} 分待批改）`;
}

/**
 * 一行的得分文本：`8 / 10`，简答没批完时追加待批改额度。
 *
 * 满分与得分都来自服务端（已把人工分并进去），前端**不重算**：
 * 重算意味着前端也要知道每题满分，那是第二份判分口径。
 */
export function rowScoreText(row: SubmissionRow): string {
  const base = `${formatScoreNumber(row.score)} / ${formatScoreNumber(row.maxScore)}`;
  const pending = pendingText(row);
  return pending === "" ? base : `${base}${pending}`;
}

/** 这条提交还需不需要教师动手。 */
export function needsGrading(row: SubmissionRow): boolean {
  return row.pendingScore > 0;
}

/* ------------------------------ 每题正确率（R-04） ------------------------------ */

/**
 * 正确率的可显示文本：`66.7%` / `100%`。
 *
 * `rate === null`（这个版本还没有提交）显示 `—`，**绝不显示 `0%`**：
 * `0%` 是「全班都答错了」，`—` 是「还没人答」。两者在教师眼里必须是不同的事。
 * 一位小数足够：看板要回答「这题难不难」，不是给学生发成绩单。
 */
export function correctRateText(stat: ItemStat): string {
  if (stat.rate === null) return NO_RATE_TEXT;
  // 先乘再取一位小数：0.6667 → 66.7，1 → 100（不拖 `.0`），0 → 0。
  const percent = Math.round(stat.rate * 1000) / 10;
  return `${String(percent)}%`;
}

/** CSS 条的宽度（0..100 的整数）。无数据时为 0，与 `—` 文案同时出现，不构成 0% 的视觉暗示。 */
export function rateBarWidth(stat: ItemStat): number {
  if (stat.rate === null) return 0;
  return Math.round(stat.rate * 100);
}

/* ------------------------------ 人工批改（R-02） ------------------------------ */

/**
 * 批改输入框的初值：已录过分的题显示原值，没录过的是空串。
 *
 * 空串而不是 `0`：`0` 是"批了、给 0 分"，空是"还没批"。这两件事在界面上长得像，
 * 在库里完全不同（一条 `manual_grades` 记录 vs 没有记录），初始值不能混。
 */
export function gradeInputValue(row: SubmissionRow, itemId: string): string {
  const recorded = row.manualScores[itemId];
  return recorded === undefined ? "" : String(recorded);
}

export type GradeInputResult =
  | { readonly ok: true; readonly score: number }
  | { readonly ok: false; readonly reason: string };

/**
 * 把输入框里的字符串变成要提交的分值。
 *
 * 只做三件事：非空、整数、0..满分。**不截断、不四舍五入**——静默改数字会让
 * 教师以为"我给了 3.7，系统记 4"，成绩单上出现没人给过的分。
 * 小数只可能是手滑，直接拒绝并要求重输。
 */
export function parseGradeInput(raw: string, maxScore: number): GradeInputResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "请填写分数（0 分也要填 0）" };
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: "只填整数，不要带小数点或正负号" };
  const score = Number(trimmed);
  if (score > maxScore) {
    return { ok: false, reason: `这道题满分 ${String(maxScore)} 分` };
  }
  return { ok: true, score };
}

/** 还有几道简答没批（按题目清单与已录分值算，不看 pendingScore，两者互为校验）。 */
export function ungradedCount(
  row: SubmissionRow,
  shortItems: readonly { readonly itemId: string; readonly score: number }[],
): number {
  return shortItems.filter((item) => row.manualScores[item.itemId] === undefined).length;
}
