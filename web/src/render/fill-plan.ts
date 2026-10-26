/**
 * 学生视图（`fill` 态）的渲染数据选择 —— **答案防泄露的第一道闸门**。
 *
 * 为什么不能直接在组件里"少渲染几个字段"：
 * - 组件拿到的是 `FormItem`（含 `answer` / `explanation` / `score` / `bloom` /
 *   `knowledgePoint`），只要有任何一条路径把整个对象塞进 `props`、`data-*`、
 *   `<details>` 里，答案就跟着进了 DOM。计划 §5 与 `AGENTS.md` §5 的红线是
 *   "学生端只能经 `publicView()` 输出"，所以这里**先投影、再白名单重建**：
 *
 *   1. `publicView()`（来自 `@intentform/schema`，不自己写一份黑名单）：schema 层已经剥掉
 *      `answer` / `explanation` / `bloom` / `knowledgePoint`（提交 `04c0e6f`），但平面上仍保留
 *      `score`；
 *   2. `toFillRenderPlan()`：只挑出"作答控件需要的那几个字段"，
 *      **`score` / `bloom` / `knowledgePoint` 一律不进 plan**。这一步是**纵深防御**：
 *      schema 层已经剥了答案类字段，这里再按白名单重建一次，任何一边失守都不会漏答案；
 *      而 `score` 是 schema 层有意保留的（教师/统计要用），所以这道闸门对它不可省。
 *
 * 出去的 `FillRenderPlan` 结构上装不下答案，渲染层再怎么写也漏不出来——
 * 这比"渲染时记得别写 answer"可靠得多。单测 `fill-plan.test.ts` 对 7 种题型逐一断言。
 */

import {
  SCHEMA_VERSION,
  publicView,
  type FormItem,
  type FormSchema,
  type PublicFormItem,
} from "@intentform/schema";

/** 一次投影：复用 schema 的 `publicView()`，不复制它的字段列表。 */
export function toFillItems(items: readonly FormItem[]): readonly PublicFormItem[] {
  const form: FormSchema = {
    // 预览不关心 meta：`publicView` 只按白名单搬字段，这里给一个最小的合法 meta。
    meta: { version: SCHEMA_VERSION, kind: "quiz", title: "学生视图预览", objectives: [] },
    items,
  };
  return publicView(form).items;
}

/** 单节点投影（流式逐字段到达，拿不到整份表单）。 */
export function toFillItem(item: FormItem): PublicFormItem {
  const [projected] = toFillItems([item]);
  if (projected === undefined) {
    // 只会在 `publicView` 丢节点时发生，属于契约被破坏，必须炸而不是静默渲染空白。
    throw new Error(`publicView 丢弃了节点 ${item.id}：投影契约被破坏`);
  }
  return projected;
}

export interface FillOption {
  readonly id: string;
  readonly text: string;
}

/** 作答控件描述。**故意不含答案、分值、层级、知识点。** */
interface PlanBase {
  readonly id: string;
  readonly title: string;
  readonly required: boolean;
  /** 只有分节带描述；题干描述走同一字段，保持结构简单。 */
  readonly description: string | null;
}

/**
 * 学生视角的渲染计划：判别联合，**控件种类与题型绑定**。
 *
 * 为什么不写成 `{ type; control: FillControl }` 那种松组合：松组合下 `type: "single"`
 * 配 `control.kind: "number"` 也能编译通过，渲染层只好再写一遍 `if` 兜底；绑死之后
 * "单选题渲染成数值框"这种错在编译期就被挡住。结构上也**装不下** `answer` /
 * `explanation` / `score` / `bloom` / `knowledgePoint`。
 */
export type FillRenderPlan =
  | (PlanBase & {
      readonly type: "single";
      readonly control: { readonly kind: "single"; readonly options: readonly FillOption[] };
    })
  | (PlanBase & {
      readonly type: "multi";
      readonly control: { readonly kind: "multi"; readonly options: readonly FillOption[] };
    })
  | (PlanBase & {
      readonly type: "fill";
      readonly control: { readonly kind: "text"; readonly maxLength: number; readonly multiline: false };
    })
  | (PlanBase & {
      readonly type: "short";
      readonly control: { readonly kind: "text"; readonly maxLength: number; readonly multiline: true };
    })
  | (PlanBase & { readonly type: "number"; readonly control: { readonly kind: "number" } })
  | (PlanBase & {
      readonly type: "scale";
      readonly control: {
        readonly kind: "scale";
        readonly min: number;
        readonly max: number;
        readonly labels: readonly [string, string] | null;
      };
    })
  | (PlanBase & { readonly type: "section"; readonly control: { readonly kind: "section" } });

/** 按题型取对应成员，注册表用它拿窄化后的入参。 */
export type FillPlanOf<T extends FillRenderPlan["type"]> = Extract<FillRenderPlan, { readonly type: T }>;

/** 所有作答控件的联合，`Record` 的键要用它（漏一种控件编译不过）。 */
export type FillControl = FillRenderPlan["control"];

function toFillOptions(options: readonly { readonly id: string; readonly text: string }[]): readonly FillOption[] {
  return options.map((option) => ({ id: option.id, text: option.text }));
}

/** 穷举 7 种题型 → 作答控件。新增题型而漏分支时编译期报错（`switch` 无 default）。 */
export function toFillRenderPlan(item: PublicFormItem): FillRenderPlan {
  switch (item.type) {
    case "single":
      return {
        id: item.id,
        type: item.type,
        title: item.title,
        required: item.required,
        description: null,
        control: { kind: "single", options: toFillOptions(item.options) },
      };

    case "multi":
      return {
        id: item.id,
        type: item.type,
        title: item.title,
        required: item.required,
        description: null,
        control: { kind: "multi", options: toFillOptions(item.options) },
      };

    case "fill":
      // 填空题可能有多个空，学生侧先给单行输入（多空作答属于 I4 的答题契约）。
      return {
        id: item.id,
        type: item.type,
        title: item.title,
        required: item.required,
        description: null,
        control: { kind: "text", maxLength: 200, multiline: false },
      };

    case "number":
      return {
        id: item.id,
        type: item.type,
        title: item.title,
        required: item.required,
        description: null,
        control: { kind: "number" },
      };

    case "short":
      return {
        id: item.id,
        type: item.type,
        title: item.title,
        required: item.required,
        description: null,
        control: { kind: "text", maxLength: item.maxLength, multiline: true },
      };

    case "scale":
      return {
        id: item.id,
        type: item.type,
        title: item.title,
        required: item.required,
        description: null,
        control: {
          kind: "scale",
          min: item.min,
          max: item.max,
          // `DeepReadonly` 会把元组弱化成 `readonly string[]`，所以这里补一次兜底。
          labels: item.labels === undefined ? null : [item.labels[0] ?? "", item.labels[1] ?? ""],
        },
      };

    case "section":
      return {
        id: item.id,
        type: item.type,
        title: item.title,
        required: false,
        description: item.description ?? null,
        control: { kind: "section" },
      };
  }
}
