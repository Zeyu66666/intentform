/**
 * 编辑态 → `PatchOp[]` 的纯函数层（省赛 R-03「受限修改」的前端一半）。
 *
 * 三件不做的事，正是这一层存在的理由：
 *   1. **不自己算总分**。`meta.totalScore` 必须等于各题分值之和，这个和只有
 *      `applyPatch()` 里的重算逻辑会算。前端再算一遍就是两份真相，改分值与加题
 *      两条路径迟早会算出不同的数。
 *   2. **不自己拼 Schema**。预览用哪份 Schema，一律以 `applyPatch()` 的返回为准：
 *      它顺带跑 `formSchema.safeParse` 补默认值（`required` / `maxLength`），
 *      所以预览里看到的形状与保存后读回来的形状一致，不会"保存完突然多出字段"。
 *   3. **不猜「有没有改动」**。判据是 `changes.length`，不是"和初始快照逐字段比"：
 *      改完又改回去的题干在 `changes` 里根本不出现，那就不该让「保存」可点。
 *
 * 编辑态刻意做成「意图 + 草稿」，而不是「一份正在被就地改写的 Schema」：
 * 提交给服务端的必须是 op 数组（服务端自己 `applyPatch` 落版本），前端若也持有
 * 一份改过的 Schema，就等于把应用逻辑实现了两遍。
 */

import {
  LIMITS,
  applyPatch,
  formItemSchema,
  type AnswerPayload,
  type BloomLevel,
  type ChoiceOption,
  type FormItem,
  type FormKind,
  type FormSchema,
  type ItemImage,
  type PatchChange,
  type PatchError,
  type PatchFormRequest,
  type PatchOp,
} from "@intentform/schema";

import { answerDraftOf, answerDraftOfPayload, supportsAnswer, toAnswerPayload, type AnswerDraft } from "./answer-input";

/**
 * 结构性编辑意图。文本类改动（题干、分值）不走这里——它们是"草稿"，
 * 因为教师会一个字符一个字符地敲，每敲一下就排一条 op 既没有意义，也会让
 * Diff 预览变成一长串噪声。
 */
export type AddItemOptions = {
  /** 预先算好的 id；补题入口用它把新题直接选中。 */
  readonly id?: string;
  /** 手工补题：模板题预填的知识点与层级。 */
  readonly knowledgePoint?: string;
  readonly bloom?: BloomLevel;
  /** 模型补题：直接带入整道候选题。 */
  readonly item?: FormItem;
};

export type EditIntent =
  | ({ readonly kind: "add" } & AddItemOptions)
  | { readonly kind: "remove"; readonly itemId: string }
  /** `toIndex` 是**移动后**的下标，与 `moveItem` op 的口径一致，不做二次换算。 */
  | { readonly kind: "move"; readonly itemId: string; readonly toIndex: number };

/**
 * 界面用的题目草稿：已把 Schema 里的值回落进来，字段必定齐全，面板不用自己兜底。
 *
 * 不适用的字段用 `null` 表示（分节没有分值/答案/必答/标注，量表没有答案/标注），
 * 而不是留空串——空串是"教师清空了"，`null` 是"这题结构上没有这一栏"。
 */
export interface ItemDraft {
  /** 题干输入框的原文（未 trim）：让教师能打出首尾空格而不被吞。 */
  readonly stem: string;
  /** 分值输入框的原文（已在界面层解析成 number，解析失败为 `NaN`）。 */
  readonly score: number;
  /** 选择题的选项；其它题型为 `null`。 */
  readonly options: readonly ChoiceOption[] | null;
  /** 答案的可编辑形状；无答案题型为 `null`。 */
  readonly answer: AnswerDraft | null;
  /** 解析原文；空串 = 没有解析（落库时删键）。 */
  readonly explanation: string;
  /** 必答；分节为 `null`（结构上没有）。 */
  readonly required: boolean | null;
  readonly bloom: BloomLevel | null;
  readonly knowledgePoint: string | null;
  /** 简答的字数上限；其它题型为 `null`。 */
  readonly maxLength: number | null;
  /** 配图；`null` 表示没有图（或教师刚移除）。 */
  readonly image: ItemImage | null;
}

