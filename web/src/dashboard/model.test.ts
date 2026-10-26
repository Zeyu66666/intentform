import { describe, expect, it } from "vitest";

import type { FormSummary, SubmissionRow, SubmissionSummary } from "@intentform/schema";

import {
  EMPTY_SUBMISSIONS_TEXT,
  NO_AVERAGE_TEXT,
  UNPUBLISHED_TEXT,
  formOptionLabel,
  isPublished,
  kindLabel,
  pickInitialForm,
  rowScoreText,
  sharePath,
  sortRowsNewestFirst,
  statsOf,
  statusLabel,
} from "./model";

function form(partial: Partial<FormSummary> & Pick<FormSummary, "id">): FormSummary {
  return {
    title: "第一单元小测",
    kind: "quiz",
    status: "draft",
    draftVersionId: "ver-1",
    updatedAt: "2024-05-01T08:00:00.000Z",
    ...partial,
  };
}

function summary(partial: Partial<SubmissionSummary>): SubmissionSummary {
  return { versionId: "ver-2", versionN: 2, count: 0, avgScore: null, maxScore: 20, ...partial };
}

describe("statsOf", () => {
  it("avgScore: null 显示占位符，绝不显示 0（没人交 ≠ 全员 0 分）", () => {
    const stats = statsOf(summary({ count: 0, avgScore: null }));
    expect(stats.averageText).toBe(NO_AVERAGE_TEXT);
    expect(stats.averageIsUnknown).toBe(true);
    expect(stats.isEmpty).toBe(true);
    expect(stats.count).toBe(0);
    // 属性里没有 "0" 这种伪值可被误用：averageText 就是占位符本身。
    expect(stats.averageText).not.toBe("0");
  });

  it("有提交时给平均分（保留一位）与满分、版本号", () => {
    const stats = statsOf(summary({ count: 3, avgScore: 13.5, maxScore: 20 }));
    expect(stats.averageText).toBe("13.5");
    expect(stats.averageIsUnknown).toBe(false);
    expect(stats.isEmpty).toBe(false);
    expect(stats.maxScoreText).toBe("20");
    expect(stats.versionLabel).toBe("v2");
  });

  it("平均 0 分是真实数据，必须显示 0", () => {
    const stats = statsOf(summary({ count: 2, avgScore: 0 }));
    expect(stats.averageText).toBe("0");
    expect(stats.averageIsUnknown).toBe(false);
  });

  it("空数据提示语存在且唯一（界面只引用这个常量）", () => {
    expect(EMPTY_SUBMISSIONS_TEXT).toBe("还没有人提交");
  });
});

describe("表单元信息", () => {
  it("未发布 = 没有 publishedVersionId；未发布不给学生链接", () => {
    const draft = form({ id: "f1", status: "draft" });
    expect(isPublished(draft)).toBe(false);
    expect(sharePath(draft)).toBeNull();
  });

  it("已发布且有 slug 才拼得出 /f/:slug", () => {
    const published = form({ id: "f2", status: "published", publishedVersionId: "ver-2", slug: "abc123" });
    expect(isPublished(published)).toBe(true);
    expect(sharePath(published)).toBe("/f/abc123");
  });

  it("状态/种类/下拉标签都用中文，未发布标记存在", () => {
    expect(statusLabel("draft")).toBe("草稿");
    expect(statusLabel("published")).toBe("已发布");
    expect(kindLabel("quiz")).toBe("判分测验");
    expect(kindLabel("survey")).toBe("问卷");
    expect(UNPUBLISHED_TEXT).toBe("未发布");
    expect(formOptionLabel(form({ id: "f3", status: "published", publishedVersionId: "v1" }))).toBe(
      "第一单元小测 · 已发布 · 判分测验",
    );
  });
});

describe("pickInitialForm", () => {
  const draft = form({ id: "draft-1" });
  const published = form({ id: "pub-1", status: "published", publishedVersionId: "ver-2", slug: "s1" });

  it("URL 指定的表单优先（刷新后仍看同一份）", () => {
    expect(pickInitialForm([published, draft], "draft-1")?.id).toBe("draft-1");
  });

  it("指定的 id 不存在时回落：已发布优先，其次列表第一份", () => {
    expect(pickInitialForm([draft, published], "nope")?.id).toBe("pub-1");
    expect(pickInitialForm([draft], null)?.id).toBe("draft-1");
  });

  it("空列表返回 null（界面显示去生成页的引导）", () => {
    expect(pickInitialForm([], null)).toBeNull();
  });
});

describe("sortRowsNewestFirst", () => {
  const rows: readonly SubmissionRow[] = [
    { submissionId: "s-old", createdAt: "2024-05-01T08:00:00.000Z", score: 5, maxScore: 20 },
    { submissionId: "s-new", createdAt: "2024-05-02T08:00:00.000Z", score: 12, maxScore: 20 },
    { submissionId: "s-mid", createdAt: "2024-05-01T09:00:00.000Z", score: 8, maxScore: 20 },
  ];

  it("时间倒序：最近提交在最上面", () => {
    expect(sortRowsNewestFirst(rows).map((row) => row.submissionId)).toEqual(["s-new", "s-mid", "s-old"]);
  });

  it("同一时刻用 submissionId 兜底，顺序稳定且不改入参", () => {
    const same: readonly SubmissionRow[] = [
      { submissionId: "b", createdAt: "2024-05-01T08:00:00.000Z", score: 1, maxScore: 2 },
      { submissionId: "a", createdAt: "2024-05-01T08:00:00.000Z", score: 1, maxScore: 2 },
    ];
    expect(sortRowsNewestFirst(same).map((row) => row.submissionId)).toEqual(["a", "b"]);
    expect(same.map((row) => row.submissionId)).toEqual(["b", "a"]);
  });

  it("空列表安全", () => {
    expect(sortRowsNewestFirst([])).toEqual([]);
  });
});

describe("rowScoreText", () => {
  it("得分 / 满分，都用服务端给的值", () => {
    expect(rowScoreText({ submissionId: "s1", createdAt: "", score: 8, maxScore: 10 })).toBe("8 / 10");
    expect(rowScoreText({ submissionId: "s2", createdAt: "", score: 2.5, maxScore: 10 })).toBe("2.5 / 10");
  });
});
