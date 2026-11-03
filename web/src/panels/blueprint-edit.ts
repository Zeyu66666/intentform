/**
 * 蓝图就地编辑的纯函数（发布前的结构承诺）。
 *
 * 三条不变量必须由编辑动作自己维持，而不是等确认时再报错：
 * 1. 章节题量之和 = `totalCount`；
 * 2. 题型分布之和 = `totalCount`；
 * 3. 问卷 `totalScore = 0`，判分卷才允许改总分。
 *
 * 因此任何改动都走 `rebalance`：改章节 → 题型按比例重分；改题型 → 章节按比例重分。
 * 比例分配用最大余数法，保证整数之和精确等于目标值。
 */

import {
  FIELD_TYPES,
  LIMITS,
  type FieldType,
  type FormBlueprint,
  type FormKind,
} from "@intentform/schema";

const NON_SECTION_TYPES = FIELD_TYPES.filter((type) => type !== "section");

function clampCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), LIMITS.fieldsMax));
}

/** 把 `total` 按 `weights` 比例分成整数，和精确等于 `total`。 */
function distribute(total: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return [];
  const sum = weights.reduce((acc, value) => acc + Math.max(0, value), 0);
  if (sum === 0) {
    const result = weights.map(() => 0);
    result[0] = total;
    return result;
  }
  const raw = weights.map((value) => (Math.max(0, value) / sum) * total);
  const floors = raw.map((value) => Math.floor(value));
  let remainder = total - floors.reduce((acc, value) => acc + value, 0);
  const order = raw
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const entry of order) {
    if (remainder <= 0) break;
    floors[entry.index] = (floors[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return floors;
}

function withSectionsAndMix(
  blueprint: FormBlueprint,
  sections: readonly { readonly title: string; readonly count: number }[],
  typeCounts: Readonly<Partial<Record<FieldType, number>>>,
): FormBlueprint {
  const sum = sections.reduce((acc, section) => acc + clampCount(section.count), 0);
  const totalCount = Math.max(1, sum);
  const adjusted = sections.map((section) => ({ ...section, count: clampCount(section.count) }));
  if (sum === 0 && adjusted[0] !== undefined) {
    adjusted[0] = { ...adjusted[0], count: 1 };
  }
  return {
    ...blueprint,
    sections: adjusted,
    totalCount,
    typeMix: typeCounts,
    totalScore: blueprint.kind === "survey" ? 0 : blueprint.totalScore,
  };
}

function sectionWeights(blueprint: FormBlueprint): number[] {
  return blueprint.sections.map((section) => section.count);
}

function mixWeights(blueprint: FormBlueprint): number[] {
  return NON_SECTION_TYPES.map((type) => blueprint.typeMix[type] ?? 0);
}

/** 改章节题量：总和变新的 `totalCount`，题型按原比例重分。 */
export function withSectionCount(blueprint: FormBlueprint, index: number, value: number): FormBlueprint {
  const sections = blueprint.sections.map((section, at) =>
    at === index ? { ...section, count: Math.max(0, clampCount(value)) } : section,
  );
  const total = Math.max(1, sections.reduce((sum, section) => sum + section.count, 0));
  const counts = distribute(total, mixWeights(blueprint));
  const typeMix = Object.fromEntries(
    NON_SECTION_TYPES.map((type, at) => [type, counts[at] ?? 0]),
  ) as Partial<Record<FieldType, number>>;
  return withSectionsAndMix(blueprint, sections, typeMix);
}

/** 改题型数量：题型和成为新的 `totalCount`，章节按原比例重分。 */
export function withTypeCount(blueprint: FormBlueprint, type: FieldType, value: number): FormBlueprint {
  if (type === "section") return blueprint;
  const next = { ...blueprint.typeMix, [type]: Math.max(0, clampCount(value)) };
  const total = Math.max(
    1,
    NON_SECTION_TYPES.reduce((sum, entry) => sum + (next[entry] ?? 0), 0),
  );
  const counts = distribute(total, sectionWeights(blueprint));
  const sections = blueprint.sections.map((section, at) => ({
    ...section,
    count: counts[at] ?? 0,
  }));
  // 若原章节数为 0（或全 0），把差额落到第一节，保证和仍等于 total。
  const adjusted = [...sections];
  const first = adjusted[0];
  if (first !== undefined) {
    const current = adjusted.reduce((sum, section) => sum + section.count, 0);
    adjusted[0] = { ...first, count: first.count + (total - current) };
  }
  return withSectionsAndMix(blueprint, adjusted, next);
}

export function withSectionTitle(blueprint: FormBlueprint, index: number, title: string): FormBlueprint {
  return {
    ...blueprint,
    sections: blueprint.sections.map((section, at) => (at === index ? { ...section, title } : section)),
  };
}

export function addSection(blueprint: FormBlueprint): FormBlueprint {
  return {
    ...blueprint,
    sections: [...blueprint.sections, { title: "新章节", count: 0 }],
  };
}

export function removeSection(blueprint: FormBlueprint, index: number): FormBlueprint {
  if (blueprint.sections.length <= 1) return blueprint;
  const removed = blueprint.sections[index]?.count ?? 0;
  const kept = blueprint.sections.filter((_, at) => at !== index);
  const first = kept[0];
  // 删掉一章不等于少出题：把这一章的题量并进第一章，保持
  // 「章节和 = totalCount」这条不变量，确认按钮不会因为一次删除突然变灰。
  if (first !== undefined && removed > 0) {
    kept[0] = { ...first, count: first.count + removed };
  }
  return { ...blueprint, sections: kept };
}

export function withTitle(blueprint: FormBlueprint, title: string): FormBlueprint {
  return { ...blueprint, title };
}

export function withTotalScore(blueprint: FormBlueprint, totalScore: number): FormBlueprint {
  if (blueprint.kind === "survey") return { ...blueprint, totalScore: 0 };
  return { ...blueprint, totalScore: Math.max(0, Math.min(LIMITS.scoreMax * LIMITS.fieldsMax, Math.floor(totalScore))) };
}

export function withKind(blueprint: FormBlueprint, kind: FormKind): FormBlueprint {
  return { ...blueprint, kind, totalScore: kind === "survey" ? 0 : blueprint.totalScore };
}

export function withKnowledgeName(blueprint: FormBlueprint, index: number, name: string): FormBlueprint {
  return {
    ...blueprint,
    knowledgePoints: blueprint.knowledgePoints.map((point, at) => (at === index ? { ...point, name } : point)),
  };
}

export function withKnowledgeId(blueprint: FormBlueprint, index: number, id: string): FormBlueprint {
  return {
    ...blueprint,
    knowledgePoints: blueprint.knowledgePoints.map((point, at) => (at === index ? { ...point, id } : point)),
  };
}

export function addKnowledgePoint(blueprint: FormBlueprint): FormBlueprint {
  const used = new Set(blueprint.knowledgePoints.map((point) => point.id));
  let index = blueprint.knowledgePoints.length + 1;
  let id = `kp_${String(index)}`;
  while (used.has(id)) {
    index += 1;
    id = `kp_${String(index)}`;
  }
  return { ...blueprint, knowledgePoints: [...blueprint.knowledgePoints, { id, name: "新知识点" }] };
}

export function removeKnowledgePoint(blueprint: FormBlueprint, index: number): FormBlueprint {
  return {
    ...blueprint,
    knowledgePoints: blueprint.knowledgePoints.filter((_, at) => at !== index),
  };
}
