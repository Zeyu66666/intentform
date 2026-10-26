/**
 * 题型注册表 —— `edit`（教师视角）与 `fill`（学生视角）两套。
 *
 * 为什么必须两套而不是"条件渲染"：
 * `fill` 态的安全红线是**绝不泄露答案**（计划 §5 / `AGENTS.md` §5）。一条
 * `{showAnswer && <Answer/>}` 分支只要有人写反一个布尔，答案就上屏了；而两套注册表
 * 里 `fill` 分支的入参类型是 `FillRenderPlan`（由 `fill-plan.ts` 从 `publicView()`
 * 投影而来，结构上装不下 `answer`），编译器替我们把这条路堵死。
 *
 * 键是 `FormItem["type"]`：新增题型时 `Record` 会缺一个键 → 编译报错；
 * 分派处是穷举 `switch` + `assertNever`，没有 `default: return null` 这种静默漏渲染。
 */

import { BLOOM_LEVELS, type FormItem } from "@intentform/schema";

import { MathText } from "./Latex";
import {
  toFillItem,
  toFillRenderPlan,
  type FillControl,
  type FillPlanOf,
  type FillRenderPlan,
} from "./fill-plan";

/** 与 `BLOOM_LEVELS` 一一对应；漏一个键编译不过。 */
const BLOOM_LABELS: Record<(typeof BLOOM_LEVELS)[number], string> = {
  remember: "记忆",
  understand: "理解",
  apply: "应用",
  analyze: "分析",
  evaluate: "评价",
  create: "创造",
};

export const TYPE_LABELS: Record<FormItem["type"], string> = {
  single: "单选",
  multi: "多选",
  fill: "填空",
  number: "数值",
  short: "简答",
  scale: "量表",
  section: "分节",
};

function assertNever(value: never): never {
  throw new Error(`未处理的题型分支: ${JSON.stringify(value)}`);
}

/* ------------------------------------------------------------------ *
 * 教师视角（edit）
 * ------------------------------------------------------------------ */

interface FieldMeta {
  readonly typeLabel: string;
  readonly required: boolean;
  /** `section`/`short`/`scale` 不判分，这里为 `null`。 */
  readonly score: number | null;
  readonly bloom: string | null;
  readonly knowledgePoint: string | null;
  readonly explanation: string | null;
}

/** 卡片头部需要的通用信息。穷举 7 型，漏一个编译不过。 */
function metaOf(item: FormItem): FieldMeta {
  const base = { typeLabel: TYPE_LABELS[item.type] } as const;

  switch (item.type) {
    case "single":
    case "multi":
    case "fill":
    case "number":
      return {
        ...base,
        required: item.required,
        // 附录 A 之后这三项都可选：没有就显示"没有"，不补 0 分、不补层级（§2.6 第 4 条）。
        score: item.score ?? null,
        bloom: item.bloom === undefined ? null : BLOOM_LABELS[item.bloom],
        knowledgePoint: item.knowledgePoint ?? null,
        explanation: item.explanation ?? null,
      };
    case "short":
    case "scale":
      return {
        ...base,
        required: item.required,
        score: null,
        bloom: null,
        knowledgePoint: null,
        explanation: null,
      };
    case "section":
      return {
        ...base,
        required: false,
        score: null,
        bloom: null,
        knowledgePoint: null,
        explanation: null,
      };
    default:
      return assertNever(item);
  }
}

function Badge({ children, tone = "muted" }: { readonly children: React.ReactNode; readonly tone?: "muted" | "accent" }): JSX.Element {
  const cls =
    tone === "accent"
      ? "border-[color:var(--color-accent)] text-[color:var(--color-accent)]"
      : "border-line text-muted";
  return (
    <span className={`rounded-sm border px-[6px] py-[1px] text-xs ${cls}`}>{children}</span>
  );
}

