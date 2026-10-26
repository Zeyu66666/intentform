/**
 * 整表发布门禁（《计划 v3.0》§2.5）。
 *
 * 为什么逐行校验不够：`validateLine()` 只回答「这一行是不是一个合法节点」，
 * 它看不见「这些节点拼起来是不是一份能发出去的表」。一条答案 id 写错的单选题
 * 自己完全合法，和被判 100 分的整表放在一起才成为事故。所以 `done` 事件之前
 * 必须再跑一次整表校验，不通过就**不发 `done`**（§3.6）。
 *
 * I2 的边界（不许假装做到了）：
 * - 这里的 meta 是**校验用的候选壳**，不是要发布的内容——I2 还没有表单元信息
 *   编辑器，标题/总分/知识点声明都得等整表编辑（I4）。因此 `title` 用占位串、
 *   `totalScore` 按节点实际分值求和、`objectives` 按节点里出现过的知识点反推。
 * - 结果是：`E_SCORE_SUM` 与 `E_KP_UNKNOWN` 在这道门禁里**恒不触发**（元信息由
 *   我们自己凑出来，自然自洽），真正起作用的是 R1 重复 id、R2–R5 答案合法性、
 *   R7 LaTeX 可解析、R6「survey 不得含判分题」，以及结构上限。
 * - I4 有了真实元信息后，只需把候选壳换成真实 meta，这道门禁的其余部分不动。
 */

import { LIMITS, validateForm } from "@intentform/schema";
import type { ErrorCode, FormItem, FormKind, SchemaError, ScoredField } from "@intentform/schema";

/** 门禁输入：已通过逐行校验的节点，`index` 是它在本次生成里的序位。 */
export interface GateField {
  readonly index: number;
  readonly node: FormItem;
}

/** 挂在某个具体节点上、可以变成 `field_error` 的错误。 */
export interface GateItemError {
  readonly index: number;
  readonly id: string;
  readonly codes: readonly ErrorCode[];
  /** 该节点的 JSON 原文（截断），让教师端能看见「哪一行被门禁拦了」。 */
  readonly raw: string;
}

export interface PublishGateResult {
  readonly ok: boolean;
  /** 节点级错误：能定位到具体某一行，回喂模型可以只改那一行。 */
  readonly itemErrors: readonly GateItemError[];
  /** 整表级错误（`meta.*` 或跨行关系）：只能整表回退，没法点名某一行。 */
  readonly formErrors: readonly SchemaError[];
}

/** 候选用占位标题：只为满足 `title.min(1)`，绝不写进任何对外事件。 */
const CANDIDATE_TITLE = "候选表单（门禁校验用，未发布）";

const ITEM_PATH = /^items\[(\d+)\]/;

/**
 * 目标路径 `items[3].answer` → 3。不是节点级路径（`meta.totalScore`、根路径）返回 null。
 */
function itemIndexOf(path: string): number | null {
  const matched = ITEM_PATH.exec(path);
  if (matched === null) return null;
  const parsed = Number.parseInt(matched[1] ?? "", 10);
  return Number.isNaN(parsed) ? null : parsed;
}

function isScored(node: FormItem): node is ScoredField {
  return node.type === "single" || node.type === "multi" || node.type === "fill" || node.type === "number";
}

/**
 * 拼一个只用于校验的候选整表。
 *
 * 导出是因为单测要能直接看「凑出来的壳长什么样」，避免门禁的判定条件藏在闭包里。
 */
export function buildCandidateForm(
  fields: readonly GateField[],
  kind: FormKind,
): { readonly meta: Record<string, unknown>; readonly items: readonly FormItem[] } {
  const items = fields.map((field) => field.node);
  const objectiveIds = new Set<string>();
  let totalScore = 0;
  for (const node of items) {
    if (!isScored(node)) continue;
    totalScore += node.score;
    objectiveIds.add(node.knowledgePoint);
  }
  const objectives = [...objectiveIds].map((id) => ({ id, name: id }));
  if (objectives.length > LIMITS.fieldsMax) objectives.length = LIMITS.fieldsMax;

  const meta: Record<string, unknown> = { version: 1, kind, title: CANDIDATE_TITLE, objectives };
  if (kind === "quiz") meta["totalScore"] = totalScore;
  return { meta, items };
}

/**
 * 跑整表门禁。纯函数：不读环境、不打日志、不抛异常。
 *
 * 调用方（`generate.ts`）的约定：`ok === false` 时不得发 `done`。
 */
export function runPublishGate(
  fields: readonly GateField[],
  kind: FormKind,
): PublishGateResult {
  if (fields.length === 0) {
    return {
      ok: false,
      itemErrors: [],
      formErrors: [
        {
          code: "E_ANSWER_MISSING",
          path: "items",
          message: "整表没有任何节点",
          repair: "至少产出一个表单节点后再发布",
        },
      ],
    };
  }

  const result = validateForm(buildCandidateForm(fields, kind));
  if (result.ok) return { ok: true, itemErrors: [], formErrors: [] };

  const byIndex = new Map<number, { id: string; codes: ErrorCode[]; raw: string }>();
  const formErrors: SchemaError[] = [];

  for (const error of result.errors) {
    const index = itemIndexOf(error.path);
    const field = index === null ? undefined : fields.find((candidate) => candidate.index === index);
    if (index === null || field === undefined) {
      formErrors.push(error);
      continue;
    }
    const bucket = byIndex.get(index) ?? {
      id: field.node.id,
      codes: [],
      raw: JSON.stringify(field.node).slice(0, LIMITS.rawLineMax),
    };
    if (!bucket.codes.includes(error.code)) bucket.codes.push(error.code);
    byIndex.set(index, bucket);
  }

  const itemErrors = [...byIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([index, bucket]) => ({
      index,
      id: bucket.id,
      codes: bucket.codes,
      raw: bucket.raw,
    }));

  return { ok: itemErrors.length === 0 && formErrors.length === 0, itemErrors, formErrors };
}
