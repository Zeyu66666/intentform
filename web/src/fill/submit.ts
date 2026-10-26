/**
 * 提交状态机 + 提交体构造（纯函数，无 React）。
 *
 * 三个必须在这里（而不是 `.tsx`）成立的事实：
 *   1. `formVersionId` 取的是**本次渲染的** `view.versionId`。§3.5 的旧版拒绝策略
 *      全靠它：页面拿着 v1 渲染、服务端已发 v2，比对不等就回 409。
 *      少了这个字段，旧页面就会用新答案判分 —— 那是判分口径污染，不是小 bug。
 *   2. 409 `version_conflict` 有专属状态：**禁用提交 + 给"刷新页面"**，
 *      绝不自动刷新（学生刚写了半页，自动刷新等于把答案冲掉）。重试也没用，
 *      因为页面渲染的还是旧版，所以这个分支不能落到通用的"失败可重试"上。
 *   3. 成功态只带分数：`SubmitResponse` 本身就没有每题对错，这里也不从本地答案
 *      里拼任何"你填的是……"回显。
 */

import {
  VERSION_CONFLICT_MESSAGE,
  type AnswerValue,
  type FillViewResponse,
  type FormKind,
  type SubmitRequest,
  type SubmitResponse,
} from "@intentform/schema";

import { describeFailure, isVersionConflict } from "../api/failures";
import type { ApiResult } from "../api/http";
import { isAnswerable, isAnswered, type AnswerState } from "./answers";
import { collectMissingRequired, type MissingField } from "./validate";

/**
 * 多空填空题的分隔符：全角「／」。
 *
 * 为什么不用半角 `/`：数学答案里 `1/2`、`3/4` 很常见，按半角切会把一个答案
 * 切成两个空，学生莫名其妙得 0 分。服务端同样只认同全角（两边口径一致）。
 */
export const BLANK_SEPARATOR = "／";

/**
 * 多空填空题输入框的 `placeholder`，也是"分隔符怎么写"的唯一提示来源。
 *
 * 两件事必须同时说清：
 *   1. **全角「／」是推荐写法**，也是前端 `splitBlanks()` 唯一切的东西；
 *   2. 服务端在判分侧**同时认半角 `/`**（I4 联调后双方对齐的口径），所以提示里
 *      两种都写出来——只说全角会让敲半角 `/` 的学生以为写坏了。
 *
 * 放在 `.ts` 而不是直接写在 `.tsx` 里，是因为 vitest 只收 `.ts`：提示文案属于
 * 契约的一部分（学生看到的话），要能被 `submit.test.ts` 钉住。
 */
export const BLANK_INPUT_PLACEHOLDER = `多个空用 ${BLANK_SEPARATOR} 或 / 分隔，按空位顺序填写`;

/** 一个元素 = 一个空。首尾空白先 trim：服务端按 trim 后比对。 */
export function splitBlanks(text: string): readonly string[] {
  return text.split(BLANK_SEPARATOR).map((part) => part.trim());
}

/**
 * 从界面状态生成线缆形状。
 *
 * 只提交**实际作答**的字段：空答案不出现在请求体里（服务端把它当"没答"，
 * 与"答了个空字符串"区分开）。未知字段、`section` 也不会被提交。
 */
export function toWireAnswers(
  items: FillViewResponse["form"]["items"],
  answers: AnswerState,
): SubmitRequest["answers"] {
  const wire: Record<string, AnswerValue> = {};

  for (const item of items) {
    if (!isAnswerable(item)) continue;
    const value = answers[item.id];
    if (!isAnswered(value)) continue;

    if (item.type === "fill") {
      // 填空题界面是一个多行输入，交上去要按空位切开；服务端按下标逐个比。
      wire[item.id] = typeof value === "string" ? [...splitBlanks(value)] : [...value];
      continue;
    }
    wire[item.id] = value;
  }

  return wire;
}

export function buildSubmitRequest(view: FillViewResponse, answers: AnswerState): SubmitRequest {
  return {
    slug: view.slug,
    formVersionId: view.versionId,
    answers: toWireAnswers(view.form.items, answers),
  };
}

export interface SubmitSuccess {
  /** quiz：`8 / 10 分`；survey：`已提交`。除这两个之外不显示任何东西。 */
  readonly summary: string;
}

export type SubmitState =
  | { readonly kind: "idle" }
  /** 必答项没填完：把清单交给界面列出来（不静默放行）。 */
  | { readonly kind: "blocked"; readonly missing: readonly MissingField[] }
  | { readonly kind: "submitting" }
  | { readonly kind: "success"; readonly success: SubmitSuccess }
  | { readonly kind: "conflict"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

/** 成功后只报"得分 / 满分"或"已提交"，不回显作答内容、不报每题对错。 */
export function formatSuccess(kind: FormKind, score: number, maxScore: number): string {
  return kind === "quiz" ? `${String(score)} / ${String(maxScore)} 分` : "已提交";
}

export function missingSummary(missing: readonly MissingField[]): string {
  return `还有 ${String(missing.length)} 道必答项没填`;
}

/**
 * 点提交时的第一个状态：先本地跑必答校验，过了才进 `submitting`。
 * 注意 `blocked` 不是错误态 —— 学生补完就能再点，所以按钮不该禁用。
 */
export function beginSubmit(
  items: FillViewResponse["form"]["items"],
  answers: AnswerState,
): SubmitState {
  const missing = collectMissingRequired(items, answers);
  return missing.length > 0 ? { kind: "blocked", missing } : { kind: "submitting" };
}

export function mapSubmitOutcome(
  outcome: ApiResult<SubmitResponse>,
  kind: FormKind,
): SubmitState {
  if (outcome.ok) {
    return {
      kind: "success",
      success: { summary: formatSuccess(kind, outcome.data.score, outcome.data.maxScore) },
    };
  }

  if (isVersionConflict(outcome.failure)) {
    // 文案来自契约常量：服务端与前端说的是同一句话，改口径只改一处。
    return { kind: "conflict", message: VERSION_CONFLICT_MESSAGE };
  }

  return {
    kind: "failed",
    message: describeFailure(outcome.failure, {
      notFound: "这个填写链接已失效（表单可能已被下架）",
      unauthorized: "这个表单暂时不接受提交",
    }),
  };
}

/**
 * 提交按钮能不能点。
 * - `submitting` / `success` / `conflict` 一律不能（冲突要先刷新页面）；
 * - `blocked` 可以 —— 那是本地校验的提示，补完再交是正常流程。
 */
export function canSubmit(state: SubmitState): boolean {
  switch (state.kind) {
    case "idle":
    case "blocked":
    case "failed":
      return true;
    case "submitting":
    case "success":
    case "conflict":
      return false;
    default:
      return assertNeverState(state);
  }
}

function assertNeverState(state: never): never {
  throw new Error(`未处理的提交状态: ${JSON.stringify(state)}`);
}
