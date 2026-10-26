/**
 * @intentform/schema — 前后端共享的类型契约层。
 *
 * I0 只固化「稳定公开面」：字段种类枚举、布鲁姆层级、FormSchema 顶层形状。
 * I1 在此基础上补齐 discriminated union 的字段属性、Zod 运行时校验与 R1-R8 语义规则。
 * 这里刻意不引入任何运行时依赖，保证底座阶段 `pnpm typecheck` 零外部库即可通过。
 */

/** FormSchema DSL 的版本号，随不兼容变更递增。 */
export const SCHEMA_VERSION = "1" as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

/** 七种字段类型。多一种都不加：覆盖面已足够，增加只会抬高校验与渲染成本。 */
export const FIELD_KINDS = [
  "single",
  "multiple",
  "blank",
  "short_answer",
  "number",
  "scale",
  "section",
] as const;

export type FieldKind = (typeof FIELD_KINDS)[number];

/** 布鲁姆认知层级，用于「大纲对齐」与覆盖矩阵。 */
export const BLOOM_LEVELS = [
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
] as const;

export type BloomLevel = (typeof BLOOM_LEVELS)[number];

/** 知识点（对应课程大纲的一个条目）。 */
export interface Objective {
  /** 稳定 id，形如 `obj-<slug>`，全表单内唯一。 */
  readonly id: string;
  /** 面向教师展示的知识点名，例如「二叉树的遍历」。 */
  readonly label: string;
}

/** 所有字段共享的属性。 */
export interface FieldBase {
  /** 稳定 id，流式增量渲染与 Patch 寻址都依赖它，全表单内唯一。 */
  readonly id: string;
  readonly kind: FieldKind;
  /** 题干（纯文本，不渲染 HTML；数学公式用 $...$ 包裹）。 */
  readonly label: string;
  readonly required: boolean;
  /** 分值，非负；section 恒为 0。 */
  readonly score: number;
  readonly bloom: BloomLevel;
  /** 指向 FormMeta.objectives[].id。 */
  readonly objectiveId: string;
}

export interface SectionField extends FieldBase {
  readonly kind: "section";
  readonly description: string;
}

export interface ChoiceOption {
  readonly id: string;
  readonly label: string;
}

export interface SingleField extends FieldBase {
  readonly kind: "single";
  readonly options: readonly ChoiceOption[];
  /** 正确选项 id。 */
  readonly answer: string;
}

export interface MultipleField extends FieldBase {
  readonly kind: "multiple";
  readonly options: readonly ChoiceOption[];
  /** 正确选项 id 集合，判分与顺序无关。 */
  readonly answer: readonly string[];
}

export interface BlankField extends FieldBase {
  readonly kind: "blank";
  /** 可接受答案，任一项命中即得分。 */
  readonly answer: readonly string[];
}

export interface ShortAnswerField extends FieldBase {
  readonly kind: "short_answer";
  /** 参考答案，主观题不参与自动判分。 */
  readonly referenceAnswer: string;
}

export interface NumberField extends FieldBase {
  readonly kind: "number";
  readonly answer: number;
  /** 允许的绝对误差。 */
  readonly tolerance: number;
}

export interface ScaleField extends FieldBase {
  readonly kind: "scale";
  readonly min: number;
  readonly max: number;
  readonly minLabel: string;
  readonly maxLabel: string;
}

export type ChoiceField = SingleField | MultipleField;

export type FormField =
  | SectionField
  | SingleField
  | MultipleField
  | BlankField
  | ShortAnswerField
  | NumberField
  | ScaleField;

export interface FormMeta {
  readonly title: string;
  readonly description: string;
  /** 建议作答时长（分钟）。 */
  readonly durationMinutes: number;
  readonly language: "zh-CN";
  readonly objectives: readonly Objective[];
}

export interface FormSchema {
  readonly version: SchemaVersion;
  readonly meta: FormMeta;
  readonly fields: readonly FormField[];
}

/** 字段种类守卫，供流式解析与渲染分派使用。 */
export function isFieldKind(value: unknown): value is FieldKind {
  return typeof value === "string" && (FIELD_KINDS as readonly string[]).includes(value);
}

/** 布尔姆层级守卫。 */
export function isBloomLevel(value: unknown): value is BloomLevel {
  return typeof value === "string" && (BLOOM_LEVELS as readonly string[]).includes(value);
}

/** 穷举检查：新增字段类型而漏了分支时，编译期直接报错。 */
export function assertNever(value: never): never {
  throw new Error(`unreachable field kind: ${String(value)}`);
}
