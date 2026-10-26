/**
 * submissions / usage_daily / login_attempts 三张小表的仓库。
 *
 * 提交是**只写一次**的：没有 update，没有 delete（看板只读）。行里的
 * `form_version_id` 是判分依据的指纹，`answers_json` 存序列化后的答案，
 * `ip_hash` 只存 `sha256(SESSION_SECRET + ip)`，明文 IP 不落库。
 */

import type { Db } from "./index.ts";

export interface SubmissionRow {
  readonly id: string;
  readonly form_id: string;
  readonly form_version_id: string;
  readonly answers_json: string;
  readonly score: number;
  readonly max_score: number;
  readonly ip_hash: string;
  readonly created_at: string;
}

export interface NewSubmission {
  readonly id: string;
  readonly formId: string;
  readonly formVersionId: string;
  readonly answersJson: string;
  readonly score: number;
  readonly maxScore: number;
  readonly ipHash: string;
  readonly createdAt: string;
}

export function insertSubmission(db: Db, row: NewSubmission): void {
  db.prepare(
    `INSERT INTO submissions
       (id, form_id, form_version_id, answers_json, score, max_score, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.formId,
    row.formVersionId,
    row.answersJson,
    row.score,
    row.maxScore,
    row.ipHash,
    row.createdAt,
  );
}

/**
 * 按 (表单, 版本) 取提交。**不跨版本合并**：不同版本的 max_score 与题目集合可能不同，
 * 混在一起算平均分是错的（《计划 v3.0》§3.5 规则 2）。
 */
export function listSubmissionsByVersion(
  db: Db,
  formId: string,
  formVersionId: string,
): readonly SubmissionRow[] {
  return db
    .prepare<[string, string], SubmissionRow>(
      `SELECT * FROM submissions
        WHERE form_id = ? AND form_version_id = ?
        ORDER BY created_at ASC, id ASC`,
    )
    .all(formId, formVersionId);
}

export function countSubmissionsByVersion(db: Db, formId: string, formVersionId: string): number {
  const row = db
    .prepare<[string, string], { c: number }>(
      "SELECT COUNT(*) AS c FROM submissions WHERE form_id = ? AND form_version_id = ?",
    )
    .get(formId, formVersionId);
  return row?.c ?? 0;
}

/** 累计当日 token 用量（I3 生成链路的账本，本层只提供读写，不在这里做限流判定）。 */
export function addDailyTokens(db: Db, teacherId: string, day: string, tokens: number): void {
  db.prepare(
    `INSERT INTO usage_daily (teacher_id, day, tokens) VALUES (?, ?, ?)
     ON CONFLICT (teacher_id, day) DO UPDATE SET tokens = tokens + excluded.tokens`,
  ).run(teacherId, day, tokens);
}

export function getDailyTokens(db: Db, teacherId: string, day: string): number {
  const row = db
    .prepare<[string, string], { tokens: number }>(
      "SELECT tokens FROM usage_daily WHERE teacher_id = ? AND day = ?",
    )
    .get(teacherId, day);
  return row?.tokens ?? 0;
}

export interface LoginAttemptRow {
  readonly key: string;
  readonly count: number;
  readonly locked_until: number;
}

export function getLoginAttempt(db: Db, key: string): LoginAttemptRow | undefined {
  return db
    .prepare<[string], LoginAttemptRow>("SELECT * FROM login_attempts WHERE key = ?")
    .get(key);
}

/**
 * 记一次失败并返回新的失败次数。
 *
 * 用一条 UPSERT 完成「读-改-写」：`count = count + 1` 是数据库侧自增，并发登录
 * 不会互相覆盖（先 SELECT 再 UPDATE 会丢计数）。锁定期到了就从 1 重新数。
 */
export function recordLoginFailure(
  db: Db,
  key: string,
  now: number,
  maxFailures: number,
  lockMs: number,
): number {
  const current = getLoginAttempt(db, key);
  const expired = current !== undefined && current.locked_until !== 0 && current.locked_until <= now;
  const nextCount = current === undefined || expired ? 1 : current.count + 1;
  const lockedUntil = nextCount >= maxFailures ? now + lockMs : 0;
  db.prepare(
    `INSERT INTO login_attempts (key, count, locked_until) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until`,
  ).run(key, nextCount, lockedUntil);
  return nextCount;
}

export function clearLoginFailures(db: Db, key: string): void {
  db.prepare("DELETE FROM login_attempts WHERE key = ?").run(key);
}

/** 登录锁是否生效。返回剩余毫秒数，0 表示没锁。 */
export function lockRemainingMs(db: Db, key: string, now: number): number {
  const row = getLoginAttempt(db, key);
  if (row === undefined || row.locked_until === 0) return 0;
  return row.locked_until > now ? row.locked_until - now : 0;
}
