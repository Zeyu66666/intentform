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
import { formSchema, type FormSchema } from "./types.ts";
import { patchOpsSchema, type PatchChange, type PatchError, type PatchOp } from "./patch.ts";

/** 路由表：前后端都从这里取路径，避免 "/api/forms/:id/publish" 手写成两种拼法。 */
export const API_PATHS = {
  login: "/api/auth/login",
  logout: "/api/auth/logout",
  me: "/api/auth/me",
  generate: "/api/generate",
  forms: "/api/forms",
  form: (formId: string) => `/api/forms/${encodeURIComponent(formId)}`,
  publish: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/publish`,
  /** 受限修改（省赛 R-03）：只接受六种操作，追加一个新草稿版本。 */
  patchForm: (formId: string) => `/api/forms/${encodeURIComponent(formId)}`,
  /** 撤销一步：把草稿指针退回当前草稿的父版本。 */
  undoDraft: (formId: string) => `/api/forms/${encodeURIComponent(formId)}/undo`,
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

/* ------------------------------ 受限修改（R-03） ---------------------------- */

/**
 * `PATCH /api/forms/:id` 的请求。
 *
 * `baseVersionId` 是乐观锁：教师界面上看到的草稿是哪一版，就带哪一版。
 * 中间别人改过（草稿指针已前进）时服务端回 409，而不是"以最后写入为准"——
 * 后者会让两个人的改动互相吞掉，且没有任何一方看到发生了这件事。
 *
 * 标题与 Schema 分开传：改标题不动题目，也不该让题目的版本号蹭一个不必要的增量。
 */
export const patchFormRequestSchema = z.object({
  baseVersionId: z.string().min(1).max(64),
  ops: patchOpsSchema,
  /** 可选：一并改表单标题。不传表示只改题目。 */
  title: z.string().trim().min(1).max(LIMITS.formTitleMax).optional(),
});

export type PatchFormRequest = z.infer<typeof patchFormRequestSchema>;

/** 撤销：把草稿指针退回 `fromVersionId` 的父版本。 */
export const undoDraftRequestSchema = z.object({
  fromVersionId: z.string().min(1).max(64),
});

export type UndoDraftRequest = z.infer<typeof undoDraftRequestSchema>;

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
  readonly count: number;
  /** 无提交时为 `null`，不要补 0——0 分和"还没有人交"是两件事。 */
  readonly avgScore: number | null;
  readonly maxScore: number;
  /** 还有待批改简答的提交条数；`0` 表示这个版本已经全部批完。 */
  readonly pendingCount: number;
}

export interface SubmissionsResponse {
  readonly ok: true;
  readonly summary: SubmissionSummary;
  readonly rows: readonly SubmissionRow[];
  /** 这个版本里需要人工批改的题目（按 schema 顺序）；空数组表示全自动判分。 */
  readonly shortItems: readonly GradableShortItem[];
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

/**
 * CSV 表头前四列固定，后面按版本里的字段 id 依次追加。
 * 表头写死在这里，是因为 `pnpm verify` 要拿它做字节级断言：
 * 一旦有人在导出里混进 `answer` 列，校验会直接失败而不是"看起来正常"。
 */
export const CSV_BASE_COLUMNS = ["submission_id", "created_at", "score", "max_score"] as const;

/** CSV 的 Content-Type；带 charset，Excel 打开中文表头才不乱码。 */
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";
