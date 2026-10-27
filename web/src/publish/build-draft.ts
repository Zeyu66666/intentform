/**
 * 把「一次生成的内存字段」组装成 `POST /api/forms` 的请求体（纯函数，无 React、无 IO）。
 *
 * 为什么要有这一层而不是在组件里拼对象：
 *   1. 服务端有一道**整表门禁**（`packages/schema` 的 R1–R8），拼错了只会拿回一句
 *      `E_ANSWER_MISSING@items[3]`。这里在本地先跑一遍同一个 `validateForm()`
 *      （schema 层的纯函数，模块边界允许），把同一句话提前说出来，用户不用等一次往返。
 *   2. `quiz` 与 `survey` 的差别是**语义**差别，不是 UI 差别：问卷不许带 `score`/`answer`，
 *      quiz 必须有 `totalScore`。规则只在这里写一遍，组件不碰。
 *   3. 生成流只给字段，不给 `meta.objectives`。而 R8 要求每个 `knowledgePoint` 都能在
 *      `objectives` 里找到，否则每题都过不了门禁——所以草稿自己把知识点登记进去。
 *
 * 本地预检不是"替代"服务端：服务端仍然是事实源，门禁 400 的 `message` 会原样显示到界面上。
 */

import {
  LIMITS,
  SCHEMA_VERSION,
  validateForm,
  type ChoiceOption,
  type CreateFormRequest,
  type FormItem,
  type FormKind,
  type ScoredField,
  type SchemaError,
} from "@intentform/schema";

/** `title` 取需求首行，最多这么多个字符（码点计，emoji 不会被劈成半个）。 */
export const DRAFT_TITLE_MAX = 40;
/** 需求为空时的兜底标题。 */
export const DEFAULT_FORM_TITLE = "未命名表单" as const;
/** 与服务端 `describeFormErrors` 同一句话的开头，让"谁抓到的"不影响用户看到的文案。 */
export const PREFLIGHT_PREFIX = "表单未通过发布校验：" as const;
/** 门禁错误里最多列几处（与服务端一致：多的折成"（共 N 处）"）。 */
const MAX_SHOWN_ERRORS = 3;

/** 请求体里 `items` 的元素类型：来自冻结契约，不另写一份。 */
type WireItem = CreateFormRequest["schema"]["items"][number];
/** 判分型字段的公共可选元数据。 */
type Extras = {
  readonly score?: number;
  readonly bloom?: NonNullable<ScoredField["bloom"]>;
  readonly knowledgePoint?: string;
  readonly explanation?: string;
};

export type PublishDraftFailureReason =
  /** 一个字段都没有：明显是"还没生成"，不该去撞服务端门禁。 */
  | "empty-fields"
  /** 组装出来的表单本身过不了 R1–R8（缺答案、缺分值、LaTeX 坏了……）。 */
  | "invalid-schema";

export interface PublishDraftFailure {
  readonly ok: false;
  readonly reason: PublishDraftFailureReason;
  /** 可直接显示给人看的一句话。 */
  readonly message: string;
}

export interface PublishDraftSuccess {
  readonly ok: true;
  /** 交给 `createForm()` 的请求体。 */
  readonly request: CreateFormRequest;
  /** 列表页/头部展示用的短标题（≤40 字）。 */
  readonly title: string;
  /** quiz 的满分合计；survey 没有分值语义，固定 `null`。 */
  readonly totalScore: number | null;
}

export type PublishDraftResult = PublishDraftSuccess | PublishDraftFailure;

/** 取首行（`\r\n` / `\n` / `\r` 都算），不做其他清洗。 */
export function firstLineOf(text: string): string {
  const [first = ""] = text.split(/\r?\n/u);
  return first;
}

/** 按**码点**截断：`slice()` 按 UTF-16 码元切，会把 emoji 切出半个代理对。 */
function sliceCodePoints(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join("");
}

