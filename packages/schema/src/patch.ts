/**
 * 受限修改（省赛 R-03 / I7 收缩版）：**六种操作**，不是任意改写。
 *
 * 为什么不做通用 Patch（整份 Schema 覆盖）：
 * 1. 整份覆盖等于把「生成」重放一遍，行级校验、整表门禁、prompt 溯源全部失去意义；
 * 2. 教师在界面上看到的是「第 3 题分值改成 8」，界面能表达的就这几种改动，
 *    接口比界面能表达的多，多出来的部分就是没人测过的攻击面；
 * 3. 差异要能回显给教师确认（Diff 预览），任意改写算不出人话级的差异。
 *
 * 因此这里只有六个 op：改题干 / 改选项 / 改分值 / 加题 / 删题 / 调顺序。
 * `applyPatch` 是纯函数：入参是旧 Schema 与 ops，出参是新 Schema 与**可读的变更列表**，
 * 不碰数据库、不碰 HTTP——服务端拿它落版本，前端拿它做预览，两边跑的是同一份规则。
 *
 * 关于 `totalScore`：`quiz` 的 `meta.totalScore` 必须等于各题分值之和（R6），
 * 而改分值/加题/删题都会让和变化。让它交给调用方手填，等于把「算错总分」变成
 * 一个必现的人为错误，所以这里**自动重算**，并在变更列表里显式记一条。
 */

import { z } from "zod";

import { LIMITS } from "./constants.ts";
import { choiceOptionSchema, formItemSchema, formSchema, type FormItem, type FormSchema } from "./types.ts";

/** 字段 id 在 Patch 里是寻址键，规则与 Schema 里一致。 */
const fieldId = z
  .string()
  .regex(LIMITS.idPattern, "id 需匹配 ^[a-z0-9_-]{3,32}$（小写字母/数字/下划线/连字符）");

const nonNegativeInt = z.number().int().min(0);

/**
 * 六个 op。判别键是 `op`，与 `formItemSchema` 用 `type` 判别同理：
 * 一个字段只描述一种改动，读代码时不用在十个可选字段里挑。
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
