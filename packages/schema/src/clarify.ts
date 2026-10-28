/**
 * 意图澄清：从需求文本识别**缺失槽位**，最多追问三个（省赛 R-05）。
 *
 * 为什么是规则而不是模型（用户 2026-10-28 裁定）：
 * - 澄清层的价值在**控制**不在**生成**。规则能给出确定的「缺哪几个、问了几次、
 *   补全了几项」，`pnpm eval` 的澄清指标才是真实测量，不是模型自证；
 * - 模型层要重录 fixture，而 R-06 的两阶段蓝图还要升 prompt，两轮重录会互相覆盖
 *   回放键；规则层不碰回放，`LLM_MODE=replay` 下照样能演示追问；
 * - 可解释：每个槽位一条正则，教师问「为什么问我这个」时有话可答。
 *
 * 三条硬边界：
 * 1. **最多 3 个**（计划 §2.1.1）；超过三个就是审问，不是澄清。
 * 2. **三条预置需求一个都不问**——它们是回放 fixture 的键，多弹一层问答等于改坏预置路径。
 * 3. **没有补充时需求原文一个字节都不变**：回放键是它的哈希（见 `replay-key.ts`）。
 */

import type { FormKind } from "./constants.ts";

/** 追问的槽位。顺序即优先级：先问「做什么」，再问「做多少」，最后问「考什么」。 */
export const CLARIFY_SLOTS = ["scene", "count", "score", "types", "knowledge"] as const;

export type ClarifySlotId = (typeof CLARIFY_SLOTS)[number];

/** 计划 §2.1.1 写死的上限。 */
export const CLARIFY_MAX_QUESTIONS = 3;

/** 单个回答的长度上限（与标题同级：够写「Unit 3 动词短语」，不够写一整篇大纲）。 */
export const CLARIFY_ANSWER_MAX_CHARS = 200;

/** 槽位的中文标签：既用于界面，也用于拼进需求的「教师补充的约束」块。 */
export const CLARIFY_SLOT_LABELS: Readonly<Record<ClarifySlotId, string>> = {
  scene: "场景",
  count: "题量",
  score: "总分",
  types: "题型",
  knowledge: "知识点",
};

export interface ClarifyQuestion {
  readonly slot: ClarifySlotId;
  /** 一句人话。恒以问号结尾，界面直接展示。 */
  readonly question: string;
  /** 可点选项；空数组表示只接受手填。 */
  readonly options: readonly string[];
  /** 手填时的占位示例。 */
  readonly placeholder: string;
}

/** 用户的回答。`answer` 是自由文本，快捷选项点下去也是文本（"10 题"），保持一种形态。 */
export interface ClarifyAnswer {
  readonly slot: ClarifySlotId;
  readonly answer: string;
}

const SURVEY_WORDS = /问卷|调查|survey|收集|反馈/i;
const QUIZ_WORDS = /测|卷|考试|练习|作业|习题|quiz/i;

/**
 * 从需求猜表单类型。只影响两条语义校验（问卷不许带答案），猜错的代价是
 * 「少拦一条」，所以用保守的关键词判定，不引入模型。
 */
export function inferFormKind(requirement: string): FormKind {
  return SURVEY_WORDS.test(requirement) ? "survey" : "quiz";
}

/**
 * 题量：「N 题」「N 道」「十道题」。
 * 用前置字符排除「第 N 题」——那是题号，不是题量。
 */
const COUNT_RE = /(?:^|[^第])\s*(?:\d+|[一二两三四五六七八九十]+)\s*(?:道|题)/;

/** 分值：「每题 5 分」「共 100 分」「满分 50 分」。`30 分钟` 不算。 */
const SCORE_RE = /(?:\d+|[一二两三四五六七八九十]+)\s*分(?!钟)/;

/** 题型：出现任意一种就认为需求对题型有话说。 */
const TYPES_RE = /单选|多选|填空|简答|判断|问答|论述|量表|连线|计算题/;

/** 知识点：显式提到知识点/考点/章节/单元/大纲/课本，或「Unit 3」「第三章」。 */
const KNOWLEDGE_RE = /知识点|考点|章节|单元|大纲|课本|课文|(?<![一-龥])unit\s*\d|第\s*[一-龥]{1,3}\s*章/i;

/**
 * 缺哪些槽位（按优先级）。
 *
 * 两处按品类裁剪，不是遗漏：
 * - **问卷不问分值**：收集页没有分值语义（附录 A 的 `E_SURVEY_HAS_ANSWER` 同一条口径）；
 * - **问卷不问知识点**：学情调查要的是「预习情况/困惑」，不是考点覆盖。
 */