/**
 * 短标题：需求首行 → trim → ≤40 码点 → 再 trim → 空则兜底。
 *
 * 尾部的第二次 `trim()` 是必要的：截断可能正好落在一个空格上，留着就是"标题末尾有空格"。
 */
export function deriveTitle(requirementText: string): string {
  const cut = sliceCodePoints(firstLineOf(requirementText).trim(), DRAFT_TITLE_MAX).trim();
  return cut === "" ? DEFAULT_FORM_TITLE : cut;
}

/**
 * `meta.title`：≤200 字，把多行需求压成一行（列表页是单行展示）。
 * 与 `deriveTitle` 两个长度是故意的：列表页短、表单头长。
 */
function deriveMetaTitle(requirementText: string): string {
  const lines = requirementText
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const single = sliceCodePoints(lines.join(" "), LIMITS.formTitleMax).trim();
  return single === "" ? DEFAULT_FORM_TITLE : single;
}

/** 只有这四种题型参与判分与 `totalScore`（与 `rules.ts` 的 `isScoredItem` 一致）。 */
function scoreOf(item: FormItem): number {
  switch (item.type) {
    case "single":
    case "multi":
    case "fill":
    case "number":
      return item.score ?? 0;
    case "short":
    case "scale":
    case "section":
      return 0;
  }
}

function knowledgePointOf(item: FormItem): string | undefined {
  switch (item.type) {
    case "single":
    case "multi":
    case "fill":
    case "number":
      return item.knowledgePoint;
    // short/scale 的结构里没有 knowledgePoint（它们不判分），section 更没有。
    case "short":
    case "scale":
    case "section":
      return undefined;
  }
}

/** 请求体里 `objectives` 的元素类型：同样直接取契约，不另写一份。 */
type WireObjective = CreateFormRequest["schema"]["meta"]["objectives"][number];

/**
 * 把题目引用到的知识点登记成 `objectives`。
 *
 * 生成流没有 objectives 事件，而 R8 要求引用必须能解析——不登记，草稿一定被门禁挡下。
 * `name` 暂时等于 id：这是唯一能拿到的可读文本，不编造教学目标的措辞。
 */
function collectObjectives(fields: readonly FormItem[]): WireObjective[] {
  const seen = new Set<string>();
  const objectives: WireObjective[] = [];
  for (const item of fields) {
    const id = knowledgePointOf(item);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    objectives.push({ id, name: id });
  }
  return objectives;
}

/** 问卷剥掉分值；quiz 原样带分。两者都保留 bloom/知识点/解析（门禁只禁 score 与 answer）。 */
function scoredExtras(item: ScoredField, kind: FormKind): Extras {
  const shared: Extras = {
    ...(item.bloom === undefined ? {} : { bloom: item.bloom }),
    ...(item.knowledgePoint === undefined ? {} : { knowledgePoint: item.knowledgePoint }),
    ...(item.explanation === undefined ? {} : { explanation: item.explanation }),
  };
  if (kind !== "quiz") return shared;
  return { ...shared, ...(item.score === undefined ? {} : { score: item.score }) };
}

function toWireOptions(options: readonly ChoiceOption[]): { id: string; text: string }[] {
  return options.map((option) => ({ id: option.id, text: option.text }));
}

/**
 * 单题换算：`FormItem`（深度只读）→ 请求体的可变结构。
 *
 * 逐字段显式重建而不是 `structuredClone`/展开整个对象：
 *   - 展开会把生成侧可能多带的键一起送上去；
 *   - survey 剥 `score`/`answer` 必须是**显式**动作，藏在通用转换里以后没人找得到。
 */
