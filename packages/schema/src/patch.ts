/**
 * 受限修改（省赛 R-03 / I7 收缩版）：**十一种操作**，不是任意改写。
 *
 * P18 从六种扩到十一种（答案 / 解析 / 必答 / 教学标注 / 字数上限），扩的是「一道题上的一个面」，
 * 不是「任意字段」：每种 op 仍然对应界面上一个能单独指出、单独撤销的改动。
 *
 * 为什么不做通用 Patch（整份 Schema 覆盖）：
 * 1. 整份覆盖等于把「生成」重放一遍，行级校验、整表门禁、prompt 溯源全部失去意义；
 * 2. 教师在界面上看到的是「第 3 题分值改成 8」，界面能表达的就这几种改动，
 *    接口比界面能表达的多，多出来的部分就是没人测过的攻击面；
 * 3. 差异要能回显给教师确认（Diff 预览），任意改写算不出人话级的差异。
 *
 * 因此这里只有十一个 op：改题干 / 改选项 / 改分值 / 加题 / 删题 / 调顺序 /
 * 改答案 / 改解析 / 改必答 / 改教学标注 / 改字数上限。
 * `applyPatch` 是纯函数：入参是旧 Schema 与 ops，出参是新 Schema 与**可读的变更列表**，
 * 不碰数据库、不碰 HTTP——服务端拿它落版本，前端拿它做预览，两边跑的是同一份规则。
 *
 * 关于 `totalScore`：`quiz` 的 `meta.totalScore` 必须等于各题分值之和（R6），
 * 而改分值/加题/删题都会让和变化。让它交给调用方手填，等于把「算错总分」变成
 * 一个必现的人为错误，所以这里**自动重算**，并在变更列表里显式记一条。
 */

import { z } from "zod";

import { BLOOM_LEVELS, LIMITS } from "./constants.ts";
import { choiceOptionSchema, formItemSchema, formSchema, type FormItem, type FormSchema } from "./types.ts";

/** 字段 id 在 Patch 里是寻址键，规则与 Schema 里一致。 */
const fieldId = z
  .string()
  .regex(LIMITS.idPattern, "id 需匹配 ^[a-z0-9_-]{3,32}$（小写字母/数字/下划线/连字符）");

const nonNegativeInt = z.number().int().min(0);

/**
 * 四种可判分题型的答案载荷。
 *
 * 载荷自带 `type`，而不是「借题目的类型推断」：`applyPatch` 拿到一条 `setAnswer`
 * 时，先要能判断「这载荷与题目是不是同一种考法」，载荷不带类型就只能猜字段形状。
 */
export const answerPayloadSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("single"), answer: z.string().min(1) }),
  z.object({ type: z.literal("multi"), answer: z.array(z.string().min(1)).min(1) }),
  z.object({ type: z.literal("fill"), answer: z.array(z.string().min(1)).min(1) }),
  z.object({
    type: z.literal("number"),
    answer: z.object({ value: z.number().finite(), tolerance: z.number().min(0) }),
  }),
]);

export type AnswerPayload = z.infer<typeof answerPayloadSchema>;

/**
 * 十一个 op。判别键是 `op`，与 `formItemSchema` 用 `type` 判别同理：
 * 一个字段只描述一种改动，读代码时不用在十一个可选字段里挑。
 *
 * P18 追加的四个 op 都只改**一道题上的一个面**（答案 / 解析 / 必答 / 教学标注），
 * 不合成万能 op：撤销、差异回显与越界拦截的粒度都是 op，一个
 * `setItem: Partial<FormItem>` 会让「这条改动改的是答案还是必答」变得不可判。
 */
