/**
 * 两阶段蓝图（省赛 R-06）。
 *
 * 蓝图 = 模型先给出的**结构化承诺**：几章、每章几题、题型怎么分布、总分多少、
 * 覆盖哪些知识点。它先于字段产出，教师确认后才开始生成——这是「意图控制」的
 * 第二层（计划 §2.4），也是「需求 / 蓝图 / 成品」三份可核验材料里的中间那份。
 *
 * 三条硬规则：
 * 1. **自洽**：章节题量之和 = 总题量 = 题型分布之和。对不上账的蓝图不是蓝图，
 *    是又一段散文，必须拒收（重试一次后仍不合法就明确报错）。
 * 2. **问卷没有分**：`kind === "survey"` 时 `totalScore` 必须是 0，
 *    与附录 A「问卷无分值语义」同一条口径。
 * 3. **分节不算题量**：蓝图里的 `totalCount` 是**题目数**（不含 section），
 *    否则「8 题」会被一道分节多算一次，偏差就从这里开始失真。
 */

import { z } from "zod";

import { FIELD_TYPES, FORM_KINDS, LIMITS, type FieldType, type FormKind } from "./constants.ts";
import type { FormItem } from "./types.ts";

export interface BlueprintSection {
  readonly title: string;
  readonly count: number;
}

export interface BlueprintKnowledgePoint {
  /** 知识点 id，与题目里的 `knowledgePoint` 同值（`^[a-z0-9_-]{3,32}$`）。 */
  readonly id: string;
  /** 人话名字，界面与 `meta.objectives` 用。 */
  readonly name: string;
}

export interface FormBlueprint {
  readonly title: string;
  readonly kind: FormKind;
  readonly sections: readonly BlueprintSection[];
  /** 题目数（**不含** section）。 */
  readonly totalCount: number;
  /** 题型分布；和必须等于 `totalCount`。 */
  readonly typeMix: Readonly<Partial<Record<FieldType, number>>>;
  /** 总分；问卷恒为 0。 */
  readonly totalScore: number;
  /**
   * 知识点：**id + 名字**。id 是关键——题目里的 `knowledgePoint` 用的就是它，
   * 不共用一套 id 就没法判断"蓝图承诺的知识点，成品真的覆盖了吗"。
   */
  readonly knowledgePoints: readonly BlueprintKnowledgePoint[];
}

/** 题型的中文说法：摘要与界面共用一份。 */
export const FIELD_TYPE_LABELS: Readonly<Record<FieldType, string>> = {
  single: "单选",
  multi: "多选",
  fill: "填空",
  number: "数值",
  short: "简答",
  scale: "量表",
  section: "分节",
};

const nonSectionTypes = FIELD_TYPES.filter((type) => type !== "section");

/**
 * 题型分布：显式列出六种非分节题型、缺省补 0、**严格模式**。
 * 缺省补 0 而不是留空：`exactOptionalPropertyTypes` 下「可选且可能 undefined」
 * 与「可选」不是一个类型，补 0 让契约两侧一致，也让求和天然成立。
 * 模型多写一个不存在的题型（"essay"）时必须报错，而不是静默丢掉再把差额
 * 算成"少出题"——那是把模型的错记成产品的偏差。
 */
const typeMixSchema = z
  .object({
    single: z.number().int().min(0).max(LIMITS.fieldsMax).default(0),
    multi: z.number().int().min(0).max(LIMITS.fieldsMax).default(0),
    fill: z.number().int().min(0).max(LIMITS.fieldsMax).default(0),
    number: z.number().int().min(0).max(LIMITS.fieldsMax).default(0),
    short: z.number().int().min(0).max(LIMITS.fieldsMax).default(0),
    scale: z.number().int().min(0).max(LIMITS.fieldsMax).default(0),
  })
  .strict();

/**
 * 契约本体。跨字段自洽性用 `superRefine` 表达——它不是"额外的业务校验"，
 * 而是蓝图这个概念的定义：对不上账的蓝图根本不算蓝图。
 */
export const blueprintSchema = z
  .object({
    title: z.string().trim().min(1, "蓝图标题不能为空").max(LIMITS.formTitleMax),
    kind: z.enum(FORM_KINDS),
    sections: z
      .array(
        z.object({
          title: z.string().trim().min(1, "章节标题不能为空").max(LIMITS.titleMax),
          count: z.number().int().min(0).max(LIMITS.fieldsMax),
        }),
      )
      .min(1, "至少要有一个章节")
      .max(20, "章节最多 20 个"),
    totalCount: z.number().int().min(1, "至少出 1 题").max(LIMITS.fieldsMax),
    typeMix: typeMixSchema,
    totalScore: z.number().int().min(0).max(LIMITS.scoreMax * LIMITS.fieldsMax),
    knowledgePoints: z
      .array(
        z.object({
          id: z.string().regex(LIMITS.idPattern, "知识点 id 需匹配 ^[a-z0-9_-]{3,32}$"),
          name: z.string().trim().min(1, "知识点名字不能为空").max(64),
        }),
      )
      .max(20),
  })
  .superRefine((blueprint, ctx) => {
    const sectionSum = blueprint.sections.reduce((sum, section) => sum + section.count, 0);
    if (sectionSum !== blueprint.totalCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sections"],
        message: `章节题量之和 ${String(sectionSum)} ≠ 总题量 ${String(blueprint.totalCount)}`,
      });
    }
    let typeSum = 0;
    for (const count of Object.values(blueprint.typeMix)) typeSum += count ?? 0;
    if (typeSum !== blueprint.totalCount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["typeMix"],
        message: `题型分布之和 ${String(typeSum)} ≠ 总题量 ${String(blueprint.totalCount)}`,
      });
    }
    if (blueprint.kind === "survey" && blueprint.totalScore !== 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["totalScore"],
        message: "问卷没有分值语义，totalScore 必须是 0",
      });
    }
  });

