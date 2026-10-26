/**
 * 教师端表单路由：建、列、看详情、发布。
 *
 * 四处要点：
 * 1. **归属进 SQL**：`findForm` 自带 `teacher_id`，查不到时再单独查一次归属，
 *    只为了把「存在但不是你的」回成 403 而不是 404（AGENTS.md §5 归属条）。
 * 2. **发布是写指针**：`publishVersion` 只 UPDATE forms 的四个字段；版本行一个字都不动，
 *    所以「发布后再改 Schema 影响历史判分」这件事在数据库层面就不成立。
 * 3. **slug 首次发布时生成，换版复用**：学生手上的链接不该因为老师改了个错别字就失效。
 * 4. **发布前跑整表门禁**（`validateForm`）：能发出去的卷子必须是可判分的，
 *    否则学生会拿到一张永远算不出分的卷子——这一步放在 publish 而不是 create，
 *    因为草稿本来就允许不完整。
 */

import {
  createFormRequestSchema,
  formSchema,
  isFormKind,
  publishRequestSchema,
  validateForm,
  VERSION_CONFLICT_MESSAGE,
  type CreateFormResponse,
  type FormDetailResponse,
  type FormKind,
  type FormStatus,
  type FormSummary,
  type FormVersionSource,
  type FormVersionSummary,
  type ListFormsResponse,
  type PublishResponse,
  type SchemaError,
} from "@intentform/schema";
import { requireTeacher } from "./auth.ts";
import {
  findForm,
  findFormOwnerId,
  findVersion,
  insertFormWithInitialVersion,
  isSlugTaken,
  listForms,
  publishVersion,
  setDraftVersion,
  type FormRow,
  type FormVersionRow,
} from "./db/forms.ts";
import { newId, newSlug } from "./ids.ts";
import {
  describeZodError,
  readJsonBody,
  sendApiError,
  sendJson,
  type RouteContext,
} from "./http.ts";

const FORM_BODY_MAX_BYTES = 256 * 1024;
const MAX_SLUG_ATTEMPTS = 8;
/** 发布门禁的 message 里最多列几条错误（再多就不是「提示」而是日志了）。 */
const MAX_ERRORS_IN_MESSAGE = 3;

function toFormKind(value: string): FormKind {
  if (isFormKind(value)) return value;
  throw new Error(`数据库里的 forms.kind 非法：${value}`);
}

function toFormStatus(value: string): FormStatus {
  if (value === "draft" || value === "published") return value;
  throw new Error(`数据库里的 forms.status 非法：${value}`);
}

function toVersionSource(value: string): FormVersionSource {
  if (value === "generate" || value === "patch" || value === "repair") return value;
  throw new Error(`数据库里的 form_versions.source 非法：${value}`);
}

function toFormSummary(row: FormRow): FormSummary {
  const slug = row.slug;
  const published = row.published_version_id;
  return {
    id: row.id,
    title: row.title,
    kind: toFormKind(row.kind),
    status: toFormStatus(row.status),
    draftVersionId: row.draft_version_id,
    updatedAt: row.updated_at,
    ...(slug === null ? {} : { slug }),
    ...(published === null ? {} : { publishedVersionId: published }),
  };
}

function toVersionSummary(row: FormVersionRow): FormVersionSummary {
  const parent = row.parent_id;
  return {
    id: row.id,
    n: row.n,
    source: toVersionSource(row.source),
    promptVersion: row.prompt_version,
    createdAt: row.created_at,
    ...(parent === null ? {} : { parentId: parent }),
  };
}

/** 归属校验：返回行，或在响应已写好时返回 undefined。 */
export function requireOwnedForm(ctx: RouteContext, formId: string): FormRow | undefined {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return undefined;
  const form = findForm(ctx.db, teacher.id, formId);
  if (form !== undefined) return form;
  if (findFormOwnerId(ctx.db, formId) !== undefined) {
    sendApiError(ctx.res, "forbidden", "无权访问该表单");
  } else {
    sendApiError(ctx.res, "not_found", "表单不存在");
  }
  return undefined;
}

export async function handleCreateForm(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;
  const body = await readJsonBody(ctx, FORM_BODY_MAX_BYTES, "表单请求体过大");
  if (!body.ok) return;
  const parsed = createFormRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  const now = new Date().toISOString();
  const formId = newId("f");
  const versionId = newId("v");
  insertFormWithInitialVersion(
    ctx.db,
    {
      id: formId,
      teacherId: teacher.id,
      title: parsed.data.title,
      kind: parsed.data.kind,
      updatedAt: now,
    },
    {
      id: versionId,
      formId,
      schemaJson: JSON.stringify(parsed.data.schema),
      source: parsed.data.source,
      parentId: null,
      // 手工/导入的表单没有 prompt 参与，记 "manual" 便于日后解释版本来源。
      promptVersion: "manual",
      createdAt: now,
    },
  );
  const form = findForm(ctx.db, teacher.id, formId);
  const version = findVersion(ctx.db, formId, versionId);
  if (form === undefined || version === undefined) {
    sendApiError(ctx.res, "internal", "表单写入后读回失败");
    return;
  }
  const response: CreateFormResponse = {
    ok: true,
    form: toFormSummary(form),
    version: toVersionSummary(version),
  };
  sendJson(ctx.res, 201, response);
}

