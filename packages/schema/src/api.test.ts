import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  API_ERROR_STATUS,
  API_PATHS,
  CSV_BASE_COLUMNS,
  aiGradeRequestSchema,
  formSettingsRequestSchema,
  ITEM_SCOPE_PATCH_OPS_SET,
  VERSION_CONFLICT_MESSAGE,
  createFormRequestSchema,
  isApiErrorBody,
  loginRequestSchema,
  patchFormPayloadOf,
  patchFormRequestSchema,
  planRequestSchema,
  publishRequestSchema,
  submitRequestSchema,
  suggestPatchRequestSchema,
  supplementItemRequestSchema,
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

describe("通用 JSON Patch 请求（2026-11-02）", () => {
  it("ops 与 jsonPatch 二选一，两个都带或都不带都拒", () => {
    const base = { baseVersionId: "v1" };
    expect(
      patchFormRequestSchema.safeParse({
        ...base,
        ops: [{ op: "setStem", itemId: "q_one", title: "新题干" }],
      }).success,
    ).toBe(true);
    expect(
      patchFormRequestSchema.safeParse({
        ...base,
        jsonPatch: [{ op: "replace", path: "/items/0/title", value: "新题干" }],
      }).success,
    ).toBe(true);
    expect(patchFormRequestSchema.safeParse(base).success).toBe(false);
    expect(
      patchFormRequestSchema.safeParse({
        ...base,
        ops: [{ op: "setStem", itemId: "q_one", title: "新题干" }],
        jsonPatch: [{ op: "test", path: "/items/0/title", value: "x" }],
      }).success,
    ).toBe(false);
  });

  it("payload 归一后仍能区分两条路径", () => {
    const ops = [{ op: "setStem", itemId: "q_one", title: "新题干" }] as const;
    const opRequest = patchFormRequestSchema.parse({ baseVersionId: "v1", ops });
    expect(patchFormPayloadOf(opRequest)).toEqual({ kind: "ops", ops });

    const jsonRequest = patchFormRequestSchema.parse({
      baseVersionId: "v1",
      jsonPatch: [{ op: "test", path: "/items/0/title", value: "x" }],
    });
    expect(patchFormPayloadOf(jsonRequest).kind).toBe("json-patch");
  });

  it("RFC 6902 操作形状不对时在契约层就拒", () => {
    expect(
      patchFormRequestSchema.safeParse({
        baseVersionId: "v1",
        jsonPatch: [{ op: "add", path: "/items/0/title" }],
      }).success,
    ).toBe(false);
    expect(
      patchFormRequestSchema.safeParse({
        baseVersionId: "v1",
        jsonPatch: [{ op: "remove", path: "/items/0/title", value: "多余" }],
      }).success,
    ).toBe(false);
  });
});

describe("AI 辅助评分（A-23）", () => {
  it("请求只收 itemId，不收答案原文", () => {
    expect(aiGradeRequestSchema.safeParse({ itemId: "q-short" }).success).toBe(true);
    expect(aiGradeRequestSchema.safeParse({ itemId: "Q" }).success).toBe(false);
    expect(
      aiGradeRequestSchema.safeParse({ itemId: "q-short", answer: "学生原文" }).success,
    ).toBe(false);
  });

  it("AI 开关默认省略不改变其它设置", () => {
    expect(formSettingsRequestSchema.safeParse({ showAnswersAfterSubmit: false }).success).toBe(true);
    expect(
      formSettingsRequestSchema.safeParse({
        showAnswersAfterSubmit: false,
        aiGradingEnabled: true,
      }).success,
    ).toBe(true);
    expect(
      formSettingsRequestSchema.safeParse({
        showAnswersAfterSubmit: false,
        aiGradingEnabled: "yes",
      }).success,
    ).toBe(false);
  });

  it("路由表带 ai-grade 路径", () => {
    expect(API_PATHS.aiGrade("f 1", "s/2")).toBe(
      "/api/forms/f%201/submissions/s%2F2/ai-grade",
    );
  });
});

describe("覆盖矩阵补题（A-22）", () => {
  it("知识点、层级、基准版本都必填，层级只认六个枚举", () => {
    expect(
      supplementItemRequestSchema.safeParse({
        baseVersionId: "v1",
        knowledgePoint: "kp-a",
        bloom: "apply",
      }).success,
    ).toBe(true);
    expect(
      supplementItemRequestSchema.safeParse({
        baseVersionId: "v1",
        knowledgePoint: "kp-a",
        bloom: "unknown",
      }).success,
    ).toBe(false);
    expect(
      supplementItemRequestSchema.safeParse({ baseVersionId: "v1", bloom: "apply" }).success,
    ).toBe(false);
  });

  it("补充要求最多 500 字", () => {
    expect(
      supplementItemRequestSchema.safeParse({
        baseVersionId: "v1",
        knowledgePoint: "kp-a",
        bloom: "apply",
        instruction: "x".repeat(501),
      }).success,
    ).toBe(false);
  });
});

describe("单题建议作用域（P18）", () => {
  it("targetItemId 可选：不给 = 整表，给了必须是合法字段 id", () => {
    expect(
      suggestPatchRequestSchema.safeParse({ baseVersionId: "v1", instruction: "改简单点" }).success,
    ).toBe(true);
    expect(
      suggestPatchRequestSchema.safeParse({
        baseVersionId: "v1",
        instruction: "改简单点",
        targetItemId: "q_2",
      }).success,
    ).toBe(true);
    expect(
      suggestPatchRequestSchema.safeParse({
        baseVersionId: "v1",
        instruction: "改简单点",
        targetItemId: "",
      }).success,
    ).toBe(false);
    expect(
      suggestPatchRequestSchema.safeParse({
        baseVersionId: "v1",
        instruction: "改简单点",
        targetItemId: "Q2",
      }).success,
    ).toBe(false);
  });

  it("单题白名单不含结构性改动（加/删/移动只能由面板按钮发起）", () => {
    for (const structural of ["addItem", "removeItem", "moveItem"]) {
      expect(ITEM_SCOPE_PATCH_OPS_SET.has(structural)).toBe(false);
    }
    for (const fieldOp of ["setStem", "setOptions", "setAnswer", "setExplanation", "setScore", "setRequired", "setMeta"]) {
      expect(ITEM_SCOPE_PATCH_OPS_SET.has(fieldOp)).toBe(true);
    }
  });
});

describe("planRequestSchema · 参考卷与联网参考", () => {
  it("接受参考卷文本和请求级联网开关", () => {
    const parsed = planRequestSchema.parse({
      requirement: "出一份高三数学试卷",
      reference: "参考卷：基础题后是参数综合题，但不得照抄。",
      webSearch: true,
    });
    expect(parsed.reference).toContain("参考卷");
    expect(parsed.webSearch).toBe(true);
  });

  it("拒绝过长参考卷", () => {
    const result = planRequestSchema.safeParse({
      requirement: "出一份试卷",
      reference: "x".repeat(20_001),
    });
    expect(result.success).toBe(false);
  });
});
