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

import type { FormKind, FormStatus, FormSummary, SubmissionRow, SubmissionSummary } from "@intentform/schema";

import { formatScoreNumber } from "../format";
import { FILL_PATH_PREFIX } from "../router";

export const EMPTY_SUBMISSIONS_TEXT = "还没有人提交" as const;
/** 未知/无数据一律占位符，绝不填 0（§2.6 第 4 条：未知值不伪填）。 */
export const NO_AVERAGE_TEXT = "—" as const;
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

/** 一行的得分文本：`8 / 10`。满分与得分都来自服务端，前端不重算。 */
export function rowScoreText(row: SubmissionRow): string {
  return `${formatScoreNumber(row.score)} / ${formatScoreNumber(row.maxScore)}`;
}
