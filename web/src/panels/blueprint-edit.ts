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
  DIFFICULTY_LEVELS,
  FIELD_TYPES,
  LIMITS,
  QUOTA_TYPES,
  type BlueprintQuota,
  type DifficultyLevel,
  type FieldType,
  type FormBlueprint,
  type FormKind,
  type QuotaType,
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

/**
 * 把配额裁到新题型容量的范围里：按原顺序保留，超出的条目先减题量再丢弃。
 * 题型总数被调小时，蓝图必须仍然合法，而不是把确认按钮变灰。
 */
function fitQuotas(
  quotas: readonly BlueprintQuota[],
  typeMix: Readonly<Partial<Record<FieldType, number>>>,
): BlueprintQuota[] {
  const used = new Map<QuotaType, number>();
  const fitted: BlueprintQuota[] = [];
  for (const quota of quotas) {
    const capacity = typeMix[quota.type] ?? 0;
    const already = used.get(quota.type) ?? 0;
    const count = Math.min(quota.count, Math.max(0, capacity - already));
    if (count <= 0) continue;
    fitted.push({ ...quota, count });
    used.set(quota.type, already + count);
  }
  return fitted;
}

/** 难度四档按原比例重分到新的总题量；原分布全 0 时整卷落到第一档。 */
function redistributeDifficulty(
  mix: Readonly<Partial<Record<DifficultyLevel, number>>>,
  totalCount: number,
): Readonly<Partial<Record<DifficultyLevel, number>>> {
  const counts = distribute(totalCount, DIFFICULTY_LEVELS.map((level) => mix[level] ?? 0));
  return Object.fromEntries(
    DIFFICULTY_LEVELS.map((level, index) => [level, counts[index] ?? 0]),
  ) as Partial<Record<DifficultyLevel, number>>;
}

function withSectionsAndMix(
  blueprint: FormBlueprint,
  sections: readonly { readonly title: string; readonly count: number }[],
  typeCounts: Readonly<Partial<Record<FieldType, number>>>,
  difficultyCounts?: Readonly<Partial<Record<DifficultyLevel, number>>>,
): FormBlueprint {
  const sum = sections.reduce((acc, section) => acc + clampCount(section.count), 0);
  const totalCount = Math.max(1, sum);
  const adjusted = sections.map((section) => ({ ...section, count: clampCount(section.count) }));
  if (sum === 0 && adjusted[0] !== undefined) {
    adjusted[0] = { ...adjusted[0], count: 1 };
  }
  const difficulty =
    difficultyCounts !== undefined
      ? difficultyCounts
      : blueprint.difficultyMix === undefined
        ? undefined
        : redistributeDifficulty(blueprint.difficultyMix, totalCount);
  return {
    ...blueprint,
    sections: adjusted,
    totalCount,
    typeMix: typeCounts,
    totalScore: blueprint.kind === "survey" ? 0 : blueprint.totalScore,
    ...(blueprint.quotas === undefined
      ? {}
      : { quotas: fitQuotas(blueprint.quotas, typeCounts) }),
    ...(difficulty === undefined ? {} : { difficultyMix: difficulty }),
  };
}

function sectionWeights(blueprint: FormBlueprint): number[] {
  return blueprint.sections.map((section) => section.count);
}

function mixWeights(blueprint: FormBlueprint): number[] {
  return NON_SECTION_TYPES.map((type) => blueprint.typeMix[type] ?? 0);
}