export type BlueprintParseResult =
  | { readonly ok: true; readonly blueprint: FormBlueprint }
  | { readonly ok: false; readonly message: string };

/** 从任意 JSON 值解析蓝图；失败给一句人话（含首条原因），不抛异常。 */
export function parseBlueprint(value: unknown): BlueprintParseResult {
  const parsed = blueprintSchema.safeParse(value);
  if (parsed.success) return { ok: true, blueprint: parsed.data };
  const first = parsed.error.issues[0];
  return { ok: false, message: first === undefined ? "蓝图不合法" : first.message };
}

/** 蓝图的一句话摘要：`8 题 / 单选 4 · 填空 2 · 简答 2 / 共 40 分 / 2 个知识点`。 */
export function summarizeBlueprint(blueprint: FormBlueprint): string {
  const mix = nonSectionTypes
    .filter((type) => (blueprint.typeMix[type] ?? 0) > 0)
    .map((type) => `${FIELD_TYPE_LABELS[type]} ${String(blueprint.typeMix[type] ?? 0)}`)
    .join(" · ");
  const score = blueprint.kind === "survey" ? "" : ` / 共 ${String(blueprint.totalScore)} 分`;
  const names = blueprint.knowledgePoints.map((point) => point.name).join("、");
  const points = blueprint.knowledgePoints.length === 0 ? "未指定知识点" : `知识点 ${names}`;
  return `${String(blueprint.totalCount)} 题 / ${mix}${score} / ${points}`;
}

export interface BlueprintDeviation {
  /** 实际题量 − 蓝图题量（分节不算）。负数是少出了题。 */
  readonly countDelta: number;
  /** 实际总分 − 蓝图总分。 */
  readonly scoreDelta: number;
  /** 每种题型的「实际 − 蓝图」；只列有差值的题型。 */
  readonly typeMixDelta: Readonly<Record<string, number>>;
  /** 蓝图承诺了、成品里没有任何题覆盖的知识点。 */
  readonly missingKnowledgePoints: readonly string[];
  /** 成品里出现、蓝图没提的知识点。 */
  readonly extraKnowledgePoints: readonly string[];
  /** 四项全对（题量、总分、题型、知识点）——「结构完全匹配」的唯一来源。 */
  readonly isExact: boolean;
}

/**
 * 比较蓝图与成品时只依赖这三样东西，不要求一个校验通过的 `FormSchema`：
 * 偏差恰恰要在"成品不合格"时也算得出来，塞一个 `formSchema.parse` 进去会把
 * 最需要度量的那一类情况变成异常。
 */
export interface BlueprintSubject {
  readonly items: readonly FormItem[];
  readonly totalScore: number;
  readonly objectives: readonly { readonly id: string; readonly name: string }[];
}

/**
 * 比较蓝图与成品。纯函数：服务端的 `thinking` 摘要与 eval 报告都用它，
 * 两处口径不可能漂移。
 */
export function compareWithBlueprint(
  blueprint: FormBlueprint,
  form: BlueprintSubject,
): BlueprintDeviation {
  const items = form.items.filter((item) => item.type !== "section");

  const actualMix = new Map<FieldType, number>();
  for (const item of items) {
    actualMix.set(item.type, (actualMix.get(item.type) ?? 0) + 1);
  }
  const typeMixDelta: Record<string, number> = {};
  for (const type of nonSectionTypes) {
    const delta = (actualMix.get(type) ?? 0) - (blueprint.typeMix[type] ?? 0);
    if (delta !== 0) typeMixDelta[type] = delta;
  }

  // 两边都按 **id** 比：蓝图的知识点自带 id，题目里的 `knowledgePoint` 用的也是它。
  // 名字只给人看，不参与对账（"顶点坐标" 与 "顶点" 是同一个考点，比名字必错）。
  const actualPoints = new Set<string>();
  for (const item of items) {
    const id = knowledgePointOf(item);
    if (id !== undefined) actualPoints.add(id);
  }
  const plannedPoints = new Set(blueprint.knowledgePoints.map((point) => point.id));
  const missingKnowledgePoints = [...plannedPoints].filter((point) => !actualPoints.has(point));
  const extraKnowledgePoints = [...actualPoints].filter((point) => !plannedPoints.has(point));

  const countDelta = items.length - blueprint.totalCount;
  const scoreDelta = form.totalScore - blueprint.totalScore;
  const isExact =
    countDelta === 0 &&
    scoreDelta === 0 &&
    Object.keys(typeMixDelta).length === 0 &&
    missingKnowledgePoints.length === 0 &&
    extraKnowledgePoints.length === 0;

  return {
    countDelta,
    scoreDelta,
    typeMixDelta,
    missingKnowledgePoints,
    extraKnowledgePoints,
    isExact,
  };
}

/** `knowledgePoint` 只有部分题型有；用窄属性读，避免为它写一套类型守卫。 */
function knowledgePointOf(item: FormItem): string | undefined {
  return "knowledgePoint" in item ? item.knowledgePoint : undefined;
}
