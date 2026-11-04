/**
 * 蓝图就地编辑的三条不变量（`blueprint-edit.ts` 的注释是它们的来源）：
 * 章节和 = 题型和 = totalCount；问卷总分恒为 0；删除章节不丢题。
 *
 * 这些函数是纯的，测试直接喂结构、断言结构；界面只负责把结果画出来。
 */

import { describe, expect, it } from "vitest";

import { parseBlueprint, type FormBlueprint } from "@intentform/schema";

import {
  addKnowledgePoint,
  addQuota,
  addSection,
  quotaRemaining,
  removeKnowledgePoint,
  removeQuota,
  removeSection,
  withDifficultyCount,
  withKnowledgeId,
  withKnowledgeName,
  withQuotaCount,
  withQuotaKnowledgePoint,
  withQuotaType,
  withSectionCount,
  withSectionTitle,
  withTitle,
  withTotalScore,
  withTypeCount,
} from "./blueprint-edit";

const BASE: FormBlueprint = {
  title: "二次函数随堂测",
  kind: "quiz",
  sections: [
    { title: "基础", count: 3 },
    { title: "应用", count: 2 },
  ],
  totalCount: 5,
  typeMix: { single: 2, fill: 2, short: 1 },
  totalScore: 25,
  knowledgePoints: [{ id: "kp_vertex", name: "顶点坐标" }],
};

function sumSections(blueprint: FormBlueprint): number {
  return blueprint.sections.reduce((sum, section) => sum + section.count, 0);
}

function sumTypes(blueprint: FormBlueprint): number {
  return Object.values(blueprint.typeMix).reduce((sum, count) => sum + (count ?? 0), 0);
}

function sumDifficulty(blueprint: FormBlueprint): number {
  const mix = blueprint.difficultyMix;
  if (mix === undefined) return 0;
  return (["basic", "standard", "comprehensive", "advanced"] as const).reduce(
    (sum, level) => sum + (mix[level] ?? 0),
    0,
  );
}

function expectValid(blueprint: FormBlueprint): void {
  const parsed = parseBlueprint(blueprint);
  expect(parsed.ok).toBe(true);
  expect(sumSections(blueprint)).toBe(blueprint.totalCount);
  expect(sumTypes(blueprint)).toBe(blueprint.totalCount);
}

describe("withSectionCount", () => {
  it("改章节题量后题型按原比例重分，仍能通过蓝图校验", () => {
    const next = withSectionCount(BASE, 0, 5);
    expect(next.sections.map((section) => section.count)).toEqual([5, 2]);
    expect(next.totalCount).toBe(7);
    expectValid(next);
    // 原比例 2:2:1，7 题按最大余数法分配为 3:3:1（.8/.8/.4 的小数位排序）。
    expect(next.typeMix).toMatchObject({ single: 3, fill: 3, short: 1 });
  });

  it("所有章节清零时至少留 1 题，不会得到 0 题的蓝图", () => {
    const next = withSectionCount(
      { ...BASE, sections: [{ title: "唯一", count: 1 }], totalCount: 1, typeMix: { single: 1 } },
      0,
      0,
    );
    expect(next.totalCount).toBe(1);
    expect(next.sections[0]?.count).toBe(1);
    expect(next.typeMix.single).toBe(1);
    expectValid(next);
  });
});

describe("withTypeCount", () => {
  it("改题型数量后章节按原比例重分，和精确等于 totalCount", () => {
    const next = withTypeCount(BASE, "single", 4);
    expect(next.typeMix.single).toBe(4);
    expect(next.totalCount).toBe(7);
    expect(next.sections.map((section) => section.count)).toEqual([4, 3]);
    expectValid(next);
  });

  it("用最大余数法分配，余数不被丢掉（5 题分成 1:1:1 → 2:2:1）", () => {
    const next = withTypeCount(
      {
        ...BASE,
        sections: [
          { title: "A", count: 1 },
          { title: "B", count: 1 },
          { title: "C", count: 1 },
        ],
        totalCount: 3,
        typeMix: { single: 3 },
      },
      "single",
      5,
    );
    expect(next.sections.map((section) => section.count)).toEqual([2, 2, 1]);
    expectValid(next);
  });

  it("分节不是可计数题型：传 section 原样返回", () => {
    expect(withTypeCount(BASE, "section", 9)).toBe(BASE);
  });
});