export const patchOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("setStem"),
    itemId: fieldId,
    title: z.string().trim().min(1).max(LIMITS.titleMax),
  }),
  z.object({
    op: z.literal("setOptions"),
    itemId: fieldId,
    options: z.array(choiceOptionSchema).min(LIMITS.optionsMin).max(LIMITS.optionsMax),
  }),
  /** 分值上限沿用 Schema 的 `scoreMax`；简答也可以带分值（R-01），但不会自动判分。 */
  z.object({ op: z.literal("setScore"), itemId: fieldId, score: nonNegativeInt.max(LIMITS.scoreMax) }),
  /** 插在 `index` 之前；`index === items.length` 表示追加到末尾。 */
  z.object({ op: z.literal("addItem"), index: nonNegativeInt, item: formItemSchema }),
  z.object({ op: z.literal("removeItem"), itemId: fieldId }),
  /** 移动到 `toIndex`（移动后该题的下标）。 */
  z.object({ op: z.literal("moveItem"), itemId: fieldId, toIndex: nonNegativeInt }),

  /* ------------------------- P18：单题编辑的四个 op ------------------------- */

  /** 改标准答案。载荷自带 `type`，`applyPatch` 校验它与题目类型是否一致。 */
  z.object({ op: z.literal("setAnswer"), itemId: fieldId, answer: answerPayloadSchema }),
  /**
   * 改解析。`section` 写它的 `description`（同一概念：这段说明文字）；
   * `null` 表示清空——落库时删键，不写空串。
   */
  z.object({
    op: z.literal("setExplanation"),
    itemId: fieldId,
    explanation: z.string().max(LIMITS.explanationMax).nullable(),
  }),
  /** 改必答。`section` 结构上没有 `required`，会回 `patch_required_unsupported`。 */
  z.object({ op: z.literal("setRequired"), itemId: fieldId, required: z.boolean() }),
  /**
   * 改教学标注。**两个字段都必填**（`null` 表示清空），不做稀疏：
   * 只传 `bloom` 会把 `knowledgePoint` 静默抹掉，而"静默抹掉"正是这次要消灭的东西。
   */
  z.object({
    op: z.literal("setMeta"),
    itemId: fieldId,
    bloom: z.enum(BLOOM_LEVELS).nullable(),
    // 与 `types.ts` 的 `shortIdSchema` 同一份字符集（那里未导出，按常量重写）。
    knowledgePoint: z.string().regex(LIMITS.shortIdPattern, "知识点 id 需匹配 ^[a-z0-9_-]{1,32}$").max(32).nullable(),
  }),
  /**
   * 改简答的字数上限（P18 追加）。
   *
   * 计划 D1 要求「简答可改 maxLength」，但原定的四个 op 里没有承载它的位置；
   * 与其让面板上的输入框只改内存不落库，不如补第五个 op——界面能改的每一项，
   * 契约里都必须有对应的、可撤销的一步。
   */
  z.object({
    op: z.literal("setMaxLength"),
    itemId: fieldId,
    maxLength: z.number().int().min(1).max(LIMITS.shortMaxLengthCap),
  }),
]);

export type PatchOp = z.infer<typeof patchOpSchema>;

export const patchOpsSchema = z.array(patchOpSchema).min(1).max(LIMITS.fieldsMax);

/**
 * 变更条目。给界面做 Diff 预览用，所以带 `before`/`after` 的**人话**版本，
 * 不带 SQL 或内部字段名。
 */
export interface PatchChange {
  readonly op: PatchOp["op"];
  /** 受影响的题目 id；改总分这类整体变更没有题目 id。 */
  readonly itemId?: string;
  /** 给人看的定位，例如 `第 3 题`。 */
  readonly where: string;
  readonly before: string;
  readonly after: string;
}

/** Patch 自己的错误码（不进 HTTP 错误码表：它们是 400 里的明细）。 */
export const PATCH_ERROR_CODES = [
  "patch_item_not_found",
  "patch_duplicate_item_id",
  "patch_index_out_of_range",
  "patch_score_unsupported",
  "patch_options_unsupported",
  "patch_schema_invalid",
  // P18：单题编辑
  "patch_answer_unsupported",
  "patch_required_unsupported",
  "patch_meta_unsupported",
  "patch_explanation_unsupported",
  "patch_maxlength_unsupported",
] as const;

export type PatchErrorCode = (typeof PATCH_ERROR_CODES)[number];

export interface PatchError {
  readonly code: PatchErrorCode;
  /** 第几个 op 出错（从 0 数），便于界面高亮具体那一步。 */
  readonly opIndex: number;
  readonly message: string;
}