export function detectMissingSlots(
  requirement: string,
  kind: FormKind = inferFormKind(requirement),
): readonly ClarifySlotId[] {
  const missing: ClarifySlotId[] = [];
  if (!QUIZ_WORDS.test(requirement) && !SURVEY_WORDS.test(requirement)) missing.push("scene");
  if (!COUNT_RE.test(requirement)) missing.push("count");
  if (kind === "quiz" && !SCORE_RE.test(requirement)) missing.push("score");
  if (!TYPES_RE.test(requirement)) missing.push("types");
  if (kind === "quiz" && !KNOWLEDGE_RE.test(requirement)) missing.push("knowledge");
  return missing;
}

const QUESTION_TEXT: Readonly<
  Record<ClarifySlotId, Omit<ClarifyQuestion, "slot">>
> = {
  scene: {
    question: "这份表单是给学生答题判分的测验，还是只收集信息？",
    options: ["判分测验", "问卷/收集"],
    placeholder: "例如：判分测验",
  },
  count: {
    question: "大概出多少道题？",
    options: ["5 题", "10 题", "20 题"],
    placeholder: "例如：12 题",
  },
  score: {
    question: "整份卷子总分定多少？",
    options: ["50 分", "100 分"],
    placeholder: "例如：60 分",
  },
  types: {
    question: "题目类型要哪些？（可多选）",
    options: ["单选", "多选", "填空", "简答"],
    placeholder: "例如：单选 + 简答",
  },
  knowledge: {
    question: "要覆盖哪些知识点或章节？",
    options: ["按课程大纲常见章节", "只要基础题"],
    placeholder: "例如：Unit 3 动词短语",
  },
};

/**
 * 生成追问列表：按 `detectMissingSlots` 的顺序取前 `CLARIFY_MAX_QUESTIONS` 个。
 * 不缺槽位时返回空数组——界面据此直接开始生成，不多一次点击。
 */
export function buildClarifyQuestions(
  requirement: string,
  kind: FormKind = inferFormKind(requirement),
): readonly ClarifyQuestion[] {
  return detectMissingSlots(requirement, kind)
    .slice(0, CLARIFY_MAX_QUESTIONS)
    .map((slot) => ({ slot, ...QUESTION_TEXT[slot] }));
}

/**
 * 把回答压成一句给时间线看的话：`澄清 2 项：题量=10 题、总分=100 分`。
 *
 * 空回答被跳过；一条不剩时返回空串，调用方据此**不发**那条 `thinking` 事件
 * （只发真实事件：没澄清就不许在时间线上演出澄清）。
 */
export function describeClarifications(answers: readonly ClarifyAnswer[]): string {
  const parts: string[] = [];
  const seen = new Set<ClarifySlotId>();
  for (const entry of answers) {
    const answer = entry.answer.trim();
    if (answer === "" || seen.has(entry.slot)) continue;
    seen.add(entry.slot);
    parts.push(`${CLARIFY_SLOT_LABELS[entry.slot]}=${answer}`);
  }
  if (parts.length === 0) return "";
  return `澄清 ${String(parts.length)} 项：${parts.join("、")}`;
}

/**
 * 把回答拼成「教师补充的约束」块，追加在需求原文之后。
 *
 * 两种安全性在这里同时成立：
 * - **空补充不改变原文**（`[]` 或全空白 → 原样返回），回放键才不会漂；
 * - 补充块最终落在用户消息的**定界数据块内**（见 `packages/llm/src/prompt.ts`），
 *   它是数据，不是指令——用户写「忽略以上要求」也只会被当成约束文本。
 *
 * 同一槽位重复回答时**后者覆盖前者**：教师改主意了，以最后一次为准。
 */
export function composeRequirement(
  requirement: string,
  answers: readonly ClarifyAnswer[],
): string {
  const latest = new Map<ClarifySlotId, string>();
  for (const entry of answers) {
    const answer = entry.answer.trim();
    if (answer === "") continue;
    latest.set(entry.slot, answer);
  }
  if (latest.size === 0) return requirement;
  const lines = CLARIFY_SLOTS.filter((slot) => latest.has(slot)).map(
    (slot) => `- ${CLARIFY_SLOT_LABELS[slot]}：${latest.get(slot) ?? ""}`,
  );
  return [requirement, "", "【教师补充的约束】", ...lines].join("\n");
}
