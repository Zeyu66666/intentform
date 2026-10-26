/**
 * @intentform/schema 的常量层：版本号、枚举、上限、守卫。
 *
 * 单独成文件是为了让上层（`types.ts` 的 Zod 定义、`rules.ts` 的语义规则）
 * 都能引用同一份数字，而不是各自复制一遍。`index.ts` 只做聚合重导出。
 *
 * 形状对齐《计划 v1.1》附录 A.1：判别字段为 `type`，顶层容器为 `items`，
 * 字段类型名是 `single`/`multi`/`fill`/`number`/`short`/`scale`/`section`。
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
 * 长度与数量上限（计划 §5「输入校验」）。集中在这里，Zod schema 与
 * server 的请求体校验共用同一份数字，避免两处各写一套而漂移。
 */
export const LIMITS = {
  /** 字段 id：小写字母 / 数字 / 下划线 / 连字符，3–32 位。Patch 以它寻址，所以必须严格。 */
  idPattern: /^[a-z0-9_-]{3,32}$/,
  /**
   * 短标识：选项 id（`a`/`b`/`c` 是常见写法）与知识点 id（`kp1`）共用。
   * 同样限定字符集，但允许 1 位——这两个不是 Patch 寻址目标，没有必要套 3 位下限。
   */
  shortIdPattern: /^[a-z0-9_-]{1,32}$/,
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
  /**
   * `field_error.raw` 的截断上限：出问题的那行 NDJSON 原文。
   * 截断而不是整行丢弃，是为了让教师端能看见"模型到底吐了什么"；
   * 上限存在，是因为一行 section 可能上万字符，SSE 帧不该被它撑爆。
   */
  rawLineMax: 2000,
  /** 收集页短链（`/f/:slug`）。随机生成，够短好念，但不许手填成别的教师也在用的串。 */
  slugMax: 32,
  /** 教师账号邮箱上限（RFC 5321 的地址长度上限）。 */
  emailMax: 320,
  /** 登录密码长度区间：下限卡住弱口令，上限防超长输入拖慢 KDF。 */
  passwordMin: 8,
  passwordMax: 200,
} as const;

/**
 * 表单状态。`published` 只表示"有过发布版本"，具体给学生看哪一版由
 * `forms.published_version_id` 决定——状态与指针分开，是为了让"下架"能只清指针。
 */
export const FORM_STATUSES = ["draft", "published"] as const;

export type FormStatus = (typeof FORM_STATUSES)[number];

/**
 * 版本来源（`form_versions.source`）：生成、受限修改、修复。
 * 不在这个集合里的来源一律拒收——留一个自由文本列，事后没人说得清版本怎么来的。
 */
export const FORM_VERSION_SOURCES = ["generate", "patch", "repair"] as const;

export type FormVersionSource = (typeof FORM_VERSION_SOURCES)[number];

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
