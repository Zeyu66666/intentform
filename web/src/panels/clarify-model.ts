/**
 * 追问表单的状态（省赛 R-05）。
 *
 * 每个槽位两份输入：**点选**（快捷选项）与**手填**。手填非空时压过点选——
 * 教师写「12 题」的意思就是「不是你们给的那三个数」。
 *
 * 为什么把状态做成「每个槽位各自一份」而不是一个大字符串：答案要按槽位标签拼进
 * 需求（`- 题量：10 题`），混成一个字符串就还原不出来了。
 */

import {
  CLARIFY_SLOTS,
  type Clarification,
  type ClarifyQuestion,
  type ClarifySlotId,
} from "@intentform/schema";

export interface SlotDraft {
  readonly options: readonly string[];
  /** 手填原文（可能含空白）；判空时才 trim。 */
  readonly custom: string;
}

export type ClarifyDrafts = Readonly<Record<ClarifySlotId, SlotDraft>>;

function emptyDraft(): SlotDraft {
  return { options: [], custom: "" };
}

export const EMPTY_DRAFTS: ClarifyDrafts = Object.freeze(
  Object.fromEntries(CLARIFY_SLOTS.map((slot) => [slot, emptyDraft()])) as Record<
    ClarifySlotId,
    SlotDraft
  >,
);

/** 只有「题型」是多选。其余槽位点一个就该替换掉上一个。 */
const MULTI_SELECT: ReadonlySet<ClarifySlotId> = new Set<ClarifySlotId>(["types"]);

function withSlot(
  drafts: ClarifyDrafts,
  slot: ClarifySlotId,
  next: SlotDraft,
): ClarifyDrafts {
  return { ...drafts, [slot]: next };
}

/** 点选一个快捷选项。单选槽位再点同一项 = 取消；多选槽位逐项开关。 */
export function toggleOption(
  drafts: ClarifyDrafts,
  slot: ClarifySlotId,
  option: string,
): ClarifyDrafts {
  const current = drafts[slot];
  if (MULTI_SELECT.has(slot)) {
    const exists = current.options.includes(option);
    const options = exists
      ? current.options.filter((entry) => entry !== option)
      : [...current.options, option];
    return withSlot(drafts, slot, { options, custom: current.custom });
  }
  const options = current.options[0] === option ? [] : [option];
  return withSlot(drafts, slot, { options, custom: current.custom });
}

/** 手填。空白手填等于「没有手填」，点选内容重新生效。 */
export function setCustom(
  drafts: ClarifyDrafts,
  slot: ClarifySlotId,
  text: string,
): ClarifyDrafts {
  return withSlot(drafts, slot, { options: drafts[slot].options, custom: text });
}

/** 这个槽位最终会被拼进需求的那段文字；没答就是空串。 */
export function answerOf(drafts: ClarifyDrafts, slot: ClarifySlotId): string {
  const draft = drafts[slot];
  const custom = draft.custom.trim();
  if (custom !== "") return custom;
  return draft.options.join("、");
}

/** 转成发给 `/api/generate` 的补充数组：只带真正问过、且答了的槽位。 */
export function buildClarifications(
  questions: readonly ClarifyQuestion[],
  drafts: ClarifyDrafts,
): readonly Clarification[] {
  const result: Clarification[] = [];
  for (const question of questions) {
    const answer = answerOf(drafts, question.slot);
    if (answer === "") continue;
    result.push({ slot: question.slot, answer });
  }
  return result;
}

/** 界面上「已答 N / 共 M」，也用于判断是否显示「跳过」。 */
export function answeredCount(
  questions: readonly ClarifyQuestion[],
  drafts: ClarifyDrafts,
): number {
  return questions.filter((question) => answerOf(drafts, question.slot) !== "").length;
}
