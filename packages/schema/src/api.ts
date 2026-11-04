/**
 * I4 的 HTTP 契约（《计划 v3.0》§4.1 I4、§3.5、§5）。
 *
 * 为什么放在 `packages/schema` 而不是 `server`：填写页与看板在 `web/`，按
 * AGENTS.md 的模块边界，`web` 只能依赖 `schema` 的类型与纯函数。契约若写在
 * server 里，前端就只能靠手抄接口形状，两边一漂移，"提交响应不含答案" 这种
 * 不变量会先在类型层面失守，字节级检查只是最后一道网。
 *
 * 这里只描述**线缆上的形状**与硬上限，不含任何实现：SQL、判分、限流都在
 * `server/src/**`。请求体用 Zod 就是为了让同一个 schema 在两侧都能跑——
 * 前端先挡一遍明显的错（少填一个必答项），服务端不信前端，再挡一遍。
 */
import { z } from "zod";
import {
  BLOOM_LEVELS,
  FORM_KINDS,
  FORM_STATUSES,
  FORM_VERSION_SOURCES,
  LIMITS,
  type FormKind,
  type FormStatus,
  type FormVersionSource,
} from "./constants.ts";
import type { PublicForm } from "./public-view.ts";
import type { ErrorCode } from "./errors.ts";
import {
  CLARIFY_ANSWER_MAX_CHARS,
  CLARIFY_SLOTS,
  type ClarifyQuestion,
} from "./clarify.ts";
import { formSchema, type FormItem, type FormSchema } from "./types.ts";
import type { FormBlueprint } from "./blueprint.ts";
import type { CoverageMatrix } from "./coverage.ts";
import { patchOpsSchema, type PatchChange, type PatchError, type PatchOp } from "./patch.ts";
import { jsonPatchOpsSchema, type JsonPatchOp } from "./json-patch.ts";

/* --------------------------- 模型运行设置（2026-11-03） --------------------------- */

/** 与 `@intentform/llm` 的 `LlmMode` 同值；schema 不能依赖 llm，所以在这里单列。 */
export const LLM_MODES = ["live", "record", "replay", "mock"] as const;
export type LlmModeName = (typeof LLM_MODES)[number];

export const LLM_MODE_LABELS: Readonly<Record<LlmModeName, string>> = {
  live: "真实调用（live）",
  record: "真实调用并录制（record）",
  replay: "回放录像（replay，不联网）",
  mock: "内置演示数据（mock，不联网）",
};

/** 搜索端点只接受 http/https；空串表示「不配置搜索」。 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * 网页修改全局模型设置。**API Key / 搜索 Key 只提交给服务端、只存内存、永不回显**；
 * 留空表示保持原 Key 不变，避免每次改端点都要重新输一遍。
 */
export const llmSettingsRequestSchema = z.object({
  mode: z.enum(LLM_MODES),
  baseUrl: z.string().trim().url("API 端点必须是合法 URL").max(300),
  model: z.string().trim().min(1, "模型名不能为空").max(120),
  apiKey: z.string().trim().max(300).optional(),
  /**
   * 联网参考搜索端点（仅 live 模式使用）。空串 = 不配置；省略 = 保持原值。
   * 供应商差异由教师侧代理适配，这里只要一个能收 `{query, limit}` 的 HTTP 端点。
   */
  searchBaseUrl: z
    .string()
    .trim()
    .max(300)
    .refine((value) => value === "" || isHttpUrl(value), "搜索端点必须是 http/https URL")
    .optional(),
  /** 搜索 Key；与 `apiKey` 同语义：省略 = 保持，空串 = 清空。 */
  searchApiKey: z.string().trim().max(300).optional(),
});

export type LlmSettingsRequest = z.infer<typeof llmSettingsRequestSchema>;

export interface LlmSettingsResponse {
  readonly ok: true;
  readonly mode: LlmModeName;
  readonly baseUrl: string;
  readonly model: string;
  /** 只回「有没有 Key」，绝不回 Key 本身。 */
  readonly hasApiKey: boolean;
  /** 搜索端点；空串表示未配置联网参考。 */
  readonly searchBaseUrl: string;
  /** 只回「有没有搜索 Key」，绝不回 Key 本身。 */
  readonly hasSearchKey: boolean;
  /** 当前登录教师是否允许改全局设置（由服务端 `ADMIN_EMAIL` 决定）。 */
  readonly canEdit: boolean;
}