export async function handleListForms(ctx: RouteContext): Promise<void> {
  const teacher = requireTeacher(ctx);
  if (teacher === undefined) return;
  const rows = listForms(ctx.db, teacher.id);
  const response: ListFormsResponse = { ok: true, forms: rows.map(toFormSummary) };
  sendJson(ctx.res, 200, response);
}

export async function handleGetForm(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  // 详情默认给草稿指针指向的版本（老师要看的是「我现在编辑的这版」）。
  const version = findVersion(ctx.db, form.id, form.draft_version_id);
  if (version === undefined) {
    sendApiError(ctx.res, "internal", "草稿版本缺失");
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(version.schema_json);
  } catch {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return;
  }
  // 从库里读出来的东西也过一遍 zod：表被手改过时这里是 500 而不是把脏数据发给前端。
  const schema = formSchema.safeParse(raw);
  if (!schema.success) {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return;
  }
  const response: FormDetailResponse = {
    ok: true,
    form: toFormSummary(form),
    version: toVersionSummary(version),
    // 教师看自己的卷子带答案，这是设计的：只有 /f/:slug 才走 publicView。
    schema: schema.data,
  };
  sendJson(ctx.res, 200, response);
}

export async function handlePublishForm(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  const body = await readJsonBody(ctx, FORM_BODY_MAX_BYTES, "发布请求体过大");
  if (!body.ok) return;
  const parsed = publishRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  const version = findVersion(ctx.db, form.id, parsed.data.versionId);
  if (version === undefined) {
    sendApiError(ctx.res, "bad_request", "该版本不属于这份表单");
    return;
  }
  let schemaJson: unknown;
  try {
    schemaJson = JSON.parse(version.schema_json);
  } catch {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return;
  }
  const checked = validateForm(schemaJson);
  if (!checked.ok) {
    // 门禁失败要**可诊断**：只回一句「未通过校验」会让老师（和评审）没法定位，
    // 但把十几条错误全塞进 message 又会变成一坨没人读完的字符串。
    // 折中：前 3 条 `错误码@路径`，再缀总数。
    sendApiError(
      ctx.res,
      "bad_request",
      `表单未通过发布校验：${describeFormErrors(checked.errors)}`,
    );
    return;
  }

  // 复用已有 slug：二维码/短链可能已经印在纸上发出去了，换版换短链等于让已发出的码
  // 全部失效。短链指向「表单」，`published_version_id` 才指向「哪一版」——换版只写指针。
  const slug = resolveSlug(ctx, form);
  if (slug === undefined) {
    sendApiError(ctx.res, "internal", "短链生成失败");
    return;
  }
  const now = new Date().toISOString();
  const published = publishVersion(ctx.db, {
    teacherId: form.teacher_id,
    formId: form.id,
    versionId: version.id,
    slug,
    updatedAt: now,
  });
  if (!published) {
    // 走到这里说明并发下表单被删/换主了；对客户端仍然是「这个版本发不出去」。
    sendApiError(ctx.res, "version_conflict", VERSION_CONFLICT_MESSAGE);
    return;
  }
  // 发布不改版本行，但草稿指针要跟上：老师发布完再打开编辑器，看到的就是刚发的这版。
  if (form.draft_version_id !== version.id) {
    setDraftVersion(ctx.db, form.id, version.id, now);
  }
  const response: PublishResponse = {
    ok: true,
    slug,
    versionId: version.id,
    publishedAt: now,
  };
  sendJson(ctx.res, 200, response);
}

/**
 * 发布门禁的错误摘要：前 3 条 `错误码@路径` + 总数。
 *
 * 为什么不是中文明文：错误码（`E_SCORE_SUM`）是**稳定**的，评审/前端可以按码写
 * 提示；`repair` 文本是写给模型的长句，塞进 HTTP 响应只会让体膨胀。
 */
function describeFormErrors(errors: readonly SchemaError[]): string {
  const shown = errors
    .slice(0, MAX_ERRORS_IN_MESSAGE)
    .map((error) => `${error.code}@${error.path}`)
    .join("、");
  if (errors.length <= MAX_ERRORS_IN_MESSAGE) return shown;
  return `${shown}（共 ${String(errors.length)} 处）`;
}

/** 已有 slug 就复用（换版不动短链），否则现生成一个不冲突的。 */
function resolveSlug(ctx: RouteContext, form: FormRow): string | undefined {
  const existing = form.slug;
  if (existing !== null && existing !== "") return existing;
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = newSlug();
    if (!isSlugTaken(ctx.db, candidate)) return candidate;
  }
  return undefined;
}