export type PatchResult =
  | { readonly ok: true; readonly schema: FormSchema; readonly changes: readonly PatchChange[] }
  | { readonly ok: false; readonly errors: readonly PatchError[] };

/** 应用到「人话」文案的操作名。 */
const OP_LABELS: Record<PatchOp["op"], string> = {
  setStem: "改题干",
  setOptions: "改选项",
  setScore: "改分值",
  addItem: "加题",
  removeItem: "删题",
  moveItem: "调顺序",
  setAnswer: "改答案",
  setExplanation: "改解析",
  setRequired: "改必答",
  setMeta: "改教学标注",
  setMaxLength: "改字数上限",
};

/**
 * 单题 op 的「哪一栏」后缀，拼在 `第 3 题` 后面。
 *
 * 不带后缀时，教师看到「第 3 题：A → C」根本分不清改的是答案还是选项文字——
 * 这两件事在界面上长得像，在库里完全不同。
 */
const FIELD_LABELS: Partial<Record<PatchOp["op"], string>> = {
  setAnswer: "答案",
  setExplanation: "解析",
  setRequired: "必答",
  setMeta: "标注",
  setMaxLength: "字数上限",
};

function whereOf(items: readonly FormItem[], itemId: string): string {
  const index = items.findIndex((item) => item.id === itemId);
  return index < 0 ? `题目 ${itemId}` : `第 ${String(index + 1)} 题`;
}

function fail(opIndex: number, code: PatchErrorCode, message: string): PatchResult {
  return { ok: false, errors: [{ code, opIndex, message }] };
}

/**
 * 结构上带 `score` 的题型（R-01 之后含简答）；分节与量表不带。
 *
 * 用 switch 而不是 `item.type !== "section" && ...`：类型收窄要看得见，
 * 否则 `item.score` 在联合类型上不可读，编译器也不认。
 */
function scoreOf(item: FormItem): number | null {
  switch (item.type) {
    case "single":
    case "multi":
    case "fill":
    case "number":
    case "short":
      return item.score ?? 0;
    default:
      return null;
  }
}

function supportsOptions(item: FormItem): boolean {
  return item.type === "single" || item.type === "multi";
}

/** 选项 id → 选项文字；找不到时退回 id（让差异条至少能显示"改到了哪一项"）。 */
function optionTextOf(item: FormItem, optionId: string): string {
  if (item.type === "single" || item.type === "multi") {
    return item.options.find((option) => option.id === optionId)?.text ?? optionId;
  }
  return optionId;
}

/** 答案载荷的人话版本：**一律用选项文字**，显示 id 对教师没有意义。 */
function answerPayloadText(item: FormItem, payload: AnswerPayload): string {
  switch (payload.type) {
    case "single":
      return optionTextOf(item, payload.answer);
    case "multi":
      return payload.answer.map((id) => optionTextOf(item, id)).join("、");
    case "fill":
      return payload.answer.join("／");
    case "number": {
      const { value, tolerance } = payload.answer;
      return tolerance === 0 ? String(value) : `${String(value)} ± ${String(tolerance)}`;
    }
  }
}

/** 当前答案的人话版本（差异条的 `before`）；没有答案时显示「（未设）」。 */
function currentAnswerText(item: FormItem): string {
  switch (item.type) {
    case "single":
      return item.answer === undefined ? "（未设）" : optionTextOf(item, item.answer);
    case "multi":
      return item.answer === undefined ? "（未设）" : item.answer.map((id) => optionTextOf(item, id)).join("、");
    case "fill":
      return item.answer === undefined ? "（未设）" : item.answer.join("／");
    case "number":
      return item.answer === undefined
        ? "（未设）"
        : item.answer.tolerance === 0
          ? String(item.answer.value)
          : `${String(item.answer.value)} ± ${String(item.answer.tolerance)}`;
    default:
      return "（无）";
  }
}

