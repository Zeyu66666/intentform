/**
 * 持久层的结构性测试：迁移幂等、版本追加式、发布是指针、归属过滤。
 *
 * 「追加式」这条不是靠约定，是靠数据库触发器；这里就用 `UPDATE` / `DELETE`
 * 去撞它，撞出 ABORT 才算证明。也顺便证明**仓库层根本没有**改版本的函数——
 * 这条用「模块导出里没有 update/delete 关键字」的形状断言来钉。
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "./index.ts";
import * as formsRepo from "./forms.ts";

const tempDirs: string[] = [];

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "intentform-db-"));
  tempDirs.push(dir);
  return join(dir, "test.db");
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tableNames(db: Db): readonly string[] {
  return db
    .prepare<[], { name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all()
    .map((row) => row.name);
}

describe("openDatabase / migrate", () => {
  it("建出 §3.5 要求的六张表", () => {
    const db = openDatabase(":memory:");
    expect(tableNames(db)).toEqual([
      "form_versions",
      "forms",
      "login_attempts",
      "submissions",
      "teachers",
      "usage_daily",
    ]);
    db.close();
  });

  it("重复打开同一个文件不会报错（迁移幂等）", () => {
    const path = tempDatabasePath();
    const first = openDatabase(path);
    first.close();
    const second = openDatabase(path);
    expect(tableNames(second)).toContain("form_versions");
    second.close();
  });
});

describe("form_versions 追加式", () => {
  function seed(db: Db): { formId: string; versionId: string } {
    const formId = "f_seed";
    const versionId = "v_seed";
    db.prepare(
      `INSERT INTO teachers (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
    ).run("t_seed", "seed@example.com", "hash", "2024-01-01T00:00:00.000Z");
    formsRepo.insertFormWithInitialVersion(
      db,
      { id: formId, teacherId: "t_seed", title: "卷子", kind: "quiz", updatedAt: "2024-01-01T00:00:00.000Z" },
      {
        id: versionId,
        formId,
        schemaJson: '{"meta":{}}',
        source: "generate",
        parentId: null,
        promptVersion: "test",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    );
    return { formId, versionId };
  }

  it("UPDATE 已存在的版本行会被触发器 ABORT", () => {
    const db = openDatabase(":memory:");
    seed(db);
    expect(() => {
      db.prepare("UPDATE form_versions SET schema_json = ?").run('{"meta":{"tampered":1}}');
    }).toThrow(/append-only/);
    db.close();
  });

  it("DELETE 已存在的版本行会被触发器 ABORT", () => {
    const db = openDatabase(":memory:");
    seed(db);
    expect(() => {
      db.prepare("DELETE FROM form_versions").run();
    }).toThrow(/append-only/);
    db.close();
  });

  it("仓库层不导出任何「改/删版本」的函数", () => {
    const exported = Object.keys(formsRepo);
    expect(exported.filter((name) => /update|delete|remove/i.test(name))).toEqual([]);
  });

  it("appendVersion 自动递增 n，且不修改已有行", () => {
    const db = openDatabase(":memory:");
    const { formId } = seed(db);
    const appended = formsRepo.appendVersion(db, {
      id: "v_second",
      formId,
      schemaJson: '{"meta":{"second":true}}',
      source: "patch",
      parentId: "v_seed",
      promptVersion: "test",
      createdAt: "2024-01-02T00:00:00.000Z",
    });
    expect(appended.n).toBe(2);
    const first = formsRepo.findVersion(db, formId, "v_seed");
    expect(first?.schema_json).toBe('{"meta":{}}');
    db.close();
  });
});

describe("发布是写指针", () => {
  it("publishVersion 只改 forms，不动版本行内容", () => {
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO teachers (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`).run(
      "t_pub",
      "pub@example.com",
      "hash",
      "2024-01-01T00:00:00.000Z",
    );
    formsRepo.insertFormWithInitialVersion(
      db,
      { id: "f_pub", teacherId: "t_pub", title: "发布卷", kind: "quiz", updatedAt: "2024-01-01T00:00:00.000Z" },
      {
        id: "v_pub",
        formId: "f_pub",
        schemaJson: '{"meta":{"version":1}}',
        source: "generate",
        parentId: null,
        promptVersion: "test",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    );
    const before = formsRepo.findVersion(db, "f_pub", "v_pub");
    const published = formsRepo.publishVersion(db, {
      teacherId: "t_pub",
      formId: "f_pub",
      versionId: "v_pub",
      slug: "abcdefghjk",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });
    expect(published).toBe(true);
    const after = formsRepo.findVersion(db, "f_pub", "v_pub");
    expect(after).toEqual(before);
    const form = formsRepo.findForm(db, "t_pub", "f_pub");
    expect(form?.published_version_id).toBe("v_pub");
    expect(form?.slug).toBe("abcdefghjk");
    expect(form?.status).toBe("published");
    db.close();
  });

  it("别人的表单查不到；publishVersion 也会被归属条件挡住", () => {
    const db = openDatabase(":memory:");
    db.prepare(`INSERT INTO teachers (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`).run(
      "t_owner",
      "owner@example.com",
      "hash",
      "2024-01-01T00:00:00.000Z",
    );
    db.prepare(`INSERT INTO teachers (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`).run(
      "t_other",
      "other@example.com",
      "hash",
      "2024-01-01T00:00:00.000Z",
    );
    formsRepo.insertFormWithInitialVersion(
      db,
      { id: "f_own", teacherId: "t_owner", title: "我的卷", kind: "quiz", updatedAt: "2024-01-01T00:00:00.000Z" },
      {
        id: "v_own",
        formId: "f_own",
        schemaJson: "{}",
        source: "generate",
        parentId: null,
        promptVersion: "test",
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    );
    expect(formsRepo.findForm(db, "t_other", "f_own")).toBeUndefined();
    expect(formsRepo.listForms(db, "t_other")).toEqual([]);
    expect(
      formsRepo.publishVersion(db, {
        teacherId: "t_other",
        formId: "f_own",
        versionId: "v_own",
        slug: "hijackslug",
        updatedAt: "2024-01-02T00:00:00.000Z",
      }),
    ).toBe(false);
    expect(formsRepo.findForm(db, "t_owner", "f_own")?.published_version_id).toBeNull();
    db.close();
  });
});
