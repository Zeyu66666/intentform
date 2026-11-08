/**
 * 题目配图的持久层。
 *
 * 图片本体不进 `schema_json`：一张 2 MB 的图若 base64 进版本，每个版本、
 * 每次读表单、每次学生打开都会多背一份。这里只存资产行，版本里存 `assetId`。
 *
 * 读取时连表单的归属与状态一起取回：路由据此决定「公开可读」还是「只有 owner
 * 能看」。已删除表单的资产与表单一样按不存在处理，不靠 404 的差异泄露历史。
 */

import type { Db } from "./index.ts";

export interface AssetRow {
  readonly id: string;
  readonly form_id: string;
  readonly teacher_id: string;
  readonly mime: string;
  readonly byte_length: number;
  readonly bytes: Buffer;
  readonly created_at: string;
}

export interface AssetReadRow {
  readonly id: string;
  readonly form_id: string;
  readonly mime: string;
  readonly byte_length: number;
  readonly bytes: Buffer;
  readonly form_teacher_id: string;
  readonly form_status: "draft" | "published";
}

export function insertAsset(db: Db, row: AssetRow): void {
  db.prepare(
    `INSERT INTO form_assets (id, form_id, teacher_id, mime, byte_length, bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.form_id, row.teacher_id, row.mime, row.byte_length, row.bytes, row.created_at);
}

export function findAssetForRead(db: Db, assetId: string): AssetReadRow | undefined {
  return db
    .prepare<[string], AssetReadRow>(
      `SELECT a.id, a.form_id, a.mime, a.byte_length, a.bytes,
              f.teacher_id AS form_teacher_id, f.status AS form_status
         FROM form_assets a
         JOIN forms f ON f.id = a.form_id
        WHERE a.id = ?
          AND NOT EXISTS (SELECT 1 FROM form_deletions d WHERE d.form_id = a.form_id)`,
    )
    .get(assetId);
}