/** 路由表：前后端都从这里取路径，避免 "/api/forms/:id/publish" 手写成两种拼法。 */
export const API_PATHS = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  me: "/api/auth/me",
  generate: "/api/generate",
  /** 意图澄清（省赛 R-05）：只回追问，不生成。 */
  clarify: "/api/clarify",
  /** 两阶段蓝图（省赛 R-06）：只回结构，不写库。 */
  plan: "/api/plan",
  forms: "/api/forms",
  form: (formId: string) => `/api/forms/${encodeURIComponent(formId)}`,
  publish: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/publish`,
  /**
   * 表单级展示设置（省赛附加 A-18）：目前只有「提交后向学生展示答案解析」。
   * 独立于版本快照——它是展示策略，不是卷面内容；改它不产生新版本。
   */
  formSettings: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/settings`,
  /** 受限修改（省赛 R-03）：只接受六种操作，追加一个新草稿版本。 */
  patchForm: (formId: string) => `/api/forms/${encodeURIComponent(formId)}`,
  /** 撤销一步：把草稿指针退回当前草稿的父版本。 */
  undoDraft: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/undo`,
  redoDraft: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/redo`,
  suggestPatch: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/suggest`,
  supplementItem: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/supplement`,
  aiGrade: (formId: string, submissionId: string) =>
    `/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}/ai-grade`,
  llmSettings: "/api/settings/llm",
  submissions: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/submissions`,
  submissionsCsv: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/submissions.csv`,
  /** 教师给某条提交里的某道简答打分（省赛 R-02）。 */
  gradeSubmission: (formId: string, submissionId: string) =>
    `/api/forms/${encodeURIComponent(formId)}/submissions/${encodeURIComponent(submissionId)}/grades`,
  submit: "/api/submissions",
  /** 学生收集页；`web/src/config.ts` 的 `fillPathPrefix` 与这里必须一致。 */
  fill: (slug: string) => `/f/${encodeURIComponent(slug)}`,
} as const;

/**
 * 错误码。刻意与 SSE 的 `SSE_ERROR_CODES` 分开：SSE 那些描述的是"生成过程中
 * 上游怎么了"，这里是"这次 HTTP 请求为什么被拒"。混在一张表里会让
 * `llm_timeout` 这种码出现在登录接口上。
 */
export const API_ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "version_conflict",
  "unprocessable",
  "payload_too_large",
  "rate_limited",
  "internal",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 失败响应统一形状：`ok:false` 放第一位，前端只判一个字段就够。 */
export interface ApiErrorBody {
  readonly ok: false;
  readonly error: ApiErrorCode;
  readonly message: string;
}

export function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record["ok"] === false &&
    typeof record["error"] === "string" &&
    (API_ERROR_CODES as readonly string[]).includes(record["error"])
  );
}

/** HTTP 状态码映射。写死在一处，免得"发布未登录" 一会儿 401 一会儿 403。 */
export const API_ERROR_STATUS: Readonly<Record<ApiErrorCode, number>> = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  /** 形状合法、内容不合规（如需求超长）。与 `/api/generate` 的 422 同一语义。 */
  unprocessable: 422,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
};

/* ---------------------------------- 鉴权 ---------------------------------- */

/**
 * 只做登录，不做开放注册（《计划 v3.0》§5：砍开放注册）。
 * 教师账号由 seed 脚本写入，密码经 argon2 哈希。
 */
