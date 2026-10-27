/**
 * 学生端投影 `publicView()`（计划 v1.1 §3.5、规则 3）。
 *
 * 一条硬约束：**学生能拿到的表单只能经这里产生**。所以实现用「白名单复制」
 * 而不是「删除敏感字段」——后者在将来给字段加上新的敏感属性时会静默泄露，
 * 前者则默认不公开，必须显式加进来才会出现在学生端。
 *
 * 契约测试 C1（`contract.test.ts`）会递归断言投影结果里不存在 `answer` /
 * `explanation` 键，也包括它们的取值。
 */

import type { FormKind } from "./constants.ts";
import type {
  ChoiceOption,
  FillField,
  FormItem,
  FormMeta,
  FormSchema,
  MultiField,
  NumberField,
  ScaleField,
  SectionField,
  ShortField,
  SingleField,
} from "./types.ts";

/** union 上的 Omit 需要分发，否则 `keyof (A|B)` 只剩公共键。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * 剥掉"教师侧元数据"。两类东西都在这个名单里：
 * - `answer` / `explanation`：答案，泄露即作弊（规则 3、契约测试 C1）；
 * - `bloom` / `knowledgePoint`：教学标注，学生看到"这题考的是 apply、知识点 kp1"
 *   等于拿到提示；《计划 v2.0》§3.5 明确要求 `publicView()` 删除它们。
 * 保留 `score`：学生需要知道分值口径，且分值不构成答案提示。
 */
type StripTeacherMeta<T> = DistributiveOmit<
  T,
  "answer" | "explanation" | "bloom" | "knowledgePoint"
>;

export type PublicSingleField = StripTeacherMeta<SingleField>;
export type PublicMultiField = StripTeacherMeta<MultiField>;
export type PublicFillField = StripTeacherMeta<FillField>;
export type PublicNumberField = StripTeacherMeta<NumberField>;
export type PublicShortField = StripTeacherMeta<ShortField>;
export type PublicScaleField = StripTeacherMeta<ScaleField>;
export type PublicSectionField = StripTeacherMeta<SectionField>;

/** 学生端可见的字段：去掉答案、解析、层级与知识点，只留作答必需的信息与分值。 */
export type PublicFormItem =
  | PublicSingleField
  | PublicMultiField
  | PublicFillField
  | PublicNumberField
  | PublicShortField
  | PublicScaleField
  | PublicSectionField;

export interface PublicFormMeta {
  readonly version: FormMeta["version"];
  readonly kind: FormKind;
  readonly title: string;
  /**
   * 注意这里**没有** `objectives`：它是教师侧的教学目标清单（"这份卷考什么"），
   * 对学生是提示。§3.5 把它和 bloom/knowledgePoint 一起划进删除名单。
   */
  /** quiz 才有；survey 不判分，因而没有总分。 */
  readonly totalScore?: number;
}

export interface PublicForm {
  readonly meta: PublicFormMeta;
  readonly items: readonly PublicFormItem[];
}

function projectOption(option: ChoiceOption): ChoiceOption {
  return { id: option.id, text: option.text };
}

/**
 * 带分值字段共享的元数据。自动判分四种与简答都从 `scoredFieldSchema` 继承 `score`
 * （省赛 R-01 之后），所以这里接受这五型；`scale` / `section` 没有分值字段，进不来。
 */
function projectScored(item: SingleField | MultiField | FillField | NumberField | ShortField): {
  readonly score?: number;
} {
  // 附录 A 之后 score 可选：没有分值就**不出现**这个键，而不是补一个 0 冒充。
  // 学生端显示"0 分"和"没有分值"是两件事（§2.6 第 4 条：未知值不伪填）。
  return item.score === undefined ? {} : { score: item.score };
}

function projectItem(item: FormItem): PublicFormItem {
  switch (item.type) {
    case "single": {
      return {
        id: item.id,
        type: "single",
        title: item.title,
        required: item.required,
        options: item.options.map(projectOption),
        ...projectScored(item),
      };
    }
    case "multi": {
      return {
        id: item.id,
        type: "multi",
        title: item.title,
        required: item.required,
        options: item.options.map(projectOption),
        ...projectScored(item),
      };
    }
    case "fill": {
      return {
        id: item.id,
        type: "fill",
        title: item.title,
        required: item.required,
        ...projectScored(item),
      };
    }
    case "number": {
      return {
        id: item.id,
        type: "number",
        title: item.title,
        required: item.required,
        ...projectScored(item),
      };
    }
    case "short": {
      return {
        id: item.id,
        type: "short",
        title: item.title,
        required: item.required,
        maxLength: item.maxLength,
        // 省赛 R-01：简答的分值对学生可见（"这题 5 分，需老师批改"），
        // 没有分值就不出现这个键——不补 0 冒充。
        ...projectScored(item),
      };
    }
    case "scale": {
      return {
        id: item.id,
        type: "scale",
        title: item.title,
        required: item.required,
        min: item.min,
        max: item.max,
        ...(item.labels === undefined ? {} : { labels: item.labels }),
      };
    }
    case "section": {
      return {
        id: item.id,
        type: "section",
        title: item.title,
        ...(item.description === undefined ? {} : { description: item.description }),
      };
    }
  }
}

function projectMeta(meta: FormMeta): PublicFormMeta {
  return {
    version: meta.version,
    kind: meta.kind,
    title: meta.title,
    ...(meta.totalScore === undefined ? {} : { totalScore: meta.totalScore }),
  };
}

/**
 * 生成学生端视图。这是唯一允许把表单交给学生端的出口。
 *
 * 注意边界：它只保证**结构字段**不泄露答案；如果有人把答案写进题干文本，
 * 那是生成端的责任（prompt 与校验都禁止），本函数不负责猜。
 */
export function publicView(form: FormSchema): PublicForm {
  return {
    meta: projectMeta(form.meta),
    items: form.items.map(projectItem),
  };
}