/**
 * 内部存的**稀疏**草稿：只记教师真的碰过的字段。
 *
 * 为什么不是两个字段都给默认值：加进来的新题不在 `state.schema` 里，`withStem()`
 * 拿不到它的分值；若此时顺手把分值补成 0，教师只是改了题干、新题的分值却被
 * 静默清零。缺省 = "没碰过"，`planPatch()` 据此不出分值的 op。
 */
type DraftPatch = {
  readonly stem?: string;
  readonly score?: number;
  /** 整组替换，与 `setOptions` 同口径。 */
  readonly options?: readonly ChoiceOption[];
  /** 载荷自带 type，和 `setAnswer` 共用一份类型。 */
  readonly answer?: AnswerPayload;
  /** `null` / 空串都表示清空。 */
  readonly explanation?: string | null;
  readonly required?: boolean;
  readonly bloom?: BloomLevel | null;
  readonly knowledgePoint?: string | null;
  readonly maxLength?: number;
  /** `null` 表示移除配图；字段缺省表示「没碰过」。 */
  readonly image?: ItemImage | null;
};

export interface EditState {
  /** 乐观锁基准：本次编辑是从哪个草稿版本改出来的。 */
  readonly baseVersionId: string;
  /** 服务端读回来的原始 Schema，一切预览都以它为底座。 */
  readonly schema: FormSchema;
  /** 当前选中的题目 id；`null` 或指向已删题时由界面回落到第一题。 */
  readonly selectedItemId: string | null;
  /**
   * 按题目 id 存草稿，而不是只存"当前选中那题"：
   * 教师改完第 1 题点开第 2 题，第 1 题的改动不能凭空消失。
   */
  readonly drafts: Readonly<Record<string, DraftPatch>>;
  readonly intents: readonly EditIntent[];
}

export interface PlanRejection {
  /** `invalid-input`：本地校验就没过（不发请求）；`patch-rejected`：`applyPatch` 拒绝了这组 op。 */
  readonly kind: "invalid-input" | "patch-rejected";
  readonly message: string;
  readonly errors: readonly PatchError[];
}

export type PatchPlan =
  | {
      readonly ok: true;
      /** 预览用的 Schema（`applyPatch` 的输出，不是本地拼的）。 */
      readonly preview: FormSchema;
      readonly ops: readonly PatchOp[];
      readonly changes: readonly PatchChange[];
      /** 可直接交给 `patchForm()` 的请求体。 */
      readonly request: PatchFormRequest;
      /** 等于 `changes.length > 0`；界面据此决定「保存」是否可点。 */
      readonly hasChanges: boolean;
    }
  | ({ readonly ok: false } & PlanRejection);

/** 新题模板：简答。理由是没有选项要填，加进来的题立刻可编辑、不会卡在"选项不足两条"。 */
const NEW_ITEM_TITLE = "新题：请填写题干" as const;
const NEW_ITEM_ID_PREFIX = "q-new-" as const;
/** quiz 的题要计分，给一个新题一个占位分值，避免存下来的卷子总分突然不守恒。 */
const NEW_ITEM_SCORE = 5 as const;

/** `addItem` 的 `item` 就是契约里那一支的类型，不另抄一份、也不需要断言。 */
type NewItem = Extract<PatchOp, { op: "addItem" }>["item"];

export function newItemTemplate(id: string, kind: FormKind): NewItem {
  switch (kind) {
    case "quiz":
      return {
        type: "short",
        id,
        title: NEW_ITEM_TITLE,
        required: true,
        score: NEW_ITEM_SCORE,
        maxLength: LIMITS.shortDefaultMaxLength,
      };
    case "survey":
      // survey 一律不许带分值与答案（语义规则 R5/R6），模板跟着分开。
      return {
        type: "short",
        id,
        title: NEW_ITEM_TITLE,
        required: true,
        maxLength: LIMITS.shortDefaultMaxLength,
      };
  }
}

