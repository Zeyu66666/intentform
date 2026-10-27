/**
 * 答案状态机（纯函数，无 React）。
 *
 * 为什么不用 `useState<Record<string,string>>` 在组件里各自判断：
 * 七种题型的取值形状不同（选项 id 字符串 / 选项 id 数组 / 文本），
 * 一旦散在 JSX 里，"多选取消最后一个勾要不要删 key"这种规则就会被写成三份。
 * 收成一个 reducer：`.tsx` 只负责把事件翻译成 action。
 *
 * 一条不变量：**空答案等于没有这个 key**。带一个 `""` 或 `[]` 的键会让
 * "必答校验"与"提交体"两处都要重复判空，漏一处就把空答案算成了已作答。
 */

import type { AnswerValue, PublicFormItem } from "@intentform/schema";

export type AnswerState = Readonly<Record<string, AnswerValue>>;

export const EMPTY_ANSWERS: AnswerState = {};

export type AnswerAction =
  /** 单选 / 量表：一个字段只有一个值，后一次点选覆盖前一次。 */
  | { readonly type: "choose"; readonly fieldId: string; readonly value: string }
  /** 多选：勾选与取消勾选是同一个动作，靠当前集合判断方向。 */
  | { readonly type: "toggle"; readonly fieldId: string; readonly optionId: string }
  /** 文本类：填空 / 数值 / 简答。原样保存，不 trim（学生正在输入的中间态不能被改写）。 */
  | { readonly type: "type"; readonly fieldId: string; readonly value: string };

function withoutKey(state: AnswerState, fieldId: string): AnswerState {
  const next: Record<string, AnswerValue> = {};
  for (const [key, value] of Object.entries(state)) {
    if (key !== fieldId) next[key] = value;
  }
  return next;
}

export function answerReducer(state: AnswerState, action: AnswerAction): AnswerState {
  switch (action.type) {
    case "choose":
      return { ...state, [action.fieldId]: action.value };
    case "type":
      return action.value === "" ? withoutKey(state, action.fieldId) : { ...state, [action.fieldId]: action.value };
    case "toggle": {
      const current = state[action.fieldId];
      const selected = Array.isArray(current) ? current : [];
      const next = selected.includes(action.optionId)
        ? selected.filter((id) => id !== action.optionId)
        : [...selected, action.optionId];
      return next.length === 0 ? withoutKey(state, action.fieldId) : { ...state, [action.fieldId]: next };
    }
    default:
      // 穷举：新增 action 类型时这里编译不过（`action` 会被收窄成 `never`）。
      return assertNeverAction(action);
  }
}

function assertNeverAction(action: never): never {
  throw new Error(`未处理的答案动作: ${JSON.stringify(action)}`);
}

/** 判空判据：字符串去空白后非空；数组里至少一个非空白项。 */
export function isAnswered(value: AnswerValue | undefined): value is AnswerValue {
  if (value === undefined) return false;
  if (typeof value === "string") return value.trim() !== "";
  return value.some((item) => item.trim() !== "");
}

/** 受控文本输入要的当前值；数组（理论上不该出现在文本字段上）降级成空串。 */
export function stringValue(state: AnswerState, fieldId: string): string {
  const value = state[fieldId];
  return typeof value === "string" ? value : "";
}

/** 受控多选要的当前勾选集。 */
export function selectedValues(state: AnswerState, fieldId: string): readonly string[] {
  const value = state[fieldId];
  return Array.isArray(value) ? value : [];
}

/**
 * 选项类控件要的「当前选中集合」。
 *
 * 为什么不能直接用 `selectedValues()`：单选在状态里存的是**字符串**，多选存的是**数组**。
 * 只认数组的实现会让单选的 `checked` 永远为 false——学生点得动、状态也存下了，
 * 但界面上一个选项都不会亮（I4 的浏览器验收只看"能否提交、有无泄漏"，漏了"选中态"，
 * 所以这处 bug 活到了 I5 的闭环脚本才被抓到：脚本断言的是 DOM 的 `input.checked`）。
 */
export function choiceValues(state: AnswerState, fieldId: string): readonly string[] {
  const value = state[fieldId];
  if (Array.isArray(value)) return value;
  return typeof value === "string" && value !== "" ? [value] : [];
}

/** `section` 是结构节点不是题目，不参与作答与必答校验。 */
export function isAnswerable(
  item: PublicFormItem,
): item is Exclude<PublicFormItem, { readonly type: "section" }> {
  return item.type !== "section";
}