function answerEquals(item: FormItem, payload: AnswerPayload): boolean {
  switch (payload.type) {
    case "single":
      return item.type === "single" && item.answer === payload.answer;
    case "multi":
      return (
        item.type === "multi" &&
        item.answer !== undefined &&
        item.answer.length === payload.answer.length &&
        item.answer.every((id, index) => id === payload.answer[index])
      );
    case "fill":
      return (
        item.type === "fill" &&
        item.answer !== undefined &&
        item.answer.length === payload.answer.length &&
        item.answer.every((blank, index) => blank === payload.answer[index])
      );
    case "number":
      return (
        item.type === "number" &&
        item.answer !== undefined &&
        item.answer.value === payload.answer.value &&
        item.answer.tolerance === payload.answer.tolerance
      );
  }
}

/** 教学标注的人话版本：`apply · kp2`；两个都空时是「（无标注）」。 */
function metaText(bloom: string | null, knowledgePoint: string | null): string {
  if (bloom === null && knowledgePoint === null) return "（无标注）";
  return `${bloom ?? "—"} · ${knowledgePoint ?? "—"}`;
}

/** 删掉一个可选键（`null` 的落库方式：删键，不写空串/`null`）。 */
function omitKey<T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

/**
 * 删掉解析键。
 *
 * 不能对联合类型直接 `Omit`：`Omit<Union, "explanation">` 会塌成公共字段，
 * 简答的 `maxLength` 这类成员私有字段就丢了。按成员分别 spread 再 delete，
 * 判别联合的结构才保得住。
 */
function withoutExplanation(item: FormItem): FormItem {
  switch (item.type) {
    case "single":
    case "multi":
    case "fill":
    case "number":
    case "short": {
      const copy = { ...item };
      delete copy.explanation;
      return copy;
    }
    case "scale":
    case "section":
      return item;
  }
}

/** 把答案载荷落到题目上；载荷与题型不符时返回 `null`。 */
function withAnswer(item: FormItem, payload: AnswerPayload): FormItem | null {
  switch (payload.type) {
    case "single":
      return item.type === "single" ? { ...item, answer: payload.answer } : null;
    case "multi":
      return item.type === "multi" ? { ...item, answer: payload.answer } : null;
    case "fill":
      return item.type === "fill" ? { ...item, answer: payload.answer } : null;
    case "number":
      return item.type === "number" ? { ...item, answer: payload.answer } : null;
  }
}

/** 自动重算 quiz 的总分。返回值可能是原值（无需变更），调用方据此决定是否记一条变更。 */
function recomputeTotalScore(schema: FormSchema): FormSchema {
  if (schema.meta.kind !== "quiz") return schema;
  let sum = 0;
  for (const item of schema.items) sum += scoreOf(item) ?? 0;
  if (schema.meta.totalScore === sum) return schema;
  return { ...schema, meta: { ...schema.meta, totalScore: sum } };
}

/** 把 zod 的结构错误压成一条人话，够界面显示即可（完整 issue 列表不进响应）。 */
function describeIssues(issues: readonly z.ZodIssue[]): string {
  const first = issues[0];
  if (first === undefined) return "修改后的表单结构不合法";
  const where = first.path.length === 0 ? "根" : first.path.join(".");
  return `${where}：${first.message}`;
}

/**
 * 依次应用 ops，遇到第一个错误就停（不返回"半套改动"）：
 * 教师在 Diff 预览里看到的是「要么全改了，要么没改」，不存在改了一半的版本。
 */