/**
 * 挑一个没被占用的新题 id。
 *
 * 用固定前缀 + 序号而不是随机串：Diff 预览里出现 `q-new-2` 比出现
 * `x7Kd2p` 更容易对上"我刚加的那道题"。序号扫描有界（题目上限 100），
 * 不会退化成无限循环。
 */
export function nextItemId(items: readonly FormItem[]): string {
  const used = new Set(items.map((item) => item.id));
  for (let n = 1; n <= LIMITS.fieldsMax + 1; n += 1) {
    const candidate = `${NEW_ITEM_ID_PREFIX}${String(n)}`;
    if (!used.has(candidate)) return candidate;
  }
  // 理论上到不了：`items` 最多 `fieldsMax` 条，而这里试了 `fieldsMax + 1` 个候选。
  return `${NEW_ITEM_ID_PREFIX}${String(used.size + 1)}`;
}

/**
 * 题型是否有分值。口径与 `applyPatch()` 里的实现一致（`single|multi|fill|number|short`），
 * 分节与量表返回 `null`——界面据此把分值输入框藏起来。
 */
export function scoreOfItem(item: FormItem): number | null {
  switch (item.type) {
    case "single":
    case "multi":
    case "fill":
    case "number":
    case "short":
      return item.score ?? 0;
    case "scale":
    case "section":
      return null;
  }
}

export function findItem(items: readonly FormItem[], itemId: string): FormItem | null {
  return items.find((item) => item.id === itemId) ?? null;
}

/**
 * 解析「右侧面板该显示哪道题」。
 *
 * 不变量：选中 id 可能指向一道刚被删掉（预览里已不存在）的题。这里回落到第一题，
 * 而不是让面板显示一个不存在的 id——那会让下一次改题干直接打到不存在的题目上。
 */
export function resolveSelection(schema: FormSchema, selectedItemId: string | null): FormItem | null {
  const found = selectedItemId === null ? null : findItem(schema.items, selectedItemId);
  return found ?? schema.items[0] ?? null;
}

/** Schema 里现有的答案；没有答案时 `null`（与"答案是空串"区分开）。 */
export function answerPayloadOf(item: FormItem): AnswerPayload | null {
  const draft = answerDraftOf(item);
  return draft === null ? null : toAnswerPayload(draft);
}

/** 某道题的当前草稿：没碰过的字段用 Schema 里的值，省得界面自己写一遍回落逻辑。 */
export function draftOf(state: EditState, item: FormItem): ItemDraft {
  const draft = state.drafts[item.id];

  const rawAnswer = draft?.answer ?? answerPayloadOf(item);
  const explanation = ((): string => {
    if (draft?.explanation !== undefined) return draft.explanation ?? "";
    if (item.type === "section") return item.description ?? "";
    if ("explanation" in item) return item.explanation ?? "";
    return "";
  })();

  return {
    stem: draft?.stem ?? item.title,
    score: draft?.score ?? scoreOfItem(item) ?? 0,
    options: draft?.options ?? ("options" in item ? item.options : null),
    answer: rawAnswer === null ? null : answerDraftOfPayload(rawAnswer),
    explanation,
    required: "required" in item ? (draft?.required ?? item.required) : null,
    bloom: "bloom" in item ? (draft?.bloom !== undefined ? draft.bloom : item.bloom ?? null) : null,
    knowledgePoint:
      "knowledgePoint" in item
        ? draft?.knowledgePoint !== undefined
          ? draft.knowledgePoint
          : item.knowledgePoint ?? null
        : null,
    maxLength: item.type === "short" ? (draft?.maxLength ?? item.maxLength) : null,
    image: draft?.image !== undefined ? draft.image : (item.image ?? null),
  };
}

