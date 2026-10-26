/**
 * 数据库句柄与迁移入口。
 *
 * `better-sqlite3` 是同步 API，整个持久层因此没有 Promise——路由层照旧是 async，
 * 但「查库」这一段不会被并发打断。这让我们能用事务把「建表单 + 落 v1」包成一步。
 *
 * 路径约定：`DATABASE_PATH` 可以是 `:memory:`（测试最快路径）、也可以是临时文件
 * （测试里需要两个进程/两次打开共享同一份数据时用）。文件模式会自动建父目录，
 * 因为默认值是 `./.data/intentform.db`，而 `.data/` 不进仓库。
 *
 * 不开 WAL：`.gitignore` 只挡了 `*.db-journal`，没挡 `*.db-wal` / `*.db-shm`，
 * 开了 WAL 会在工作区留两个不受管的文件。单人赛的数据量下 DELETE 日志足够。
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { MIGRATION_STATEMENTS } from "./schema.ts";

/** 仓库函数统一接受的句柄类型。 */
export type Db = Database.Database;

export function openDatabase(databasePath: string): Db {
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(databasePath), { recursive: true });
  }
  const db = new Database(databasePath);
  // 外键约束默认是关的，six 张表的 REFERENCES 全靠它生效。
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

/** 幂等迁移：每次打开都跑一遍，已建好的对象因 IF NOT EXISTS 直接跳过。 */
export function migrate(db: Db): void {
  for (const statement of MIGRATION_STATEMENTS) {
    db.exec(statement);
  }
}
