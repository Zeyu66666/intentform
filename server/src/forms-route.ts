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
  applyPatch,
  createFormRequestSchema,
  formSchema,
  isFormKind,
  patchFormPayloadOf,
  patchFormRequestSchema,
  publishRequestSchema,
  redoDraftRequestSchema,
  translateJsonPatch,
  undoDraftRequestSchema,
  validateForm,
  VERSION_CONFLICT_MESSAGE,
  type CreateFormResponse,
  type DeleteFormResponse,
  type FormDetailResponse,
  type FormKind,
  type FormSchema,
  type FormStatus,
  type FormSummary,
  type FormVersionSource,
  type FormVersionSummary,
  type ListFormsResponse,
  type PatchFormResponse,
  type PatchIssue,
  type PatchOp,
  type PublishResponse,
  type RedoDraftResponse,
  type SchemaError,
  type UndoDraftResponse,
} from "@intentform/schema";
import { requireTeacher } from "./auth.ts";
import {
  appendVersion,
  clearRedo,
  findForm,
  findFormOwnerId,
  findVersion,
  insertFormWithInitialVersion,
  isSlugTaken,
  listForms,
  popRedo,
  publishVersion,
  pushRedo,
  redoDepth,
  setDraftVersion,
  softDeleteForm,
  updateFormTitle,
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

/**
 * `DELETE /api/forms/:id` —— 逻辑删除。
 *
 * 不物理删行：版本是历史提交的判分依据，`form_versions` 的触发器也不允许删。
 * 写一条 tombstone 后，列表/详情/学生页/提交统计会同时看不到它，效果与删除一致；
 * 数据库里仍能回答「这条历史提交当年是哪张卷子」。
 */
export async function handleDeleteForm(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  const deleted = softDeleteForm(ctx.db, form.teacher_id, form.id, new Date().toISOString());
  if (!deleted) {
    // 并发下另一个请求先删掉了：对客户端仍是「它已经不在了」。
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const response: DeleteFormResponse = { ok: true, formId: form.id };
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
  // 编辑器默认看草稿；打印页可以显式请求发布快照，避免把尚未发布的改稿印出去。
  const requestedVersionId = ctx.url.searchParams.get("versionId");
  const versionId = requestedVersionId === null || requestedVersionId === ""
    ? form.draft_version_id
    : requestedVersionId;
  const version = findVersion(ctx.db, form.id, versionId);
  if (version === undefined) {
    sendApiError(ctx.res, "not_found", "该版本不存在，或不属于这份表单");
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
    redoAvailable: redoDepth(ctx.db, form.id) > 0,
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

/* ------------------------- 受限修改（省赛 R-03 / I7） ----------------------- */

/**
 * 读某个版本行的 Schema。损坏时已写响应并返回 undefined——与详情接口同口径，
 * 表被手改过时这里是 500，而不是把脏数据当"当前草稿"继续算差异。
 */
function readVersionSchema(
  ctx: RouteContext,
  formId: string,
  versionId: string,
): { version: FormVersionRow; schema: FormSchema } | undefined {
  const version = findVersion(ctx.db, formId, versionId);
  if (version === undefined) {
    sendApiError(ctx.res, "not_found", "版本不存在");
    return undefined;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(version.schema_json);
  } catch {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return undefined;
  }
  const schema = formSchema.safeParse(raw);
  if (!schema.success) {
    sendApiError(ctx.res, "internal", "版本快照损坏");
    return undefined;
  }
  return { version, schema: schema.data as FormSchema };
}

/**
 * `PATCH /api/forms/:id` —— 受限修改。
 *
 * 三处要点：
 * 1. **乐观锁在草稿指针上**：`baseVersionId` 必须等于 `forms.draft_version_id`。
 *    不等就 409，既不"以最后写入为准"，也不静默合并——后者会让两个人的改动互相吞掉。
 * 2. **追加版本，不原地改**：版本行只增不改（§3.5），撤销因此天然可行：把指针退回去即可。
 * 3. **追加前不跑整表门禁**：草稿允许不完整（发布才跑门禁）。但结构必须过 zod，
 *    否则下一次读详情就会 500。
 */
export async function handlePatchForm(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  const body = await readJsonBody(ctx, FORM_BODY_MAX_BYTES, "修改请求体过大");
  if (!body.ok) return;
  const parsed = patchFormRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  if (parsed.data.baseVersionId !== form.draft_version_id) {
    // 与旧版提交 409 同一条文案：两处都是"你手上那版不是当前的"，刷新能解决。
    sendApiError(ctx.res, "version_conflict", VERSION_CONFLICT_MESSAGE);
    return;
  }
  const base = readVersionSchema(ctx, form.id, parsed.data.baseVersionId);
  if (base === undefined) return;

  // 两种请求形状在这里归一：受限 op 直接过 applyPatch；RFC 6902 先翻译回受限 op。
  // 翻译失败不写库、不产生版本，错误定位到具体第几条 JSON Patch。
  const payload = patchFormPayloadOf(parsed.data);
  let ops: readonly PatchOp[];
  if (payload.kind === "json-patch") {
    const translated = translateJsonPatch(base.schema, payload.ops);
    if (!translated.ok) {
      const first = translated.errors[0];
      sendApiError(
        ctx.res,
        "bad_request",
        `通用 Patch 未通过校验：${first?.message ?? "无法翻译为受限改动"}`,
      );
      return;
    }
    ops = translated.ops;
  } else {
    ops = payload.ops;
  }

  const applied = applyPatch(base.schema, ops);
  if (!applied.ok) {
    const detail = applied.errors.map((error) => `#${String(error.opIndex)} ${error.code}`).join("、");
    sendApiError(ctx.res, "bad_request", `修改未通过校验：${applied.errors[0]?.message ?? detail}`);
    return;
  }
  if (applied.changes.length === 0) {
    // 空改动不产生版本：否则点一次"保存"就多一版，撤销栈里全是空步。
    const response: PatchFormResponse = {
      ok: true,
      form: toFormSummary(form),
      version: toVersionSummary(base.version),
      schema: base.schema,
      changes: [],
      issues: patchIssues(base.schema),
    };
    sendJson(ctx.res, 200, response);
    return;
  }

  const now = new Date().toISOString();
  const versionId = newId("v");
  const appended = appendVersion(ctx.db, {
    id: versionId,
    formId: form.id,
    schemaJson: JSON.stringify(applied.schema),
    source: "patch",
    parentId: base.version.id,
    // 人工改的版本没有 prompt 参与；写 "manual" 与手工导入同口径，便于日后解释来源。
    promptVersion: "manual",
    createdAt: now,
  });
  // 撤销后又产生了新版本：旧分支作废，重做栈清空。否则「重做」会把已经被
  // 新改动绕过的旧版本重新拨回来，历史看起来像分叉。
  clearRedo(ctx.db, form.id);
  setDraftVersion(ctx.db, form.id, appended.id, now);
  if (parsed.data.title !== undefined && parsed.data.title !== form.title) {
    updateFormTitle(ctx.db, {
      teacherId: form.teacher_id,
      formId: form.id,
      title: parsed.data.title,
      updatedAt: now,
    });
  }
  const refreshed = findForm(ctx.db, form.teacher_id, form.id);
  if (refreshed === undefined) {
    sendApiError(ctx.res, "internal", "表单写入后读回失败");
    return;
  }
  const response: PatchFormResponse = {
    ok: true,
    form: toFormSummary(refreshed),
    version: toVersionSummary(appended),
    schema: applied.schema,
    changes: applied.changes,
    issues: patchIssues(applied.schema),
  };
  sendJson(ctx.res, 200, response);
}

/**
 * 新草稿的门禁提示：草稿允许半成品，但不能让使用者对「现在能不能发布」毫无所知。
 * 与发布用的是同一个 `validateForm`，所以提示和真正发布时的拒绝原因不会两套说法。
 */
function patchIssues(schema: FormSchema): readonly PatchIssue[] {
  const checked = validateForm(schema);
  if (checked.ok) return [];
  return checked.errors.map((error) => ({
    code: error.code,
    path: error.path,
    message: error.message,
  }));
}

/**
 * `POST /api/forms/:id/undo` —— 撤销一步。
 *
 * 撤销 = 把当前版本压入重做栈，再把草稿指针退回 `fromVersionId` 的父版本。
 * **不删版本行**：撤销之后还能按 LIFO 重做回来，也能从父版本继续改（此时清空重做栈）。
 *
 * 优先只认"没有父版本"（v1）：此时没有更早的草稿可退，回 200 且 `undone: false`。
 */
export async function handleUndoDraft(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  const body = await readJsonBody(ctx, FORM_BODY_MAX_BYTES, "撤销请求体过大");
  if (!body.ok) return;
  const parsed = undoDraftRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  if (parsed.data.fromVersionId !== form.draft_version_id) {
    sendApiError(ctx.res, "version_conflict", VERSION_CONFLICT_MESSAGE);
    return;
  }
  const current = readVersionSchema(ctx, form.id, parsed.data.fromVersionId);
  if (current === undefined) return;

  const parentId = current.version.parent_id;
  if (parentId === null || parentId === "") {
    const response: UndoDraftResponse = {
      ok: true,
      form: toFormSummary(form),
      version: toVersionSummary(current.version),
      schema: current.schema,
      undone: false,
      redoAvailable: redoDepth(ctx.db, form.id) > 0,
    };
    sendJson(ctx.res, 200, response);
    return;
  }
  const parent = readVersionSchema(ctx, form.id, parentId);
  if (parent === undefined) return;

  const now = new Date().toISOString();
  // 先压栈再拨指针：万一两步之间失败，栈里多一条旧版本比少一条安全——
  // 重做时会核对 parentId，对不上就当作空栈，不会把别的分支拨回来。
  pushRedo(ctx.db, form.id, current.version.id);
  setDraftVersion(ctx.db, form.id, parent.version.id, now);
  const refreshed = findForm(ctx.db, form.teacher_id, form.id);
  if (refreshed === undefined) {
    sendApiError(ctx.res, "internal", "表单写入后读回失败");
    return;
  }
  const response: UndoDraftResponse = {
    ok: true,
    form: toFormSummary(refreshed),
    version: toVersionSummary(parent.version),
    schema: parent.schema,
    undone: true,
    redoAvailable: redoDepth(ctx.db, form.id) > 0,
  };
  sendJson(ctx.res, 200, response);
}

/**
 * `POST /api/forms/:id/redo` —— 重做一步（2026-11-02 重做栈）。
 *
 * 与撤销共用乐观锁：`fromVersionId` 必须等于当前草稿指针。栈顶版本的
 * `parent_id` 必须正好是当前草稿——对不上说明撤销后已经走过新分支，
 * 旧栈作废，回 200 且 `redone: false`，不把历史拨成分叉。
 */
export async function handleRedoDraft(ctx: RouteContext): Promise<void> {
  const formId = ctx.params["id"];
  if (formId === undefined) {
    sendApiError(ctx.res, "not_found", "表单不存在");
    return;
  }
  const form = requireOwnedForm(ctx, formId);
  if (form === undefined) return;
  const body = await readJsonBody(ctx, FORM_BODY_MAX_BYTES, "重做请求体过大");
  if (!body.ok) return;
  const parsed = redoDraftRequestSchema.safeParse(body.value);
  if (!parsed.success) {
    sendApiError(ctx.res, "bad_request", describeZodError(parsed.error));
    return;
  }
  if (parsed.data.fromVersionId !== form.draft_version_id) {
    sendApiError(ctx.res, "version_conflict", VERSION_CONFLICT_MESSAGE);
    return;
  }
  const current = readVersionSchema(ctx, form.id, parsed.data.fromVersionId);
  if (current === undefined) return;

  const versionId = popRedo(ctx.db, form.id);
  if (versionId === undefined) {
    const response: RedoDraftResponse = {
      ok: true,
      form: toFormSummary(form),
      version: toVersionSummary(current.version),
      schema: current.schema,
      redone: false,
      redoAvailable: false,
    };
    sendJson(ctx.res, 200, response);
    return;
  }
  const target = readVersionSchema(ctx, form.id, versionId);
  if (target === undefined || target.version.parent_id !== current.version.id) {
    // 栈顶不是当前草稿的直接子版本：撤销后改过，旧分支作废。
    clearRedo(ctx.db, form.id);
    const response: RedoDraftResponse = {
      ok: true,
      form: toFormSummary(form),
      version: toVersionSummary(current.version),
      schema: current.schema,
      redone: false,
      redoAvailable: false,
    };
    sendJson(ctx.res, 200, response);
    return;
  }

  const now = new Date().toISOString();
  setDraftVersion(ctx.db, form.id, target.version.id, now);
  const refreshed = findForm(ctx.db, form.teacher_id, form.id);
  if (refreshed === undefined) {
    sendApiError(ctx.res, "internal", "表单写入后读回失败");
    return;
  }
  const response: RedoDraftResponse = {
    ok: true,
    form: toFormSummary(refreshed),
    version: toVersionSummary(target.version),
    schema: target.schema,
    redone: true,
    redoAvailable: redoDepth(ctx.db, form.id) > 0,
  };
  sendJson(ctx.res, 200, response);
}