export function initialEditState(schema: FormSchema, baseVersionId: string): EditState {
  return {
    baseVersionId,
    schema,
    selectedItemId: null,
    drafts: {},
    intents: [],
  };
}

export function withSelection(state: EditState, itemId: string | null): EditState {
  return { ...state, selectedItemId: itemId };
}

export function withStem(state: EditState, itemId: string, stem: string): EditState {
  // 只覆盖题干这一个字段：另一字段若本来是"没碰过"，改完题干后仍然是"没碰过"。
  return { ...state, drafts: { ...state.drafts, [itemId]: { ...state.drafts[itemId], stem } } };
}

export function withScore(state: EditState, itemId: string, score: number): EditState {
  return { ...state, drafts: { ...state.drafts, [itemId]: { ...state.drafts[itemId], score } } };
}

/** 所有单字段写入共用一件正确的事：保留该题已有的其它草稿字段。 */
function mergeDraft(state: EditState, itemId: string, patch: DraftPatch): EditState {
  return { ...state, drafts: { ...state.drafts, [itemId]: { ...state.drafts[itemId], ...patch } } };
}

export function withOptions(state: EditState, itemId: string, options: readonly ChoiceOption[]): EditState {
  return mergeDraft(state, itemId, { options });
}

export function withAnswer(state: EditState, itemId: string, answer: AnswerPayload): EditState {
  return mergeDraft(state, itemId, { answer });
}

export function withExplanation(state: EditState, itemId: string, explanation: string): EditState {
  return mergeDraft(state, itemId, { explanation });
}

export function withRequired(state: EditState, itemId: string, required: boolean): EditState {
  return mergeDraft(state, itemId, { required });
}

export function withMeta(
  state: EditState,
  itemId: string,
  meta: { readonly bloom: BloomLevel | null; readonly knowledgePoint: string | null },
): EditState {
  return mergeDraft(state, itemId, { bloom: meta.bloom, knowledgePoint: meta.knowledgePoint });
}

export function withMaxLength(state: EditState, itemId: string, maxLength: number): EditState {
  return mergeDraft(state, itemId, { maxLength });
}

export function withImage(state: EditState, itemId: string, image: ItemImage | null): EditState {
  return mergeDraft(state, itemId, { image });
}

/**
 * 「这题改回原样」：只删本地草稿，不产生任何 op、不产生版本。
 *
 * 删 key 而不是把字段写成 Schema 的当前值：后者在下一轮 Schema 变了之后会变成
 * 一条"改回旧值"的真实改动，前者永远是"没碰过"。
 */
export function withClearItemDraft(state: EditState, itemId: string): EditState {
  const rest = { ...state.drafts };
  delete rest[itemId];
  return { ...state, drafts: rest };
}

export function withAddItem(state: EditState, options: AddItemOptions = {}): EditState {
  return { ...state, intents: [...state.intents, { kind: "add", ...options }] };
}

export function withRemoveItem(state: EditState, itemId: string): EditState {
  return { ...state, intents: [...state.intents, { kind: "remove", itemId }] };
}

export function withMoveItem(state: EditState, itemId: string, toIndex: number): EditState {
  return { ...state, intents: [...state.intents, { kind: "move", itemId, toIndex }] };
}

/** 上移/下移的落点；到头了给 `null`，界面据此禁用按钮（下标换算只此一处）。 */
export function moveTargets(
  items: readonly FormItem[],
  itemId: string,
): { readonly up: number | null; readonly down: number | null } {
  const index = items.findIndex((item) => item.id === itemId);
  if (index < 0) return { up: null, down: null };
  return {
    up: index > 0 ? index - 1 : null,
    down: index < items.length - 1 ? index + 1 : null,
  };
}

function reject(kind: PlanRejection["kind"], message: string, errors: readonly PatchError[] = []): PatchPlan {
  return { ok: false, kind, message, errors };
}