export function applyPatch(input: FormSchema, ops: readonly PatchOp[]): PatchResult {
  let items: FormItem[] = [...input.items];
  const changes: PatchChange[] = [];

  for (let i = 0; i < ops.length; i += 1) {
    const op = ops[i] as PatchOp;
    const label = OP_LABELS[op.op];

    if (op.op === "addItem") {
      if (op.index > items.length) {
        return fail(i, "patch_index_out_of_range", `${label}：位置 ${String(op.index)} 超出题目数 ${String(items.length)}`);
      }
      if (items.some((item) => item.id === op.item.id)) {
        return fail(i, "patch_duplicate_item_id", `${label}：题目 id ${op.item.id} 已存在`);
      }
      items = [...items.slice(0, op.index), op.item, ...items.slice(op.index)];
      changes.push({
        op: op.op,
        itemId: op.item.id,
        where: `第 ${String(op.index + 1)} 题`,
        before: "（无）",
        after: `新增「${op.item.title}」`,
      });
      continue;
    }

    const index = items.findIndex((item) => item.id === op.itemId);
    if (index < 0) {
      return fail(i, "patch_item_not_found", `${label}：找不到题目 ${op.itemId}`);
    }
    const target = items[index] as FormItem;
    const where = whereOf(items, op.itemId);

    if (op.op === "setStem") {
      if (target.title === op.title) continue;
      items = items.map((item, at) => (at === index ? { ...item, title: op.title } : item));
      changes.push({ op: op.op, itemId: op.itemId, where, before: target.title, after: op.title });
      continue;
    }

    if (op.op === "setScore") {
      const currentScore = scoreOf(target);
      if (currentScore === null) {
        return fail(i, "patch_score_unsupported", `${label}：${where}是分节，没有分值`);
      }
      const before = currentScore;
      if (before === op.score) continue;
      items = items.map((item, at) => (at === index ? { ...item, score: op.score } : item));
      changes.push({
        op: op.op,
        itemId: op.itemId,
        where,
        before: `${String(before)} 分`,
        after: `${String(op.score)} 分`,
      });
      continue;
    }

    if (op.op === "setOptions") {
      if (!supportsOptions(target)) {
        return fail(i, "patch_options_unsupported", `${label}：${where}不是选择题，没有选项`);
      }
      const before = "options" in target ? target.options.map((o) => o.text).join(" / ") : "";
      const after = op.options.map((o) => o.text).join(" / ");
      if (before === after) continue;
      items = items.map((item, at) => (at === index ? { ...item, options: op.options } : item));
      changes.push({ op: op.op, itemId: op.itemId, where, before, after });
      continue;
    }

    if (op.op === "setAnswer") {
      const nextItem = withAnswer(target, op.answer);
      if (nextItem === null) {
        return fail(
          i,
          "patch_answer_unsupported",
          `${label}：${where}是 ${target.type} 题，不能写成 ${op.answer.type} 的答案`,
        );
      }
      if (answerEquals(target, op.answer)) continue;
      items = items.map((item, at) => (at === index ? nextItem : item));
      changes.push({
        op: op.op,
        itemId: op.itemId,
        where: `${where} · ${FIELD_LABELS[op.op] ?? ""}`,
        before: currentAnswerText(target),
        after: answerPayloadText(target, op.answer),
      });
      continue;
    }

    if (op.op === "setExplanation") {
      if (target.type === "section") {
        const before = target.description ?? null;
        if (before === op.explanation) continue;
        const nextItem: FormItem =
          op.explanation === null ? omitKey(target, "description") : { ...target, description: op.explanation };
        items = items.map((item, at) => (at === index ? nextItem : item));
        changes.push({
          op: op.op,
          itemId: op.itemId,
          where: `${where} · ${FIELD_LABELS[op.op] ?? ""}`,
          before: before ?? "（无）",
          after: op.explanation ?? "（无）",
        });
        continue;
      }
      if (target.type === "scale") {
        return fail(i, "patch_explanation_unsupported", `${label}：${where}是量表，没有解析栏`);
      }
      const before = target.explanation ?? null;
      if (before === op.explanation) continue;
      const nextItem: FormItem =
        op.explanation === null ? withoutExplanation(target) : { ...target, explanation: op.explanation };
      items = items.map((item, at) => (at === index ? nextItem : item));
      changes.push({
        op: op.op,
        itemId: op.itemId,
        where: `${where} · ${FIELD_LABELS[op.op] ?? ""}`,
        before: before ?? "（无）",
        after: op.explanation ?? "（无）",
      });
      continue;
    }

    if (op.op === "setRequired") {
      if (target.type === "section") {
        return fail(i, "patch_required_unsupported", `${label}：${where}是分节，没有必答设置`);
      }
      if (target.required === op.required) continue;
      const nextItem: FormItem = { ...target, required: op.required };
      items = items.map((item, at) => (at === index ? nextItem : item));
      changes.push({
        op: op.op,
        itemId: op.itemId,
        where: `${where} · ${FIELD_LABELS[op.op] ?? ""}`,
        before: target.required ? "必答" : "选答",
        after: op.required ? "必答" : "选答",
      });
      continue;
    }

    if (op.op === "setMeta") {
      if (target.type === "scale" || target.type === "section") {
        return fail(i, "patch_meta_unsupported", `${label}：${where}是量表/分节，没有教学标注`);
      }
      const beforeBloom = target.bloom ?? null;
      const beforeKp = target.knowledgePoint ?? null;
      if (beforeBloom === op.bloom && beforeKp === op.knowledgePoint) continue;

      // `{...target}` 的副本上删键：`null` 的落库方式是删键，不是写 `null`/`""`。
      const nextItem = { ...target };
      if (op.bloom === null) delete nextItem.bloom;
      else nextItem.bloom = op.bloom;
      if (op.knowledgePoint === null) delete nextItem.knowledgePoint;
      else nextItem.knowledgePoint = op.knowledgePoint;

      items = items.map((item, at) => (at === index ? nextItem : item));
      changes.push({
        op: op.op,
        itemId: op.itemId,
        where: `${where} · ${FIELD_LABELS[op.op] ?? ""}`,
        before: metaText(beforeBloom, beforeKp),
        after: metaText(op.bloom, op.knowledgePoint),
      });
      continue;
    }

    if (op.op === "setMaxLength") {
      if (target.type !== "short") {
        return fail(i, "patch_maxlength_unsupported", `${label}：${where}不是简答题，没有字数上限`);
      }
      if (target.maxLength === op.maxLength) continue;
      const nextItem: FormItem = { ...target, maxLength: op.maxLength };
      items = items.map((item, at) => (at === index ? nextItem : item));
      changes.push({
        op: op.op,
        itemId: op.itemId,
        where: `${where} · ${FIELD_LABELS[op.op] ?? ""}`,
        before: `${String(target.maxLength)} 字`,
        after: `${String(op.maxLength)} 字`,
      });
      continue;
    }

    if (op.op === "removeItem") {
      items = [...items.slice(0, index), ...items.slice(index + 1)];
      changes.push({ op: op.op, itemId: op.itemId, where, before: target.title, after: "（已删除）" });
      continue;
    }

    // moveItem
    const maxIndex = items.length - 1;
    if (op.toIndex > maxIndex) {
      return fail(i, "patch_index_out_of_range", `${label}：目标位置 ${String(op.toIndex)} 超出题目数 ${String(items.length)}`);
    }
    if (op.toIndex === index) continue;
    const moved = target;
    const rest = items.filter((_, at) => at !== index);
    items = [...rest.slice(0, op.toIndex), moved, ...rest.slice(op.toIndex)];
    changes.push({
      op: op.op,
      itemId: op.itemId,
      where,
      before: `第 ${String(index + 1)} 位`,
      after: `第 ${String(op.toIndex + 1)} 位`,
    });
  }

  const draft: FormSchema = { ...input, items };
  const beforeTotal = input.meta.totalScore ?? 0;
  const next = recomputeTotalScore(draft);
  const afterTotal = next.meta.totalScore ?? 0;
  if (beforeTotal !== afterTotal) {
    changes.push({
      op: "setScore",
      where: "总分",
      before: `${String(beforeTotal)} 分`,
      after: `${String(afterTotal)} 分`,
    });
  }

  // 结构再过一遍 zod：单条 op 合法不等于组合结果合法（例如把唯一选项删到不足两条）。
  const parsed = formSchema.safeParse(next);
  if (!parsed.success) {
    return fail(ops.length - 1, "patch_schema_invalid", describeIssues(parsed.error.issues));
  }
  // 用解析结果而不是 next：`formSchema` 会补默认值（required / maxLength），
  // 落库前统一成「解析后」的形状，读侧就不用再猜哪些默认值没写。
  const schema = parsed.data as FormSchema;
  if (changes.length === 0) {
    return { ok: true, schema, changes: [] };
  }
  return { ok: true, schema, changes };
}