describe("删除章节", () => {
  it("删除章节把题量并进第一章，不减少总题量", () => {
    const next = removeSection(BASE, 0);
    expect(next.sections).toEqual([{ title: "应用", count: 5 }]);
    expect(next.totalCount).toBe(5);
    expectValid(next);
  });

  it("只剩一个章节时拒绝删除", () => {
    const one: FormBlueprint = {
      ...BASE,
      sections: [{ title: "只有一章", count: 5 }],
    };
    expect(removeSection(one, 0)).toBe(one);
  });

  it("新增章节默认 0 题，结构仍然自洽", () => {
    const next = addSection(BASE);
    expect(next.sections).toHaveLength(3);
    expect(next.sections[2]?.count).toBe(0);
    expectValid(next);
  });
});

describe("标题、总分与题型", () => {
  it("改标题只动标题", () => {
    const next = withTitle(BASE, "新标题");
    expect(next.title).toBe("新标题");
    expect(next.sections).toBe(BASE.sections);
    expectValid(next);
  });

  it("改章节标题只动目标章节", () => {
    const next = withSectionTitle(BASE, 1, "综合应用");
    expect(next.sections.map((section) => section.title)).toEqual(["基础", "综合应用"]);
    expectValid(next);
  });

  it("问卷总分恒为 0，不论输入多少", () => {
    const survey: FormBlueprint = { ...BASE, kind: "survey", totalScore: 0 };
    expect(withTotalScore(survey, 50).totalScore).toBe(0);
    expect(withTotalScore(BASE, 40).totalScore).toBe(40);
  });
});

describe("知识点编辑", () => {
  it("改名字与 id 只影响目标知识点", () => {
    const named = withKnowledgeName(BASE, 0, "开口方向");
    expect(named.knowledgePoints[0]?.name).toBe("开口方向");
    expect(named.knowledgePoints[0]?.id).toBe("kp_vertex");
    const renamed = withKnowledgeId(named, 0, "kp_open");
    expect(renamed.knowledgePoints[0]).toEqual({ id: "kp_open", name: "开口方向" });
  });

  it("新增知识点避开已有 id，删除按位置生效", () => {
    const added = addKnowledgePoint(BASE);
    expect(added.knowledgePoints).toHaveLength(2);
    expect(added.knowledgePoints[1]?.id).not.toBe("kp_vertex");
    expect(added.knowledgePoints[1]?.id).toMatch(/^kp_\d+$/);

    const removed = removeKnowledgePoint(added, 0);
    expect(removed.knowledgePoints).toEqual([added.knowledgePoints[1]]);
  });
});