/**
 * 编辑态 → 请求体。
 *
 * 两遍结构：
 *   1. **结构意图先落地**。每排一条 op 就在"上一步的结果"上试跑一次，所以加题的 id
 *      和移动的下标都是对着当前形状算的，而不是对着最初那份 Schema 猜。
 *   2. **再把草稿收成文本 op**，按最终 Schema 的题目顺序走一遍，Diff 的顺序因此
 *      与题目列表一致，不会东一条西一条。
 *
 * 最后**整组 ops 再跑一次** `applyPatch()`，拿它给出的 `changes` 当唯一真相：
 * 服务端也是一次性应用整个数组，分步 changes 会多算几条"总分"中间值，
 * 预览要显示的是教师将看到的最终差异。
 */
export function planPatch(state: EditState): PatchPlan {
  const ops: PatchOp[] = [];
  let schema = state.schema;

  const advance = (op: PatchOp): PlanRejection | null => {
    const result = applyPatch(schema, [op]);
    if (!result.ok) {
      const first = result.errors[0];
      return {
        kind: "patch-rejected",
        message: first?.message ?? "这条修改不被接受",
        errors: result.errors,
      };
    }
    schema = result.schema;
    ops.push(op);
    return null;
  };

  for (const intent of state.intents) {
    switch (intent.kind) {
      case "add": {
        if (intent.item !== undefined) {
          const failure = advance({
            op: "addItem",
            index: schema.items.length,
            item: formItemSchema.parse(intent.item),
          });
          if (failure !== null) return { ok: false, ...failure };
          break;
        }
        const id = intent.id ?? nextItemId(schema.items);
        const template = newItemTemplate(id, schema.meta.kind);
        const item = {
          ...template,
          ...(intent.knowledgePoint === undefined ? {} : { knowledgePoint: intent.knowledgePoint }),
          ...(intent.bloom === undefined ? {} : { bloom: intent.bloom }),
        };
        const failure = advance({
          op: "addItem",
          index: schema.items.length,
          item,
        });
        if (failure !== null) return { ok: false, ...failure };
        break;
      }
      case "remove": {
        const failure = advance({ op: "removeItem", itemId: intent.itemId });
        if (failure !== null) return { ok: false, ...failure };
        break;
      }
      case "move": {
        const failure = advance({ op: "moveItem", itemId: intent.itemId, toIndex: intent.toIndex });
        if (failure !== null) return { ok: false, ...failure };
        break;
      }
    }
  }

  for (const [index, item] of schema.items.entries()) {
    const draft = state.drafts[item.id];
    // 没有草稿 = 没碰过这题；`setStem` 相同值时 `applyPatch` 本来也不会记变更，
    // 但在这里先挡掉，省一次无意义的 op。
    if (draft === undefined) continue;
    // 题号只数题目，不数分节：分节后的第一道题仍是「第 1 题」。
    const question =
      item.type === "section"
        ? `分节「${item.title}」`
        : `第 ${String(schema.items.slice(0, index + 1).filter((node) => node.type !== "section").length)} 题`;

    if (draft.stem !== undefined) {
      const title = draft.stem.trim();
      if (title === "") {
        return reject("invalid-input", `${question}的题干不能为空`);
      }
      if (title.length > LIMITS.titleMax) {
        return reject("invalid-input", `${question}的题干最多 ${String(LIMITS.titleMax)} 字`);
      }
      if (title !== item.title) {
        const failure = advance({ op: "setStem", itemId: item.id, title });
        if (failure !== null) return { ok: false, ...failure };
      }
    }

    /* -------------------------------- 配图 -------------------------------- */
    if (draft.image !== undefined && JSON.stringify(draft.image) !== JSON.stringify(item.image ?? null)) {
      const failure = advance({ op: "setImage", itemId: item.id, image: draft.image });
      if (failure !== null) return { ok: false, ...failure };
    }

    /* -------------------------------- 选项 -------------------------------- */
    if (draft.options !== undefined && (item.type === "single" || item.type === "multi")) {
      if (draft.options.length < LIMITS.optionsMin || draft.options.length > LIMITS.optionsMax) {
        return reject(
          "invalid-input",
          `${question}的选项需 ${String(LIMITS.optionsMin)}–${String(LIMITS.optionsMax)} 条`,
        );
      }
      const options = draft.options.map((option) => ({ id: option.id, text: option.text.trim() }));
      const seen = new Set<string>();
      for (const option of options) {
        if (!LIMITS.shortIdPattern.test(option.id)) {
          return reject("invalid-input", `${question}的选项 id「${option.id}」只能用小写字母/数字/下划线/连字符`);
        }
        if (seen.has(option.id)) {
          return reject("invalid-input", `${question}的选项 id「${option.id}」重复`);
        }
        seen.add(option.id);
        if (option.text === "") {
          return reject("invalid-input", `${question}有选项文字为空`);
        }
        if (option.text.length > LIMITS.optionTextMax) {
          return reject("invalid-input", `${question}的选项文字最多 ${String(LIMITS.optionTextMax)} 字`);
        }
      }
      if (JSON.stringify(options) !== JSON.stringify("options" in item ? item.options : [])) {
        const failure = advance({ op: "setOptions", itemId: item.id, options });
        if (failure !== null) return { ok: false, ...failure };
      }
    }

    /* -------------------------------- 答案 -------------------------------- */
    // survey 一律不产答案 op（R5）；面板也不会给它答案输入框，这里是第二道闸。
    //
    // 校验的触发条件比"产 op"宽一格：**只改了选项**也要校验现有答案。
    // 否则删掉正确项后，答案仍指向一个不存在的 id，本地不报、保存也不报（草稿
    // 允许不可发布），直到发布时才炸——那正是这次要提前挡掉的错。
    const answerTouched = draft.answer !== undefined;
    const optionsTouched =
      draft.options !== undefined && (item.type === "single" || item.type === "multi");
    const effectiveAnswer = draft.answer ?? answerPayloadOf(item);
    if (
      (answerTouched || optionsTouched) &&
      effectiveAnswer !== null &&
      state.schema.meta.kind !== "survey" &&
      supportsAnswer(item)
    ) {
      const payload = effectiveAnswer;
      if (payload.type !== item.type) {
        return reject("invalid-input", `${question}的答案类型与题型不符`);
      }
      const optionIds = new Set(
        (draft.options ?? ("options" in item ? item.options : [])).map((option) => option.id),
      );
      switch (payload.type) {
        case "single":
          if (payload.answer === "") return reject("invalid-input", `${question}还没选正确答案`);
          if (!optionIds.has(payload.answer)) {
            return reject("invalid-input", `${question}的正确答案不在选项里`);
          }
          break;
        case "multi": {
          const unique = new Set(payload.answer);
          if (payload.answer.length === 0) return reject("invalid-input", `${question}至少要选一个正确答案`);
          if (unique.size !== payload.answer.length) return reject("invalid-input", `${question}的正确答案重复`);
          if (payload.answer.some((id) => !optionIds.has(id))) {
            return reject("invalid-input", `${question}的正确答案不在选项里`);
          }
          break;
        }
        case "fill":
          if (payload.answer.length === 0 || payload.answer.some((blank) => blank.trim() === "")) {
            return reject("invalid-input", `${question}的填空答案不能有空`);
          }
          break;
        case "number": {
          const { value, tolerance } = payload.answer;
          if (!Number.isFinite(value) || !Number.isFinite(tolerance) || tolerance < 0) {
            return reject("invalid-input", `${question}的数值答案或容差不是有效数字`);
          }
          break;
        }
      }
      if (answerTouched && JSON.stringify(answerPayloadOf(item)) !== JSON.stringify(payload)) {
        const failure = advance({ op: "setAnswer", itemId: item.id, answer: payload });
        if (failure !== null) return { ok: false, ...failure };
      }
    }

    /* -------------------------------- 解析 -------------------------------- */
    if (draft.explanation !== undefined && item.type !== "scale") {
      const raw = draft.explanation ?? "";
      const explanation = raw.trim() === "" ? null : raw;
      if (explanation !== null && explanation.length > LIMITS.explanationMax) {
        return reject("invalid-input", `${question}的解析最多 ${String(LIMITS.explanationMax)} 字`);
      }
      const current =
        item.type === "section" ? item.description ?? null : "explanation" in item ? item.explanation ?? null : null;
      if (explanation !== current) {
        const failure = advance({ op: "setExplanation", itemId: item.id, explanation });
        if (failure !== null) return { ok: false, ...failure };
      }
    }

    /* -------------------------------- 分值 -------------------------------- */
    // 分节/量表没有分值；survey 不允许带分值（R5）。输入框已藏，草稿不该变成注定失败的 op。
    const score = draft.score;
    if (score !== undefined && scoreOfItem(item) !== null && state.schema.meta.kind !== "survey") {
      if (!Number.isInteger(score) || score < 0 || score > LIMITS.scoreMax) {
        return reject("invalid-input", `${question}的分值需是 0–${String(LIMITS.scoreMax)} 的整数`);
      }
      if (score !== scoreOfItem(item)) {
        const failure = advance({ op: "setScore", itemId: item.id, score });
        if (failure !== null) return { ok: false, ...failure };
      }
    }

    /* -------------------------------- 必答 -------------------------------- */
    if (draft.required !== undefined && "required" in item && item.required !== draft.required) {
      const failure = advance({ op: "setRequired", itemId: item.id, required: draft.required });
      if (failure !== null) return { ok: false, ...failure };
    }

    /* ------------------------------ 教学标注 ------------------------------ */
    if (
      (draft.bloom !== undefined || draft.knowledgePoint !== undefined) &&
      item.type !== "scale" &&
      item.type !== "section"
    ) {
      const bloom = draft.bloom !== undefined ? draft.bloom : item.bloom ?? null;
      const knowledgePoint =
        draft.knowledgePoint !== undefined ? draft.knowledgePoint : item.knowledgePoint ?? null;
      if (bloom !== (item.bloom ?? null) || knowledgePoint !== (item.knowledgePoint ?? null)) {
        const failure = advance({ op: "setMeta", itemId: item.id, bloom, knowledgePoint });
        if (failure !== null) return { ok: false, ...failure };
      }
    }

    /* ------------------------------ 字数上限 ------------------------------ */
    if (draft.maxLength !== undefined && item.type === "short") {
      if (
        !Number.isInteger(draft.maxLength) ||
        draft.maxLength < 1 ||
        draft.maxLength > LIMITS.shortMaxLengthCap
      ) {
        return reject(
          "invalid-input",
          `${question}的字数上限需是 1–${String(LIMITS.shortMaxLengthCap)} 的整数`,
        );
      }
      if (draft.maxLength !== item.maxLength) {
        const failure = advance({ op: "setMaxLength", itemId: item.id, maxLength: draft.maxLength });
        if (failure !== null) return { ok: false, ...failure };
      }
    }
  }

  const request: PatchFormRequest = { baseVersionId: state.baseVersionId, ops };
  if (ops.length === 0) {
    // 一条 op 都没有：不必跑 `applyPatch`，预览就是原始 Schema。
    return { ok: true, preview: state.schema, ops, changes: [], request, hasChanges: false };
  }

  const applied = applyPatch(state.schema, ops);
  if (!applied.ok) {
    const first = applied.errors[0];
    return reject("patch-rejected", first?.message ?? "这组修改不被接受", applied.errors);
  }
  return {
    ok: true,
    preview: applied.schema,
    ops,
    changes: applied.changes,
    request,
    hasChanges: applied.changes.length > 0,
  };
}
