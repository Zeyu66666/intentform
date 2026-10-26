/**
 * @intentform/schema — 前后端共享的类型契约层。
 *
 * 形状对齐《计划 v1.1》附录 A.1 的 FormSchema 草案（判别字段为 `type`，顶层容器为 `items`），
 * 这样 I1 落地 Zod 时不需要把 I0 的命名再推翻一遍。
 *
 * I0 只固化「稳定公开面」：字段类型枚举、布鲁姆层级、各字段的形状、顶层容器。
 * I1 在此基础上补 Zod 运行时校验、R1–R8 语义规则（附录 A.2）与 `publicView()` 投影。
 * 这里刻意不引入任何运行时依赖，保证底座阶段 `pnpm typecheck` 零外部库即可通过。
 */

/** FormSchema 的版本号。不兼容变更（改名 / 删字段 / 语义变化）时递增，并同步更新回放键。 */
export const SCHEMA_VERSION = 1 as const;

export type SchemaVersion = typeof SCHEMA_VERSION;

/**
 * 七种字段类型。多一种都不加：覆盖面已足够，增加只会抬高校验与渲染成本。
 * `section` 是结构节点，不是题目，不参与判分。
 */
export const FIELD_TYPES = [
  "single",
  "multi",
  "fill",
  "number",
  "short",
  "scale",
  "section",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * 参与自动判分的题型（计划 §2.1 范围说明）。
 * `short` 只收集文本、看板标「待批阅」；`scale` 是收集型字段。R6 的分值合计只统计这四个。
 */
export const AUTO_GRADED_TYPES = ["single", "multi", "fill", "number"] as const;

export type AutoGradedType = (typeof AUTO_GRADED_TYPES)[number];

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

/** 表单种类：`quiz` 判分出看板；`survey` 只收集，禁止出现 `answer` / `score`。 */
export const FORM_KINDS = ["quiz", "survey"] as const;

export type FormKind = (typeof FORM_KINDS)[number];

/**
 * 长度与数量上限（计划 §5「输入校验」）。集中在这里，I1 的 Zod schema 与
 * server 的请求体校验共用同一份数字，避免两处各写一套而漂移。
 */
export const LIMITS = {
  /** 字段 id：小写字母 / 数字 / 下划线 / 连字符，3–32 位。Patch 以它寻址，所以必须严格。 */
  idPattern: /^[a-z0-9_-]{3,32}$/,
  titleMax: 500,
  formTitleMax: 200,
  optionTextMax: 200,
  explanationMax: 1000,
  shortDefaultMaxLength: 500,
  shortMaxLengthCap: 2000,
  scoreMax: 100,
  fieldsMax: 100,
  /** 选项数量（R4）。 */
  optionsMin: 2,
  optionsMax: 8,
  /** 需求正文上限，service 层校验用。 */
  requirementMaxChars: 4000,
  /** 单份答卷上限，service 层校验用。 */
  submissionMaxBytes: 64 * 1024,
} as const;

/** 知识点。对应课程大纲的一个条目，`id` 被字段的 `knowledgePoint` 引用。 */
export interface Objective {
  readonly id: string;
  /** 面向教师展示的知识点名，例如「二叉树的遍历」。 */
  readonly name: string;
}

/** 收集型字段（`short` / `scale`）与判分型字段共享的部分。 */
export interface FieldBase {
  /** 稳定 id：流式增量渲染、Patch 寻址、答案回填全靠它，全表单内唯一（R1）。 */
  readonly id: string;
  /** 题干 / 标题（纯文本，不渲染 HTML；数学公式用 `$...$` 或 `$$...$$`）。 */
  readonly title: string;
  readonly required: boolean;
}

/** 判分型字段额外带的分值与教学元数据。 */
export interface ScoredBase extends FieldBase {
  /** 分值，整数（R6 要求合计等于 `meta.totalScore`，整数避免浮点求和误差）。 */
  readonly score: number;
  readonly bloom: BloomLevel;
  /** 指向 `meta.objectives[].id`（R8 校验存在性）。 */
  readonly knowledgePoint: string;
  /** 教师侧解析，公开视图会剥掉。 */
  readonly explanation?: string;
}

export interface ChoiceOption {
  readonly id: string;
  /** 选项文本，支持 LaTeX。 */
  readonly text: string;
}

export interface SingleField extends ScoredBase {
  readonly type: "single";
  readonly options: readonly ChoiceOption[];
  /** 正确选项的 id（R2：必须是某个选项的 id）。 */
  readonly answer: string;
}

export interface MultiField extends ScoredBase {
  readonly type: "multi";
  readonly options: readonly ChoiceOption[];
  /** 正确选项 id 集合：非空、去重、全部属于选项（R3）；判分与顺序无关；v1 全对才得分。 */
  readonly answer: readonly string[];
}

export interface FillField extends ScoredBase {
  readonly type: "fill";
  /** 可接受答案列表，至少 1 项且非空串（R5）；任一项命中即得分。 */
  readonly answer: readonly string[];
}

export interface NumberField extends ScoredBase {
  readonly type: "number";
  readonly answer: {
    readonly value: number;
    /** 允许的绝对误差，≥ 0（R5）。 */
    readonly tolerance: number;
  };
}

export interface ShortField extends FieldBase {
  readonly type: "short";
  /** 作答字数上限，默认 500、上限 2000。v1 不自动判分。 */
  readonly maxLength: number;
}

export interface ScaleField extends FieldBase {
  readonly type: "scale";
  readonly min: number;
  readonly max: number;
  /** 两端的文字锚点，例如 ["完全不同意", "完全同意"]。 */
  readonly labels?: readonly [string, string];
}

/** 分节标题：结构节点，不是题目，因此不带 `required` 与分值。 */
export interface SectionField {
  readonly type: "section";
  readonly id: string;
  readonly title: string;
  readonly description?: string;
}

export type ScoredField = SingleField | MultiField | FillField | NumberField;

export type CollectField = ShortField | ScaleField;

export type ChoiceField = SingleField | MultiField;

/** 顶层 `items` 的元素。 */
export type FormItem = SectionField | ScoredField | CollectField;

export interface FormMeta {
  readonly version: SchemaVersion;
  readonly kind: FormKind;
  readonly title: string;
  readonly objectives: readonly Objective[];
  /** 自动判分题分值之和；`survey` 不带。 */
  readonly totalScore?: number;
}

export interface FormSchema {
  readonly meta: FormMeta;
  /** 字段与分节按渲染顺序排列，上限 `LIMITS.fieldsMax`。 */
  readonly items: readonly FormItem[];
}

/** 字段类型守卫，供流式解析与渲染分派使用。 */
export function isFieldType(value: unknown): value is FieldType {
  return typeof value === "string" && (FIELD_TYPES as readonly string[]).includes(value);
}

/** 判分型字段守卫：R6 与判分逻辑都靠它区分「要不要算分」。 */
export function isAutoGradedType(value: unknown): value is AutoGradedType {
  return typeof value === "string" && (AUTO_GRADED_TYPES as readonly string[]).includes(value);
}

/** 布鲁姆层级守卫。 */
export function isBloomLevel(value: unknown): value is BloomLevel {
  return typeof value === "string" && (BLOOM_LEVELS as readonly string[]).includes(value);
}

/** 表单种类守卫。 */
export function isFormKind(value: unknown): value is FormKind {
  return typeof value === "string" && (FORM_KINDS as readonly string[]).includes(value);
}

/** 穷举检查：新增字段类型而漏了分支时，编译期直接报错。 */
export function assertNever(value: never): never {
  throw new Error(`unreachable variant: ${String(value)}`);
}