function OptionList({
  options,
  answers,
}: {
  readonly options: readonly { readonly id: string; readonly text: string }[];
  readonly answers: readonly string[];
}): JSX.Element {
  return (
    <ul className="mt-1 flex list-none flex-col gap-1 p-0">
      {options.map((option) => {
        const correct = answers.includes(option.id);
        return (
          <li
            key={option.id}
            className={`flex items-start gap-2 rounded-sm px-2 py-1 text-sm ${
              correct ? "bg-bg" : ""
            }`}
          >
            <span className="mt-[2px] shrink-0 font-mono text-xs text-muted">{option.id}</span>
            <span className="min-w-0 break-words">
              <MathText text={option.text} />
            </span>
            {correct ? (
              <span className="ml-auto shrink-0 text-xs text-[color:var(--color-success)]">
                ✓ 正确
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function AnswerLine({ label, children }: { readonly label: string; readonly children: React.ReactNode }): JSX.Element {
  return (
    <p className="mt-1 text-sm">
      <span className="text-muted">{label}：</span>
      <span className="font-medium text-[color:var(--color-success)]">{children}</span>
    </p>
  );
}

/** edit 注册表：键 = 题型，值是"这个题型在教师视角要显示的东西"。 */
const EDIT_REGISTRY: {
  readonly [K in FormItem["type"]]: (item: Extract<FormItem, { readonly type: K }>) => JSX.Element;
} = {
  // answer 可选之后，四种判分题型都要能表达"没有答案"：
  // survey 里这是**合法**的（只收集不判分），quiz 里则由门禁拦下并给可读原因。
  single: (item) =>
    item.answer === undefined ? (
      <AnswerLine label="答案">未设置</AnswerLine>
    ) : (
      <>
        <OptionList options={item.options} answers={[item.answer]} />
        <AnswerLine label="答案">
          {item.answer}（{item.options.find((option) => option.id === item.answer)?.text ?? "选项不存在"}）
        </AnswerLine>
      </>
    ),
  multi: (item) =>
    item.answer === undefined ? (
      <AnswerLine label="答案">未设置</AnswerLine>
    ) : (
      <>
        <OptionList options={item.options} answers={item.answer} />
        <AnswerLine label="答案">{item.answer.join("、")}</AnswerLine>
      </>
    ),
  fill: (item) =>
    item.answer === undefined ? (
      <AnswerLine label="答案">未设置</AnswerLine>
    ) : (
      <>
        <AnswerLine label="答案">{item.answer.join(" ／ ")}</AnswerLine>
        <p className="mt-1 text-xs text-muted">共 {item.answer.length} 个空，按空序作答。</p>
      </>
    ),
  number: (item) =>
    item.answer === undefined ? (
      <AnswerLine label="答案">未设置</AnswerLine>
    ) : (
      <>
        <AnswerLine label="答案">{item.answer.value}</AnswerLine>
        <p className="mt-1 text-xs text-muted">允许容差 ±{item.answer.tolerance}</p>
      </>
    ),
  short: (item) => (
    <p className="mt-1 text-xs text-muted">
      简答题不自动判分，学生作答上限 {item.maxLength} 字（人工/AI 评分在 I4 落地）。
    </p>
  ),
  scale: (item) => (
    <p className="mt-1 text-xs text-muted">
      量表 {item.min}–{item.max}
      {item.labels === undefined ? "（未设置两端标签）" : `，两端为「${item.labels[0]}」「${item.labels[1]}」`}
    </p>
  ),
  section: (item) =>
    item.description === undefined ? (
      <span />
    ) : (
      <p className="mt-1 text-sm text-muted">
        <MathText text={item.description} />
      </p>
    ),
};

export function EditField({ item }: { readonly item: FormItem }): JSX.Element {
  const meta = metaOf(item);

  if (item.type === "section") {
    return (
      <section id={`field-${item.id}`} className="mt-2 first:mt-0">
        <h3 className="m-0 border-b border-line pb-1 text-lg font-semibold">
          <MathText text={item.title} />
        </h3>
        {EDIT_REGISTRY.section(item)}
      </section>
    );
  }

  return (
    <article
      id={`field-${item.id}`}
      className="animate-field-in rounded-md border border-line bg-surface p-2"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <span className="text-xs text-muted">{meta.typeLabel}</span>
        {meta.required ? (
          <span className="text-xs text-[color:var(--color-danger)]" aria-label="必答">
            *
          </span>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-1">
          {meta.score === null ? null : <Badge>{meta.score} 分</Badge>}
          {meta.bloom === null ? null : <Badge tone="accent">{meta.bloom}</Badge>}
          {meta.knowledgePoint === null ? null : <Badge>知识 {meta.knowledgePoint}</Badge>}
        </div>
      </header>

      <p className="mb-1 mt-1 text-base font-medium">
        <MathText text={item.title} />
      </p>

      {renderEditBody(item)}

      {meta.explanation === null ? null : (
        <details className="mt-2 rounded-sm border border-line px-2 py-1">
          <summary className="cursor-pointer text-xs text-muted">解析</summary>
          <p className="mb-0 mt-1 text-sm text-ink">
            <MathText text={meta.explanation} />
          </p>
        </details>
      )}
    </article>
  );
}

/** 穷举分派：注册表的键与 `FormItem["type"]` 一一对应。 */
function renderEditBody(item: FormItem): JSX.Element {
  switch (item.type) {
    case "single":
      return EDIT_REGISTRY.single(item);
    case "multi":
      return EDIT_REGISTRY.multi(item);
    case "fill":
      return EDIT_REGISTRY.fill(item);
    case "number":
      return EDIT_REGISTRY.number(item);
    case "short":
      return EDIT_REGISTRY.short(item);
    case "scale":
      return EDIT_REGISTRY.scale(item);
    case "section":
      return EDIT_REGISTRY.section(item);
    default:
      return assertNever(item);
  }
}

/* ------------------------------------------------------------------ *
 * 学生视角（fill）
 * ------------------------------------------------------------------ */

const CONTROL_HINT: Record<FillControl["kind"], string> = {
  single: "单选",
  multi: "多选",
  text: "填写",
  number: "数值",
  scale: "量表",
  section: "分节",
};

type FillRegistry = {
  readonly [K in FillRenderPlan["type"]]: (plan: FillPlanOf<K>) => JSX.Element;
};

/**
 * fill 注册表：**只有作答控件**。
 *
 * 注意入参是 `FillRenderPlan`（判别联合，控件与题型绑定），**不是** `FormItem`：
 * 它结构上没有 `answer` / `explanation` / `score` / `bloom` / `knowledgePoint`，
 * 所以"顺手把答案也渲染出来"在这层写不出来；也不需要 `if (control.kind !== …)` 兜底，
 * 因为 `type` 与 `control.kind` 是编译期绑死的。
 */
const FILL_REGISTRY: FillRegistry = {
  single: (plan) => (
    <fieldset className="m-0 mt-2 flex flex-col gap-1 border-0 p-0">
      <legend className="sr-only">{plan.title}</legend>
      {plan.control.options.map((option) => {
        const id = `${plan.id}-opt-${option.id}`;
        return (
          <label key={option.id} htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-[2px] text-sm hover:bg-bg">
            <input id={id} type="radio" name={plan.id} value={option.id} className="size-[14px] shrink-0" />
            <span className="min-w-0 break-words">
              <MathText text={option.text} />
            </span>
          </label>
        );
      })}
    </fieldset>
  ),
  multi: (plan) => (
    <fieldset className="m-0 mt-2 flex flex-col gap-1 border-0 p-0">
      <legend className="sr-only">{plan.title}</legend>
      {plan.control.options.map((option) => {
        const id = `${plan.id}-opt-${option.id}`;
        return (
          <label key={option.id} htmlFor={id} className="flex cursor-pointer items-center gap-2 rounded-sm px-1 py-[2px] text-sm hover:bg-bg">
            <input id={id} type="checkbox" name={plan.id} value={option.id} className="size-[14px] shrink-0" />
            <span className="min-w-0 break-words">
              <MathText text={option.text} />
            </span>
          </label>
        );
      })}
    </fieldset>
  ),
  fill: (plan) => {
    const id = `${plan.id}-answer`;
    return (
      <div className="mt-2 flex flex-col gap-1">
        <label htmlFor={id} className="text-xs text-muted">
          按空序依次填写，用「／」分隔
        </label>
        <input
          id={id}
          name={plan.id}
          type="text"
          maxLength={plan.control.maxLength}
          placeholder="在此作答"
          className="w-full rounded-sm border border-line bg-surface px-2 py-1 text-sm"
        />
      </div>
    );
  },
  number: (plan) => {
    const id = `${plan.id}-answer`;
    return (
      <div className="mt-2 flex flex-col gap-1">
        <label htmlFor={id} className="sr-only">
          {plan.title}
        </label>
        <input
          id={id}
          name={plan.id}
          type="number"
          step="any"
          inputMode="decimal"
          className="w-40 rounded-sm border border-line bg-surface px-2 py-1 text-sm"
        />
      </div>
    );
  },
  short: (plan) => {
    const id = `${plan.id}-answer`;
    return (
      <div className="mt-2 flex flex-col gap-1">
        <label htmlFor={id} className="sr-only">
          {plan.title}
        </label>
        <textarea
          id={id}
          name={plan.id}
          rows={3}
          maxLength={plan.control.maxLength}
          placeholder="在此作答"
          className="w-full resize-y rounded-sm border border-line bg-surface px-2 py-1 text-sm"
        />
        <span className="text-xs text-muted">最多 {plan.control.maxLength} 字</span>
      </div>
    );
  },
  scale: (plan) => {
    const values: number[] = [];
    for (let value = plan.control.min; value <= plan.control.max; value += 1) values.push(value);
    return (
      <fieldset className="m-0 mt-2 border-0 p-0">
        <legend className="sr-only">{plan.title}</legend>
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{plan.control.labels?.[0] ?? plan.control.min}</span>
          <span>{plan.control.labels?.[1] ?? plan.control.max}</span>
        </div>
        <div className="mt-1 flex gap-3">
          {values.map((value) => {
            const id = `${plan.id}-scale-${String(value)}`;
            return (
              <label key={value} htmlFor={id} className="flex cursor-pointer flex-col items-center gap-[2px] text-xs">
                <input id={id} type="radio" name={plan.id} value={value} className="size-[14px]" />
                <span>{value}</span>
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  },
  section: (plan) =>
    plan.description === null ? (
      <span />
    ) : (
      <p className="mt-1 text-sm text-muted">
        <MathText text={plan.description} />
      </p>
    ),
};

/** 学生视角入口：**先投影，再渲染**（顺序不能反）。 */
export function FillField({ item }: { readonly item: FormItem }): JSX.Element {
  // 第 1 道闸门：publicView 剥答案；第 2 道闸门：fill-plan 白名单重建。
  const plan = toFillRenderPlan(toFillItem(item));

  if (plan.type === "section") {
    return (
      <section id={`fill-${plan.id}`} className="mt-2 first:mt-0">
        <h3 className="m-0 border-b border-line pb-1 text-lg font-semibold">
          <MathText text={plan.title} />
        </h3>
        {FILL_REGISTRY.section(plan)}
      </section>
    );
  }

  return (
    <article
      id={`fill-${plan.id}`}
      className="animate-field-in rounded-md border border-line bg-surface p-2"
    >
      <p className="m-0 text-base font-medium">
        <MathText text={plan.title} />
        {plan.required ? (
          <span className="ml-1 text-[color:var(--color-danger)]" aria-label="必答">
            *
          </span>
        ) : null}
      </p>
      {renderFillBody(plan)}
    </article>
  );
}

function renderFillBody(plan: FillRenderPlan): JSX.Element {
  switch (plan.type) {
    case "single":
      return FILL_REGISTRY.single(plan);
    case "multi":
      return FILL_REGISTRY.multi(plan);
    case "fill":
      return FILL_REGISTRY.fill(plan);
    case "number":
      return FILL_REGISTRY.number(plan);
    case "short":
      return FILL_REGISTRY.short(plan);
    case "scale":
      return FILL_REGISTRY.scale(plan);
    case "section":
      return FILL_REGISTRY.section(plan);
    default:
      return assertNever(plan);
  }
}

/** 供面板显示"这是什么控件"的纯函数（不渲染答案）。 */
export function controlHint(plan: FillRenderPlan): string {
  return CONTROL_HINT[plan.control.kind];
}
