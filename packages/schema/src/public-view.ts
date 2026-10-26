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
  Objective,
  ScaleField,
  SectionField,
  ShortField,
  SingleField,
} from "./types.ts";

/** union 上的 Omit 需要分发，否则 `keyof (A|B)` 只剩公共键。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type StripAnswer<T> = DistributiveOmit<T, "answer" | "explanation">;

export type PublicSingleField = StripAnswer<SingleField>;
export type PublicMultiField = StripAnswer<MultiField>;
export type PublicFillField = StripAnswer<FillField>;
export type PublicNumberField = StripAnswer<NumberField>;
export type PublicShortField = StripAnswer<ShortField>;
export type PublicScaleField = StripAnswer<ScaleField>;
export type PublicSectionField = SectionField;

/** 学生端可见的字段：去掉了答案与解析，保留分值、层级与知识点。 */
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
  readonly objectives: readonly Objective[];
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
 * 判分型字段共享的元数据。短答与量表是收集型字段，结构上就没有这三项
 * （见 `types.ts` 的 `collectFieldSchema`），所以这里只接受判分型。
 */
function projectScored(item: SingleField | MultiField | FillField | NumberField): {
  readonly score: number;
  readonly bloom: SingleField["bloom"];
  readonly knowledgePoint: string;
} {
  return {
    score: item.score,
    bloom: item.bloom,
    knowledgePoint: item.knowledgePoint,
  };
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
    objectives: meta.objectives.map((objective) => ({ id: objective.id, name: objective.name })),
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
