/**
 * Zod 定义与类型导出（计划 v1.1 附录 A.1）。
 *
 * 单一事实源：结构只在 Zod 里写一遍，TS 类型一律从 `z.infer` 派生。
 * 手写 interface + 手写 Zod 的双份定义会漂移，这里刻意不这么做。
 *
 * 运行时只做**结构**校验；跨字段的**语义**规则（R1–R8）在 `rules.ts`，
 * 因为它们需要整体视角（id 全表唯一、分值合计、知识点引用）。
 */

import { z } from "zod";

import { BLOOM_LEVELS, FORM_KINDS, LIMITS, SCHEMA_VERSION } from "./constants";

/**
 * 深度只读：契约对象出库后不允许调用方改写。
 *
 * 已知取舍：元组（如 `scale.labels`）会被弱化成 `readonly string[]`，
 * 长度信息由 `z.tuple` 在运行时保证。类型层面少一个自由度，换取实现简单。
 */
export type DeepReadonly<T> = T extends string | number | boolean | null | undefined
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

/** 字段 id：Patch 以它寻址，所以比短标识更严（3–32 位）。 */
const fieldIdSchema = z
  .string()
  .regex(LIMITS.idPattern, "id 需匹配 ^[a-z0-9_-]{3,32}$（小写字母/数字/下划线/连字符）");

/** 选项 id 与知识点 id：短标识，允许 1 位。 */
const shortIdSchema = z
  .string()
  .regex(LIMITS.shortIdPattern, "id 需匹配 ^[a-z0-9_-]{1,32}$");

export const objectiveSchema = z.object({
  id: shortIdSchema,
  name: z.string().min(1).max(LIMITS.titleMax),
});

export const choiceOptionSchema = z.object({
  id: shortIdSchema,
  text: z.string().min(1).max(LIMITS.optionTextMax),
});

/** 所有字段共有的部分。`required` 默认 `true`：题默认必答，例外才显式关掉。 */
const baseFieldSchema = z.object({
  id: fieldIdSchema,
  title: z.string().min(1).max(LIMITS.titleMax),
  required: z.boolean().default(true),
});

/** 判分型字段：分值、布鲁姆层级、知识点，外加教师侧解析。 */
const scoredFieldSchema = baseFieldSchema.extend({
  score: z.number().int().min(0).max(LIMITS.scoreMax),
  bloom: z.enum(BLOOM_LEVELS),
  knowledgePoint: shortIdSchema,
  /** 教师侧解析，`publicView` 会剥掉。 */
  explanation: z.string().max(LIMITS.explanationMax).optional(),
});

export const singleFieldSchema = scoredFieldSchema.extend({
  type: z.literal("single"),
  options: z.array(choiceOptionSchema).min(LIMITS.optionsMin).max(LIMITS.optionsMax),
  answer: z.string().min(1),
});

export const multiFieldSchema = scoredFieldSchema.extend({
  type: z.literal("multi"),
  options: z.array(choiceOptionSchema).min(LIMITS.optionsMin).max(LIMITS.optionsMax),
  answer: z.array(z.string().min(1)).min(1),
});

export const fillFieldSchema = scoredFieldSchema.extend({
  type: z.literal("fill"),
  answer: z.array(z.string().min(1)).min(1),
});

export const numberFieldSchema = scoredFieldSchema.extend({
  type: z.literal("number"),
  answer: z.object({
    value: z.number().finite(),
    tolerance: z.number().min(0),
  }),
});

export const shortFieldSchema = baseFieldSchema.extend({
  type: z.literal("short"),
  maxLength: z
    .number()
    .int()
    .min(1)
    .max(LIMITS.shortMaxLengthCap)
    .default(LIMITS.shortDefaultMaxLength),
});

export const scaleFieldSchema = baseFieldSchema.extend({
  type: z.literal("scale"),
  min: z.number().int(),
  max: z.number().int(),
  labels: z.tuple([z.string().min(1), z.string().min(1)]).optional(),
});

/** 分节：结构节点，不带 `required` 与分值，因此不继承 `baseFieldSchema`。 */
export const sectionFieldSchema = z.object({
  type: z.literal("section"),
  id: fieldIdSchema,
  title: z.string().min(1).max(LIMITS.titleMax),
  description: z.string().max(LIMITS.explanationMax).optional(),
});

export const formItemSchema = z.discriminatedUnion("type", [
  singleFieldSchema,
  multiFieldSchema,
  fillFieldSchema,
  numberFieldSchema,
  shortFieldSchema,
  scaleFieldSchema,
  sectionFieldSchema,
]);

export const formMetaSchema = z.object({
  version: z.literal(SCHEMA_VERSION),
  kind: z.enum(FORM_KINDS),
  title: z.string().min(1).max(LIMITS.formTitleMax),
  objectives: z.array(objectiveSchema),
  /** 自动判分题分值之和。`quiz` 必须有（R6 校验一致性），`survey` 不带。 */
  totalScore: z.number().int().min(0).optional(),
});

/**
 * 顶层结构。`items` 上限 100 在这里挡住，避免超大表单进后续链路。
 *
 * `superRefine` 只放**两个字段之间的关系**（`scale` 的 `min < max`），
 * 因为它不属于附录 A.2 的任何一条语义规则，而是结构自洽性；
 * 放在这里可以让 `discriminatedUnion` 的成员保持纯 `ZodObject`。
 */
export const formSchema = z
  .object({
    meta: formMetaSchema,
    items: z.array(formItemSchema).max(LIMITS.fieldsMax),
  })
  .superRefine((value, ctx) => {
    value.items.forEach((item, index) => {
      if (item.type !== "scale") return;
      if (item.min >= item.max) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["items", index, "max"],
          message: `scale 的 max(${item.max}) 必须大于 min(${item.min})`,
        });
      }
    });
  });

export type Objective = DeepReadonly<z.infer<typeof objectiveSchema>>;
export type ChoiceOption = DeepReadonly<z.infer<typeof choiceOptionSchema>>;
export type SingleField = DeepReadonly<z.infer<typeof singleFieldSchema>>;
export type MultiField = DeepReadonly<z.infer<typeof multiFieldSchema>>;
export type FillField = DeepReadonly<z.infer<typeof fillFieldSchema>>;
export type NumberField = DeepReadonly<z.infer<typeof numberFieldSchema>>;
export type ShortField = DeepReadonly<z.infer<typeof shortFieldSchema>>;
export type ScaleField = DeepReadonly<z.infer<typeof scaleFieldSchema>>;
export type SectionField = DeepReadonly<z.infer<typeof sectionFieldSchema>>;

export type ScoredField = SingleField | MultiField | FillField | NumberField;
export type CollectField = ShortField | ScaleField;
export type ChoiceField = SingleField | MultiField;
export type FormItem = DeepReadonly<z.infer<typeof formItemSchema>>;
export type FormMeta = DeepReadonly<z.infer<typeof formMetaSchema>>;
export type FormSchema = DeepReadonly<z.infer<typeof formSchema>>;