function toWireItem(item: FormItem, kind: FormKind): WireItem {
  const quiz = kind === "quiz";

  switch (item.type) {
    case "section":
      return {
        type: "section",
        id: item.id,
        title: item.title,
        ...(item.description === undefined ? {} : { description: item.description }),
      };
    case "single":
      return {
        type: "single",
        id: item.id,
        title: item.title,
        required: item.required,
        ...scoredExtras(item, kind),
        options: toWireOptions(item.options),
        ...(quiz && item.answer !== undefined ? { answer: item.answer } : {}),
      };
    case "multi":
      return {
        type: "multi",
        id: item.id,
        title: item.title,
        required: item.required,
        ...scoredExtras(item, kind),
        options: toWireOptions(item.options),
        ...(quiz && item.answer !== undefined ? { answer: [...item.answer] } : {}),
      };
    case "fill":
      return {
        type: "fill",
        id: item.id,
        title: item.title,
        required: item.required,
        ...scoredExtras(item, kind),
        ...(quiz && item.answer !== undefined ? { answer: [...item.answer] } : {}),
      };
    case "number":
      return {
        type: "number",
        id: item.id,
        title: item.title,
        required: item.required,
        ...scoredExtras(item, kind),
        ...(quiz && item.answer !== undefined
          ? { answer: { value: item.answer.value, tolerance: item.answer.tolerance } }
          : {}),
      };
    case "short":
      return {
        type: "short",
        id: item.id,
        title: item.title,
        required: item.required,
        maxLength: item.maxLength,
      };
    case "scale":
      return {
        type: "scale",
        id: item.id,
        title: item.title,
        required: item.required,
        min: item.min,
        max: item.max,
        ...(item.labels === undefined
          ? {}
          : { labels: [item.labels[0] ?? "", item.labels[1] ?? ""] }),
      };
  }
}

/**
 * 门禁错误 → `E_X@items[3].answer` 这种一行字（与服务端 `describeFormErrors` 同格式）。
 * 超过 3 处折成"（共 N 处）"，避免一屏红字把真正要看的那条挤掉。
 */
export function formatGateErrors(errors: readonly SchemaError[]): string {
  const shown = errors
    .slice(0, MAX_SHOWN_ERRORS)
    .map((error) => `${error.code}@${error.path}`)
    .join("、");
  return errors.length > MAX_SHOWN_ERRORS ? `${shown}（共 ${String(errors.length)} 处）` : shown;
}

/**
 * 组装草稿。
 *
 * 失败是**可判定**的两种：没有字段、或过不了本地预检。不返回"半成品"——
 * 半成品只会在服务端换来一句更晚、更难定位的 400。
 */
export function buildPublishDraft(
  fields: readonly FormItem[],
  requirementText: string,
  kind: FormKind,
): PublishDraftResult {
  if (fields.length === 0) {
    return {
      ok: false,
      reason: "empty-fields",
      message: "还没有可发布的字段：先生成一份表单，再点「保存并发布」。",
    };
  }

  const items = fields.map((item) => toWireItem(item, kind));
  const scoreSum = fields.reduce((sum, item) => sum + scoreOf(item), 0);

  const meta: CreateFormRequest["schema"]["meta"] = {
    version: SCHEMA_VERSION,
    kind,
    title: deriveMetaTitle(requirementText),
    objectives: collectObjectives(fields),
    // 问卷绝不能带 totalScore（R6：`E_SCORE_SUM@meta.totalScore`）。
    ...(kind === "quiz" ? { totalScore: scoreSum } : {}),
  };

  const request: CreateFormRequest = {
    title: deriveTitle(requirementText),
    kind,
    schema: { meta, items },
    source: "generate",
  };

  // 与服务端同一套规则、同一个实现：这里过不了，服务端一定也过不了。
  const verdict = validateForm(request.schema);
  if (!verdict.ok) {
    return {
      ok: false,
      reason: "invalid-schema",
      message: `${PREFLIGHT_PREFIX}${formatGateErrors(verdict.errors)}`,
    };
  }

  return {
    ok: true,
    request,
    title: request.title,
    totalScore: kind === "quiz" ? scoreSum : null,
  };
}
