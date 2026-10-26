import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  API_PATHS,
  CSV_BASE_COLUMNS,
  VERSION_CONFLICT_MESSAGE,
  createFormRequestSchema,
  isApiErrorBody,
  loginRequestSchema,
  publishRequestSchema,
  submitRequestSchema,
} from "./api.ts";
import { formSchema } from "./types.ts";

/** 一份最小合法测验：一道单选题。照着 §3.5 的 Schema 写，别另造一套形状。 */
const quizForm = formSchema.parse({
  meta: {
    version: 1,
    kind: "quiz",
    title: "小测",
    objectives: [],
    totalScore: 5,
  },
  items: [
    {
      id: "q_one",
      type: "single",
      title: "1+1=？",
      required: true,
      score: 5,
      options: [
        { id: "a", text: "2" },
        { id: "b", text: "3" },
      ],
      answer: "a",
    },
  ],
});

describe("API_PATHS", () => {
  it("把 id 编进路径，避免拼串时漏转义", () => {
    expect(API_PATHS.form("f_1")).toBe("/api/forms/f_1");
    expect(API_PATHS.publish("f_1")).toBe("/api/forms/f_1/publish");
    expect(API_PATHS.submissionsCsv("f_1")).toBe("/api/forms/f_1/submissions.csv");
    expect(API_PATHS.form("a b/c")).toBe("/api/forms/a%20b%2Fc");
    expect(API_PATHS.fill("k3x9")).toBe("/f/k3x9");
  });
});

describe("错误码", () => {
  it("每个错误码都有 HTTP 状态", () => {
    for (const code of API_ERROR_CODES) {
      expect(API_ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
    }
  });

  it("版本冲突是 409，不是 400——它是「刷新后重试」，不是「你请求写错了」", () => {
    expect(API_ERROR_STATUS.version_conflict).toBe(409);
  });

  it("isApiErrorBody 认形状、拒野码", () => {
    expect(isApiErrorBody({ ok: false, error: "not_found", message: "x" })).toBe(true);
    expect(isApiErrorBody({ ok: false, error: "whatever", message: "x" })).toBe(false);
    expect(isApiErrorBody({ ok: true })).toBe(false);
    expect(isApiErrorBody(null)).toBe(false);
  });
});

describe("loginRequestSchema", () => {
  it("邮箱归一化：去空白、转小写", () => {
    const parsed = loginRequestSchema.parse({ email: "  Teacher@Example.COM ", password: "12345678" });
    expect(parsed.email).toBe("teacher@example.com");
  });

  it("密码短于 8 位直接拒", () => {
    expect(loginRequestSchema.safeParse({ email: "a@b.com", password: "1234567" }).success).toBe(false);
  });
});

describe("createFormRequestSchema", () => {
  it("接受通过结构校验的 Schema，source 缺省为 generate", () => {
    const parsed = createFormRequestSchema.parse({ title: "小测", kind: "quiz", schema: quizForm });
    expect(parsed.source).toBe("generate");
  });

  it("结构不合法的 Schema 进不了库", () => {
    // 空 items 在结构层合法（"整表至少要一道判分题"属于语义门禁），所以这里用真正的结构错误
    const broken = createFormRequestSchema.safeParse({
      title: "小测",
      kind: "quiz",
      schema: { meta: { version: 1, kind: "quiz", title: "x", objectives: [] }, items: [{ id: "q1" }] },
    });
    expect(broken.success).toBe(false);
  });

  it("标题上限与 kind 都按常量卡", () => {
    expect(createFormRequestSchema.safeParse({ title: "x".repeat(201), kind: "quiz", schema: quizForm }).success).toBe(
      false,
    );
    expect(createFormRequestSchema.safeParse({ title: "小测", kind: "exam", schema: quizForm }).success).toBe(false);
  });
});

describe("publishRequestSchema", () => {
  it("必须显式带版本 id", () => {
    expect(publishRequestSchema.safeParse({}).success).toBe(false);
    expect(publishRequestSchema.parse({ versionId: "v_1" }).versionId).toBe("v_1");
  });
});

describe("submitRequestSchema", () => {
  it("答案只收字符串与字符串数组", () => {
    const ok = submitRequestSchema.safeParse({
      slug: "k3x9",
      formVersionId: "v_1",
      answers: { q_one: "a", q_multi: ["a", "b"], q_fill: ["答"] },
    });
    expect(ok.success).toBe(true);
    const bad = submitRequestSchema.safeParse({ slug: "k3x9", formVersionId: "v_1", answers: { q_one: 1 } });
    expect(bad.success).toBe(false);
  });

  it("必须带学生页面实际渲染的版本号（§3.5 旧版拒绝策略的前提）", () => {
    const missing = submitRequestSchema.safeParse({ slug: "k3x9", answers: { q_one: "a" } });
    expect(missing.success).toBe(false);
  });

  it("版本冲突文案是契约的一部分，前端直接展示", () => {
    expect(VERSION_CONFLICT_MESSAGE).toContain("刷新");
  });
});

describe("CSV 表头", () => {
  it("前四列固定，顺序就是表头顺序", () => {
    expect(CSV_BASE_COLUMNS).toEqual(["submission_id", "created_at", "score", "max_score"]);
  });
});