describe("知识点 × 题型配额", () => {
  it("加配额只占位，不增加题量", () => {
    const next = addQuota(BASE);
    expect(next.quotas).toEqual([{ knowledgePoint: "kp_vertex", type: "single", count: 1 }]);
    expect(sumTypes(next)).toBe(next.totalCount);
    expectValid(next);
  });

  it("没有知识点或没有题型余量时加配额原样返回", () => {
    const noPoints: FormBlueprint = { ...BASE, knowledgePoints: [] };
    expect(addQuota(noPoints)).toBe(noPoints);
    const full: FormBlueprint = {
      ...BASE,
      typeMix: { single: 1 },
      quotas: [{ knowledgePoint: "kp_vertex", type: "single", count: 1 }],
    };
    expect(addQuota(full)).toBe(full);
  });

  it("题量夹在 1..该题型剩余容量", () => {
    const one = addQuota(BASE);
    expect(quotaRemaining(one, "single")).toBe(1);
    expect(withQuotaCount(one, 0, 99).quotas?.[0]?.count).toBe(2);
    expect(withQuotaCount(one, 0, 0).quotas?.[0]?.count).toBe(1);
    expectValid(withQuotaCount(one, 0, 2));
  });

  it("换题型按新题型余量裁剪；没有余量的题型不换", () => {
    const one = addQuota(BASE);
    const changed = withQuotaType(one, 0, "short");
    expect(changed.quotas?.[0]).toEqual({ knowledgePoint: "kp_vertex", type: "short", count: 1 });
    expectValid(changed);

    const fullShort: FormBlueprint = {
      ...BASE,
      quotas: [{ knowledgePoint: "kp_vertex", type: "short", count: 1 }],
    };
    expect(withQuotaType(fullShort, 0, "short")).toBe(fullShort);
    expect(withQuotaType(fullShort, 0, "multi")).toBe(fullShort);
  });

  it("改知识点只动目标条目的引用", () => {
    const two: FormBlueprint = {
      ...BASE,
      knowledgePoints: [
        { id: "kp_vertex", name: "顶点坐标" },
        { id: "kp_open", name: "开口方向" },
      ],
      quotas: [
        { knowledgePoint: "kp_vertex", type: "single", count: 1 },
        { knowledgePoint: "kp_vertex", type: "short", count: 1 },
      ],
    };
    const changed = withQuotaKnowledgePoint(two, 1, "kp_open");
    expect(changed.quotas?.[1]?.knowledgePoint).toBe("kp_open");
    expect(changed.quotas?.[0]?.knowledgePoint).toBe("kp_vertex");
    expectValid(changed);
  });

  it("改知识点或题型时不制造重复组合", () => {
    const two: FormBlueprint = {
      ...BASE,
      knowledgePoints: [
        { id: "kp_vertex", name: "顶点坐标" },
        { id: "kp_open", name: "开口方向" },
      ],
      quotas: [
        { knowledgePoint: "kp_vertex", type: "single", count: 1 },
        { knowledgePoint: "kp_open", type: "single", count: 1 },
      ],
    };
    expect(withQuotaKnowledgePoint(two, 1, "kp_vertex")).toBe(two);
    expect(withQuotaType(two, 1, "single")).toBe(two);
  });

  it("删除配额按位置生效", () => {
    const two: FormBlueprint = { ...BASE, quotas: [
      { knowledgePoint: "kp_vertex", type: "single", count: 1 },
      { knowledgePoint: "kp_vertex", type: "short", count: 1 },
    ] };
    expect(removeQuota(two, 0).quotas).toEqual([{ knowledgePoint: "kp_vertex", type: "short", count: 1 }]);
  });

  it("题型总数调小会裁剪配额而不是把蓝图改成非法", () => {
    const one = addQuota(BASE);
    const shrunk = withTypeCount(one, "single", 0);
    expect((shrunk.quotas ?? []).every((quota) => quota.type !== "single")).toBe(true);
    expectValid(shrunk);
  });

  it("章节重分导致题型容量变小时同样裁剪", () => {
    const withTwo: FormBlueprint = {
      ...BASE,
      typeMix: { single: 5 },
      quotas: [{ knowledgePoint: "kp_vertex", type: "single", count: 2 }],
    };
    const next = withSectionCount(withTwo, 0, 1);
    expect((next.quotas ?? []).every((quota) => quota.count <= (next.typeMix.single ?? 0))).toBe(true);
    expectValid(next);
  });

  it("删除知识点连带删除它的配额；改 id 同步改写引用", () => {
    const one = addQuota(BASE);
    const removed = removeKnowledgePoint(one, 0);
    expect(removed.quotas).toEqual([]);
    expectValid(removed);

    const renamed = withKnowledgeId(one, 0, "kp_open");
    expect(renamed.quotas?.[0]?.knowledgePoint).toBe("kp_open");
    expectValid(renamed);
  });
});

describe("难度分布编辑", () => {
  const withDifficulty: FormBlueprint = {
    ...BASE,
    difficultyMix: { basic: 2, standard: 2, comprehensive: 1, advanced: 0 },
  };

  it("改难度题量后总题量跟着变，章节与题型按比例重分", () => {
    const next = withDifficultyCount(withDifficulty, "advanced", 3);
    expect(next.difficultyMix?.advanced).toBe(3);
    expect(next.totalCount).toBe(8);
    expect(sumDifficulty(next)).toBe(next.totalCount);
    expect(sumSections(next)).toBe(next.totalCount);
    expect(sumTypes(next)).toBe(next.totalCount);
    expectValid(next);
  });

  it("改章节题量时难度按原比例重分，不丢档", () => {
    const next = withSectionCount(withDifficulty, 0, 4);
    expect(next.totalCount).toBe(6);
    expect(sumDifficulty(next)).toBe(6);
    expectValid(next);
  });

  it("没有难度字段的旧蓝图不会被凭空补上", () => {
    const next = withTypeCount(BASE, "single", 3);
    expect(next.difficultyMix).toBeUndefined();
    expectValid(next);
  });
});
