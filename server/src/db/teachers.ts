/**
 * teachers 表仓库。
 *
 * 只有三件事：按 email 找人（登录）、按 id 找人（每次请求校验会话）、插一个人（seed）。
 * 没有注册接口，所以没有「创建教师」的 HTTP 路径——`insertTeacher` 只给 seed 用。
 */

import type { Db } from "./index.ts";

export interface TeacherRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly created_at: string;
}

export function findTeacherByEmail(db: Db, email: string): TeacherRow | undefined {
  return db
    .prepare<[string], TeacherRow>("SELECT * FROM teachers WHERE email = ?")
    .get(email);
}

export function findTeacherById(db: Db, id: string): TeacherRow | undefined {
  return db
    .prepare<[string], TeacherRow>("SELECT * FROM teachers WHERE id = ?")
    .get(id);
}

export function insertTeacher(db: Db, row: TeacherRow): void {
  db.prepare(
    `INSERT INTO teachers (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
  ).run(row.id, row.email, row.password_hash, row.created_at);
}
