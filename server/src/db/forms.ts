/**
 * forms / form_versions 仓库。
 *
 * 关键约束（《计划 v3.0》§3.5）：
 * - 每条按 id 取表单的查询都带 `teacher_id`，越权在 SQL 层就查不到；
 * - 版本行只增不改：本文件没有 updateVersion / deleteVersion，唯一写版本的入口是
 *   `appendVersion`，且它只做 INSERT；
 * - `publishVersion` 是**写指针**：只更新 forms 的三个字段，不碰版本行；
 * - 同一表单的版本号 `n` 单调递增，由 `MAX(n)+1` 在事务里生成，靠
 *   `UNIQUE (form_id, n)` 兜住并发。
 */

import type { Db } from "./index.ts";

export interface FormRow {
  readonly id: string;
  readonly teacher_id: string;
  readonly title: string;
  readonly kind: string;
  readonly draft_version_id: string;
  readonly published_version_id: string | null;
  readonly slug: string | null;
  readonly status: string;
  readonly updated_at: string;
}

export interface FormVersionRow {
  readonly id: string;
  readonly form_id: string;
  readonly n: number;
  readonly schema_json: string;
  readonly source: string;
  readonly parent_id: string | null;
  readonly prompt_version: string;
  readonly created_at: string;
}

export interface NewForm {
  readonly id: string;
  readonly teacherId: string;
  readonly title: string;
  readonly kind: string;
  readonly updatedAt: string;
}

export interface NewVersion {
  readonly id: string;
  readonly formId: string;
  readonly schemaJson: string;
  readonly source: string;
  readonly parentId: string | null;
  readonly promptVersion: string;
  readonly createdAt: string;
}

export interface PublishInput {
  readonly teacherId: string;
  readonly formId: string;
  readonly versionId: string;
  readonly slug: string;
  readonly updatedAt: string;
}

/** 建表单与落 v1 必须同生同死，所以包在一个事务里。 */
export function insertFormWithInitialVersion(db: Db, form: NewForm, version: NewVersion): void {
  const run = db.transaction((): void => {
    db.prepare(
      `INSERT INTO forms
         (id, teacher_id, title, kind, draft_version_id, published_version_id, slug, status, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, 'draft', ?)`,
    ).run(form.id, form.teacherId, form.title, form.kind, version.id, form.updatedAt);
    insertVersionLine(db, version, 1);
  });
  run();
}

function insertVersionLine(db: Db, version: NewVersion, n: number): void {
  db.prepare(
    `INSERT INTO form_versions
       (id, form_id, n, schema_json, source, parent_id, prompt_version, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    version.id,
    version.formId,
    n,
    version.schemaJson,
    version.source,
    version.parentId,
    version.promptVersion,
    version.createdAt,
  );
}

/** 追加一个新版本（发布后的「改草稿」）。刻意不接受调用方指定 `n`。 */
export function appendVersion(db: Db, version: NewVersion): FormVersionRow {
  const run = db.transaction((): FormVersionRow => {
    const next = db
      .prepare<[string], { n: number | null }>(
        "SELECT MAX(n) AS n FROM form_versions WHERE form_id = ?",
      )
      .get(version.formId);
    const n = (next?.n ?? 0) + 1;
    insertVersionLine(db, version, n);
    const row = findVersion(db, version.formId, version.id);
    if (row === undefined) {
      throw new Error(`version row vanished after insert: ${version.id}`);
    }
    return row;
  });
  return run();
}

export function listForms(db: Db, teacherId: string): readonly FormRow[] {
  return db
    .prepare<[string], FormRow>(
      "SELECT * FROM forms WHERE teacher_id = ? ORDER BY updated_at DESC, id DESC",
    )
    .all(teacherId);
}

export function findForm(db: Db, teacherId: string, formId: string): FormRow | undefined {
  return db
    .prepare<[string, string], FormRow>(
      "SELECT * FROM forms WHERE id = ? AND teacher_id = ?",
    )
    .get(formId, teacherId);
}

/**
 * 只查归属，不带 `teacher_id` 条件——**仅供区分 403 与 404**。
 * 返回值一律不经过响应体：调用方只能拿它决定「存在但不是你的」还是「不存在」。
 */
export function findFormOwnerId(db: Db, formId: string): string | undefined {
  const row = db
    .prepare<[string], { teacher_id: string }>("SELECT teacher_id FROM forms WHERE id = ?")
    .get(formId);
  return row?.teacher_id;
}

/** 学生端入口：只认已发布（`published_version_id` 非空）的表单。 */
export function findPublishedFormBySlug(db: Db, slug: string): FormRow | undefined {
  return db
    .prepare<[string], FormRow>(
      `SELECT * FROM forms
        WHERE slug = ? AND status = 'published' AND published_version_id IS NOT NULL`,
    )
    .get(slug);
}

export function findVersion(
  db: Db,
  formId: string,
  versionId: string,
): FormVersionRow | undefined {
  return db
    .prepare<[string, string], FormVersionRow>(
      "SELECT * FROM form_versions WHERE id = ? AND form_id = ?",
    )
    .get(versionId, formId);
}

/** 取某表单最新版本（详情页在 draft 指针之外给个兜底）。 */
export function latestVersion(db: Db, formId: string): FormVersionRow | undefined {
  return db
    .prepare<[string], FormVersionRow>(
      "SELECT * FROM form_versions WHERE form_id = ? ORDER BY n DESC LIMIT 1",
    )
    .get(formId);
}

export function isSlugTaken(db: Db, slug: string): boolean {
  const row = db
    .prepare<[string], { c: number }>("SELECT COUNT(*) AS c FROM forms WHERE slug = ?")
    .get(slug);
  return (row?.c ?? 0) > 0;
}

/**
 * 发布 = 写指针。三件事原子完成：指向新版本、状态变 published、首次发布时落 slug。
 * 归属与「版本必须属于该表单」都写进 WHERE，用 affected rows 判断成败——
 * 这样就不存在「先查再写」之间被换掉的窗口。
 *
 * `slug = COALESCE(slug, ?)`：换版不动短链，学生手上那张二维码继续有效。
 */
export function publishVersion(db: Db, input: PublishInput): boolean {
  const result = db
    .prepare(
      `UPDATE forms
          SET published_version_id = ?,
              status = 'published',
              slug = COALESCE(slug, ?),
              updated_at = ?
        WHERE id = ?
          AND teacher_id = ?
          AND EXISTS (
                SELECT 1 FROM form_versions v
                 WHERE v.id = ? AND v.form_id = forms.id
              )`,
    )
    .run(
      input.versionId,
      input.slug,
      input.updatedAt,
      input.formId,
      input.teacherId,
      input.versionId,
    );
  return result.changes === 1;
}

/** 草稿指针推进（改草稿后详情页要能看到最新版本）。只动指针，不动版本行。 */
/** 改标题：仍然带 `teacher_id`，越权在 SQL 层查不到。 */
export function updateFormTitle(
  db: Db,
  input: { readonly teacherId: string; readonly formId: string; readonly title: string; readonly updatedAt: string },
): boolean {
  const result = db
    .prepare("UPDATE forms SET title = ?, updated_at = ? WHERE id = ? AND teacher_id = ?")
    .run(input.title, input.updatedAt, input.formId, input.teacherId);
  return result.changes > 0;
}

export function setDraftVersion(db: Db, formId: string, versionId: string, updatedAt: string): void {
  db.prepare("UPDATE forms SET draft_version_id = ?, updated_at = ? WHERE id = ?").run(
    versionId,
    updatedAt,
    formId,
  );
}