/** 改难度题量：总题量跟着变，章节与题型按原比例重分。 */
export function withDifficultyCount(
  blueprint: FormBlueprint,
  level: DifficultyLevel,
  value: number,
): FormBlueprint {
  if (!DIFFICULTY_LEVELS.includes(level) || blueprint.difficultyMix === undefined) return blueprint;
  const next = { ...blueprint.difficultyMix, [level]: Math.max(0, clampCount(value)) } as Partial<
    Record<DifficultyLevel, number>
  >;
  const total = Math.max(1, DIFFICULTY_LEVELS.reduce((sum, entry) => sum + (next[entry] ?? 0), 0));
  const sectionCounts = distribute(total, sectionWeights(blueprint));
  const sections = blueprint.sections.map((section, index) => ({
    ...section,
    count: sectionCounts[index] ?? 0,
  }));
  const typeCounts = distribute(total, mixWeights(blueprint));
  const typeMix = Object.fromEntries(
    NON_SECTION_TYPES.map((type, index) => [type, typeCounts[index] ?? 0]),
  ) as Partial<Record<FieldType, number>>;
  return withSectionsAndMix(blueprint, sections, typeMix, next);
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
  const previous = blueprint.knowledgePoints[index]?.id;
  const knowledgePoints = blueprint.knowledgePoints.map((point, at) =>
    at === index ? { ...point, id } : point,
  );
  if (previous === undefined || previous === id || blueprint.quotas === undefined) {
    return { ...blueprint, knowledgePoints };
  }
  return {
    ...blueprint,
    knowledgePoints,
    quotas: blueprint.quotas.map((quota) =>
      quota.knowledgePoint === previous ? { ...quota, knowledgePoint: id } : quota,
    ),
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
  const removed = blueprint.knowledgePoints[index];
  const knowledgePoints = blueprint.knowledgePoints.filter((_, at) => at !== index);
  if (removed === undefined || blueprint.quotas === undefined) {
    return { ...blueprint, knowledgePoints };
  }
  return {
    ...blueprint,
    knowledgePoints,
    quotas: blueprint.quotas.filter((quota) => quota.knowledgePoint !== removed.id),
  };
}

/** 这个「知识点 + 题型」组合是否还没被别的条目占用。 */
export function quotaPairFree(
  blueprint: FormBlueprint,
  knowledgePoint: string,
  type: FieldType,
  exceptIndex = -1,
): boolean {
  return !(blueprint.quotas ?? []).some(
    (quota, index) =>
      index !== exceptIndex && quota.knowledgePoint === knowledgePoint && quota.type === type,
  );
}

/** 某题型还能再指定几道；`exceptIndex` 用于编辑单条配额时排除它自己。 */
export function quotaRemaining(
  blueprint: FormBlueprint,
  type: FieldType,
  exceptIndex = -1,
): number {
  if (type === "section" || type === "scale") return 0;
  const used = (blueprint.quotas ?? []).reduce(
    (sum, quota, index) =>
      index !== exceptIndex && quota.type === type ? sum + quota.count : sum,
    0,
  );
  return Math.max(0, (blueprint.typeMix[type] ?? 0) - used);
}

/** 加一条指定：优先第一个知识点、第一个还有余量且未被占用的题型，初始 1 道。 */
export function addQuota(blueprint: FormBlueprint): FormBlueprint {
  for (const point of blueprint.knowledgePoints) {
    for (const type of QUOTA_TYPES) {
      if (quotaRemaining(blueprint, type) === 0) continue;
      if (!quotaPairFree(blueprint, point.id, type)) continue;
      return {
        ...blueprint,
        quotas: [...(blueprint.quotas ?? []), { knowledgePoint: point.id, type, count: 1 }],
      };
    }
  }
  return blueprint;
}

export function removeQuota(blueprint: FormBlueprint, index: number): FormBlueprint {
  if (blueprint.quotas === undefined) return blueprint;
  return { ...blueprint, quotas: blueprint.quotas.filter((_, at) => at !== index) };
}

export function withQuotaKnowledgePoint(
  blueprint: FormBlueprint,
  index: number,
  knowledgePoint: string,
): FormBlueprint {
  const quota = blueprint.quotas?.[index];
  if (
    quota === undefined ||
    blueprint.knowledgePoints.every((point) => point.id !== knowledgePoint) ||
    !quotaPairFree(blueprint, knowledgePoint, quota.type, index)
  ) {
    return blueprint;
  }
  return {
    ...blueprint,
    quotas: (blueprint.quotas ?? []).map((entry, at) =>
      at === index ? { ...entry, knowledgePoint } : entry,
    ),
  };
}

export function withQuotaType(
  blueprint: FormBlueprint,
  index: number,
  type: FieldType,
): FormBlueprint {
  const quota = blueprint.quotas?.[index];
  if (quota === undefined || type === "section" || type === "scale" || type === quota.type) {
    return blueprint;
  }
  if (!quotaPairFree(blueprint, quota.knowledgePoint, type, index)) return blueprint;
  const remaining = quotaRemaining(blueprint, type, index);
  if (remaining === 0) return blueprint;
  const count = Math.min(quota.count, remaining);
  return {
    ...blueprint,
    quotas: (blueprint.quotas ?? []).map((entry, at) =>
      at === index ? { ...entry, type, count } : entry,
    ),
  };
}

export function withQuotaCount(
  blueprint: FormBlueprint,
  index: number,
  value: number,
): FormBlueprint {
  const quota = blueprint.quotas?.[index];
  if (quota === undefined) return blueprint;
  const remaining = quotaRemaining(blueprint, quota.type, index);
  if (remaining === 0) return blueprint;
  const count = Math.min(remaining, Math.max(1, clampCount(value)));
  return {
    ...blueprint,
    quotas: (blueprint.quotas ?? []).map((entry, at) =>
      at === index ? { ...entry, count } : entry,
    ),
  };
}