export const loginRequestSchema = z.object({
  email: z.string().trim().toLowerCase().max(LIMITS.emailMax),
  password: z.string().min(LIMITS.passwordMin).max(LIMITS.passwordMax),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** 登录后前端能拿到的东西：只有 id 与邮箱。密码哈希、创建时间都不出服务端。 */
export interface TeacherIdentity {
  readonly id: string;
  readonly email: string;
}

export interface LoginResponse {
  readonly ok: true;
  readonly teacher: TeacherIdentity;
}

export interface MeResponse {
  readonly ok: true;
  readonly teacher: TeacherIdentity;
}

/* --------------------------------- 表单管理 -------------------------------- */

export const formKindSchema = z.enum(FORM_KINDS);
export const formStatusSchema = z.enum(FORM_STATUSES);
export const formVersionSourceSchema = z.enum(FORM_VERSION_SOURCES);

/**
 * 新建表单 = 把一份**已通过整表门禁**的 Schema 落成 `v1` 草稿版本。
 * 这里再跑一遍 `formSchema`（结构）而不是 `validateForm`（语义）：语义门禁
 * 属于生成链路的 responsibility（`packages/llm/src/publish-gate.ts`），
 * 接口层只保证"存进来的东西能被 DSL 解析"，否则一存进去后续所有读取都炸。
 */
export const createFormRequestSchema = z.object({
  title: z.string().trim().min(1).max(LIMITS.formTitleMax),
  kind: formKindSchema,
  schema: formSchema,
  /** 缺省视为 `generate`：手动上传的 Schema 也走生成入口，不另开一条路。 */
  source: formVersionSourceSchema.default("generate"),
});

export type CreateFormRequest = z.infer<typeof createFormRequestSchema>;

/** 列表项。刻意不带 `schema_json`：列表页不需要整份表单，带上就是白传几十 KB。 */
export interface FormSummary {
  readonly id: string;
  readonly title: string;
  readonly kind: FormKind;
  readonly status: FormStatus;
  readonly slug?: string;
  readonly draftVersionId: string;
  readonly publishedVersionId?: string;
  readonly updatedAt: string;
}

export interface FormVersionSummary {
  readonly id: string;
  readonly n: number;
  readonly source: FormVersionSource;
  readonly promptVersion: string;
  readonly parentId?: string;
  readonly createdAt: string;
}

export interface CreateFormResponse {
  readonly ok: true;
  readonly form: FormSummary;
  readonly version: FormVersionSummary;
}

export interface ListFormsResponse {
  readonly ok: true;
  readonly forms: readonly FormSummary[];
}

/** 教师侧详情：带完整 Schema（含答案），所以这个接口必须登录且校验归属。 */
export interface FormDetailResponse {
  readonly ok: true;
  readonly form: FormSummary;
  readonly version: FormVersionSummary;
  readonly schema: FormSchema;
  /** 撤销栈里是否还有可重做的一步（2026-11-02 重做栈）。 */
  readonly redoAvailable: boolean;
}

/**
 * 发布 = 把某个版本 id 写进 `forms.published_version_id`（§3.5 规则 1）。
 * 请求里显式带 `versionId` 而不是"发最新草稿"：教师看到的预览是哪一版，
 * 发的就该是哪一版，中间被别人加了草稿也不影响这次操作。
 */
export const publishRequestSchema = z.object({
  versionId: z.string().min(1).max(64),
});

export type PublishRequest = z.infer<typeof publishRequestSchema>;

export interface PublishResponse {
  readonly ok: true;
  readonly slug: string;
  readonly versionId: string;
  readonly publishedAt: string;
}

/* ---------------------------- 表单展示设置（A-18） --------------------------- */

/**
 * `POST /api/forms/:id/settings` 的请求。
 *
 * 只接受**显式布尔值**，不接受 `undefined`/`null` 表示「不改」——这个接口只有
 * 一个开关，含糊的写入会让「我以为我关了」变成事故。
 */
export const formSettingsRequestSchema = z.object({
  showAnswersAfterSubmit: z.boolean(),
  /**
   * AI 辅助评分（2026-11-03）。**默认关闭**；只有教师显式打开，且只对简答题，
   * 才允许把该题原文发给模型。省略表示不改这一项，兼容老客户端。
   */
  aiGradingEnabled: z.boolean().optional(),
});

export type FormSettingsRequest = z.infer<typeof formSettingsRequestSchema>;

export interface FormSettingsResponse {
  readonly ok: true;
  readonly showAnswersAfterSubmit: boolean;
  readonly aiGradingEnabled: boolean;
}

/* ------------------------------ 受限修改（R-03） ---------------------------- */

/**
 * `PATCH /api/forms/:id` 的请求。
 *
 * `baseVersionId` 是乐观锁：教师界面上看到的草稿是哪一版，就带哪一版。
 * 中间别人改过（草稿指针已前进）时服务端回 409，而不是"以最后写入为准"——
 * 后者会让两个人的改动互相吞掉，且没有任何一方看到发生了这件事。
 *
 * 标题与 Schema 分开传：改标题不动题目，也不该让题目的版本号蹭一个不必要的增量。
 *
 * 两种载荷二选一：`ops` 是界面用的十一个受限 op；`jsonPatch` 是 2026-11-02
 * 拉进来的 RFC 6902 通用语法。后者落库前会被翻译回前者，**不是**直接改 Schema。
 */
export const patchFormRequestSchema = z.union([
  z
    .object({
      baseVersionId: z.string().min(1).max(64),
      ops: patchOpsSchema,
      /** 可选：一并改表单标题。不传表示只改题目。 */
      title: z.string().trim().min(1).max(LIMITS.formTitleMax).optional(),
    })
    .strict(),
  /**
   * 通用 JSON Patch（RFC 6902 形状，2026-11-02 负责人拉入范围）。
   *
   * 语法通用、落库仍受限：服务端先把它翻译回十一个 op，再过 `applyPatch`。
   * 与 `ops` 二选一，两个都带或都不带都会被 `.strict()` 拒掉。
   */
  z
    .object({
      baseVersionId: z.string().min(1).max(64),
      jsonPatch: jsonPatchOpsSchema,
      title: z.string().trim().min(1).max(LIMITS.formTitleMax).optional(),
    })
    .strict(),
]);

export type PatchFormRequest = z.infer<typeof patchFormRequestSchema>;

/** 请求实际走哪条路径：界面用受限 op，通用 JSON Patch 供脚本/高级调用。 */
export type PatchFormPayload =
  | { readonly kind: "ops"; readonly ops: readonly PatchOp[] }
  | { readonly kind: "json-patch"; readonly ops: readonly JsonPatchOp[] };

/** 把两种请求形状归一成「待翻译的载荷」，调用方不必到处写 `in` 判断。 */
export function patchFormPayloadOf(request: PatchFormRequest): PatchFormPayload {
  return "ops" in request
    ? { kind: "ops", ops: request.ops }
    : { kind: "json-patch", ops: request.jsonPatch };
}

/**
 * `POST /api/forms/:id/suggest` 的请求：一句中文修改要求（R-03）。
 *
 * 带 `baseVersionId` 而不只是指令，是因为"改哪一版"必须由调用方说清楚：建议是基于
 * 某一版算出来的，如果草稿在两次点击之间前进过，把建议套到新版上就可能对不上题号。
 */
export const suggestPatchRequestSchema = z.object({
  baseVersionId: z.string().min(1).max(64),
  instruction: z.string().trim().min(1).max(LIMITS.requirementMaxChars),
  /**
   * 单题作用域（P18）：给了就只允许改这道题；省略 = 整表（与旧行为一致）。
   *
   * 用 `targetItemId` 而不是「让模型自己从中文里找第 2 题」：作用域是服务端
   * 强制的事实，不是提示词里的请求。模型越界时整体拒绝，不静默过滤。
   */
  targetItemId: z.string().regex(LIMITS.idPattern, "题目 id 需匹配 ^[a-z0-9_-]{3,32}$").optional(),
});

export type SuggestPatchRequest = z.infer<typeof suggestPatchRequestSchema>;

/** 建议的作用域：整表或单题；响应里带出来，界面据此写「仅第 2 题」。 */
export type SuggestScope = { readonly kind: "form" } | { readonly kind: "item"; readonly itemId: string };

/**
 * 单题作用域允许的 op 集合（P18）：结构性改动（加/删/移动）不走一句话，走面板按钮。
 *
 * 「删掉这题」之所以不在白名单：删除是结构性、不可逆感知最强的动作，必须由教师
 * **在面板上点**并看见题目消失；被一句「这题不好」隐式删掉是事故。
 */
export const ITEM_SCOPE_PATCH_OPS = [
  "setStem",
  "setOptions",
  "setAnswer",
  "setExplanation",
  "setScore",
  "setRequired",
  "setMeta",
  "setMaxLength",
] as const;

/** `includes` 的实参是 `PatchOp["op"]` 时元组元素集合更窄，用 Set 判定，不做类型断言。 */
export const ITEM_SCOPE_PATCH_OPS_SET: ReadonlySet<string> = new Set<string>(ITEM_SCOPE_PATCH_OPS);

/**
 * 建议的响应：**只回操作集与差异，不写库**。
 *
 * 界面必须先把差异摆给使用者看，人确认之后才发 `PATCH /api/forms/:id`——
 * 一步到位地"边生成边写入"会让"模型理解错了"变成一次真实的版本增量，
 * 而撤销栈再干净，也不如一开始就没写进去。
 */
export interface SuggestPatchResponse {
  readonly ok: true;
  readonly ops: readonly PatchOp[];
  readonly changes: readonly PatchChange[];
  /** 本次建议的作用域；`form` 是整表，`item` 带目标题 id（P18）。 */
  readonly scope: SuggestScope;
  /** 套用之后的可发布状态；与 PATCH 返回的 issues 同源同义。 */
  readonly issues: readonly PatchIssue[];
  /** 产生这条建议的来源；界面据此标注「本次由 mock 脚本产生」。 */
  readonly source: "live" | "record" | "mock";
  readonly promptVersion: string;
}

/* ------------------------- 覆盖矩阵补题（2026-11-03） ------------------------ */

/**
 * `POST /api/forms/:id/supplement` 的请求：为某个「知识点 × 布鲁姆层级」
 * 生成**一道**题。只回候选，不写库；教师确认后才由编辑器发 `addItem`。
 */
export const supplementItemRequestSchema = z.object({
  baseVersionId: z.string().min(1).max(64),
  knowledgePoint: z.string().regex(LIMITS.shortIdPattern, "知识点 id 不合法").max(32),
  bloom: z.enum(BLOOM_LEVELS),
  /** 可选补充要求；不传就按知识点与层级生成。 */
  instruction: z.string().trim().max(500).optional(),
});

export type SupplementItemRequest = z.infer<typeof supplementItemRequestSchema>;

export interface SupplementItemResponse {
  readonly ok: true;
  /** 候选题目；id 由服务端生成，教师确认前不进草稿。 */
  readonly item: FormItem;
  readonly source: "live" | "record" | "mock";
  readonly promptVersion: string;
}

/** 撤销：把草稿指针退回 `fromVersionId` 的父版本。 */
export const undoDraftRequestSchema = z.object({
  fromVersionId: z.string().min(1).max(64),
});

export type UndoDraftRequest = z.infer<typeof undoDraftRequestSchema>;

/** 重做：把撤销时压栈的版本重新设为草稿。请求形状与撤销一致（同样带乐观锁）。 */
export const redoDraftRequestSchema = z.object({
  fromVersionId: z.string().min(1).max(64),
});

export type RedoDraftRequest = z.infer<typeof redoDraftRequestSchema>;

export interface PatchFormResponse {
  readonly ok: true;
  readonly form: FormSummary;
  readonly version: FormVersionSummary;
  readonly schema: FormSchema;
  /** 人话级差异，界面直接渲染成「第 3 题 5 分 → 8 分」。 */
  readonly changes: readonly PatchChange[];
  /**
   * 这份新草稿**离可发布还差什么**（`validateForm` 的错误码，只做提示不拦保存）。
   * 草稿态允许半成品——改选项把答案 id 删掉、把总分改得对不上，都该存得下去，
   * 但界面上必须当场看见「现在还不能发布」，否则使用者要到点发布那一刻才发现，
   * 而且错误会归因到"保存坏了"而不是"我这次改坏了"。
   */
  readonly issues: readonly PatchIssue[];
}

/** 门禁提示：只带 `code/path/message`，不带 `repair`（那是给模型看的修复指令）。 */
export interface PatchIssue {
  readonly code: ErrorCode;
  readonly path: string;
  readonly message: string;
}

/**
 * 撤销的响应。`changes` 为空表示「已经退到 v1，没有更早的草稿可退」——
 * 这种请求仍回 200：对使用者来说它已经是"回到最初"的状态，不是错误。
 */
export interface UndoDraftResponse {
  readonly ok: true;
  readonly form: FormSummary;
  readonly version: FormVersionSummary;
  readonly schema: FormSchema;
  readonly undone: boolean;
  /** 这次撤销之后，重做栈里是否还有一步。界面据此点亮「重做」。 */
  readonly redoAvailable: boolean;
}

/**
 * 重做的响应。`redone === false` 不是错误：栈空或栈顶与当前草稿对不上
 * （撤销后又改过）时，表示「没有可重做的步骤」。
 */
export interface RedoDraftResponse {
  readonly ok: true;
  readonly form: FormSummary;
  readonly version: FormVersionSummary;
  readonly schema: FormSchema;
  readonly redone: boolean;
  readonly redoAvailable: boolean;
}

/** Patch 被拒时的明细（400 响应的 `error.detail` 里带 `errors`）。 */
export interface PatchRejection {
  readonly errors: readonly PatchError[];
  readonly ops: readonly PatchOp[];
}

/* ------------------------------- 学生端收集页 ------------------------------ */

/**
 * `GET /f/:slug` 的响应。`form` 的类型就是 `PublicForm`——学生端能看到的
 * 一切必须经过 `publicView()`，这里用类型把出口卡死：想加一个 `answer`
 * 字段就必须先改 `public-view.ts`，而那里有 C1 契约测试看着。
 */
export interface FillViewResponse {
  readonly ok: true;
  readonly formId: string;
  readonly versionId: string;
  readonly versionN: number;
  readonly slug: string;
  readonly form: PublicForm;
}

/**
 * 学生提交的答案值。只允许字符串与字符串数组：
 * 选项题交选项 id，填空题交字符串数组，数值题交字符串（解析与容差判定在服务端，
 * 不让前端把 "3.14" 预处理成 3.14 再交上来——那等于让学生自证解析正确）。
 */
export const answerValueSchema = z.union([z.string(), z.array(z.string())]);

export type AnswerValue = z.infer<typeof answerValueSchema>;

export const submitRequestSchema = z.object({
  slug: z.string().min(1).max(LIMITS.slugMax),
  /**
   * 学生页面**实际渲染的那个版本**。服务端拿它与当前 `published_version_id`
   * 比对，不等就拒（§3.5：旧版页面提交 → 「版本已更新，请刷新」）。
   * 只按这个版本判分，绝不用新版答案去判旧版作答。
   */
  formVersionId: z.string().min(1).max(64),
  /** 键是字段 id；未知键由服务端拒绝（学生改 DOM 加字段不该静默计 0 分）。 */
  answers: z.record(answerValueSchema),
});

export type SubmitRequest = z.infer<typeof submitRequestSchema>;

/**
 * 提交响应。**只有得分与满分**：不带每题对错、不带正确答案、不带他人统计，
 * 也不回显学生填了什么（回显也是一条泄露路径——浏览器历史里会留下它）。
 */
export interface SubmitResponse {
  readonly ok: true;
  readonly submissionId: string;
  readonly score: number;
  readonly maxScore: number;
  /**
   * 满分里**需要人工批改**的部分（简答分值之和，省赛 R-01）。
   * `score` 只含自动判分得分，所以 `score + pendingScore ≤ maxScore` 恒成立；
   * 学生看到「28 / 40 分，其中 10 分待老师批改」时不至于以为自己被误判。
   */
  readonly pendingScore: number;
  /**
   * 提交后答案解析（省赛附加 A-18）。**默认不出现**：只有教师在该表单上打开
   * 「提交后向学生展示答案解析」时，才随这一次提交的响应返回。
   *
   * 只在提交成功的响应里出现，是为了让 `publicView()` 保持零答案：学生没有提交
   * 之前，拿不到任何可回放的答案载体。代价是「交一次就能把答案转给别人」——
   * 所以它默认关闭，并且由教师逐表单决定是否开启。
   */
  readonly review?: readonly SubmitReviewItem[];
}

/** 一道题的提交后回看：学生填了什么、对不对、正确答案与解析。 */
export interface SubmitReviewItem {
  readonly itemId: string;
  readonly title: string;
  readonly type: "single" | "multi" | "fill" | "number" | "short" | "scale";
  /** 学生答案的可读文本（选项 id 已换成选项文字）。没作答是空串。 */
  readonly given: string;
  /**
   * 客观题：`judgeItem` 的判定结果（与判分、统计同一入口）；
   * 简答与量表没有对错，固定 `null`——未知值不伪填。
   */
  readonly correct: boolean | null;
  /** 正确答案的可读文本；简答 / 量表没有标准答案，是空串。 */
  readonly expected: string;
  readonly explanation?: string;
}

/** 版本冲突时给人类看的话。前端直接展示，所以文案放在契约里而不是各处硬编码。 */
export const VERSION_CONFLICT_MESSAGE = "版本已更新，请刷新页面后重试";

/* --------------------------------- 看板 ---------------------------------- */

export interface SubmissionRow {
  readonly submissionId: string;
  readonly createdAt: string;
  /** 自动判分得分 + 已批改的人工分。 */
  readonly score: number;
  readonly maxScore: number;
  /** 该条提交里还没批改的简答分值之和；0 表示这条已经"结清"。 */
  readonly pendingScore: number;
  /** 已录入的人工分：`itemId -> 分值`。没有批改过就是空对象，不是 undefined。 */
  readonly manualScores: Readonly<Record<string, number>>;
  /**
   * 学生答案原样返回（只给教师端看板用）。
   *
   * 学生提交的响应里**永远不出现**这个字段（`SubmissionsResponse` 与 `SubmitResponse`
   * 是两套类型）；把它放看板行里，是为了让「批改简答」这个界面不用再发一次请求，
   * 也不必为此新增一条按 id 读单条提交的路由。
   */
  readonly answers: Readonly<Record<string, string | readonly string[]>>;
}

/** 待批改的一道简答：看板靠它渲染批改表单，不必再拉一次表单详情。 */
export interface GradableShortItem {
  readonly itemId: string;
  readonly title: string;
  /** 这题的满分；教师录入的分数不能超过它。 */
  readonly score: number;
}

export interface SubmissionSummary {
  readonly versionId: string;
  readonly versionN: number;
  /** 表单类型决定看板的评分区块：survey 只显示回收数，不显示分数。 */
  readonly kind: FormKind;
  readonly count: number;
  /** 无提交时为 `null`，不要补 0——0 分和"还没有人交"是两件事。 */
  readonly avgScore: number | null;
  readonly maxScore: number;
  /** 还有待批改简答的提交条数；`0` 表示这个版本已经全部批完。 */
  readonly pendingCount: number;
}

/**
 * 选项/量表取值的分布（A-09 的「各选项分布」）。
 *
 * 分母与 `CollectionStat.total` 一致（提交份数）。多选一题可选多个选项，
 * 因此各选项占比之和可能超过 100%——这是多选的语义，不是算错。
 */
export interface CollectionOptionStat {
  /** 选项 id；量表字段用取值的字符串形式（`"4"`）。 */
  readonly optionId: string;
  /** 选项文字；量表没有文字时是取值本身。 */
  readonly label: string;
  readonly count: number;
  readonly rate: number | null;
}

/** 收集型表单的逐字段回收统计。 */
export interface CollectionStat {
  readonly itemId: string;
  readonly title: string;
  readonly type: "single" | "multi" | "fill" | "number" | "short" | "scale";
  readonly total: number;
  readonly answered: number;
  readonly rate: number | null;
  /**
   * 选择型（单选/多选）与量表的取值分布；简答/填空/数值没有固定取值，不出现这个键。
   * 量表跨度超过 10 档时也不出现——一屏几十根条不是统计，是噪音。
   */
  readonly options?: readonly CollectionOptionStat[];
}

/**
 * 一道题的统计（省赛 R-04）。
 *
 * 只统计**能判对错**的题：四种自动判分题型且该题带标准答案。简答由教师给分，
 * 没有「对错」；survey 的字段没有答案，硬算会得到一片 0%，看起来像「学生全错」。
 * 所以 survey 的 `itemStats` 是空数组，看板整块不渲染——未知值不伪填。
 */
export interface ItemStat {
  readonly itemId: string;
  /** 题干标题：看板直接渲染，不必为了一个标题再拉一次表单详情。 */
  readonly title: string;
  readonly score: number;
  /** 分母：**该版本的提交份数**。未作答的提交也算在分母里。 */
  readonly total: number;
  /** 有过作答的提交数（答错也算）。`answered < total` 说明有学生跳过了这题。 */
  readonly answered: number;
  /** 答对的提交数。 */
  readonly correct: number;
  /**
   * `correct / total`，保留 4 位小数；`total === 0` 时是 `null`，不是 `0`。
   * 0 会被读成「全班全错」，而 `null` 是「还没有人提交」——与 `avgScore` 同一条口径。
   */
  readonly rate: number | null;
}

export interface SubmissionsResponse {
  readonly ok: true;
  readonly summary: SubmissionSummary;
  readonly rows: readonly SubmissionRow[];
  /** 这个版本里需要人工批改的题目（按 schema 顺序）；空数组表示全自动判分。 */
  readonly shortItems: readonly GradableShortItem[];
  /** 逐题正确率（按 schema 顺序）；survey 或没有可判分题时是空数组。 */
  readonly itemStats: readonly ItemStat[];
  /** 收集型表单的逐字段回收统计；quiz 为空数组。 */
  readonly collectionStats: readonly CollectionStat[];
  /** 由当前版本实际 Schema 计算的知识点 × 布鲁姆覆盖矩阵。 */
  readonly coverageMatrix: CoverageMatrix;
}

/* ------------------------------- 人工批改 -------------------------------- */

/**
 * 给一条提交里的一道简答打分（省赛 R-02）。
 *
 * `score` 是**这道题的得分**，不是"再给几分"：重复提交同一题按覆盖处理，
 * 所以教师改错了直接改数字重发，不需要先撤销。
 */
export const gradeRequestSchema = z.object({
  itemId: z.string().regex(LIMITS.shortIdPattern, "itemId 需匹配 ^[a-z0-9_-]{1,32}$"),
  score: z
    .number()
    .int("分值必须是整数")
    .min(0, "分值不能是负数")
    // 与 schema 的单题分值上限用同一个数字：两处各写一份迟早会漂移，届时
    // 会出现「schema 里 120 分的题，教师端永远打不了满分」这种荒唐状态。
    .max(LIMITS.scoreMax, `单题分值不能超过 ${String(LIMITS.scoreMax)}`),
});

export type GradeRequest = z.infer<typeof gradeRequestSchema>;

export interface GradeResponse {
  readonly ok: true;
  /** 打完这一题之后，该条提交的最新状态（得分/待批改额度都已重算）。 */
  readonly submission: SubmissionRow;
}

/* --------------------------- AI 辅助评分（A-23） --------------------------- */

/**
 * `POST /api/forms/:id/submissions/:submissionId/ai-grade` 的请求。
 *
 * 只收 `itemId`：学生答案由服务端从这条提交里取，教师不能借这个接口
 * 把任意文本送进模型。表单级开关 `aiGradingEnabled` 关闭时整条路由拒绝。
 */
export const aiGradeRequestSchema = z
  .object({
    itemId: z.string().regex(LIMITS.shortIdPattern, "itemId 需匹配 ^[a-z0-9_-]{1,32}$"),
  })
  // 学生答案必须由服务端从提交里取；客户端多传一个 answer 键也直接拒，避免"像是能指定答案"。
  .strict();

export type AiGradeRequest = z.infer<typeof aiGradeRequestSchema>;

/**
 * 只回**建议**，不落分。教师看到建议后仍要点原来的「保存」才写 `manual_grades`，
 * 所以模型不能直接改任何学生的成绩。
 */
export interface AiGradeResponse {
  readonly ok: true;
  readonly itemId: string;
  readonly suggestedScore: number;
  readonly maxScore: number;
  readonly rationale: string;
  readonly source: "live" | "record" | "mock";
  readonly promptVersion: string;
}

/**
 * CSV 表头前四列固定，后面按版本里的字段 id 依次追加。
 * 表头写死在这里，是因为 `pnpm verify` 要拿它做字节级断言：
 * 一旦有人在导出里混进 `answer` 列，校验会直接失败而不是"看起来正常"。
 */
export const CSV_BASE_COLUMNS = ["submission_id", "created_at", "score", "max_score"] as const;

/** CSV 的 Content-Type；带 charset，Excel 打开中文表头才不乱码。 */
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

/* ------------------------------- 意图澄清（R-05） ------------------------------- */

/**
 * 澄清请求。匿名可用（与生成页一致：还没登录也能先问清楚再生成）。
 * `kind` 可省：省了由 `inferFormKind` 从文本推断；显式传则以调用方为准
 * （界面上的品类选择器就是"显式传"的那一方）。
 */
export const clarifyRequestSchema = z.object({
  requirement: z
    .string()
    .trim()
    .min(1, "需求不能为空")
    .max(LIMITS.requirementMaxChars, `需求最多 ${String(LIMITS.requirementMaxChars)} 字`),
  kind: z.enum(FORM_KINDS).optional(),
});

export type ClarifyRequest = z.infer<typeof clarifyRequestSchema>;

export interface ClarifyResponse {
  readonly ok: true;
  /** 实际用来找槽位的品类（推断值或调用方指定值），界面据此显示"按问卷问"。 */
  readonly kind: FormKind;
  /** 最多 3 条；空数组表示需求已经够完整，直接生成即可。 */
  readonly questions: readonly ClarifyQuestion[];
}

/**
 * 一条回答。`answer` 是自由文本，快捷选项点下去也是文本（"10 题"）——
 * 保持一种形态，界面与契约都不用为"选项 vs 手填"分叉。
 */
export const clarificationSchema = z.object({
  slot: z.enum(CLARIFY_SLOTS),
  answer: z
    .string()
    .trim()
    .min(1, "回答不能为空")
    .max(CLARIFY_ANSWER_MAX_CHARS, `回答最多 ${String(CLARIFY_ANSWER_MAX_CHARS)} 字`),
});

export type Clarification = z.infer<typeof clarificationSchema>;

/** 一次生成最多带几条补充：与追问上限同量级，防止有人拿它当配置文件灌内容。 */
export const CLARIFICATIONS_MAX = 8;

/* ------------------------------- 蓝图（R-06） ------------------------------- */

/**
 * 规划请求：与澄清请求同形（需求 + 可选品类 + 可选补答）。
 * 补答先进需求，再拿去规划——两步看到的是同一段需求，否则蓝图和成品的口径会岔开。
 */
export const PLAN_REFERENCE_MAX_CHARS = 20_000;

export const planRequestSchema = clarifyRequestSchema.extend({
  clarifications: z.array(clarificationSchema).max(CLARIFICATIONS_MAX).optional(),
  /**
   * 教师粘贴的参考试卷原文。**只用于规划阶段**提炼结构与风格；
   * 生成阶段收不到它（见 `buildUserPrompt` 的参数形状），从结构上防照抄。
   */
  reference: z
    .string()
    .trim()
    .max(PLAN_REFERENCE_MAX_CHARS, `参考试卷最多 ${String(PLAN_REFERENCE_MAX_CHARS)} 字`)
    .optional(),
  /** 本次请求是否允许联网参考；服务端还会检查模式与搜索配置，任一不满足就不搜。 */
  webSearch: z.boolean().optional(),
});

export type PlanRequest = z.infer<typeof planRequestSchema>;

/**
 * 联网参考回执。
 *
 * - `off`：四道闸有任一不满足（非 live / 未勾选 / 端点或 Key 未配置），**零外呼**；
 * - `used`：搜索成功且拿到至少一条可用结果；
 * - `empty`：搜索成功但没有可用结果（供应商返回空/字段全不合规）；
 * - `failed`：超时、网络错误、HTTP 非 2xx 或响应不是约定 JSON。规划照常继续。
 */
export const PLAN_SEARCH_STATUSES = ["off", "used", "empty", "failed"] as const;
export type PlanSearchStatus = (typeof PLAN_SEARCH_STATUSES)[number];

export interface PlanResponse {
  readonly ok: true;
  readonly kind: FormKind;
  /** 结构化蓝图（教师确认的对象）。 */
  readonly blueprint: FormBlueprint;
  /** 一句话摘要，界面直接显示。 */
  readonly summary: string;
  /** 实际送给模型的需求（拼过补答）；与生成时用的那一串**逐字节相同**。 */
  readonly requirement: string;
  /** 本次是否真的联网参考（离线模式恒为 `off`）。 */
  readonly searchStatus: PlanSearchStatus;
  /** 实际送入规划提示的搜索结果条数（`off`/`failed` 时为 0）。 */
  readonly searchCount: number;
}
