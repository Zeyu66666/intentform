/**
 * 从实际生成的表单 Schema 计算知识点 × 布鲁姆覆盖矩阵。
 *
 * 矩阵的行来自 `meta.objectives`，列固定为六个布鲁姆层级；因此即使某个
 * 知识点或层级没有题，也会保留一个值为 0 的单元格，避免把「未覆盖」误读成
 * 「没有统计」。
 */

import { BLOOM_LEVELS, type BloomLevel } from "./constants.ts";
import type { FormSchema } from "./types.ts";

export interface CoverageMatrixRow {
  readonly objectiveId: string;
  readonly objectiveName: string;
  readonly counts: Readonly<Record<BloomLevel, number>>;
}

export interface CoverageMatrix {
  readonly blooms: readonly BloomLevel[];
  readonly rows: readonly CoverageMatrixRow[];
}

function emptyCounts(): Record<BloomLevel, number> {
  return {
    remember: 0,
    understand: 0,
    apply: 0,
    analyze: 0,
    evaluate: 0,
    create: 0,
  };
}

/** 只读取字段上的标注，不根据需求或蓝图补造任何题目。 */
export function coverageMatrixOf(schema: FormSchema): CoverageMatrix {
  const rows = schema.meta.objectives.map((objective) => ({
    objectiveId: objective.id,
    objectiveName: objective.name,
    counts: emptyCounts(),
  }));
  const byObjective = new Map(rows.map((row) => [row.objectiveId, row]));

  for (const item of schema.items) {
    if (!("knowledgePoint" in item) || !("bloom" in item)) continue;
    const knowledgePoint = item.knowledgePoint;
    const bloom = item.bloom;
    if (knowledgePoint === undefined || bloom === undefined) continue;
    const row = byObjective.get(knowledgePoint);
    if (row === undefined) continue;
    row.counts[bloom] += 1;
  }

  return { blooms: BLOOM_LEVELS, rows };
}
