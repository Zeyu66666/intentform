/**
 * 建表与迁移（《计划 v3.0》§3.5 六张表）。
 *
 * 三条贯穿整个持久层的规则，写在最上面，后面每个仓库函数都要遵守：
 *
 * 1. **form_versions 是追加式的**：写入后任何代码路径都不许 UPDATE / DELETE。
 *    这里用触发器把这条焊死在数据库里，而不是靠「我们记得别写」。仓库层也
 *    干脆不提供 updateVersion / deleteVersion 这样的函数——没有 API 就没人能误用。
 *    连 `forms` 的 ON DELETE CASCADE 也到不了版本行（触发器优先），这是有意的：
 *    历史提交的判分依据不能被连带擦掉。
 *
 * 2. **发布是写指针**：`forms.published_version_id` 指向某个已存在的版本行，
 *    发布本身不产生新版本、不改旧版本。所以「发布后再改 Schema」物理上做不到，
 *    快照天然成立（VC1 验的就是这个）。
 *
 * 3. **归属条件进 SQL**：`forms` 的每一处查询都带 `teacher_id = ?`，不靠上层
 *    「先查再判断」，因为那种写法忘一次就是越权。
 *
 * 全部语句都是 `CREATE ... IF NOT EXISTS`，迁移幂等：启动即执行，重复启动无副作用。
 */

/** 建表语句 + 索引 + 追加式触发器。顺序有意义：先表后索引后触发器。 */
export const MIGRATION_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS teachers (
     id            TEXT PRIMARY KEY,
     email         TEXT NOT NULL UNIQUE,
     password_hash TEXT NOT NULL,
     created_at    TEXT NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS forms (
     id                   TEXT PRIMARY KEY,
     teacher_id           TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
     title                TEXT NOT NULL,
     kind                 TEXT NOT NULL CHECK (kind IN ('quiz', 'survey')),
     draft_version_id     TEXT NOT NULL,
     published_version_id TEXT,
     slug                 TEXT UNIQUE,
     status               TEXT NOT NULL CHECK (status IN ('draft', 'published')),
     updated_at           TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_forms_teacher_id ON forms(teacher_id)`,

  `CREATE TABLE IF NOT EXISTS form_versions (
     id             TEXT PRIMARY KEY,
     form_id        TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
     n              INTEGER NOT NULL,
     schema_json    TEXT NOT NULL,
     source         TEXT NOT NULL CHECK (source IN ('generate', 'patch', 'repair')),
     parent_id      TEXT,
     prompt_version TEXT NOT NULL,
     created_at     TEXT NOT NULL,
     UNIQUE (form_id, n)
   )`,

  `CREATE TABLE IF NOT EXISTS submissions (
     id              TEXT PRIMARY KEY,
     form_id         TEXT NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
     form_version_id TEXT NOT NULL REFERENCES form_versions(id),
     answers_json    TEXT NOT NULL,
     score           INTEGER NOT NULL,
     max_score       INTEGER NOT NULL,
     ip_hash         TEXT NOT NULL,
     created_at      TEXT NOT NULL
   )`,

  `CREATE INDEX IF NOT EXISTS idx_submissions_form_version
     ON submissions(form_id, form_version_id)`,

  `CREATE TABLE IF NOT EXISTS usage_daily (
     teacher_id TEXT NOT NULL REFERENCES teachers(id) ON DELETE CASCADE,
     day        TEXT NOT NULL,
     tokens     INTEGER NOT NULL,
     PRIMARY KEY (teacher_id, day)
   )`,

  `CREATE TABLE IF NOT EXISTS login_attempts (
     key          TEXT PRIMARY KEY,
     count        INTEGER NOT NULL,
     locked_until INTEGER NOT NULL
   )`,

  // 追加式锁：UPDATE 直接 ABORT，DELETE 也 ABORT。
  `CREATE TRIGGER IF NOT EXISTS form_versions_append_only_update
     BEFORE UPDATE ON form_versions
   BEGIN
     SELECT RAISE(ABORT, 'form_versions is append-only: versions cannot be modified');
   END`,

  `CREATE TRIGGER IF NOT EXISTS form_versions_append_only_delete
     BEFORE DELETE ON form_versions
   BEGIN
     SELECT RAISE(ABORT, 'form_versions is append-only: versions cannot be deleted');
   END`,
];
